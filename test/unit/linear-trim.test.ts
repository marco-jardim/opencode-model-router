import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { gitMetadataSegment } from "../../src/routing/roles/read-set";
import { isPathSeparator, isSlash, trimEndWhile, trimStartWhile } from "../../src/util/linear-trim";
import { depthBelow, perimeterKey } from "../../src/verify/git-top";

const LONG = 100_000;

function isSpace(char: string): boolean {
  return char === " ";
}

describe("linear-trim", () => {
  describe("trimEndWhile", () => {
    it("matches the old `/\\/+$/` regex on short inputs", () => {
      const inputs = ["", "/", "//", "a", "a/", "a//", "/a", "/a/", "a/b", "a/b///", "///a///", "a\\", "a/\\/"];
      for (const input of inputs) {
        expect(trimEndWhile(input, isSlash), input).toBe(input.replace(/\/+$/, ""));
      }
    });

    it("matches the old `/[\\\\/]+$/` regex for path separators on short inputs", () => {
      const inputs = ["", "/", "\\", "a\\/", "a/\\b", "C:\\x\\\\", "\\\\srv\\share\\", "a"];
      for (const input of inputs) {
        expect(trimEndWhile(input, isPathSeparator), input).toBe(input.replace(/[\\/]+$/, ""));
      }
    });

    it("returns the same string when nothing is trimmed", () => {
      const value = "abc";
      expect(trimEndWhile(value, isSlash)).toBe(value);
    });

    it(`completes fast on ${LONG} repeated "/" not at the end`, () => {
      const input = `${"/".repeat(LONG)}x`;
      const started = performance.now();
      expect(trimEndWhile(input, isSlash)).toBe(input);
      expect(trimEndWhile("/".repeat(LONG), isSlash)).toBe("");
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it(`completes fast on ${LONG} repeated " "`, () => {
      const input = `${" ".repeat(LONG)}x`;
      const started = performance.now();
      expect(trimEndWhile(input, isSpace)).toBe(input);
      expect(trimEndWhile(`x${" ".repeat(LONG)}`, isSpace)).toBe("x");
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("trimStartWhile", () => {
    it("matches the old `/^\\/+/` regex on short inputs", () => {
      const inputs = ["", "/", "//", "a", "/a", "//a/", "a/", "/a/b"];
      for (const input of inputs) {
        expect(trimStartWhile(input, isSlash), input).toBe(input.replace(/^\/+/, ""));
      }
    });

    it(`completes fast on ${LONG} repeated "/" and " "`, () => {
      const started = performance.now();
      expect(trimStartWhile(`${"/".repeat(LONG)}x`, isSlash)).toBe("x");
      expect(trimStartWhile(`x${" ".repeat(LONG)}`, isSpace)).toBe(`x${" ".repeat(LONG)}`);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("callers (CodeQL js/polynomial-redos rewrites)", () => {
    it("git-top perimeterKey matches the old regex normalisation on short inputs", () => {
      const oldKey = (at: string): string => {
        const normalized = path.resolve(at).replace(/\\/g, "/").replace(/\/+$/, "");
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      };
      const inputs = ["/", "/repo", "/repo/", "/repo///", "/Repo/Sub", "repo/x/", ".", "C:\\Work\\Repo\\", "C:/"];
      for (const input of inputs) {
        expect(perimeterKey(input), input).toBe(oldKey(input));
      }
      expect(depthBelow("/repo/a/b", "/repo")).toBe(2);
      expect(depthBelow("/repo", "/repo/")).toBe(0);
      expect(depthBelow("/other", "/repo")).toBe(-1);
    });

    it(`git-top perimeterKey and depthBelow complete fast on ${LONG} repeated "/"`, () => {
      const run = "/".repeat(LONG);
      const started = performance.now();
      expect(perimeterKey(`/repo${run}x`)).toBe(perimeterKey("/repo/x"));
      expect(depthBelow(`/repo${run}`, "/repo")).toBe(0);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("read-set gitMetadataSegment matches the old regex on short inputs", () => {
      const oldSegment = (segment: string): boolean =>
        segment.replace(/:.*$/s, "").replace(/[. ]+$/, "").toLowerCase() === ".git";
      const inputs = [
        ".git", ".GIT", ".git.", ".git ", ".git. .", ".git::$INDEX_ALLOCATION", ".git:x:y", ".git:\nz", "git", ".gi",
        "..git", " .git", ".git.x", "", ":", ".", " ", "x:.git", ".git\t", ".git. a",
      ];
      for (const input of inputs) {
        expect(gitMetadataSegment(input), JSON.stringify(input)).toBe(oldSegment(input));
      }
    });

    it(`read-set gitMetadataSegment completes fast on ${LONG} repeated " " or "."`, () => {
      const started = performance.now();
      expect(gitMetadataSegment(`.git${" ".repeat(LONG)}`)).toBe(true);
      expect(gitMetadataSegment(`.git${" ".repeat(LONG)}x`)).toBe(false);
      expect(gitMetadataSegment(`.git${".".repeat(LONG)}x`)).toBe(false);
      expect(gitMetadataSegment(`${". ".repeat(LONG)}:`)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("predicates", () => {
    it("isPathSeparator accepts only / and \\", () => {
      expect(isPathSeparator("/")).toBe(true);
      expect(isPathSeparator("\\")).toBe(true);
      expect(isPathSeparator(":")).toBe(false);
      expect(isPathSeparator("a")).toBe(false);
    });

    it("isSlash accepts only /", () => {
      expect(isSlash("/")).toBe(true);
      expect(isSlash("\\")).toBe(false);
    });
  });
});
