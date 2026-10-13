import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveCheckPlacements } from "../../src/routing/roles/check-placement";
import { canonicalAuthorityPath, captureRootOf, insideWorkRoot, verificationScope } from "../../src/routing/roles/work-root";
import type { Check, DoD } from "../../src/verify/dod";

const dodOf = (checks: Check[]): DoD => ({ kind: "deterministic", checks, criteria: [], deliverable: null, source: "explicit" });

// base/w (a repository, the work root W) with w/pkg, w/my-library~2 and w/vendor (a nested repository inside W); base/other
// (another repository in R) with other/sub; base/lib (a repository next to W); base/outside (no repository of its own).
let base = "";
let w = "";
let other = "";
let lib = "";
let outside = "";

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "placement-")));
  w = join(base, "w");
  other = join(base, "other");
  lib = join(base, "lib");
  outside = join(base, "outside");
  const dirs = [join(w, ".git"), join(w, "pkg"), join(w, "my-library~2"), join(w, "vendor", ".git")];
  for (const dir of [...dirs, join(other, ".git"), join(other, "sub"), join(lib, ".git"), outside]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const insideOther = (p: string): boolean => insideWorkRoot(p, other);

describe("resolveCheckPlacements (cross-repo P2.2)", () => {
  it("is inert for a tier scope (no work root)", () => {
    const dod = dodOf([{ kind: "run", command: "npm test", cwd: "pkg", scope: "full" }]);
    expect(resolveCheckPlacements(dod, verificationScope(undefined, undefined))).toEqual({});
    expect(resolveCheckPlacements(dod, verificationScope(w, undefined), { inReadSet: () => true })).toEqual({});
  });

  it("is inert when no check has a per-check key", () => {
    const scope = verificationScope(undefined, w);
    expect(resolveCheckPlacements(dodOf([]), scope)).toEqual({});
    expect(resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test" }, { kind: "fileExists", path: "x" }]), scope)).toEqual({});
  });

  it("resolves a relative cwd inside W to its canonical directory, not foreign", () => {
    const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: "pkg" }]), verificationScope(undefined, w));
    expect(result).toEqual({ placements: [{ cwd: join(w, "pkg"), top: w, foreign: false }] });
  });

  it("refuses a relative cwd that leaves W (`../lib`) even when the read set holds it", () => {
    const inReadSet = vi.fn(() => true);
    const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd: "../lib" }]), verificationScope(undefined, w), {
      inReadSet,
    });
    expect(result).toEqual({ refused: { index: 0, kind: "run", text: "../lib", why: "outside" } });
    expect(result.placements).toBeUndefined();
    expect(inReadSet).not.toHaveBeenCalled();
  });

  it("places an absolute cwd in another repository of the read set as foreign, top = that repository", () => {
    const inReadSet = vi.fn(insideOther);
    const sub = join(other, "sub");
    const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: sub }]), verificationScope(undefined, w), { inReadSet });
    expect(result).toEqual({ placements: [{ cwd: sub, top: other, foreign: true }] });
    expect(inReadSet).toHaveBeenCalledWith(sub);
  });

  it("compares tops like the old `/\\/+$/` normalisation on short inputs (CodeQL js/polynomial-redos)", () => {
    const oldKey = (top: string): string => {
      const normalized = top.replace(/\\/g, "/").replace(/\/+$/, "");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    const sub = join(other, "sub");
    const variants = [w, `${w}/`, `${w}///`, `${w}\\\\`, `${w}/x`, `/${w}`, other, `${other}//`];
    for (const variant of variants) {
      const topOf = (dir: string): string | undefined => (dir === w ? w : variant);
      const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: sub }]), verificationScope(undefined, w), { inReadSet: insideOther, topOf });
      expect(result, variant).toEqual({ placements: [{ cwd: sub, top: variant, foreign: oldKey(variant) !== oldKey(w) }] });
    }
  });

  it("compares a top with 100 000 trailing '/' fast (no polynomial backtracking)", () => {
    const sub = join(other, "sub");
    const run = "/".repeat(100_000);
    const started = performance.now();
    for (const top of [`${w}${run}`, `${w}${run}x`]) {
      const topOf = (dir: string): string | undefined => (dir === w ? w : top);
      const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: sub }]), verificationScope(undefined, w), { inReadSet: insideOther, topOf });
      expect(result.placements?.[0]?.foreign).toBe(top.endsWith("x"));
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses an absolute cwd outside W and outside the read set", () => {
    const inReadSet = vi.fn(insideOther);
    const result = resolveCheckPlacements(dodOf([{ kind: "buildPasses", cwd: outside }]), verificationScope(undefined, w), { inReadSet });
    expect(result).toEqual({ refused: { index: 0, kind: "buildPasses", text: outside, why: "outside" } });
    expect(inReadSet).toHaveBeenCalledWith(outside);
  });

  // QA round 1 #7: the 8.3 case `D:\PROGRA~1\x` moved out of this cross-platform list on purpose; it is a win32-only refusal now
  // (see the two short-name tests below).
  it("refuses UNC and `.git` paths before any filesystem probe, read-set or top lookup", () => {
    const inReadSet = vi.fn(() => true);
    const topOf = vi.fn(() => w);
    const canonical = vi.fn(canonicalAuthorityPath);
    for (const cwd of ["\\\\server\\share\\x", "//server/share/x", join(other, ".git", "hooks"), join(w, ".git"), join(w, ".GIT")]) {
      const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd }]), verificationScope(undefined, w), {
        inReadSet,
        topOf,
        canonical,
      });
      expect(result).toEqual({ refused: { index: 0, kind: "run", text: cwd, why: "outside" } });
    }
    expect(inReadSet).not.toHaveBeenCalled();
    expect(topOf).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it("refuses trailing-dot/space `.git` variants (`.git.`, `.git `) before any filesystem probe (QA round 1 #6)", () => {
    const inReadSet = vi.fn(() => true);
    const topOf = vi.fn(() => w);
    const canonical = vi.fn(canonicalAuthorityPath);
    const cwds = [".git.", ".git ", ".GIT..", ".git. ", "pkg/.git./x", join(w, ".git."), join(w, ".git ", "hooks"), join(other, ".Git.", "hooks")];
    for (const cwd of cwds) {
      const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd }]), verificationScope(undefined, w), {
        inReadSet,
        topOf,
        canonical,
      });
      expect(result).toEqual({ refused: { index: 0, kind: "run", text: cwd, why: "outside" } });
    }
    expect(inReadSet).not.toHaveBeenCalled();
    expect(topOf).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it("refuses a cwd whose CANONICAL path has a `.git` segment, before the read set or any top lookup (QA round 1 #6)", () => {
    const inReadSet = vi.fn(() => true);
    const topOf = vi.fn(() => w);
    const cases: [string, string][] = [
      ["pkg", join(w, ".git")],
      ["pkg", join(w, ".GIT", "hooks")],
      [join(other, "sub"), join(other, ".git")],
    ];
    for (const [cwd, canonicalPath] of cases) {
      const canonical = vi.fn(() => canonicalPath);
      const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd }]), verificationScope(undefined, w), {
        inReadSet,
        topOf,
        canonical,
      });
      expect(result).toEqual({ refused: { index: 0, kind: "run", text: cwd, why: "outside" } });
      expect(canonical).toHaveBeenCalledTimes(1);
    }
    expect(inReadSet).not.toHaveBeenCalled();
    expect(topOf).not.toHaveBeenCalled();
  });

  it("accepts `~<digit>` in a long segment (`my-library~2`) inside W on every platform (QA round 1 #7)", () => {
    const lib2 = join(w, "my-library~2");
    const scope = verificationScope(undefined, w);
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: "my-library~2" }]), scope)).toEqual({
      placements: [{ cwd: lib2, top: w, foreign: false }],
    });
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: lib2 }]), scope)).toEqual({
      placements: [{ cwd: lib2, top: w, foreign: false }],
    });
  });

  it.runIf(process.platform === "win32")("refuses an 8.3 short-name segment on win32 before any filesystem probe (QA round 1 #7)", () => {
    const inReadSet = vi.fn(() => true);
    const topOf = vi.fn(() => w);
    const canonical = vi.fn(canonicalAuthorityPath);
    for (const cwd of ["D:\\PROGRA~1\\x", "PROGRA~1", "backup~1", "pkg\\MARQUI~1.TXT", join(w, "BACKUP~1", "x")]) {
      const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd }]), verificationScope(undefined, w), {
        inReadSet,
        topOf,
        canonical,
      });
      expect(result).toEqual({ refused: { index: 0, kind: "run", text: cwd, why: "outside" } });
    }
    expect(inReadSet).not.toHaveBeenCalled();
    expect(topOf).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("does not refuse a `~<digit>` segment lexically off win32 (QA round 1 #7)", () => {
    const topOf = vi.fn(() => w);
    for (const cwd of ["D:\\PROGRA~1\\x", "backup~1"]) {
      const canonical = vi.fn(canonicalAuthorityPath);
      const result = resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd }]), verificationScope(undefined, w), {
        topOf,
        canonical,
      });
      expect(canonical).toHaveBeenCalledWith(cwd, w);
      expect(result).toEqual({ placements: [{ cwd: join(w, cwd), top: w, foreign: false }] });
    }
  });

  it("normalizes `scope=` case-insensitively", () => {
    const result = resolveCheckPlacements(
      dodOf([{ kind: "testsPass", scope: "FULL" }, { kind: "lintClean", scope: "Affected" }]),
      verificationScope(undefined, w),
    );
    expect(result).toEqual({
      placements: [
        { cwd: w, top: w, foreign: false, scope: "full" },
        { cwd: w, top: w, foreign: false, scope: "affected" },
      ],
    });
  });

  it("refuses an unknown `scope=`; the first offending check in index order wins", () => {
    const scope = verificationScope(undefined, w);
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", scope: "all" }]), scope)).toEqual({
      refused: { index: 0, kind: "testsPass", text: "all", why: "scope" },
    });
    const topOf = vi.fn(() => w);
    const result = resolveCheckPlacements(
      dodOf([{ kind: "run", command: "npm test", cwd: "pkg" }, { kind: "testsPass", scope: "everything" }, { kind: "run", command: "x", cwd: "../lib" }]),
      scope,
      { topOf },
    );
    expect(result).toEqual({ refused: { index: 1, kind: "testsPass", text: "everything", why: "scope" } });
    expect(topOf).not.toHaveBeenCalled();
  });

  it("places a check with only `scope=` at the block base, not foreign", () => {
    const scope = verificationScope("pkg", w);
    expect(scope.cwd).toBe(join(w, "pkg"));
    const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", scope: "affected" }]), scope);
    expect(result).toEqual({ placements: [{ cwd: join(w, "pkg"), top: w, foreign: false, scope: "affected" }] });
  });

  it("allows only roots inside W without a read-set predicate", () => {
    const scope = verificationScope(undefined, w);
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: join(other, "sub") }]), scope)).toEqual({
      refused: { index: 0, kind: "testsPass", text: join(other, "sub"), why: "outside" },
    });
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: join(w, "pkg") }]), scope)).toEqual({
      placements: [{ cwd: join(w, "pkg"), top: w, foreign: false }],
    });
  });

  it("keeps placements index-aligned with `dod.checks`, with undefined holes", () => {
    const result = resolveCheckPlacements(
      dodOf([
        { kind: "run", command: "npm test" },
        { kind: "testsPass", cwd: "pkg" },
        { kind: "fileExists", path: "x" },
        { kind: "testsPass", cwd: join(other, "sub"), scope: "full" },
      ]),
      verificationScope(undefined, w),
      { inReadSet: insideOther },
    );
    expect(result.refused).toBeUndefined();
    expect(result.placements).toHaveLength(4);
    expect(result.placements).toEqual([
      undefined,
      { cwd: join(w, "pkg"), top: w, foreign: false },
      undefined,
      { cwd: join(other, "sub"), top: other, foreign: true, scope: "full" },
    ]);
  });

  it("treats an unknown top outside W as foreign", () => {
    const topOf = vi.fn((dir: string) => (insideWorkRoot(dir, w) ? w : undefined));
    const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: outside }]), verificationScope(undefined, w), {
      inReadSet: () => true,
      topOf,
    });
    expect(result).toEqual({ placements: [{ cwd: outside, top: undefined, foreign: true }] });
  });

  it("never makes a cwd inside W foreign, even below a nested `.git`; its own top is still reported (QA round 1 #8)", () => {
    const pkg = join(w, "pkg");
    const scope = verificationScope(undefined, w);
    const nested = vi.fn((dir: string) => (dir === pkg ? pkg : w));
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: "pkg" }]), scope, { topOf: nested })).toEqual({
      placements: [{ cwd: pkg, top: pkg, foreign: false }],
    });
    const unknown = vi.fn((dir: string) => (dir === w ? w : undefined));
    expect(resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: "pkg" }]), scope, { topOf: unknown })).toEqual({
      placements: [{ cwd: pkg, top: undefined, foreign: false }],
    });
    // On disk: w/vendor holds its own `.git` (a vendored repository).
    const vendor = join(w, "vendor");
    expect(resolveCheckPlacements(dodOf([{ kind: "run", command: "npm test", cwd: "vendor", scope: "full" }]), scope)).toEqual({
      placements: [{ cwd: vendor, top: vendor, foreign: false, scope: "full" }],
    });
  });

  // QA round 1 #8 changed this case on purpose: a cwd inside W is never foreign now, so the comparison is exercised on a
  // placement outside W (in the read set) instead of `pkg`.
  it.runIf(process.platform === "win32")("compares tops case-insensitively with normalized separators on win32", () => {
    const sub = join(other, "sub");
    const topOf = (dir: string): string => (dir === w ? w : `${w.toUpperCase().replace(/\\/g, "/")}/`);
    const result = resolveCheckPlacements(dodOf([{ kind: "testsPass", cwd: sub }]), verificationScope(undefined, w), {
      topOf,
      inReadSet: insideOther,
    });
    expect(result.placements?.[0]).toMatchObject({ cwd: sub, foreign: false });
  });
});

describe("captureRootOf", () => {
  it("is the work root of a role scope, even with a block `cwd:` subdirectory", () => {
    const scope = verificationScope("pkg", w);
    expect(scope.cwd).toBe(join(w, "pkg"));
    expect(captureRootOf(scope)).toBe(w);
    expect(captureRootOf(verificationScope(undefined, w))).toBe(w);
  });

  it("is the cwd of a tier scope", () => {
    expect(captureRootOf(verificationScope("/elsewhere", undefined))).toBe("/elsewhere");
    expect(captureRootOf(verificationScope(undefined, undefined))).toBeUndefined();
  });

  it("is the work root of an outside (refused) scope", () => {
    const scope = verificationScope(outside, w);
    expect(scope.outside).toBe(true);
    expect(captureRootOf(scope)).toBe(w);
  });
});
