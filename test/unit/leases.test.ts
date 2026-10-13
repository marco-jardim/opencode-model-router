import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLeaseRegistry,
  foldKeyPath,
  formatRunNote,
  keyOf,
  type Holder,
  type HolderInput,
  type LeaseActor,
  type LeaseOptions,
  type LeaseRegistry,
  type LeaseSeams,
  type LeaseSnapshot,
  type PathKey,
  type Unkeyable,
} from "../../src/router/leases";
import { canonicalPath as canonicalPathFromDispatch } from "../../src/verify/dispatch";
import { canonicalPath } from "../../src/verify/canonical-path";
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

/**
 * DF-1.1-4: a rig whose seam answers like the v2 adapter's: the write key is scoped by the checkout (`repo` = the tree)
 * and `shared` names the repository the checkouts belong to (`/w1` and `/w2` are two worktrees of `R`).
 */
function checkoutRig(): Rig {
  const fs = fakeFs(VIRTUAL_DIRS);
  const clock = { now: 1_000 };
  const byTree = repoMap(VIRTUAL_TREES);
  const seams: LeaseSeams = {
    realpath: (p) => fs.realpath(p),
    repoKeyOf: (dir) => {
      const id = byTree(dir);
      return id === undefined ? undefined : { repo: id.tree, tree: id.tree, shared: id.repo };
    },
    now: () => clock.now,
  };
  const reg = createLeaseRegistry(seams, { runMode: "annotate", platform: "linux" });
  return { reg, fs, clock, seams };
}
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

const holderA = { holderID: "A", tree: "/w1", isChild: true, scope: "until-complete", acquiredAt: 1_000, lastSeenAt: 1_000 };

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
  const fold = (text: string): string => foldKeyPath(text);

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

  const expectedLogical = () => `r:R${NUL}${win ? "SRC/A.TS" : "Src/A.ts"}`;

  it("keys an existing file inside a repository by repository and relative path", () => {
    const key = asKey(keyOf(file, root, seams));
    expect(key.logical).toBe(expectedLogical());
    expect(key.repo).toBe("R");
    expect(key.tree).toBe(fold(repoDir));
    expect(key.rel).toBe(win ? "SRC/A.TS" : "Src/A.ts");
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
    expect(viaShort.logical).toBe(`r:R${NUL}LONGDIRECTORYNAME/B.TS`);
  });

  it("keys a file that does not exist yet by its existing ancestor", () => {
    const fresh = asKey(keyOf(join(srcDir, "New", "Deep.ts"), root, seams));
    expect(fresh.logical).toBe(`r:R${NUL}${win ? "SRC/NEW/DEEP.TS" : "Src/New/Deep.ts"}`);
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
      expect(keyOf("\\\\.\\pipe\\x", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("\\\\?\\Volume{1234}\\x.ts", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("x.ts", "\\\\.\\pipe\\", seams)).toEqual({ unkeyable: "device path" });
    });

    it.runIf(win)("unwraps the device spellings of a drive path", () => {
      const direct = asKey(keyOf(file, root, seams));
      expect(asKey(keyOf(`\\\\.\\${file}`, root, seams)).logical).toBe(direct.logical);
      expect(asKey(keyOf(`\\??\\${file}`, root, seams)).logical).toBe(direct.logical);
      expect(asKey(keyOf("Src\\A.ts", `\\\\.\\${repoDir}`, seams)).logical).toBe(direct.logical);
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
    expect(direct.physical).toBe("C:/REPO/SRC/A.TS");
    expect(direct.logical).toBe("x:C:/REPO/SRC/A.TS");
  });

  it("unwraps an extended UNC path and keeps a UNC root", () => {
    const seams = mk([]);
    expect(asKey(keyOf("\\\\?\\UNC\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//HOST/SHARE/DIR/F.TS");
    expect(asKey(keyOf("\\\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//HOST/SHARE/DIR/F.TS");
    expect(asKey(keyOf("\\\\.\\UNC\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//HOST/SHARE/DIR/F.TS");
    expect(asKey(keyOf("\\??\\UNC\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//HOST/SHARE/DIR/F.TS");
  });

  it("rejects win32 unkeyable forms on any host", () => {
    const seams = mk(["C:\\"]);
    expect(keyOf("C:foo", "C:\\", seams, "win32")).toEqual({ unkeyable: "drive-relative path" });
    expect(keyOf("\\\\.\\pipe\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "device path" });
    expect(keyOf("C:\\Missing\\PROGRA~1\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "8.3 short name in a missing path" });
    expect(keyOf("C:\\a\\...\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "empty path segment" });
    expect(keyOf("rel", "rel", seams, "win32")).toEqual({ unkeyable: "relative path without an absolute base" });
  });

  it("strips a trailing slash a link target carries, but keeps a root", () => {
    const posix = mk(["/", "/w1"], { "/lnk": "/w1/" });
    expect(asKey(keyOf("/lnk", "/", posix, "linux")).physical).toBe("/w1");
    expect(asKey(keyOf("/", "/", posix, "linux")).physical).toBe("/");
    const winSeams = mk(["C:\\"], { "C:\\drive": "C:\\", "C:\\share": "\\\\host\\share\\" });
    expect(asKey(keyOf("C:\\drive", "C:\\", winSeams, "win32")).physical).toBe("C:/");
    expect(asKey(keyOf("C:\\share", "C:\\", winSeams, "win32")).physical).toBe("//HOST/SHARE/");
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

    it("is allowed in another repository, and lists the unkeyed paths", () => {
      const { reg } = holdingX();
      const s = child("S1", "/s1");
      expect(reg.acquireWrite(s, null)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
      expect(reg.acquireWrite(s, ["", "/s1/src/z.ts"])).toEqual({
        ok: true,
        leased: ["/s1/src/z.ts"],
        reentrant: [],
        unkeyed: [""],
      });
    });

    it("is refused for another worktree of the repository that another owner leases in (QA-1.3-17)", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(C, null)).toEqual({ ok: false, reason: "unknown-target", holders: [holderA] });
      expect(reg.acquireWrite(C, ["", "/w2/src/z.ts"])).toMatchObject({ ok: false, reason: "unknown-target" });
      expect(reg.acquireWrite(C, "/w2/src/z.ts")).toMatchObject({ ok: true });
    });

    it("keeps the per-tree behaviour for a holder outside every repository", () => {
      const { reg } = rig();
      expect(reg.acquireWrite(A, "/out/src/f.ts")).toMatchObject({ ok: true });
      expect(reg.acquireWrite(child("O", "/out"), null)).toMatchObject({ ok: true });
      expect(reg.acquireWrite(child("O2", "/out"), "")).toMatchObject({ ok: true });
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
        expect(reg.checkRun(actor(ROOT), "")).toEqual({ ok: true });
        expect(reg.checkRun(actor(B), "/s1")).toEqual({ ok: true });
      }
    });

    it("fails closed for a child run in an unkeyable directory while another owner holds a lease (QA-1.3-30)", () => {
      for (const bad of ["", `/w1${NUL}`, 5 as unknown as string, undefined as unknown as string]) {
        const annotate = holdingX({ runMode: "annotate" });
        expect(annotate.reg.checkRun(actor(B), bad)).toEqual({ ok: true, contaminatedBy: [holderA], fileCount: 1 });
        const refuse = holdingX({ runMode: "refuse" });
        expect(refuse.reg.checkRun(actor(B), bad)).toEqual({ ok: false, reason: "run-refused", holders: [holderA], fileCount: 1 });
        expect(refuse.reg.checkRun(actor(A), bad)).toEqual({ ok: true });
        expect(refuse.reg.checkRun(actor(ROOT), bad)).toEqual({ ok: true });
      }
      const { reg } = rig({ runMode: "refuse" });
      expect(reg.checkRun(actor(B), "")).toEqual({ ok: true });
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
      if (result.ok || result.reason !== "run-refused") throw new Error("expected refusal");
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

  it("counts a holder's leases outside any repository only under the run directory (QA-1.3-12)", () => {
    const { reg } = rig({ runMode: "refuse" });
    reg.acquireWrite(A, "/out/src/f.ts");
    expect(reg.checkRun(actor(B), "/out")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1 });
    expect(reg.checkRun(actor(B), "/out/src")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1 });
    expect(reg.checkRun(actor(B), "/s1")).toEqual({ ok: true });
    expect(reg.release("A")).toEqual({ released: 1, retained: 0 });
    expect(reg.checkRun(actor(B), "/out")).toEqual({ ok: true });
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

  it("honours a custom age, and falls back to 6 h for zero or an invalid one (QA-1.3-28)", () => {
    const custom = rig({ sweepAgeMs: 100 });
    custom.reg.acquireWrite(A, X);
    custom.clock.now = 1_099;
    expect(custom.reg.sweep().released).toBe(0);
    custom.clock.now = 1_100;
    expect(custom.reg.sweep().released).toBe(1);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
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
      holders: [{ holderID: "A", tree: "/w1", isChild: true, scope: "until-complete", acquiredAt: 0, lastSeenAt: 0 }],
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

// ---------------------------------------------------------------------------------------------------------------------
// Phase 1.3 QA round 1.
// ---------------------------------------------------------------------------------------------------------------------

const Y = "/w1/src/y.ts";

/** A registry on win32 rules over a virtual C: drive whose repository `R` has its tree at `C:\Repo`. */
function winRig(links: Record<string, string> = {}, opts: Partial<LeaseOptions> = {}) {
  const fs = fakeFs(["C:\\", "C:\\Repo", "C:\\Repo\\src", "C:\\Other"], links);
  const clock = { now: 1_000 };
  const answer = { repo: "R", tree: "C:/Repo" };
  const seams: LeaseSeams = {
    realpath: (p) => fs.realpath(p),
    repoKeyOf: (dir) => (/^c:[\\/]repo(?:[\\/]|$)/i.test(dir) ? answer : undefined),
    now: () => clock.now,
  };
  const reg = createLeaseRegistry(seams, { runMode: "annotate", platform: "win32", ...opts });
  return { reg, fs, clock, seams, answer };
}

const WA: HolderInput = { holderID: "A", tree: "C:\\Repo", isChild: true, scope: "until-complete" };
const WB: HolderInput = { ...WA, holderID: "B" };
const WX = "C:\\Repo\\src\\x.ts";

describe("QA-1.3-2: ownership by task", () => {
  const producer = child("P", "/w1", { scope: "until-integrated", taskRef: "T" });
  const retry = child("P2", "/w1", { taskRef: "T" });
  const verifier = { holderID: "V", tree: "/w1", isChild: true, taskRef: "T" };
  const other = child("U1", "/w1", { taskRef: "U" });
  const otherActor = { ...actor(other), taskRef: "U" };

  it("lets a retry, its verifier and its QA child through, and still refuses a child of another task", () => {
    const { reg } = rig({ runMode: "refuse" });
    expect(reg.acquireWrite(producer, [X, Y])).toMatchObject({ ok: true, leased: [X, Y] });
    expect(reg.acquireWrite(retry, X)).toEqual({ ok: true, leased: [], reentrant: [X], unkeyed: [] });
    // One line per holder and pair: X is held by P and P2, Y by P.
    expect(reg.snapshot().leases).toHaveLength(3);
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["P", "P2"]);
    expect(reg.checkRead(verifier, X)).toEqual({ ok: true });
    expect(reg.checkRun(verifier, "/w1")).toEqual({ ok: true });
    expect(reg.filterSearchResults(verifier, "/w1", [X, "src/y.ts"])).toEqual({
      kept: [X, "src/y.ts"],
      omitted: 0,
      holders: [],
    });
    expect(reg.acquireWrite(other, X)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRead(otherActor, X)).toMatchObject({ ok: false, reason: "underEdit", holders: [{ holderID: "P" }] });
    expect(reg.checkRun(otherActor, "/w1")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 2 });
    expect(reg.filterSearchResults(otherActor, "/w1", [X])).toMatchObject({ omitted: 1 });
  });

  it("does not count a re-entrant write against the cap", () => {
    const { reg } = rig({ cap: 1 });
    expect(reg.acquireWrite(producer, X)).toMatchObject({ ok: true });
    expect(reg.acquireWrite(retry, X)).toMatchObject({ ok: true, leased: [], reentrant: [X] });
  });

  it("leases a new file of the retry under the same owner", () => {
    const { reg } = rig();
    reg.acquireWrite(producer, X);
    expect(reg.acquireWrite(retry, Y)).toMatchObject({ ok: true, leased: [Y] });
    expect(reg.acquireWrite(producer, Y)).toMatchObject({ ok: true, reentrant: [Y] });
    expect(reg.acquireWrite(other, Y)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRun({ ...actor(retry), taskRef: "T" }, "/w1")).toEqual({ ok: true });
  });

  it("exempts the same owner from an unknown-target refusal", () => {
    const { reg } = rig();
    reg.acquireWrite(producer, X);
    expect(reg.acquireWrite(retry, null)).toMatchObject({ ok: true });
    expect(reg.acquireWrite(other, null)).toMatchObject({ ok: false, reason: "unknown-target" });
  });

  it("does not mix up a taskRef with a holderID of the same text", () => {
    const { reg } = rig();
    reg.acquireWrite(child("T", "/w1"), X);
    expect(reg.acquireWrite(child("Q", "/w1", { taskRef: "T" }), X)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRead({ ...actor(A), holderID: "Q", taskRef: "T" }, X)).toMatchObject({ ok: false, reason: "underEdit" });
  });

  it("keeps a holder without a taskRef its own owner", () => {
    const { reg } = holdingX();
    expect(reg.checkRead({ ...actor(B), taskRef: "T" }, X)).toMatchObject({ ok: false, reason: "underEdit" });
  });
});

describe("QA-1.3-5: device spellings and fail-closed unkeyable paths", () => {
  const GLOBAL = "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Repo\\src\\x.ts";
  const VOLUME = "\\\\?\\Volume{1234}\\Repo\\src\\x.ts";
  const links = { [GLOBAL]: WX, [VOLUME]: `\\\\?\\${WX}` };

  it("keys the DOS-device spellings of a drive path like the drive path", () => {
    const { reg } = winRig();
    expect(reg.acquireWrite(WA, WX)).toMatchObject({ ok: true });
    for (const spelling of [
      "\\\\.\\C:\\Repo\\src\\x.ts",
      "\\\\?\\C:\\Repo\\src\\x.ts",
      "\\??\\C:\\Repo\\src\\x.ts",
      "//./c:/repo/src/X.ts",
    ]) {
      expect(reg.checkRead(actor(WB), spelling), spelling).toMatchObject({ ok: false, reason: "underEdit" });
      expect(reg.acquireWrite(WB, spelling), spelling).toMatchObject({ ok: false, reason: "held" });
    }
  });

  it("keys the device forms the filesystem resolves to a DOS path", () => {
    const { reg } = winRig(links);
    expect(reg.acquireWrite(WA, WX)).toMatchObject({ ok: true });
    for (const spelling of [VOLUME]) {
      expect(reg.checkRead(actor(WB), spelling), spelling).toMatchObject({ ok: false, reason: "underEdit", path: WX });
      expect(reg.acquireWrite(WB, spelling), spelling).toMatchObject({ ok: false, reason: "held" });
    }
    expect(asKey(keyOf(VOLUME, "C:\\", winRig(links).seams, "win32")).physical).toBe("C:/REPO/SRC/X.TS");
  });

  it("does not resolve GLOBALROOT, pipe or other non-volume device forms: unkeyable, no filesystem call (QA-1.3-31)", () => {
    const rigged = winRig(links);
    for (const device of [GLOBAL, "\\\\.\\pipe\\x", "\\\\.\\PhysicalDrive0", "\\\\?\\GLOBALROOT\\Device\\NamedPipe\\x", "\\??\\GLOBALROOT\\x"]) {
      expect(asUnkeyable(keyOf(device, "C:\\", rigged.seams, "win32")), device).toBe("device path");
      expect(asUnkeyable(keyOf("x", device, rigged.seams, "win32")), device).toBe("device path");
    }
    expect(rigged.fs.calls.filter((call) => /pipe|GLOBALROOT|PhysicalDrive/i.test(call))).toEqual([]);
    // Fail closed while any other owner holds a lease, like every other aliasing device form.
    rigged.reg.acquireWrite(WA, WX);
    expect(rigged.reg.checkRead(actor(WB), GLOBAL)).toMatchObject({ ok: false, reason: "underEdit" });
  });

  it("refuses a child's read of an unresolvable device path while any other owner holds a lease", () => {
    const { reg } = winRig();
    const device = "\\\\?\\GLOBALROOT\\Device\\Nowhere\\x.ts";
    expect(reg.checkRead(actor(WB), device)).toEqual({ ok: true });
    reg.acquireWrite(WA, "C:\\Other\\f.ts");
    const refused = reg.checkRead(actor(WB), device);
    expect(refused).toMatchObject({ ok: false, reason: "underEdit", path: device, holders: [{ holderID: "A" }] });
    expect(reg.checkRead({ ...actor(WA), isChild: false, holderID: "root" }, device)).toEqual({ ok: true });
    expect(reg.checkRead(actor(WA), device)).toEqual({ ok: true });
    expect(reg.checkRead(actor(WB), "")).toEqual({ ok: true });
    expect(reg.filterSearchResults(actor(WB), "C:\\Repo", [device, "src\\y.ts"])).toMatchObject({
      kept: ["src\\y.ts"],
      omitted: 1,
      holders: [{ holderID: "A" }],
    });
  });

  it("refuses a child's write of an unresolvable device path while any other owner holds a lease", () => {
    const { reg } = winRig();
    const device = "\\\\.\\pipe\\x";
    expect(reg.acquireWrite(WB, device)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [device] });
    reg.acquireWrite(WA, "C:\\Other\\f.ts");
    expect(reg.acquireWrite(WB, device)).toMatchObject({ ok: false, reason: "unknown-target", holders: [{ holderID: "A" }] });
    expect(reg.acquireWrite(WB, ["C:\\Repo\\src\\y.ts", "C:\\Repo\\Missing\\PROGRA~1\\z"])).toMatchObject({
      ok: false,
      reason: "unknown-target",
    });
    expect(reg.acquireWrite({ ...WB, holderID: "R", isChild: false }, device)).toMatchObject({ ok: true });
    reg.release("A");
    expect(reg.acquireWrite(WB, device)).toMatchObject({ ok: true });
  });

  it("exempts the same owner from the fail-closed refusal", () => {
    const { reg } = winRig();
    reg.acquireWrite({ ...WA, taskRef: "T" }, WX);
    const device = "\\\\.\\pipe\\x";
    expect(reg.checkRead({ ...actor(WB), taskRef: "T" }, device)).toEqual({ ok: true });
    expect(reg.acquireWrite({ ...WB, taskRef: "T" }, device)).toMatchObject({ ok: true });
  });

  it("does not fail closed for empty, NUL or non-string paths", () => {
    const { reg } = holdingX();
    expect(reg.checkRead(actor(B), `a${NUL}b`)).toEqual({ ok: true });
    expect(reg.checkRead(actor(B), 5 as unknown as string)).toEqual({ ok: true });
  });
});

describe("QA-1.3-6: inputs outside the declared types", () => {
  it("treats a path value that is not null, a string or an array as an unknown target, without throwing", () => {
    const { reg } = holdingX();
    const refused = { ok: false, reason: "unknown-target", holders: [holderA] };
    for (const value of [5, undefined, {}, true, new Set<string>(), new Set([Y]), () => Y]) {
      expect(reg.acquireWrite(B, value as unknown as string), String(value)).toEqual(refused);
    }
    expect(reg.acquireWrite(ROOT, 5 as unknown as string)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
    expect(reg.acquireWrite(child("S1", "/s1"), undefined as unknown as string)).toMatchObject({ ok: true });
  });

  it("describes any array entry that is not a string without throwing", () => {
    const { reg } = rig();
    const hostile = { toString: () => { throw new Error("no"); } };
    expect(reg.acquireWrite(A, [Symbol("s"), hostile, Y] as unknown as string[])).toMatchObject({ ok: true, leased: [Y] });
  });

  it("refuses an actor that is not a valid object, with invalid-holder", () => {
    const { reg } = holdingX();
    for (const value of [undefined, null, "B", 5, []]) {
      const actorValue = value as unknown as LeaseActor;
      expect(reg.checkRead(actorValue, X), String(value)).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.checkRun(actorValue, "/w1"), String(value)).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.filterSearchResults(actorValue, "/w1", [X]), String(value)).toMatchObject({
        kept: [],
        omitted: 1,
        invalid: expect.any(String),
      });
    }
  });

  it("refuses an isChild that is not a boolean instead of treating the actor as root", () => {
    const { reg } = holdingX();
    for (const isChild of [undefined, "yes", 1, null]) {
      const bad = { ...actor(B), isChild } as unknown as LeaseActor;
      expect(reg.checkRead(bad, X)).toEqual({ ok: false, reason: "invalid-holder", message: "isChild must be a boolean" });
      expect(reg.checkRun(bad, "/w1")).toMatchObject({ ok: false, reason: "invalid-holder" });
    }
  });

  it("refuses a relative or missing tree and a bad holderID or taskRef of an actor", () => {
    const { reg } = holdingX();
    expect(reg.checkRead({ ...actor(B), tree: "w1" }, X)).toEqual({
      ok: false,
      reason: "invalid-holder",
      message: "tree must be an absolute path",
    });
    expect(reg.checkRead({ ...actor(B), tree: undefined } as unknown as LeaseActor, X)).toMatchObject({ reason: "invalid-holder" });
    expect(reg.checkRead({ ...actor(B), holderID: "" }, X)).toMatchObject({ reason: "invalid-holder" });
    expect(reg.checkRead({ ...actor(B), taskRef: 3 } as unknown as LeaseActor, X)).toMatchObject({ reason: "invalid-holder" });
  });

  it("rejects a holder with a relative tree", () => {
    const { reg } = rig();
    expect(reg.acquireWrite({ ...A, tree: "w1" }, X)).toEqual({
      ok: false,
      reason: "invalid-holder",
      message: "tree must be an absolute path",
    });
    expect(reg.acquireWrite({ ...A, tree: "./w1" }, X)).toMatchObject({ reason: "invalid-holder" });
    expect(reg.snapshot().leases).toEqual([]);
  });

  it("answers a path or paths that are not strings without throwing", () => {
    const { reg } = holdingX();
    expect(reg.checkRead(actor(B), undefined as unknown as string)).toEqual({ ok: true });
    // An unkeyable run directory fails closed for a child (QA-1.3-30).
    expect(reg.checkRun(actor(B), undefined as unknown as string)).toMatchObject({ ok: true, contaminatedBy: [holderA] });
    expect(reg.filterSearchResults(actor(B), undefined as unknown as string, undefined as unknown as string[])).toEqual({
      kept: [],
      omitted: 0,
      holders: [],
    });
    expect(reg.filterSearchResults(actor(B), "/w1", [5, X] as unknown as string[])).toMatchObject({ omitted: 1 });
  });
});

describe("QA-1.3-7: the sweep ages from lastSeenAt", () => {
  const seen = (reg: LeaseRegistry) => pick(reg.snapshot().holders, 0).lastSeenAt;

  it("refreshes lastSeenAt on every acquire (re-entrant too), read, search and run of the holder", () => {
    const { reg, clock } = holdingX();
    expect(seen(reg)).toBe(1_000);
    clock.now = 2_000;
    reg.acquireWrite(A, X);
    expect(seen(reg)).toBe(2_000);
    clock.now = 3_000;
    reg.checkRead(actor(A), X);
    expect(seen(reg)).toBe(3_000);
    clock.now = 4_000;
    reg.checkRun(actor(A), "/w1");
    expect(seen(reg)).toBe(4_000);
    clock.now = 5_000;
    reg.filterSearchResults(actor(A), "/w1", ["src/x.ts"]);
    expect(seen(reg)).toBe(5_000);
    clock.now = 6_000;
    reg.acquireWrite(A, Y);
    expect(seen(reg)).toBe(6_000);
    expect(pick(reg.snapshot().holders, 0).acquiredAt).toBe(1_000);
  });

  it("refreshes the holder of a lease a same-task session writes again", () => {
    const { reg, clock } = rig();
    reg.acquireWrite(child("P", "/w1", { taskRef: "T" }), X);
    clock.now = 4_000;
    reg.acquireWrite(child("P2", "/w1", { taskRef: "T" }), X);
    expect(seen(reg)).toBe(4_000);
  });

  it("does not sweep a holder that keeps working", () => {
    const { reg, clock } = holdingX();
    clock.now = 1_000 + SIX_H - 1;
    reg.acquireWrite(A, X);
    clock.now = 1_000 + SIX_H;
    expect(reg.sweep()).toEqual({ released: 0, holders: [] });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    clock.now = 1_000 + 2 * SIX_H - 1;
    expect(reg.sweep()).toEqual({ released: 1, holders: ["A"] });
  });

  it("sweeps a stale until-complete holder on the spot when a write conflicts with it", () => {
    const { reg, clock } = holdingX();
    clock.now = 1_000 + SIX_H;
    expect(reg.acquireWrite(B, X)).toEqual({ ok: true, leased: [X], reentrant: [], unkeyed: [] });
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["B"]);
  });

  it("re-evaluates a whole array after sweeping", () => {
    const { reg, clock } = holdingX();
    reg.acquireWrite(C, "/w2/src/z.ts");
    clock.now = 1_000 + SIX_H - 1;
    reg.acquireWrite(C, "/w2/src/z.ts");
    clock.now = 1_000 + SIX_H;
    expect(reg.acquireWrite(B, [Y, X, "/w2/src/z.ts"])).toMatchObject({ ok: false, reason: "held", path: "/w2/src/z.ts" });
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["C"]);
  });

  it("sweeps a stale holder named by a root write, a read, a run and an unknown-target write", () => {
    for (const probe of [
      (reg: LeaseRegistry) => reg.acquireWrite(ROOT, X),
      (reg: LeaseRegistry) => reg.checkRead(actor(B), X),
      (reg: LeaseRegistry) => reg.checkRun(actor(B), "/w1"),
      (reg: LeaseRegistry) => reg.acquireWrite(B, null),
      (reg: LeaseRegistry) => reg.filterSearchResults(actor(B), "/w1", [X]),
    ]) {
      const { reg, clock } = holdingX({ runMode: "refuse" });
      clock.now = 1_000 + SIX_H;
      const result = probe(reg);
      expect(result).not.toMatchObject({ ok: false });
      expect(result).not.toHaveProperty("omitted", 1);
      expect(reg.snapshot().leases).toEqual([]);
    }
  });

  it("never sweeps an until-integrated holder on the spot", () => {
    const { reg, clock } = rig();
    reg.acquireWrite(child("I", "/w1", { scope: "until-integrated", taskRef: "T" }), X);
    clock.now = 1_000 + 10 * SIX_H;
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
  });

  it("does not sweep a holder younger than the age on the spot", () => {
    const { reg, clock } = holdingX();
    clock.now = 1_000 + SIX_H - 1;
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRead(actor(B), X)).toMatchObject({ ok: false, reason: "underEdit" });
  });
});

describe("QA-1.3-8: restore checks consistency", () => {
  const base = (): LeaseSnapshot => {
    const r = rig();
    r.reg.acquireWrite(A, X);
    r.reg.acquireWrite(child("O", "/out"), "/out/src/f.ts");
    return r.reg.snapshot();
  };
  const withLease = (index: number, patch: Record<string, unknown>) => (snap: LeaseSnapshot): unknown => ({
    ...snap,
    leases: snap.leases.map((lease, at) => (at === index ? { ...lease, ...patch } : lease)),
  });
  const withHolder = (index: number, patch: Record<string, unknown>) => (snap: LeaseSnapshot): unknown => ({
    ...snap,
    holders: snap.holders.map((holder, at) => (at === index ? { ...holder, ...patch } : holder)),
  });

  const bad: [string, (snap: LeaseSnapshot) => unknown][] = [
    ["an x: lease with a tree", withLease(1, { tree: "/out" })],
    ["an r: lease without a tree", withLease(0, { tree: null })],
    ["an r: lease whose physical lies outside its tree", withLease(0, { physical: "/w2/src/x.ts" })],
    ["an r: lease whose physical is a sibling by prefix", withLease(0, { tree: "/w1/sr", physical: X })],
    ["a physical path with backslashes", withLease(0, { physical: "\\w1\\src\\x.ts" })],
    ["a physical path with a trailing slash", withLease(1, { physical: "/out/src/f.ts/", logical: "x:/out/src/f.ts/" })],
    ["a tree with a trailing slash", withLease(0, { tree: "/w1/" })],
    ["a logical key that does not match the physical path", withLease(0, { logical: `r:R${NUL}src/other.ts` })],
    ["an x: key that does not match the physical path", withLease(1, { logical: "x:/out/src/g.ts" })],
    ["a logical key without a key space", withLease(0, { logical: "R" })],
    ["a relative holder tree", withHolder(0, { tree: "w1" })],
    ["a non-numeric lastSeenAt", withHolder(0, { lastSeenAt: "now" })],
    ["a non-finite lastSeenAt", withHolder(0, { lastSeenAt: Number.NaN })],
  ];
  for (const [name, corrupt] of bad) {
    it(`rejects ${name} and leaves the state unchanged`, () => {
      const { reg } = rig();
      reg.acquireWrite(B, Y);
      const before = reg.snapshot();
      const result = reg.restore(corrupt(base()));
      expect(result).toMatchObject({ ok: false, reason: "invalid-snapshot" });
      expect(reg.snapshot()).toEqual(before);
    });
  }

  it("clamps a stamp in the future to now()", () => {
    const { reg, clock } = rig();
    clock.now = 3_000;
    const snap = withHolder(0, { acquiredAt: 9_000_000, lastSeenAt: 8_000_000 })(base());
    expect(reg.restore(snap)).toEqual({ ok: true, leases: 2 });
    const [first] = reg.snapshot().holders;
    expect(first).toMatchObject({ acquiredAt: 3_000, lastSeenAt: 3_000 });
    clock.now = 3_000 + SIX_H - 1;
    // only the other holder, last seen at 1 000, is stale: the clamped one was last seen at now()
    expect(reg.sweep().holders).toEqual(["O"]);
  });

  it("takes a holder without lastSeenAt as last seen when acquired", () => {
    const { reg } = rig();
    const snap = withHolder(0, { lastSeenAt: undefined, acquiredAt: 500 })(base());
    expect(reg.restore(snap)).toEqual({ ok: true, leases: 2 });
    expect(pick(reg.snapshot().holders, 0)).toMatchObject({ acquiredAt: 500, lastSeenAt: 500 });
  });

  it("drops the until-complete holders and their leases on request", () => {
    const r = rig();
    r.reg.acquireWrite(A, X);
    r.reg.acquireWrite(child("I", "/w2", { scope: "until-integrated", taskRef: "T" }), "/w2/src/z.ts");
    const snap = r.reg.snapshot();
    const keep = rig();
    expect(keep.reg.restore(snap, { dropCompleteHolders: true })).toEqual({ ok: true, leases: 1 });
    expect(keep.reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["I"]);
    expect(keep.reg.acquireWrite(B, X)).toMatchObject({ ok: true });
    expect(rig().reg.restore(snap, { dropCompleteHolders: false })).toEqual({ ok: true, leases: 2 });
    expect(rig().reg.restore(snap, {})).toEqual({ ok: true, leases: 2 });
  });

  it("still validates the leases of a dropped holder", () => {
    const r = rig();
    r.reg.acquireWrite(A, X);
    const snap = withLease(0, { physical: "/w2/src/x.ts" })(r.reg.snapshot());
    expect(rig().reg.restore(snap, { dropCompleteHolders: true })).toMatchObject({ ok: false, reason: "invalid-snapshot" });
  });

  it("checks a snapshot against the platform's normal form", () => {
    const { reg } = winRig();
    const holders = [{ ...WA, acquiredAt: 1, lastSeenAt: 1 }];
    const lease = { logical: `r:R${NUL}SRC/X.TS`, physical: "C:/REPO/SRC/X.TS", tree: "C:/REPO", holderID: "A", display: WX };
    const snapshot = (patch: Record<string, unknown>) => ({ version: 1, takenAt: 1, holders, leases: [{ ...lease, ...patch }] });
    expect(reg.restore(snapshot({}))).toEqual({ ok: true, leases: 1 });
    expect(reg.restore(snapshot({ physical: "c:/repo/src/x.ts" }))).toMatchObject({ ok: false });
    expect(reg.restore(snapshot({ physical: "C:\\REPO\\SRC\\X.TS" }))).toMatchObject({ ok: false });
    expect(reg.restore(snapshot({ tree: "C:/Repo" }))).toMatchObject({ ok: false });
    expect(reg.checkRead(actor(WB), WX)).toMatchObject({ ok: false, reason: "underEdit" });
  });
});

describe("QA-1.3-9: repoKeyOf answers are folded like physical keys", () => {
  it("accepts a forward-slash, backslash, trailing-slash or differently cased answer alike", () => {
    const logicals = new Set<string>();
    for (const tree of ["C:/Repo", "C:\\Repo", "C:\\Repo\\", "c:/repo/", "C:/REPO"]) {
      for (const repo of ["R", "r"]) {
        const { seams, answer } = winRig();
        answer.tree = tree;
        answer.repo = repo;
        const key = asKey(keyOf(WX, "C:\\", seams, "win32"));
        expect(key.tree, tree).toBe("C:/REPO");
        expect(key.repo).toBe("R");
        expect(key.rel).toBe("SRC/X.TS");
        logicals.add(key.logical);
      }
    }
    expect([...logicals]).toEqual([`r:R${NUL}SRC/X.TS`]);
  });

  it("conflicts across spellings of the answer through the registry", () => {
    const { reg, answer } = winRig();
    expect(reg.acquireWrite(WA, WX)).toMatchObject({ ok: true });
    answer.tree = "c:\\repo\\";
    answer.repo = "r";
    expect(reg.acquireWrite(WB, "c:/repo/SRC/x.ts")).toMatchObject({ ok: false, reason: "held" });
  });

  it("exports the fold function the adapter spells its answers with", () => {
    expect(foldKeyPath("C:\\Repo\\", "win32")).toBe("C:/REPO");
    expect(foldKeyPath("c:/repo", "win32")).toBe("C:/REPO");
    expect(foldKeyPath("C:\\", "win32")).toBe("C:/");
    expect(foldKeyPath("\\\\host\\share\\", "win32")).toBe("//HOST/SHARE/");
    expect(foldKeyPath("/", "linux")).toBe("/");
    expect(foldKeyPath("/Repo/Src//", "linux")).toBe("/Repo/Src");
  });
});

describe("QA-1.3-10: case folding", () => {
  it("folds each UTF-16 unit with toUpperCase on win32 only", () => {
    expect(foldKeyPath("ΟΔΟΣ", "win32")).toBe(foldKeyPath("οδοσ", "win32"));
    expect(foldKeyPath("ΟΔΟΣ", "win32")).toBe(foldKeyPath("οδος", "win32"));
    expect(foldKeyPath("ſ", "win32")).toBe(foldKeyPath("s", "win32"));
    expect(foldKeyPath("ſ", "win32")).toBe(foldKeyPath("S", "win32"));
    expect(foldKeyPath("ΟΔΟΣ", "linux")).not.toBe(foldKeyPath("οδοσ", "linux"));
    expect(foldKeyPath("ſ", "linux")).toBe("ſ");
  });

  it("keeps a unit whose upper case is longer than one unit, and leaves astral characters alone", () => {
    expect(foldKeyPath("ß", "win32")).toBe("ß");
    expect(foldKeyPath("ǰ", "win32")).toBe("ǰ");
    expect(foldKeyPath("\u{10428}", "win32")).toBe("\u{10428}");
    expect(foldKeyPath("é", "win32")).toBe("É");
  });

  it("conflicts two spellings that differ only by such letters", () => {
    const { reg } = winRig();
    expect(reg.acquireWrite(WA, "C:\\Repo\\src\\ΟΔΟΣ.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(WB, "C:\\Repo\\src\\οδοσ.ts")).toMatchObject({ ok: false, reason: "held" });
    expect(reg.acquireWrite(WA, "C:\\Repo\\src\\ſ.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(WB, "C:\\Repo\\src\\S.TS")).toMatchObject({ ok: false, reason: "held" });
  });
});

describe("QA-1.3-11: one logical key, several (physical, tree) pairs", () => {
  const W2X = "/w2/src/x.ts";

  it("records a re-entrant write in another tree and checks reads and runs in each", () => {
    const { reg } = rig({ runMode: "refuse" });
    expect(reg.acquireWrite(A, X)).toMatchObject({ ok: true });
    expect(reg.checkRead(actor(C), W2X)).toEqual({ ok: true });
    expect(reg.checkRun(actor(C), "/w2")).toEqual({ ok: true });
    expect(reg.acquireWrite(A, W2X)).toEqual({ ok: true, leased: [], reentrant: [W2X], unkeyed: [] });
    expect(reg.checkRead(actor(C), W2X)).toMatchObject({ ok: false, reason: "underEdit", holders: [{ holderID: "A" }] });
    expect(reg.checkRead(actor(B), X)).toMatchObject({ ok: false, reason: "underEdit" });
    expect(reg.checkRun(actor(C), "/w2")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1 });
    expect(reg.checkRun(actor(C), "/w1")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1 });
    expect(reg.filterSearchResults(actor(C), "/w2", ["src/x.ts", "src/y.ts"])).toMatchObject({ kept: ["src/y.ts"], omitted: 1 });
    expect(reg.acquireWrite(C, W2X)).toMatchObject({ ok: false, reason: "held" });
  });

  it("counts one logical key once, and lets the same pair be recorded once", () => {
    const { reg } = rig({ cap: 1 });
    reg.acquireWrite(A, X);
    expect(reg.acquireWrite(A, W2X)).toMatchObject({ ok: true, reentrant: [W2X] });
    expect(reg.acquireWrite(A, W2X)).toMatchObject({ ok: true, reentrant: [W2X] });
    expect(reg.snapshot().leases).toHaveLength(2);
    expect(reg.acquireWrite(A, Y)).toMatchObject({ ok: false, reason: "cap", held: 1 });
  });

  it("adds the pair only when the whole array succeeds", () => {
    const { reg } = holdingX();
    reg.acquireWrite(C, "/w2/src/z.ts");
    expect(reg.acquireWrite(A, [W2X, "/w2/src/z.ts"])).toMatchObject({ ok: false, reason: "held" });
    expect(reg.snapshot().leases).toHaveLength(2);
  });

  it("ends every pair with the lease, and survives a snapshot round trip", () => {
    const { reg, clock } = rig({ runMode: "refuse" });
    reg.acquireWrite(A, X);
    reg.acquireWrite(A, W2X);
    const snap = JSON.parse(JSON.stringify(reg.snapshot())) as LeaseSnapshot;
    expect(snap.leases.map((lease) => [lease.logical, lease.tree])).toEqual([
      [REL_X_KEY, "/w1"],
      [REL_X_KEY, "/w2"],
    ]);
    const second = rig({ runMode: "refuse" });
    second.clock.now = clock.now;
    expect(second.reg.restore(snap)).toEqual({ ok: true, leases: 1 });
    expect(second.reg.snapshot()).toEqual(snap);
    expect(second.reg.checkRead(actor(C), W2X)).toMatchObject({ ok: false, reason: "underEdit" });
    expect(second.reg.release("A")).toEqual({ released: 1, retained: 0 });
    expect(second.reg.checkRun(actor(C), "/w2")).toEqual({ ok: true });
    expect(second.reg.checkRun(actor(C), "/w1")).toEqual({ ok: true });
  });

  it("rejects a repeated pair or the same key under two holders in a snapshot", () => {
    const { reg } = rig();
    reg.acquireWrite(A, X);
    reg.acquireWrite(A, W2X);
    const snap = reg.snapshot();
    const [first, second] = snap.leases;
    expect(rig().reg.restore({ ...snap, leases: [first, first] })).toMatchObject({ ok: false });
    const other = { ...snap, holders: [...snap.holders, { ...holderA, holderID: "Z" }], leases: [first, { ...second, holderID: "Z" }] };
    expect(rig().reg.restore(other)).toMatchObject({ ok: false, message: expect.stringMatching(/duplicate lease/) });
  });
});

describe("QA-1.3-12: a run also counts the leases under the run directory", () => {
  it("counts a lease of another repository (a nested tree or submodule) under the run directory", () => {
    const { reg } = rig({ runMode: "refuse" });
    reg.acquireWrite(child("S1", "/s1"), "/s1/src/z.ts");
    expect(reg.checkRun(actor(B), "/w1")).toEqual({ ok: true });
    expect(reg.checkRun(actor(B), "/")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1, holders: [{ holderID: "S1" }] });
    expect(reg.checkRun(actor(ROOT), "/")).toMatchObject({ ok: true, contaminatedBy: [{ holderID: "S1" }], fileCount: 1 });
    expect(reg.checkRun({ ...actor(B), taskRef: "T" }, "/s1")).toMatchObject({ ok: false });
  });

  it("counts x: keys under the directory and not the siblings of it", () => {
    const { reg } = rig({ runMode: "refuse" });
    reg.acquireWrite(A, ["/out/src/f.ts", X]);
    expect(reg.checkRun(actor(B), "/out/src")).toMatchObject({ ok: false, fileCount: 1 });
    expect(reg.checkRun(actor(B), "/out/sr")).toEqual({ ok: true });
    expect(reg.checkRun(actor(C), "/w1")).toMatchObject({ ok: false, fileCount: 1 });
    expect(reg.checkRun(actor(C), "/")).toMatchObject({ ok: false, fileCount: 2 });
  });

  it("counts a file once when it is under the directory and in its tree", () => {
    const { reg } = holdingX();
    expect(reg.checkRun(actor(B), "/w1/src")).toMatchObject({ ok: true, fileCount: 1 });
  });
});

describe("QA-1.3-13: input size", () => {
  const seams = (): LeaseSeams => {
    const fs = fakeFs(["/", "/w1"]);
    return { realpath: (p) => fs.realpath(p), repoKeyOf: () => undefined, now: () => 0 };
  };

  it("makes a path above 32 767 characters unkeyable", () => {
    expect(keyOf(`/${"a".repeat(32_767)}`, "/", seams(), "linux")).toEqual({ unkeyable: "path too long" });
    expect(keyOf("a".repeat(32_768), "/w1", seams(), "linux")).toEqual({ unkeyable: "path too long" });
    expect(keyOf("a", `/${"b".repeat(32_767)}`, seams(), "linux")).toEqual({ unkeyable: "path too long" });
    expect(keyOf(`/${"a".repeat(32_766)}`, "/", seams(), "linux")).toHaveProperty("physical");
  });

  it("makes a path above 4 096 segments unkeyable", () => {
    // Segments are counted on the resolved path (QA-1.3-30), and the reason is compared, not the 4 096-segment path.
    const reasonOf = (key: PathKey | Unkeyable): string => ("unkeyable" in key ? key.unkeyable : "keyed");
    expect(reasonOf(keyOf(`/${"a/".repeat(4_096)}`, "/", seams(), "linux"))).toBe("too many path segments");
    expect(reasonOf(keyOf(`/${"a/".repeat(4_095)}`, "/", seams(), "linux"))).toBe("keyed");
    expect(reasonOf(keyOf(`/${"a/../".repeat(5_000)}b`, "/", seams(), "linux"))).toBe("keyed");
    expect(keyOf(`${"a/".repeat(4_096)}`, "/w1", seams(), "linux")).toEqual({ unkeyable: "too many path segments" });
    expect(keyOf(`/${"a/".repeat(4_094)}`, "/", seams(), "linux")).toHaveProperty("physical");
    expect(reasonOf(keyOf(`C:\\${"a\\".repeat(4_096)}`, "C:\\", seams(), "win32"))).toBe("too many path segments");
  });

  it("lists an oversize path as unkeyed and refuses it as an unknown target", () => {
    const { reg } = holdingX();
    const huge = "a".repeat(40_000);
    expect(reg.acquireWrite(B, huge)).toMatchObject({ ok: false, reason: "unknown-target" });
    expect(reg.acquireWrite(child("S1", "/s1"), huge)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [huge] });
    expect(reg.checkRead(actor(B), huge)).toEqual({ ok: true });
  });
});

describe("QA-1.3-15: the NT object prefix", () => {
  it("treats `\\??\\C:\\…` like `\\\\?\\C:\\…`", () => {
    const { seams } = winRig();
    const direct = asKey(keyOf(WX, "C:\\", seams, "win32"));
    expect(asKey(keyOf(`\\??\\${WX}`, "C:\\", seams, "win32")).logical).toBe(direct.logical);
    expect(asKey(keyOf("x.ts", "\\??\\C:\\Repo\\src", seams, "win32")).physical).toBe(direct.physical);
    expect(asKey(keyOf("\\??\\UNC\\Host\\Share\\f.ts", "C:\\", seams, "win32")).physical).toBe("//HOST/SHARE/F.TS");
  });

  it("makes other `\\??\\` forms unkeyable", () => {
    const { seams } = winRig();
    expect(keyOf("\\??\\Volume{1}\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "device path" });
    expect(keyOf("\\??\\C:x", "C:\\", seams, "win32")).toEqual({ unkeyable: "device path" });
  });

  it("does not treat the prefix as special on posix rules", () => {
    const fs = fakeFs(["/"]);
    const posixSeams: LeaseSeams = { realpath: (p) => fs.realpath(p), repoKeyOf: () => undefined, now: () => 0 };
    expect(keyOf("/??/x", "/", posixSeams, "linux")).toHaveProperty("physical", "/??/x");
  });
});

describe("QA-1.3-16: canonicalPath lives in a leaf module", () => {
  it("is the same function from the leaf and from the verify dispatch module", () => {
    expect(canonicalPathFromDispatch).toBe(canonicalPath);
  });

  it("falls back to the native realpath when the realpath argument is not a function", () => {
    const cwd = process.cwd();
    const native = canonicalPath(cwd);
    expect(canonicalPath(cwd, "realpath" as unknown as (p: string) => string)).toBe(native);
    expect(canonicalPath(cwd, null as unknown as (p: string) => string)).toBe(native);
    expect(canonicalPath(cwd, undefined)).toBe(native);
  });

  it("resolves the nearest existing ancestor and keeps the missing tail", () => {
    const seen: string[] = [];
    const result = canonicalPath("/a/b/c", (p) => {
      seen.push(p);
      if (p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "") === "/a") return "/real-a";
      throw new Error("ENOENT");
    });
    expect(result.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")).toBe("/real-a/b/c");
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("is imported by the lease registry from the leaf, and the leaf imports only node built-ins", () => {
    const leaf = readFileSync(join(__dirname, "..", "..", "src", "verify", "canonical-path.ts"), "utf8");
    const specifiers = [...leaf.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
    const leases = readFileSync(join(__dirname, "..", "..", "src", "router", "leases.ts"), "utf8");
    expect(leases).toContain('from "../verify/canonical-path"');
    expect(leases).not.toContain('from "../verify/dispatch"');
  });
});

describe("QA-1.3-17: an unknown-target write is refused per repository", () => {
  it("is refused while another owner leases a file in any worktree of the same repository", () => {
    const { reg } = rig();
    reg.acquireWrite(C, "/w2/src/z.ts");
    expect(reg.acquireWrite(B, null)).toEqual({
      ok: false,
      reason: "unknown-target",
      holders: [expect.objectContaining({ holderID: "C" })],
    });
    expect(reg.acquireWrite(B, [""])).toMatchObject({ ok: false, reason: "unknown-target" });
  });

  it("is allowed in another repository and for the same owner", () => {
    const { reg } = rig();
    reg.acquireWrite(child("P", "/w2", { taskRef: "T" }), "/w2/src/z.ts");
    expect(reg.acquireWrite(child("S1", "/s1"), null)).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("P2", "/w1", { taskRef: "T" }), null)).toMatchObject({ ok: true });
  });

  it("is allowed again once the other owner's leases end", () => {
    const { reg } = rig();
    reg.acquireWrite(C, "/w2/src/z.ts");
    reg.release("C");
    expect(reg.acquireWrite(B, null)).toMatchObject({ ok: true });
  });

  it("is not triggered by x: leases (those keep the per-tree behaviour)", () => {
    const { reg } = rig();
    reg.acquireWrite(child("O", "/out"), "/out/src/f.ts");
    expect(reg.acquireWrite(B, null)).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("O2", "/out"), null)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Phase 1.3 QA round 2.
// ---------------------------------------------------------------------------------------------------------------------

const X2 = "/w2/src/x.ts";

describe("QA-1.3-18: an actor whose holderID is recorded is that holder", () => {
  const recorded = child("P", "/w1", { taskRef: "T" });
  const own: LeaseActor = { holderID: "P", tree: "/w1", isChild: true };

  /** P holds X and Y for task T, and an unrelated child holds a file in /w2 so that the foreign paths are taken. */
  function holding(runMode: "annotate" | "refuse"): Rig {
    const r = rig({ runMode });
    expect(r.reg.acquireWrite(recorded, [X, Y])).toMatchObject({ ok: true });
    expect(r.reg.acquireWrite(C, "/w2/src/z.ts")).toMatchObject({ ok: true });
    return r;
  }

  it("is never refused its own files, with or without repeating taskRef", () => {
    const { reg } = holding("refuse");
    for (const reader of [own, { ...own, taskRef: "T" }]) {
      expect(reg.checkRead(reader, X)).toEqual({ ok: true });
      expect(reg.filterSearchResults(reader, "/w1", [X, "src/y.ts"])).toEqual({ kept: [X, "src/y.ts"], omitted: 0, holders: [] });
      expect(reg.checkRun(reader, "/w1")).toMatchObject({ ok: true });
    }
    expect(reg.checkRun(own, "/w1")).toEqual({ ok: true });
    // Another owner is still refused.
    expect(reg.checkRead(actor(B), X)).toMatchObject({ ok: false, reason: "underEdit" });
  });

  it("is an invalid holder when taskRef, tree or isChild differ from the record", () => {
    const { reg } = holding("refuse");
    const bad: LeaseActor[] = [
      { ...own, taskRef: "U" },
      { ...own, tree: "/w2" },
      { ...own, isChild: false },
    ];
    for (const reader of bad) {
      expect(reg.checkRead(reader, X), JSON.stringify(reader)).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.checkRun(reader, "/w1"), JSON.stringify(reader)).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.filterSearchResults(reader, "/w1", [X]), JSON.stringify(reader)).toMatchObject({ kept: [], omitted: 1 });
    }
  });

  it("cannot claim a taskRef a recorded task-less holder does not have", () => {
    const { reg } = holdingX();
    expect(reg.checkRead({ ...actor(A), taskRef: "T" }, X)).toMatchObject({ ok: false, reason: "invalid-holder" });
    expect(reg.checkRead(actor(A), X)).toEqual({ ok: true });
  });

  it("exempts a holder from a lease it holds itself, even as a sibling of the task", () => {
    const { reg } = rig();
    const sibling = child("P2", "/w1", { taskRef: "T" });
    expect(reg.acquireWrite(recorded, X)).toMatchObject({ ok: true });
    expect(reg.acquireWrite(sibling, X)).toMatchObject({ ok: true, reentrant: [X] });
    expect(reg.checkRead({ holderID: "P2", tree: "/w1", isChild: true }, X)).toEqual({ ok: true });
  });
});

describe("QA-1.3-19: drive-less rooted and device paths on win32", () => {
  it("makes a rooted path without a drive unkeyable, and the reason aliasing", () => {
    const { seams } = winRig();
    for (const spelling of ["\\Repo\\src\\x.ts", "/Repo/src/x.ts", "\\x"]) {
      expect(asUnkeyable(keyOf(spelling, "C:\\Repo", seams, "win32")), spelling).toBe("rooted path without a drive");
    }
    // A UNC path is not drive-less, and posix rules are untouched.
    const unc = keyOf("\\\\server\\share\\x", "C:\\Repo", seams, "win32");
    expect("unkeyable" in unc ? unc.unkeyable : "keyed").not.toBe("rooted path without a drive");
    expect(keyOf("/w1/src/x.ts", "/", rig().seams, "linux")).toHaveProperty("physical");
  });

  it("refuses a child's read and write of such a spelling while another owner holds a lease", () => {
    const { reg } = winRig();
    expect(reg.checkRead(actor(WB), "\\Repo\\src\\x.ts")).toEqual({ ok: true });
    expect(reg.acquireWrite(WA, WX)).toMatchObject({ ok: true });
    expect(reg.checkRead(actor(WB), "\\Repo\\src\\x.ts")).toMatchObject({ ok: false, reason: "underEdit", holders: [{ holderID: "A" }] });
    expect(reg.acquireWrite(WB, "\\Repo\\src\\x.ts")).toMatchObject({ ok: false, reason: "unknown-target" });
    expect(reg.checkRead(actor(WA), "\\Repo\\src\\x.ts")).toEqual({ ok: true });
  });
});

describe("QA-1.3-20: a lease has a set of holders", () => {
  const p1 = child("P1", "/w1", { taskRef: "T" });
  const p2 = child("P2", "/w1", { taskRef: "T" });
  const integrated = child("P3", "/w1", { taskRef: "T", scope: "until-integrated" });

  it("ends only with the last holder of the owner", () => {
    const { reg } = rig();
    expect(reg.acquireWrite(p1, X)).toMatchObject({ ok: true, leased: [X] });
    expect(reg.acquireWrite(p2, X)).toMatchObject({ ok: true, leased: [], reentrant: [X] });
    expect(reg.release("P1")).toEqual({ released: 0, retained: 0 });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held", holders: [{ holderID: "P2" }] });
    expect(reg.release("P2")).toEqual({ released: 1, retained: 0 });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true, leased: [X] });
  });

  it("lives as long as the strongest scope among the holders", () => {
    const { reg } = rig();
    reg.acquireWrite(p1, X);
    reg.acquireWrite(integrated, X);
    expect(reg.release("P1")).toEqual({ released: 0, retained: 0 });
    expect(reg.release("P3")).toEqual({ released: 0, retained: 1 });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.releaseTask("T")).toEqual({ released: 1, holders: expect.arrayContaining(["P3"]) });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true });
  });

  it("keeps a file a sibling wrote after the first writer is swept", () => {
    const { reg, clock } = rig();
    reg.acquireWrite(p1, X);
    clock.now = 1_000 + SIX_H - 1;
    reg.acquireWrite(p2, Y);
    clock.now = 1_000 + SIX_H;
    expect(reg.sweep()).toEqual({ released: 1, holders: ["P1"] });
    expect(reg.acquireWrite(B, Y)).toMatchObject({ ok: false, reason: "held", holders: [{ holderID: "P2" }] });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true });
  });

  it("round-trips through a snapshot, and keeps the lease of the integrated holder when complete ones are dropped", () => {
    const { reg } = rig();
    reg.acquireWrite(p1, X);
    reg.acquireWrite(integrated, X);
    const snap: unknown = JSON.parse(JSON.stringify(reg.snapshot()));
    const copy = rig();
    expect(copy.reg.restore(snap)).toEqual({ ok: true, leases: 1 });
    expect(copy.reg.release("P1")).toEqual({ released: 0, retained: 0 });
    expect(copy.reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held", holders: [{ holderID: "P3" }] });
    const dropped = rig();
    expect(dropped.reg.restore(snap, { dropCompleteHolders: true })).toEqual({ ok: true, leases: 1 });
    expect(dropped.reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["P3"]);
    expect(dropped.reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held", holders: [{ holderID: "P3" }] });
  });
});

describe("QA-1.3-21: one file in two worktrees", () => {
  it("records every (physical, tree) pair of an array, in either order", () => {
    for (const paths of [[X, X2], [X2, X]]) {
      const { reg } = rig();
      expect(reg.acquireWrite(A, paths)).toMatchObject({ ok: true, leased: [pick(paths, 0)] });
      const lines = reg.snapshot().leases;
      expect(lines.map((lease) => lease.tree).sort()).toEqual(["/w1", "/w2"]);
      expect(new Set(lines.map((lease) => lease.logical)).size).toBe(1);
      for (const [reader, path] of [[actor(B), X], [actor(C), X2], [actor(B), X2]] as const) {
        expect(reg.checkRead(reader, path)).toMatchObject({ ok: false, reason: "underEdit" });
      }
      expect(reg.checkRun(actor(C), "/w2")).toMatchObject({ ok: true, contaminatedBy: [{ holderID: "A" }] });
    }
  });

  it("adds the second pair to a lease the owner already holds", () => {
    const { reg } = rig();
    reg.acquireWrite(A, X);
    expect(reg.acquireWrite(A, [X, X2])).toMatchObject({ ok: true, leased: [], reentrant: [X] });
    expect(reg.snapshot().leases).toHaveLength(2);
    expect(reg.checkRead(actor(C), X2)).toMatchObject({ ok: false, reason: "underEdit" });
  });
});

describe("QA-1.3-22: a search without an absolute tree", () => {
  it("resolves relative entries against the reader's tree", () => {
    const { reg } = holdingX();
    for (const tree of ["relative/dir", "", undefined, 5]) {
      const result = reg.filterSearchResults(actor(B), tree as unknown as string, ["src/x.ts", "src/y.ts"]);
      expect(result, String(tree)).toMatchObject({ kept: ["src/y.ts"], omitted: 1, holders: [{ holderID: "A" }] });
    }
    expect(reg.filterSearchResults(actor(B), "/w2", ["src/x.ts"])).toMatchObject({ kept: ["src/x.ts"], omitted: 0 });
  });
});

describe("QA-1.3-23/25: relOnDisk", () => {
  it("is the on-disk spelling of the relative path while rel and physical are folded", () => {
    const { seams } = winRig();
    const key = asKey(keyOf("C:\\Repo\\src\\New.TS", "C:\\", seams, "win32"));
    expect(key.rel).toBe("SRC/NEW.TS");
    expect(key.relOnDisk).toBe("src/New.TS");
    expect(key.physical).toBe("C:/REPO/SRC/NEW.TS");
    expect(asKey(keyOf("C:\\Other\\f.ts", "C:\\", seams, "win32")).relOnDisk).toBeNull();
    const linux = asKey(keyOf(X, "/", rig().seams, "linux"));
    expect(linux.rel).toBe("src/x.ts");
    expect(linux.relOnDisk).toBe("src/x.ts");
    expect(asKey(keyOf("/out/src", "/", rig().seams, "linux")).relOnDisk).toBeNull();
  });
});

describe("QA-1.3-26: run checks use the indexes", () => {
  it("keeps the run indexes right across release, sweep, re-acquire and restore", () => {
    const { reg, clock } = rig();
    const contaminated = (): boolean => "contaminatedBy" in reg.checkRun(actor(B), "/w1");
    expect(contaminated()).toBe(false);
    reg.acquireWrite(A, X);
    expect(contaminated()).toBe(true);
    expect(reg.checkRun(actor(B), "/")).toMatchObject({ ok: true, fileCount: 1 });
    reg.release("A");
    expect(contaminated()).toBe(false);
    expect(reg.checkRun(actor(B), "/")).toEqual({ ok: true });
    reg.acquireWrite(A, X);
    clock.now = 1_000 + SIX_H;
    reg.sweep();
    expect(contaminated()).toBe(false);
    expect(reg.checkRun(actor(B), "/")).toEqual({ ok: true });
    clock.now = 1_000;
    reg.acquireWrite(A, [X, "/out/src/o.ts"]);
    const snap: unknown = JSON.parse(JSON.stringify(reg.snapshot()));
    expect(reg.checkRun(actor(B), "/out")).toMatchObject({ fileCount: 1 });
    const other = rig();
    expect(other.reg.restore(snap)).toMatchObject({ ok: true });
    expect(other.reg.checkRun(actor(B), "/out")).toMatchObject({ fileCount: 1 });
    expect(other.reg.checkRun(actor(B), "/w1")).toMatchObject({ fileCount: 1 });
    expect(other.reg.restore({ version: 1, takenAt: 1_000, holders: [], leases: [] })).toMatchObject({ ok: true });
    expect(other.reg.checkRun(actor(B), "/out")).toEqual({ ok: true });
    expect(other.reg.checkRun(actor(B), "/w1")).toEqual({ ok: true });
  });

  it("finds a lease under a run directory by any ancestor, and not a sibling", () => {
    const { reg } = rig();
    reg.acquireWrite(child("S", "/s1"), "/out/src/q.ts");
    for (const dir of ["/", "/out", "/out/src", "/out/src/q.ts"]) {
      expect(reg.checkRun(actor(B), dir), dir).toMatchObject({ ok: true, fileCount: 1 });
    }
    expect(reg.checkRun(actor(B), "/out/sr")).toEqual({ ok: true });
    expect(reg.checkRun(actor(B), "/w2")).toEqual({ ok: true });
  });
});

describe("QA-1.3-29: hostile input never escapes", () => {
  const boom = (): never => {
    throw new Error("boom");
  };
  const hostileObject = (key: string): Record<string, unknown> => {
    const target: Record<string, unknown> = { holderID: "H", tree: "/w1", isChild: true, scope: "until-complete" };
    Object.defineProperty(target, key, { get: boom, enumerable: true });
    return target;
  };
  const revokedProxy = (): object => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    return revocable.proxy;
  };
  const revokedArray = (): string[] => {
    const revocable = Proxy.revocable<string[]>([], {});
    revocable.revoke();
    return revocable.proxy;
  };

  it("answers invalid-holder for a holder or actor with a throwing getter or a revoked Proxy", () => {
    const { reg } = holdingX();
    for (const key of ["holderID", "tree", "isChild", "scope", "taskRef"]) {
      const hostile = hostileObject(key);
      expect(reg.acquireWrite(hostile as unknown as HolderInput, X), key).toMatchObject({ ok: false, reason: "invalid-holder" });
      if (key === "scope") continue; // an actor has no scope: that getter is never read
      expect(reg.checkRead(hostile as unknown as LeaseActor, X), key).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.checkRun(hostile as unknown as LeaseActor, "/w1"), key).toMatchObject({ ok: false, reason: "invalid-holder" });
      expect(reg.filterSearchResults(hostile as unknown as LeaseActor, "/w1", [X]), key).toMatchObject({ kept: [], invalid: expect.any(String) });
    }
    const proxy = revokedProxy();
    expect(reg.acquireWrite(proxy as HolderInput, X)).toMatchObject({ reason: "invalid-holder" });
    expect(reg.checkRead(proxy as LeaseActor, X)).toMatchObject({ reason: "invalid-holder" });
    expect(reg.checkRun(proxy as LeaseActor, "/w1")).toMatchObject({ reason: "invalid-holder" });
    expect(reg.filterSearchResults(proxy as LeaseActor, "/w1", [X])).toMatchObject({ kept: [], invalid: expect.any(String) });
    expect(reg.snapshot().leases).toHaveLength(1);
  });

  it("treats a revoked or throwing path array as an unknown target", () => {
    const { reg } = holdingX();
    expect(reg.acquireWrite(B, revokedArray())).toMatchObject({ ok: false, reason: "unknown-target" });
    const throwing = [Y];
    Object.defineProperty(throwing, 0, { get: boom, enumerable: true });
    expect(reg.acquireWrite(B, throwing)).toMatchObject({ ok: false, reason: "unknown-target" });
    expect(reg.filterSearchResults(actor(B), "/w1", revokedArray())).toMatchObject({ kept: [], invalid: expect.any(String) });
    expect(reg.release(revokedProxy() as unknown as string)).toEqual({ released: 0, retained: 0 });
  });

  it("rejects a snapshot it cannot read and keeps its state", () => {
    const { reg } = holdingX();
    expect(reg.restore(revokedProxy())).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    const snap = { version: 1, takenAt: 1_000, holders: [hostileObject("scope")], leases: [] };
    expect(reg.restore(snap)).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    expect(reg.restore({ version: 1, takenAt: 1_000, holders: revokedArray(), leases: [] })).toMatchObject({ ok: false });
    expect(reg.snapshot().leases).toHaveLength(1);
  });
});

describe("QA-1.3-30: oversize after .. collapse", () => {
  it("counts the segments of the resolved path, not of the input", () => {
    const { seams } = rig();
    const reason = (key: PathKey | Unkeyable): string => ("unkeyable" in key ? key.unkeyable : "keyed");
    expect(reason(keyOf(`/${"a/../".repeat(4_000)}w1/src/x.ts`, "/", seams, "linux"))).toBe("keyed");
    expect(reason(keyOf(`/${"a/".repeat(4_096)}`, "/", seams, "linux"))).toBe("too many path segments");
    expect(reason(keyOf(`/${"a".repeat(32_767)}`, "/", seams, "linux"))).toBe("path too long");
  });
});

describe("QA-1.3-33: restore details", () => {
  const twoHolders = (): ReturnType<typeof rig> => {
    const r = rig();
    r.reg.acquireWrite(A, X);
    return r;
  };

  it("finds a duplicate line in any order, also for a holder that is dropped", () => {
    const snap = twoHolders().reg.snapshot();
    const line = pick(snap.leases, 0);
    const other = { ...line, physical: "/w2/src/x.ts", tree: "/w2" };
    for (const leases of [[line, line], [line, other, line], [other, line, other]]) {
      for (const opts of [undefined, { dropCompleteHolders: true }]) {
        const target = rig();
        expect(target.reg.restore({ ...snap, leases }, opts), JSON.stringify(opts)).toMatchObject({ ok: false, reason: "invalid-snapshot" });
        expect(target.reg.snapshot().leases).toEqual([]);
      }
    }
    expect(rig().reg.restore({ ...snap, leases: [line, other] })).toEqual({ ok: true, leases: 1 });
  });

  it("rejects holders of different owners on one lease", () => {
    const r = rig();
    r.reg.acquireWrite(A, X);
    r.reg.acquireWrite(C, "/w2/src/z.ts");
    const snap = r.reg.snapshot();
    const lineA = pick(snap.leases.filter((lease) => lease.holderID === "A"), 0);
    const clash = { ...lineA, holderID: "C", physical: "/w2/src/x.ts", tree: "/w2" };
    expect(rig().reg.restore({ ...snap, leases: [lineA, clash] })).toMatchObject({ ok: false, reason: "invalid-snapshot" });
  });

  it("requires an x: physical path to be absolute", () => {
    const snap = twoHolders().reg.snapshot();
    const lease = { logical: "x:relative/path", physical: "relative/path", tree: null, holderID: "A", display: "relative/path" };
    expect(rig().reg.restore({ ...snap, leases: [lease] })).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    const absolute = { ...lease, logical: "x:/out/f.ts", physical: "/out/f.ts", display: "/out/f.ts" };
    expect(rig().reg.restore({ ...snap, leases: [absolute] })).toEqual({ ok: true, leases: 1 });
  });

  it("requires the repository of an r: key to be folded", () => {
    const { reg } = winRig();
    reg.acquireWrite(WA, WX);
    const snap = reg.snapshot();
    const line = pick(snap.leases, 0);
    expect(line.logical).toBe(`r:R${NUL}SRC/X.TS`);
    const unfolded = { ...line, logical: `r:r${NUL}SRC/X.TS` };
    expect(winRig().reg.restore({ ...snap, leases: [unfolded] })).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    expect(winRig().reg.restore(snap)).toEqual({ ok: true, leases: 1 });
  });
});

describe("QA-1.3-34: units whose upper case is longer", () => {
  it("folds a unit to its lower case when the upper case is longer than one unit", () => {
    expect(foldKeyPath("\u1fb3", "win32")).toBe("\u1fb3");
    expect(foldKeyPath("\u1fbc", "win32")).toBe("\u1fb3");
    expect(foldKeyPath("C:\\a\u1fb3", "win32")).toBe(foldKeyPath("C:\\A\u1fbc", "win32"));
    expect(foldKeyPath("\u1fb3", "linux")).toBe("\u1fb3");
    expect(foldKeyPath("\u1fbc", "linux")).toBe("\u1fbc");
  });

  it("conflicts two spellings that differ only by such letters", () => {
    const { reg } = winRig();
    expect(reg.acquireWrite(WA, "C:\\Repo\\src\\a\u1fb3.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(WB, "C:\\Repo\\src\\A\u1fbc.TS")).toMatchObject({ ok: false, reason: "held" });
  });
});

describe("DF-1.1-4: write keys per checkout, plan tasks repository-wide", () => {
  const P1 = child("P1", "/w1", { taskRef: "T1", scope: "until-integrated" });
  const P2 = child("P2", "/w2", { taskRef: "T2", scope: "until-integrated" });
  const heldBy = (result: unknown): string | undefined =>
    (result as { holders?: Holder[] }).holders?.[0]?.holderID;

  it("two ordinary children editing one repo-relative path in two worktrees are both allowed", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(child("A", "/w1"), "/w1/src/x.ts")).toMatchObject({ ok: true, leased: ["/w1/src/x.ts"] });
    expect(reg.acquireWrite(child("B", "/w2"), "/w2/src/x.ts")).toMatchObject({ ok: true, leased: ["/w2/src/x.ts"] });
    expect(reg.checkRead({ holderID: "B", tree: "/w2", isChild: true }, "/w2/src/x.ts")).toEqual({ ok: true });
    expect(reg.acquireWrite(child("A", "/w1"), null)).toMatchObject({ ok: true });
  });

  it("keeps every conflict within one checkout", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(child("A", "/w1"), "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("B", "/w1"), "/w1/src/x.ts")).toMatchObject({ ok: false, reason: "held", key: `r:/w1${NUL}src/x.ts` });
    expect(reg.acquireWrite({ holderID: "root", tree: "/w1", isChild: false, scope: "until-complete" }, "/w1/src/x.ts")).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRead({ holderID: "B", tree: "/w1", isChild: true }, "/w1/src/x.ts")).toMatchObject({ ok: false, reason: "underEdit" });
    expect(reg.acquireWrite(child("B", "/w1"), null)).toMatchObject({ ok: false, reason: "unknown-target" });
  });

  it("refuses a plan task the path another plan task holds in another worktree of the repository", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    const second = reg.acquireWrite(P2, "/w2/src/x.ts");
    // QA-PDF13-1: the conflict names the holder's own file (in its checkout), not the requester's copy.
    expect(second).toMatchObject({ ok: false, reason: "held", path: "/w1/src/x.ts", key: `r:/w1${NUL}src/x.ts` });
    expect(heldBy(second)).toBe("P1");
    expect(reg.acquireWrite(P2, null)).toMatchObject({ ok: false, reason: "unknown-target" });
    expect(reg.acquireWrite(P2, "/w2/src/other.ts")).toMatchObject({ ok: true });
    expect(reg.releaseTask("T1").holders).toEqual(["P1"]);
    expect(reg.acquireWrite(P2, "/w2/src/x.ts")).toMatchObject({ ok: true });
  });

  it("a plan task and an ordinary child meet only in one checkout", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("B", "/w2"), "/w2/src/x.ts")).toMatchObject({ ok: true });
    expect(heldBy(reg.acquireWrite(child("C", "/w1"), "/w1/src/x.ts"))).toBe("P1");
    expect(heldBy(reg.acquireWrite(P2, "/w2/src/x.ts"))).toBe("P1");
    expect(reg.acquireWrite(child("B", "/w2"), null)).toMatchObject({ ok: true });
  });

  it("the sessions of one plan task, and plan tasks of another repository, do not conflict", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("P1-retry", "/w2", { taskRef: "T1", scope: "until-integrated" }), "/w2/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("PS", "/s1", { taskRef: "TS", scope: "until-integrated" }), "/s1/src/x.ts")).toMatchObject({ ok: true });
  });

  it("the snapshot keeps the shared repository, and restore validates it", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    const snap = reg.snapshot();
    expect(snap.leases).toEqual([
      { logical: `r:/w1${NUL}src/x.ts`, physical: "/w1/src/x.ts", tree: "/w1", holderID: "P1", display: "/w1/src/x.ts", shared: "R" },
    ]);
    const next = checkoutRig().reg;
    expect(next.restore(snap, { dropCompleteHolders: true })).toEqual({ ok: true, leases: 1 });
    expect(heldBy(next.acquireWrite(P2, "/w2/src/x.ts"))).toBe("P1");
    const line = pick(snap.leases, 0);
    for (const shared of [5, "", "r\\x"]) {
      expect(next.restore({ ...snap, leases: [{ ...line, shared }] })).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    }
    expect(next.restore({ ...snap, leases: [{ logical: `x:/out/src/x.ts`, physical: "/out/src/x.ts", tree: null, holderID: "P1", display: "/out/src/x.ts", shared: "R" }] })).toMatchObject({
      ok: false,
      reason: "invalid-snapshot",
      message: expect.stringContaining("invalid shared repository"),
    });
    const twoShared = { ...snap, holders: [...snap.holders, { ...pick(snap.holders, 0), holderID: "P1b" }] };
    expect(next.restore({ ...twoShared, leases: [line, { ...line, holderID: "P1b", shared: "Q" }] })).toMatchObject({
      ok: false,
      reason: "invalid-snapshot",
      message: expect.stringContaining("two shared repositories"),
    });
  });

  it("QA-PDF13-1: planHolderOf answers the plan-task holder of a repo-relative path in any checkout", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("B", "/w2"), "/w2/src/y.ts")).toMatchObject({ ok: true });
    expect(reg.planHolderOf("/w2", "src/x.ts")?.holderID).toBe("P1");
    expect(reg.planHolderOf("/w1", "/w1/src/x.ts")?.holderID).toBe("P1");
    expect(reg.planHolderOf("/w1", "src/y.ts")).toBeNull(); // only an ordinary child holds it, in /w2
    expect(reg.planHolderOf("/s1", "src/x.ts")).toBeNull(); // another repository
    expect(reg.planHolderOf("/w1", "")).toBeNull();
    expect(reg.planHolderOf("relative", "src/x.ts")).toBeNull();
    expect(reg.releaseTask("T1").holders).toEqual(["P1"]);
    expect(reg.planHolderOf("/w2", "src/x.ts")).toBeNull();
    // A seam without `shared` (one key for the repository) answers the same way.
    const plain = rig().reg;
    expect(plain.acquireWrite(P1, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(plain.planHolderOf("/w2", "src/x.ts")?.holderID).toBe("P1");
  });

  it("QA-PDF13-2: a snapshot from before the fix (no `shared`) is re-keyed to the checkout on restore", () => {
    const old = rig();
    expect(old.reg.acquireWrite(A, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(old.reg.acquireWrite(P2, "/w2/src/y.ts")).toMatchObject({ ok: true });
    const snap = old.reg.snapshot();
    expect(snap.leases.every((lease) => lease.shared === undefined && lease.logical.startsWith(`r:R${NUL}`))).toBe(true);
    const { reg } = checkoutRig();
    expect(reg.restore(snap)).toEqual({ ok: true, leases: 2 });
    expect(heldBy(reg.acquireWrite(child("B", "/w1"), "/w1/src/x.ts"))).toBe("A");
    expect(reg.checkRead({ holderID: "C", tree: "/w1", isChild: true }, "/w1/src/x.ts")).toMatchObject({ ok: false, reason: "underEdit" });
    expect(reg.acquireWrite(child("B", "/w2"), "/w2/src/x.ts")).toMatchObject({ ok: true });
    expect(heldBy(reg.acquireWrite(P1, "/w1/src/y.ts"))).toBe("P2");
    const lines = reg.snapshot().leases;
    expect(lines.find((lease) => lease.holderID === "A")).toMatchObject({ logical: `r:/w1${NUL}src/x.ts`, shared: "R" });
    expect(lines.find((lease) => lease.holderID === "P2")).toMatchObject({ logical: `r:/w2${NUL}src/y.ts`, shared: "R" });
    // The same snapshot restored under a seam without `shared` keeps its keys.
    const same = rig().reg;
    expect(same.restore(snap)).toEqual({ ok: true, leases: 2 });
    expect(same.snapshot().leases.map((lease) => lease.logical)).toEqual(snap.leases.map((lease) => lease.logical));
  });

  it("QA-PDF13-5: a root or a plain child in the home checkout may edit a path a plan task holds in its slot", () => {
    const { reg } = checkoutRig();
    expect(reg.acquireWrite(P2, "/w2/src/x.ts")).toMatchObject({ ok: true });
    const root = { holderID: "root", tree: "/w1", isChild: false, scope: "until-complete" } as const;
    expect(reg.acquireWrite(root, "/w1/src/x.ts")).toMatchObject({ ok: true });
    expect(reg.acquireWrite(child("B", "/w1"), "/w1/src/x.ts")).toMatchObject({ ok: true, leased: ["/w1/src/x.ts"] });
  });
});

describe("the registry has no await", () => {
  it("contains no await in code", () => {
    const source = readFileSync(join(__dirname, "..", "..", "src", "router", "leases.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bawait\b/);
    expect(code).not.toMatch(/\basync\b/);
  });
});
