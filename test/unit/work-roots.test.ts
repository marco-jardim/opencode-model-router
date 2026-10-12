// DF-1-1: a location outside every configured `routing.workRoots` entry is not the plan's; unset or empty work roots never
// make a location "outside" (nothing changes for a user without them).
import { describe, expect, it } from "vitest";
import { locationOutsideWorkRoots } from "../../src/router/work-roots";

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

  it("DF-1-1 a glob root: `*` within one segment, `**` across segments", () => {
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-scratch", ["D:\\git\\omr-cpx-*"], "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\omr-cpx-scratch\\deep\\dir", ["D:\\git\\omr-cpx-*"], "win32")).toBe(false);
    expect(locationOutsideWorkRoots("D:\\git\\opencode-model-router", ["D:\\git\\omr-cpx-*"], "win32")).toBe(true);
    expect(locationOutsideWorkRoots("/srv/a/b/work", ["/srv/**/work"], "linux")).toBe(false);
    expect(locationOutsideWorkRoots("/srv/a/b/play", ["/srv/**/work"], "linux")).toBe(true);
  });
});
