import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessRisk, isConfigPath, REASONS, MEDIUM_CHANGE_MAX, SMALL_CHANGE_MAX, type RiskInput } from "../../src/verify/risk";
import type { ChangedPath, StaticScoping } from "../../src/verify/runner";

const scopable: StaticScoping = { scopable: true, runner: "vitest", pendingSearches: 0, notes: [] };
const noAffected: StaticScoping = { noAffected: true, note: "none" };
const unverifiable: StaticScoping = { unverifiable: true, reason: "x", code: "no-git-root" };

function files(n: number, prefix = "src/f"): ChangedPath[] {
  return Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.ts`, status: "M" }));
}

function run(over: Partial<RiskInput>): ReturnType<typeof assessRisk> {
  return assessRisk({ changedFiles: files(1), reference: true, producerTier: "medium", scopingPlan: scopable, ...over });
}

describe("assessRisk", () => {
  it("row 1: empty change set is low with the exact reason", () => {
    expect(run({ changedFiles: [], reference: false })).toEqual({ level: "low", reasons: ["no changes attributed"] });
  });

  it("row 2: docs-only is low", () => {
    const r = run({ changedFiles: [{ path: "docs/a.md" }, { path: "README.md" }, { path: "docs\\x\\y.png" }] });
    expect(r).toEqual({ level: "low", reasons: [REASONS.docsOnly] });
  });

  it("rows 3-5: file-count boundaries", () => {
    expect(run({ changedFiles: files(1) })).toEqual({ level: "low", reasons: [REASONS.small] });
    expect(run({ changedFiles: files(SMALL_CHANGE_MAX) }).level).toBe("low");
    expect(run({ changedFiles: files(SMALL_CHANGE_MAX + 1) })).toEqual({ level: "medium", reasons: [REASONS.mediumCount] });
    expect(run({ changedFiles: files(MEDIUM_CHANGE_MAX) }).level).toBe("medium");
    expect(run({ changedFiles: files(MEDIUM_CHANGE_MAX + 1) })).toEqual({ level: "high", reasons: [REASONS.largeCount] });
    expect([SMALL_CHANGE_MAX, MEDIUM_CHANGE_MAX]).toEqual([5, 15]);
  });

  it("row 6: a deleted test file is high", () => {
    for (const path of ["test/unit/a.test.ts", "src/a.spec.tsx", "pkg/test_x.py", "pkg/x_test.py", "src/__tests__/a.js"]) {
      const r = run({ changedFiles: [{ path, status: "D" }] });
      expect(r.level).toBe("high");
      expect(r.reasons).toContain(REASONS.testDeleted);
    }
    expect(run({ changedFiles: [{ path: "test/a.test.ts", status: "deleted" }] }).level).toBe("high");
  });

  it("row 7: a modified test file is medium", () => {
    expect(run({ changedFiles: [{ path: "test/unit/a.test.ts", status: "M" }] })).toEqual({
      level: "medium",
      reasons: [REASONS.small, REASONS.testModified],
    });
  });

  it("row 8: non-test deletion or rename is medium", () => {
    expect(run({ changedFiles: [{ path: "src/a.ts", status: "D" }] })).toEqual({
      level: "medium",
      reasons: [REASONS.small, REASONS.deletedOrRenamed],
    });
    expect(run({ changedFiles: [{ path: "src/b.ts", previousPath: "src/a.ts" }] }).reasons).toContain(REASONS.deletedOrRenamed);
    expect(run({ changedFiles: [{ path: "src/b.ts", status: "R100" }] }).level).toBe("medium");
  });

  it("row 9: config, lock or CI change is at least medium", () => {
    for (const path of [
      "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.build.json",
      "vitest.config.ts", "jest.config.js", "conftest.py", "pyproject.toml", ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
    ]) {
      const r = run({ changedFiles: [{ path, status: "M" }] });
      expect(ORDER(r.level)).toBeGreaterThanOrEqual(1);
      expect(r.reasons).toContain(REASONS.configChanged);
    }
  });

  it("row 10: scoping impossible adds a reason and is medium", () => {
    expect(run({ scopingPlan: unverifiable })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.unverifiable] });
  });

  it("NoAffected adds an informational reason only", () => {
    expect(run({ scopingPlan: noAffected })).toEqual({ level: "low", reasons: [REASONS.small, REASONS.noAffected] });
  });

  it("row 11: fast tier is medium; other tiers do not raise", () => {
    expect(run({ producerTier: "fast" })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.fastTier] });
    expect(run({ producerTier: "heavy" }).level).toBe("low");
  });

  it("row 12: no reference raises one step, capped at high", () => {
    expect(run({ reference: false })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.noReference] });
    expect(run({ reference: false, changedFiles: files(6) }).level).toBe("high");
    expect(run({ reference: false, changedFiles: files(16) })).toEqual({
      level: "high",
      reasons: [REASONS.largeCount, REASONS.noReference],
    });
  });

  it("a destructive change is never low", () => {
    const r = run({ changedFiles: [...files(1), { path: "test/a.test.ts", status: "D" }, { path: ".github/x.yml" }] });
    expect(r.level).toBe("high");
  });

  it("reasons are stable strings", () => {
    expect(REASONS).toEqual({
      empty: "no changes attributed",
      docsOnly: "documentation-only change",
      small: "1-5 files changed",
      mediumCount: "6-15 files changed",
      largeCount: "16 or more files changed",
      testDeleted: "a test file was deleted",
      testModified: "a test file was modified",
      deletedOrRenamed: "files were deleted or renamed",
      configChanged: "config, lock or CI files changed",
      unverifiable: "scoping impossible (S6): the change cannot be verified by scoped tests",
      fullScope: "the full suite runs (scope=full)",
      noAffected: "no affected tests found by static scoping",
      fastTier: "produced by the fast tier",
      noReference: "no reference captured: risk raised one step",
    });
  });

  it("P2e QA-1 #7: a full-scope plan is medium with the neutral reason, never the S6 one", () => {
    const r = run({ changedFiles: files(1), scopingPlan: { fullScope: true } });
    expect(r.level).toBe("medium");
    expect(r.reasons).toContain(REASONS.fullScope);
    expect(r.reasons).not.toContain(REASONS.unverifiable);
  });

  it("QA-1.6-9: absolute paths are classified repo-relative", () => {
    const posix = "/home/u/docs/app";
    const win = "D:\\work\\docs\\app";
    expect(run({ root: posix, changedFiles: [{ path: `${posix}/test/a.test.ts`, status: " D" }] }).level).toBe("high");
    expect(run({ root: win, changedFiles: [{ path: `${win}\\src\\core.ts`, status: " D" }] }).level).toBe("medium");
    expect(run({ root: "d:/work/docs/app", changedFiles: [{ path: `${win}\\src\\core.ts`, status: "D " }] }).reasons).toContain(
      REASONS.deletedOrRenamed,
    );
    const pkg = run({ root: posix, reference: false, changedFiles: [{ path: `${posix}/package.json`, status: " M" }] });
    expect(pkg.level).toBe("high");
    expect(run({ root: "/tmp/test/app", changedFiles: [{ path: "/tmp/test/app/src/a.ts", status: " M" }] })).toEqual({
      level: "low",
      reasons: [REASONS.small],
    });
    expect(run({ root: win, changedFiles: [{ path: `${win}\\docs\\guide.md`, status: " M" }] }).reasons).toEqual([REASONS.docsOnly]);
    // absolute without a usable root is never documentation
    expect(run({ changedFiles: [{ path: "/home/u/docs/a.md" }] }).reasons).not.toContain(REASONS.docsOnly);
    expect(run({ root: "/other", changedFiles: [{ path: "/home/u/docs/a.md" }] }).reasons).not.toContain(REASONS.docsOnly);
  });

  it("QA-1.6-10: docs exclude config/test paths and non-doc types", () => {
    for (const path of ["requirements.txt", "requirements-dev.txt", "CMakeLists.txt", "docs/package.json", "docs/conf.py", "docs/vite.config.ts", "notes.txt", "test/fixtures/a.md"]) {
      expect(run({ changedFiles: [{ path, status: "M" }] }).reasons, path).not.toContain(REASONS.docsOnly);
    }
    for (const path of ["docs/a.txt", "docs/img/x.svg", "guide.adoc", "LICENSE.txt", "pkg/README.mdx"]) {
      expect(run({ changedFiles: [{ path, status: "M" }] }).reasons, path).toEqual([REASONS.docsOnly]);
    }
  });

  it("QA-1.6-11: snapshots count as tests; extended config list", () => {
    for (const path of ["src/__snapshots__/a.test.ts.snap", "x/a.snap"]) {
      expect(run({ changedFiles: [{ path, status: "M" }] })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.testModified] });
    }
    for (const path of [
      "vite.config.ts", "vitest.config.mts", "vitest.workspace.ts", "jest.config.cjs", "vitest.setup.ts", "src/setupTests.js",
      "pytest.ini", "tox.ini", "setup.cfg", "setup.py", "pyproject.toml", "conftest.py", ".gitlab-ci.yml", "Makefile",
      "CMakeLists.txt", "requirements.txt", "requirements-dev.txt",
    ]) {
      expect(run({ changedFiles: [{ path, status: "M" }] }).reasons, path).toContain(REASONS.configChanged);
    }
  });

  it("QA-1.6-12: D or R in either porcelain column counts", () => {
    expect(run({ changedFiles: [{ path: "test/a.test.ts", status: "MD" }] }).level).toBe("high");
    expect(run({ changedFiles: [{ path: "src/a.ts", status: "AD" }] }).reasons).toContain(REASONS.deletedOrRenamed);
    expect(run({ changedFiles: [{ path: "src/a.ts", status: "RM" }] }).reasons).toContain(REASONS.deletedOrRenamed);
    expect(run({ changedFiles: [{ path: "src/a.ts", status: " M" }] }).reasons).toEqual([REASONS.small]);
    expect(run({ changedFiles: [{ path: "src/a.ts", status: "MM" }] }).reasons).toEqual([REASONS.small]);
  });

  it("QA-1.6-13: a test renamed to a non-test path counts as deleted", () => {
    for (const path of ["src/a.ts", "src/a.test.ts.bak"]) {
      const r = run({ changedFiles: [{ path, previousPath: "src/a.test.ts", status: "R " }] });
      expect(r.level).toBe("high");
      expect(r.reasons).toContain(REASONS.testDeleted);
    }
    expect(run({ changedFiles: [{ path: "src/b.test.ts", previousPath: "src/a.test.ts" }] }).reasons).toContain(REASONS.testModified);
  });

  it("QA-1.6-15: duplicate paths are counted once", () => {
    const dup = Array.from({ length: 6 }, () => ({ path: "src/a.ts", status: "M" }));
    expect(run({ changedFiles: dup })).toEqual({ level: "low", reasons: [REASONS.small] });
    const win = Array.from({ length: 6 }, (_, i) => ({ path: i % 2 ? "C:\\r\\src\\A.ts" : "c:/r/src/a.ts" }));
    expect(run({ root: "C:\\r", changedFiles: win }).reasons).toContain(REASONS.small);
  });

  it("QA-1.6-21: setup rule is limited to test-setup conventions and linear", () => {
    for (const p of ["vitest.setup.ts", "src/setupTests.js", "e2e/global-setup.ts", "jest.setup.js", "tests/auth.setup.mts", "globalSetup.cjs", "test-setup.tsx"]) {
      expect(isConfigPath(p)).toBe(true);
    }
    for (const p of ["src/setup.ts", "src/ui/SetupWizard.tsx", "src/hooks/useSetup.ts", "src/server/setupRoutes.js", "lib/teardownAndSetup.mjs"]) {
      expect(isConfigPath(p)).toBe(false);
    }
    const long = `src/${"setup".repeat(20_000)}.ts`;
    const t0 = performance.now();
    isConfigPath(long);
    run({ changedFiles: [{ path: long }] });
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("QA-1.6-23: requirements/*.txt is a dependency manifest", () => {
    expect(isConfigPath("requirements/base.txt")).toBe(true);
    expect(run({ changedFiles: [{ path: "requirements/base.txt" }] }).reasons).toContain(REASONS.configChanged);
    expect(isConfigPath("requirements/sub/notes.txt")).toBe(false);
  });

  it("risk.ts imports nothing with side effects", () => {
    const src = readFileSync(new URL("../../src/verify/risk.ts", import.meta.url), "utf8");
    expect(src.match(/^import .*$/gm)).toEqual(['import type { ChangedPath, StaticScoping } from "./runner";']);
    // QA-1.6-30: comments stripped first; the one allowed type import removed; spaced calls caught.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
      .replace('import type { ChangedPath, StaticScoping } from "./runner";', "");
    expect(code).not.toMatch(
      /child_process|\brequire\s*\(|\bimport\s*\(|\bimport\b|node:|\bprocess\b|\bfetch\b|\bWebSocket\b|\bXMLHttpRequest\b|^\s*export\b.*\bfrom\b|export\s*\*|\bWorker\b|\bEventSource\b|sendBeacon|\bBun\.|\bDeno\./m,
    );
  });

  it("QA-1.6-31: more test-setup and dependency conventions are config", () => {
    for (const p of [
      "src/setup-jest.ts", "jest-setup.js", "vitest-setup.mts", "global-teardown.ts", "e2e/global-teardown.cjs",
      "playwright.config.ts", "requirements.in", "requirements-dev.in", "Pipfile",
    ]) {
      expect(isConfigPath(p)).toBe(true);
    }
    expect(isConfigPath("src/teardown.ts")).toBe(false);
    expect(isConfigPath("src/Pipfile.md")).toBe(false);
  });

  it("QA-1.6-36: requirements/*.in, any-case requirements folder, more setup basenames", () => {
    for (const p of [
      "requirements/base.in", "Requirements/base.txt", "REQUIREMENTS/dev.in", "setupVitest.ts", "setup-vitest.ts",
      "src/testSetup.ts", "globalTeardown.js", "e2e/globalteardown.mjs",
    ]) {
      expect(isConfigPath(p)).toBe(true);
    }
    expect(isConfigPath("src/requirements/notes.md")).toBe(false);
    expect(isConfigPath("setupVitest.json")).toBe(false);
  });

  it("QA-1.6-32: root trailing-slash trim is linear", () => {
    const t0 = performance.now();
    run({ root: `${"/".repeat(1_000_000)}x`, changedFiles: [{ path: "src/a.ts" }] });
    run({ root: `/repo${"/".repeat(1_000_000)}`, changedFiles: [{ path: "/repo/docs/a.md" }] });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

function ORDER(l: string): number {
  return ["low", "medium", "high"].indexOf(l);
}
