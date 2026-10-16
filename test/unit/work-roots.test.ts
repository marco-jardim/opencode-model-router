// DF-1-1: a location outside every configured `routing.workRoots` entry is not the plan's; unset or empty work roots never
// make a location "outside" (nothing changes for a user without them).
import { describe, expect, it } from "vitest";
import { locationOutsideWorkRoots } from "../../src/router/work-roots";
import { canonicalAuthorityPath } from "../../src/routing/roles/work-root";

describe("G-18 canonicalAuthorityPath trailing separators", () => {
  it.each<{ platform: NodeJS.Platform; base: string; expected: string }>([
    { platform: "linux", base: "/work", expected: "/work/child" },
    { platform: "linux", base: "/work/\\/", expected: "/work/child" },
    { platform: "linux", base: "/", expected: "/child" },
    { platform: "win32", base: "C:\\", expected: "C:\\child" },
    { platform: "win32", base: "C:/", expected: "C:\\child" },
    { platform: "win32", base: "C:\\work\\/\\/", expected: "C:\\work\\child" },
    { platform: "win32", base: "C:\\link\\..\\work\\/", expected: "C:\\link\\..\\work\\child" },
  ])("trims trailing separators from $base on $platform without normalising the base", ({ platform, base, expected }) => {
    expect(canonicalAuthorityPath("child", base, { platform, realpath: path => path })).toBe(expected);
  });

  it("trims a 100,000-character run of trailing separators but preserves an interior run", () => {
    const separators = "/\\".repeat(50_000);
    const opts = { platform: "linux" as const, realpath: (path: string) => path };
    expect(canonicalAuthorityPath("child", `/work${separators}`, opts)).toBe("/work/child");
    const base = `/work${separators}nested`;
    expect(canonicalAuthorityPath("child", base, opts)).toBe(`${base}/child`);
  });
});

describe("DF-1-1 locationOutsideWorkRoots", () => {
  it("DF-1-1 unset or empty work roots: never outside", () => {
    expect(locationOutsideWorkRoots("D:\\git\\anything", undefined, "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\anything", [], "win32")).toBe(false);
    expect(locationOutsideWorkRoots("/home/u/anything", [], "linux")).toBe(false);
  });

  it("DF-1-1 a plain root contains itself and its descendants, never a sibling with the same prefix", () => {
    const roots = ["D:\\git\\omr-cpx-pdf1-1"];
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-pdf1-1", roots, "win32")).toBe(false);
    expect(locationOutsideWorkRoots("d:/GIT/omr-cpx-pdf1-1/src", roots, "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-pdf1-10", roots, "win32")).toBe(true);
    expect(locationOutsideWorkRoots("D:\\git\\opencode-model-router", roots, "win32")).toBe(true);
    expect(locationOutsideWorkRoots("/home/u/Repo", ["/home/u/repo"], "linux")).toBe(true);
  });

  it("DF-1-1 a glob root: `*` and `**` match across segments", () => {
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-scratch", ["D:\\git\\omr-cpx-*"], "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-scratch\\deep\\dir", ["D:\\git\\omr-cpx-*"], "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\opencode-model-router", ["D:\\git\\omr-cpx-*"], "win32")).toBe(true);
    expect(locationOutsideWorkRoots("/srv/a/b/work", ["/srv/**/work"], "linux")).toBe(false);
    expect(locationOutsideWorkRoots("/srv/a/b/play", ["/srv/**/work"], "linux")).toBe(true);
  });
});

/** A realpath that resolves nothing: every path is used as written. */
const unresolved = (path: string): string => {
  throw new Error(`ENOENT: ${path}`);
};

describe("QA-DF1-25 the workRoots matcher follows the documented glob semantics", () => {
  it("QA-DF1-25 `*` crosses separators (as the host matches the external_directory rule)", () => {
    expect(locationOutsideWorkRoots("D:\\git\\a\\b\\work", ["D:/git/*/work"], "win32", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/a/b/work", ["/srv/*/work"], "linux", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/a/b/play", ["/srv/*/work"], "linux", unresolved)).toBe(true);
    // The documented over-match: `D:/git/omr-rta-*` takes every directory that starts with `omr-rta-`, nested ones too.
    expect(locationOutsideWorkRoots("D:\\git\\omr-rta-evil\\x", ["D:/git/omr-rta-*"], "win32", unresolved)).toBe(false);
  });

  it("QA-DF1-25 `?` is one character", () => {
    expect(locationOutsideWorkRoots("/srv/wt-1", ["/srv/wt-?"], "linux", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/wt-1/deep", ["/srv/wt-?"], "linux", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/wt-10", ["/srv/wt-?"], "linux", unresolved)).toBe(true);
  });

  it("QA-DF1-25 `[`, `]`, `{` and `}` are literal in the match and cut the static prefix", () => {
    expect(locationOutsideWorkRoots("/srv/wt[1]", ["/srv/wt[1]"], "linux", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/wt1", ["/srv/wt[1]"], "linux", unresolved)).toBe(true);
    expect(locationOutsideWorkRoots("/srv/{a,b}/x", ["/srv/{a,b}"], "linux", unresolved)).toBe(false);
    expect(locationOutsideWorkRoots("/srv/a", ["/srv/{a,b}"], "linux", unresolved)).toBe(true);
    // The static directory before `[` is resolved, the tail kept verbatim.
    const realpath = (path: string): string => {
      if (path === "/alias/") return "/srv";
      throw new Error(`ENOENT: ${path}`);
    };
    expect(locationOutsideWorkRoots("/srv/wt[1]", ["/alias/wt[1]"], "linux", realpath)).toBe(false);
  });

  it("QA-DF1-25 the location and the entry's static directory are realpath-resolved", () => {
    const links: Record<string, string> = { "D:\\link\\wt": "D:\\git\\wt-1", "D:/alias/": "D:\\git", "D:/alias/repo": "D:\\git\\repo" };
    const realpath = (path: string): string => {
      const hit = links[path];
      if (hit === undefined) throw new Error(`ENOENT: ${path}`);
      return hit;
    };
    // A junction into a work root is inside it; the same spelling unresolved is not.
    expect(locationOutsideWorkRoots("D:\\link\\wt", ["D:/git/wt-*"], "win32", realpath)).toBe(false);
    expect(locationOutsideWorkRoots("D:\\link\\wt", ["D:/git/wt-*"], "win32", unresolved)).toBe(true);
    // An entry whose static directory is an alias matches the canonical location.
    expect(locationOutsideWorkRoots("D:\\git\\wt-2", ["D:/alias/wt-*"], "win32", realpath)).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\repo\\src", ["D:/alias/repo"], "win32", realpath)).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\wt-2", ["D:/alias/wt-*"], "win32", unresolved)).toBe(true);
  });
});
