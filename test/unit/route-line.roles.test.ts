import { describe, expect, it } from "vitest";
import { parseRouteLine } from "../../src/routing/classify/route-line";

const parse = (text: string, positions: "first" | "any" = "first") => parseRouteLine(text, { positions });

describe("route line roles keys", () => {
  it("parses tier, budget and root", () => {
    const { line } = parse("[route tier=heavy budget=250 root=D:\\git\\omr-rta-p11]\nbody");
    expect(line?.tier).toBe("heavy");
    expect(line?.budget).toBe(250);
    expect(line?.root).toBe("D:\\git\\omr-rta-p11");
    expect(line?.ignored).toEqual([]);
  });

  it("keeps POSIX roots and the case of the path", () => {
    expect(parse("[route root=/Home/Me/Repo]").line?.root).toBe("/Home/Me/Repo");
  });

  it("accepts a quoted root with spaces", () => {
    const { line } = parse('[route class=debug root="D:\\My Work\\Repo" budget=5]');
    expect(line?.root).toBe("D:\\My Work\\Repo");
    expect(line?.budget).toBe(5);
    expect(line?.class).toBe("debug");
  });

  it("ignores invalid values", () => {
    for (const body of ["tier=giant", "tier", "budget=0", "budget=10001", "budget=1.5", "budget=-3", "root=rel\\dir", "root=./x", "root"]) {
      const { line } = parse(`[route ${body}]`);
      const key = body.split("=")[0]!;
      expect(line?.tier).toBeUndefined();
      expect(line?.budget).toBeUndefined();
      expect(line?.root).toBeUndefined();
      expect(line?.ignored).toContain(key);
    }
    expect(parse("[route budget=10000]").line?.budget).toBe(10000);
  });

  it("recognises the keys only on the first line (A22)", () => {
    const text = "hello\n[route tier=fast budget=3 root=/x]\n";
    const r = parse(text);
    expect(r.line).toBeNull();
    expect(r.stripped).toBe(text);
    expect(parse(text, "any").line?.root).toBe("/x");
  });

  it("treats differing roles keys as a conflict", () => {
    const r = parse("[route tier=fast]\n[route tier=heavy]", "any");
    expect(r.conflict).toBe(true);
    expect(r.line?.tier).toBeUndefined();
    expect(r.line?.ignored).toContain("conflict:tier");
  });
});

describe("QA-P12-1-6: work roots are local paths; a malformed first route line is flagged", () => {
  it.each([
    ["UNC", "\\\\host\\share\\repo"],
    ["UNC with forward slashes", "//host/share/repo"],
    ["Win32 file namespace", "\\\\?\\D:\\git\\repo"],
    ["Win32 device namespace", "\\\\.\\D:\\git\\repo"],
    ["parent segment", "D:\\git\\..\\Windows"],
    ["trailing parent segment", "D:\\git\\repo\\.."],
    ["POSIX parent segment", "/home/me/../root"],
    ["POSIX double slash", "//etc/passwd"],
    ["drive-relative", "D:git\\repo"],
  ])("rejects a %s root", (_name, root) => {
    const { line } = parse(`[route root=${root}]`);
    expect(line?.root).toBeUndefined();
    expect(line?.ignored).toContain("root");
    expect(parse(`[route root="${root}"]`).line?.root).toBeUndefined();
  });

  it("keeps drive-absolute and POSIX roots, including dotted names that are not `..` segments", () => {
    for (const root of ["D:\\git\\omr-rta-p12", "D:/git/omr-rta-p12", "/x", "/home/me/repo..old", "D:\\git\\.hidden\\..x"]) {
      expect(parse(`[route root=${root}]`).line?.root).toBe(root);
    }
  });

  it("flags a first line that starts like a route line but does not parse; the line stays text", () => {
    for (const text of ["[route class=debug\nbody", "[route root=D:\\a]b]\nbody", `[route ${"x".repeat(600)}]\nbody`, "  [route tier=heavy\nbody"]) {
      const r = parse(text);
      expect(r.line).toBeNull();
      expect(r.count).toBe(0);
      expect(r.malformed).toBe(true);
      expect(r.stripped).toBe(text);
    }
  });

  it("adds `malformed` to the ignored list of a route line parsed elsewhere", () => {
    const r = parse("[route class=debug\nbody\n[route tier=heavy]", "any");
    expect(r.line?.tier).toBe("heavy");
    expect(r.line?.ignored).toEqual(["malformed"]);
    expect(r.malformed).toBe(true);
  });

  it("does not flag other tags, valid lines, fenced or indented text, or a [route mention after the first line", () => {
    for (const text of [
      "[router ✓ verified: ok]\nbody",
      "[routes are fun\nbody",
      "[route tier=fast]\nbody",
      "[route]\nbody",
      "```\n[route class=debug\n```",
      "    [route class=debug\nbody",
      "body\n[route class=debug",
      "no route here",
    ]) {
      expect(parse(text).malformed).toBeUndefined();
      expect(parse(text, "any").malformed).toBeUndefined();
    }
  });
});
