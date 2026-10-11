import { describe, expect, it } from "vitest";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import { pinOf, pinTarget, samePin } from "../../src/verify/pin";
import type { LinkPin } from "../../src/verify/pin";

function snap(root: string, over: Partial<TreeSnapshot> = {}): TreeSnapshot {
  return { cwd: root, root, head: "h1", fingerprint: "f1", dirty: false, files: [], ignored: "i1", ...over };
}

function pinned(pin: LinkPin): Extract<LinkPin, { kind: "pinned" }> {
  if (pin.kind !== "pinned") throw new Error(`expected pinned, got ${pin.why}`);
  return pin;
}

describe("pinOf", () => {
  it("pins an admitted, observed snapshot with an ignored digest", () => {
    const pin = pinOf("/r/a", snap("/r/a"), true);
    expect(pin).toEqual({ kind: "pinned", root: "/r/a", head: "h1", fingerprint: "f1", ignored: "i1", nested: [] });
  });

  it("is unpinnable not-admitted when the target is not admitted", () => {
    expect(pinOf("/r/a", snap("/r/a"), false)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-admitted" });
  });

  it("is unpinnable not-observed without a snapshot", () => {
    expect(pinOf("/r/a", undefined, true)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-observed" });
  });

  it("is unpinnable not-git when the snapshot has no root", () => {
    expect(pinOf("/r/a", snap("/r/a", { root: undefined }), true)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-git" });
  });

  it("is unpinnable over-bounds when the ignored digest is over its bounds", () => {
    expect(pinOf("/r/a", snap("/r/a", { ignored: "over-bounds" }), true)).toEqual({ kind: "unpinnable", root: "/r/a", why: "over-bounds" });
  });

  it("is unpinnable not-observed when the ignored digest is absent", () => {
    expect(pinOf("/r/a", snap("/r/a", { ignored: undefined }), true)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-observed" });
  });
});

describe("samePin", () => {
  const base = (): LinkPin => pinOf("/r/a", snap("/r/a"), true);

  it("is true for the same snapshot", () => {
    expect(samePin(base(), base())).toBe(true);
  });

  it("is false when the head changes", () => {
    expect(samePin(base(), pinOf("/r/a", snap("/r/a", { head: "h2" }), true))).toBe(false);
  });

  it("is false when the fingerprint changes", () => {
    expect(samePin(base(), pinOf("/r/a", snap("/r/a", { fingerprint: "f2" }), true))).toBe(false);
  });

  it("is false when the ignored digest changes", () => {
    expect(samePin(base(), pinOf("/r/a", snap("/r/a", { ignored: "i2" }), true))).toBe(false);
  });

  it("is false when either side is unpinnable", () => {
    const bad = pinOf("/r/a", undefined, true);
    expect(samePin(bad, bad)).toBe(false);
    expect(samePin(base(), bad)).toBe(false);
    expect(samePin(bad, base())).toBe(false);
  });

  it("is false for different roots", () => {
    expect(samePin(base(), pinOf("/r/b", snap("/r/b"), true))).toBe(false);
  });

  it("compares root keys with normalised separators, case-insensitively on win32", () => {
    const a = pinOf("/r/Repo", snap("/r/Repo"), true);
    const b = pinOf("/r/repo/", snap("/r/repo"), true);
    expect(samePin(a, b)).toBe(process.platform === "win32");
    const c = pinOf("/r//Repo", snap("/r/Repo"), true);
    expect(samePin(a, c)).toBe(true);
  });

  it("compares nested pins independent of order, and by count", () => {
    const x = pinOf("/r/x", snap("/r/x"), true);
    const y = pinOf("/r/y", snap("/r/y"), true);
    const root = pinned(base());
    const ab: LinkPin = { ...root, nested: [x, y] };
    const ba: LinkPin = { ...root, nested: [y, x] };
    const one: LinkPin = { ...root, nested: [x] };
    const changed: LinkPin = { ...root, nested: [x, pinOf("/r/y", snap("/r/y", { head: "h9" }), true)] };
    expect(samePin(ab, ba)).toBe(true);
    expect(samePin(ab, one)).toBe(false);
    expect(samePin(ab, changed)).toBe(false);
  });
});

describe("pinTarget", () => {
  const make = (links: Record<string, string[]>, opts: { throwOn?: string; missing?: string[]; heads?: Record<string, string> } = {}) => ({
    snapshot: async (dir: string): Promise<TreeSnapshot | undefined> => {
      if (dir === opts.throwOn) throw new Error("boom");
      if (opts.missing?.includes(dir)) return undefined;
      return snap(dir, { head: opts.heads?.[dir] ?? "h1" });
    },
    admitted: (_dir: string) => true,
    externalLinks: (dir: string) => links[dir] ?? [],
  });

  it("pins a root without links", async () => {
    const pin = await pinTarget("/r/a", make({}));
    expect(pinned(pin).nested).toEqual([]);
  });

  it("pins a level-1 link as nested and samePin compares it", async () => {
    const links = { "/r/a": ["/r/b"] };
    const first = await pinTarget("/r/a", make(links));
    const again = await pinTarget("/r/a", make(links));
    const moved = await pinTarget("/r/a", make(links, { heads: { "/r/b": "h2" } }));
    expect(pinned(first).nested.map((n) => n.root)).toEqual(["/r/b"]);
    expect(samePin(first, again)).toBe(true);
    expect(samePin(first, moved)).toBe(false);
  });

  it("makes the root unpinnable deep-link when a level-1 target has external links", async () => {
    const pin = await pinTarget("/r/a", make({ "/r/a": ["/r/b"], "/r/b": ["/r/c"] }));
    expect(pin).toEqual({ kind: "unpinnable", root: "/r/a", why: "deep-link" });
  });

  it("makes the root unpinnable with the nested reason when a nested pin is unpinnable", async () => {
    const pin = await pinTarget("/r/a", make({ "/r/a": ["/r/b"] }, { missing: ["/r/b"] }));
    expect(pin).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-observed" });
  });

  it("is unpinnable when the root itself is not admitted", async () => {
    const deps = { ...make({}), admitted: () => false };
    expect(await pinTarget("/r/a", deps)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-admitted" });
  });

  it("reports not-observed when the snapshot throws", async () => {
    expect(await pinTarget("/r/a", make({}, { throwOn: "/r/a" }))).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-observed" });
    expect(await pinTarget("/r/a", make({ "/r/a": ["/r/b"] }, { throwOn: "/r/b" }))).toEqual({
      kind: "unpinnable",
      root: "/r/a",
      why: "not-observed",
    });
  });

  it("reports not-observed when link discovery throws", async () => {
    const deps = {
      ...make({}),
      externalLinks: (): string[] => {
        throw new Error("boom");
      },
    };
    expect(await pinTarget("/r/a", deps)).toEqual({ kind: "unpinnable", root: "/r/a", why: "not-observed" });
  });
});
