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
