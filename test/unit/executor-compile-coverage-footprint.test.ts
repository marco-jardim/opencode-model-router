import { describe, expect, it } from "vitest";
import {
  MAX_DIR_EXPANSION,
  UNKNOWN_WRITES,
  extractFootprint,
  loadRepoView,
  normalizeRepoPath,
  overlaps,
  repoViewFrom,
  touchKey,
  type FootprintInput,
  type OwnershipInput,
  type RepoGit,
  type RepoView,
  type TaskFootprint,
} from "../../src/executor/compile/footprint";

const BIG = Array.from({ length: MAX_DIR_EXPANSION + 5 }, (_, i) => `lib/f${i}.ts`);
const FILES = [
  "src/a.ts", "src/b.ts", "src/dir/x.ts", "src/dir/y.ts", "test/unit/a.test.ts", "README.md", "docs/Guide.md",
  "pkg1/index.ts", "pkg2/index.ts", "src/a.ts", "", ...BIG,
];

const win = (ci = false): RepoView => repoViewFrom({ toplevel: "D:\\repo", worktrees: ["D:\\repo-wt"], files: FILES, caseInsensitive: ci });
const posix = (): RepoView => repoViewFrom({ toplevel: "/repo", worktrees: ["/repo-wt"], files: FILES, caseInsensitive: false });
const NONE: ReadonlySet<string> = new Set();
const norm = (raw: string, repo: RepoView, allowNew = false, created: ReadonlySet<string> = NONE): ReturnType<typeof normalizeRepoPath> =>
  normalizeRepoPath(raw, repo, { allowNew, createdEarlier: created });

describe("keys and overlaps", () => {
  it("folds case only when asked", () => {
    expect(touchKey("A/B", false)).toBe("A/B");
    expect(touchKey("A/B", true)).toBe("a/b");
  });

  it("treats equal paths, prefixes and the root as overlapping", () => {
    expect(overlaps("a/b", "a/b", false)).toBe(true);
    expect(overlaps("a", "a/b", false)).toBe(true);
    expect(overlaps("a/b", "a", false)).toBe(true);
    expect(overlaps("", "a", false)).toBe(true);
    expect(overlaps("a", "", false)).toBe(true);
    expect(overlaps("a", "ab", false)).toBe(false);
    expect(overlaps("A/B", "a/b", false)).toBe(false);
    expect(overlaps("A/B", "a", true)).toBe(true);
  });
});

describe("repoViewFrom", () => {
  it("derives files, directories and basenames, dropping duplicates and blanks", () => {
    const v = repoViewFrom({ toplevel: "/r", worktrees: ["/w"], files: ["a\\b\\c.ts", "a/b/c.ts", "", "a/d.ts", "x.ts"], caseInsensitive: false });
    expect([...v.files]).toEqual(["a/b/c.ts", "a/d.ts", "x.ts"]);
    expect([...v.dirs].sort()).toEqual(["a", "a/b"]);
    expect(v.byBasename.get("c.ts")).toEqual(["a/b/c.ts"]);
    expect(v.worktrees).toEqual(["/w"]);
  });

  it("keys basenames by folded case on a case-insensitive repository", () => {
    const v = repoViewFrom({ toplevel: "/r", worktrees: [], files: ["a/File.TS", "b/file.ts"], caseInsensitive: true });
    expect(v.byBasename.get("file.ts")).toEqual(["a/File.TS", "b/file.ts"]);
  });
});

describe("loadRepoView", () => {
  const git = (over: Record<string, { code: number; stdout: string }>): RepoGit => ({
    run: async (args) => over[args.join(" ")] ?? { code: 0, stdout: "" },
  });
  const ok = {
    "rev-parse --show-toplevel": { code: 0, stdout: "/top\n" },
    "worktree list --porcelain": { code: 0, stdout: "worktree /top\nHEAD x\n\nworktree /other\nHEAD y\nworktree \n" },
    "ls-files -z": { code: 0, stdout: "a.ts\0b/c.ts\0" },
    "config core.ignorecase": { code: 0, stdout: "TRUE\n" },
  };

  it("reads toplevel, other worktrees, files and the case flag", async () => {
    const v = await loadRepoView(git(ok), "/cwd");
    expect(v.toplevel).toBe("/top");
    expect(v.worktrees).toEqual(["/other"]);
    expect([...v.files]).toEqual(["a.ts", "b/c.ts"]);
    expect(v.caseInsensitive).toBe(true);
  });

  it("tolerates a failing worktree list and a missing ignorecase setting", async () => {
    const v = await loadRepoView(git({ ...ok, "worktree list --porcelain": { code: 1, stdout: "" }, "config core.ignorecase": { code: 1, stdout: "" } }), "/cwd");
    expect(v.worktrees).toEqual([]);
    expect(v.caseInsensitive).toBe(false);
  });

  it("fails when the toplevel or the file list cannot be read", async () => {
    await expect(loadRepoView(git({ ...ok, "rev-parse --show-toplevel": { code: 128, stdout: "" } }), "/cwd")).rejects.toThrow(/show-toplevel failed in \/cwd \(exit 128\)/);
    await expect(loadRepoView(git({ ...ok, "rev-parse --show-toplevel": { code: 0, stdout: "  \n" } }), "/cwd")).rejects.toThrow(/show-toplevel/);
    await expect(loadRepoView(git({ ...ok, "ls-files -z": { code: 2, stdout: "" } }), "/cwd")).rejects.toThrow(/ls-files failed in \/top \(exit 2\)/);
  });
});

describe("normalizeRepoPath rejections", () => {
  const reason = (raw: string, repo = win()): string => {
    const r = norm(raw, repo, true);
    return r.ok ? `ok:${r.path}` : r.reason;
  };

  it("rejects urls, devices, unc paths and rooted spellings without a drive", () => {
    expect(reason("https://x.test/a")).toBe("url");
    expect(reason("file:/x")).toBe("url");
    expect(reason("\\\\?\\C:\\x")).toBe("device");
    expect(reason("//./pipe/x")).toBe("device");
    expect(reason("\\??\\C:\\x")).toBe("device");
    expect(reason("\\\\host\\share\\x")).toBe("unc");
    expect(reason("//host/share")).toBe("unc");
    expect(reason("/src/a.ts")).toBe("device");
    expect(reason("\\src\\a.ts", posix())).toBe("device");
  });

  it("rejects NUL, drive-relative, escaping and colon spellings", () => {
    expect(reason("a\0b")).toBe("outside");
    expect(reason("C:foo")).toBe("outside");
    expect(reason("../x.ts")).toBe("escape");
    expect(reason("src/../../x.ts")).toBe("escape");
    expect(reason("src/a:b.ts")).toBe("outside");
    expect(reason("a:b")).toBe("outside");
    expect(reason("   ")).toBe("not-found");
  });

  it("reports ambiguity, absence and unknown parents", () => {
    expect(reason("index.ts")).toBe("ambiguous");
    expect(norm("nothing.ts", win(), false)).toMatchObject({ ok: false, reason: "not-found" });
    expect(norm("src/new.ts", win(), false)).toMatchObject({ ok: false, reason: "not-found" });
    expect(norm("nodir/new.ts", win(), true)).toMatchObject({ ok: false, reason: "not-found" });
    expect(norm("nothing.ts", win(), true)).toMatchObject({ ok: true, path: "nothing.ts", via: "new" });
  });

  it("keeps the original spelling in the failure", () => {
    expect(norm("  https://x.test/a ", win())).toMatchObject({ ok: false, reason: "url", raw: "  https://x.test/a " });
    expect(norm("D:\\elsewhere\\q\\z.ts", win(), false)).toMatchObject({ ok: false, reason: "outside", raw: "D:\\elsewhere\\q\\z.ts" });
  });
});

describe("normalizeRepoPath resolution", () => {
  it("maps absolute windows paths under the toplevel and worktrees", () => {
    expect(norm("D:\\repo\\src\\a.ts", win())).toEqual({ ok: true, path: "src/a.ts", via: "worktree", dir: false });
    expect(norm("d:/repo/src/dir/", win())).toMatchObject({ ok: true, path: "src/dir", via: "worktree", dir: true });
    expect(norm("d:/REPO/src/dir/", win())).toMatchObject({ ok: true, path: "src/dir", via: "suffix", dir: true });
    expect(norm("D:\\repo-wt\\README.md", win())).toMatchObject({ ok: true, path: "README.md", via: "worktree" });
    expect(norm("D:\\repo", win())).toEqual({ ok: true, path: "", via: "worktree", dir: true });
    expect(norm("D:\\repo\\src\\fresh.ts", win())).toMatchObject({ ok: true, path: "src/fresh.ts", via: "worktree", dir: false });
    expect(norm("D:\\repo\\src\\fresh\\", win())).toMatchObject({ ok: true, path: "src/fresh", dir: true });
    expect(norm("D:\\repo\\a:b", win())).toMatchObject({ ok: false, reason: "outside" });
  });

  it("folds case under a case-insensitive repository", () => {
    expect(norm("D:\\repo\\SRC\\A.TS", win(true))).toMatchObject({ ok: true, path: "src/a.ts" });
    expect(norm("src/A.ts", win(true))).toMatchObject({ ok: true, path: "src/a.ts", via: "relative" });
    expect(norm("readme.md", win(true))).toMatchObject({ ok: true, path: "README.md", via: "basename" });
    expect(norm("src/A.ts", win(false), true)).toMatchObject({ ok: true, via: "new", path: "src/A.ts" });
  });

  it("maps paths under another root to the longest existing suffix", () => {
    expect(norm("C:\\other\\src\\a.ts", win())).toEqual({ ok: true, path: "src/a.ts", via: "suffix", dir: false });
    expect(norm("/other/place/src/dir", posix())).toMatchObject({ ok: true, path: "src/dir", via: "suffix", dir: true });
    expect(norm("C:\\other\\test\\unit\\new.test.ts", win(), true)).toMatchObject({ ok: true, path: "test/unit/new.test.ts", via: "suffix" });
    expect(norm("/other/test/unit/new.test.ts", posix(), true)).toMatchObject({ ok: true, path: "test/unit/new.test.ts", via: "suffix" });
    expect(norm("C:\\other\\unit\\gen\\", win(), true, new Set(["unit"]))).toMatchObject({ ok: true, path: "unit/gen", via: "suffix", dir: true });
  });

  it("tells an unknown drive from an unmatched path on a known one", () => {
    expect(norm("E:\\x\\y.ts", win())).toMatchObject({ ok: false, reason: "other-drive" });
    expect(norm("D:\\zzz\\nothing.ts", win())).toMatchObject({ ok: false, reason: "outside" });
    expect(norm("/zzz/nothing.ts", posix())).toMatchObject({ ok: false, reason: "outside" });
    expect(norm("/zzz/nothing.ts", posix(), true)).toMatchObject({ ok: false, reason: "outside" });
  });

  it("resolves absolute posix paths", () => {
    expect(norm("/repo/src/b.ts", posix())).toEqual({ ok: true, path: "src/b.ts", via: "worktree", dir: false });
    expect(norm("/repo-wt/src/a.ts", posix())).toMatchObject({ ok: true, path: "src/a.ts" });
    expect(norm("/repo/", posix())).toMatchObject({ ok: true, path: "", dir: true });
  });

  it("resolves relative paths and the root", () => {
    expect(norm("./src//a.ts", win())).toEqual({ ok: true, path: "src/a.ts", via: "relative", dir: false });
    expect(norm("src\\dir", win())).toMatchObject({ ok: true, path: "src/dir", dir: true });
    expect(norm("src/x/../b.ts", win())).toMatchObject({ ok: true, path: "src/b.ts" });
    expect(norm("src/", win())).toMatchObject({ ok: true, path: "src", dir: true });
    expect(norm("./", win())).toMatchObject({ ok: false, reason: "not-found" });
    expect(norm("src/newdir/", win(), true)).toMatchObject({ ok: true, path: "src/newdir", via: "new", dir: true });
    expect(norm("fresh/x.ts", win(), true, new Set(["fresh"]))).toMatchObject({ ok: true, via: "new" });
    expect(norm("FRESH/x.ts", win(true), true, new Set(["fresh"]))).toMatchObject({ ok: true, via: "new" });
  });

  it("extends the folded created-set lazily as it grows", () => {
    const created = new Set(["one"]);
    expect(norm("ONE/a.ts", win(true), true, created)).toMatchObject({ ok: true });
    created.add("Two");
    expect(norm("two/a.ts", win(true), true, created)).toMatchObject({ ok: true });
    expect(norm("three/a.ts", win(true), true, created)).toMatchObject({ ok: false });
  });

  it("resolves bare names by basename, directory or as new files", () => {
    expect(norm("a.test.ts", win())).toMatchObject({ ok: true, path: "test/unit/a.test.ts", via: "basename" });
    expect(norm("docs", win())).toMatchObject({ ok: true, path: "docs", via: "relative", dir: true });
    expect(norm("brand-new.ts", win(), true)).toMatchObject({ ok: true, via: "new", dir: false });
  });

  it("reduces globs to their static prefix", () => {
    expect(norm("src/*.ts", win())).toEqual({ ok: true, path: "src", via: "relative", dir: true });
    expect(norm("src\\dir\\**\\*.ts", win())).toMatchObject({ ok: true, path: "src/dir", dir: true });
    expect(norm("*.md", win())).toMatchObject({ ok: false, reason: "not-found", raw: "*.md" });
    expect(norm("/*.ts", posix())).toMatchObject({ ok: false, reason: "outside" });
    expect(norm("nodir/*.ts", win(), true)).toMatchObject({ ok: false, reason: "not-found", raw: "nodir/*.ts" });
    expect(norm("D:\\repo\\src\\*.ts", win())).toMatchObject({ ok: true, path: "src", dir: true });
  });
});

function fi(o: Partial<FootprintInput> & { writes?: string | null; reads?: string | null } = {}): FootprintInput {
  const line = (t: string | null | undefined): FootprintInput["writesLine"] =>
    t === null || t === undefined ? null : { line: 3, text: t, none: /^none$/i.test(t.trim()) };
  return {
    id: "t", kind: "task", body: "", manual: false, route: null,
    writesLine: line(o.writes), readsLine: line(o.reads),
    ...(({ writes: _w, reads: _r, ...rest }) => rest)(o),
  };
}

function run(t: FootprintInput, repo = win(), own: OwnershipInput[] = [], created = new Set<string>()): TaskFootprint {
  return extractFootprint(t, own, repo, created);
}

describe("extractFootprint Writes and Reads lines", () => {
  it("takes a closed Writes line as explicit evidence", () => {
    const r = run(fi({ writes: "`src/a.ts`, `src/b.ts:12`, `src/a.ts#L3-L9`", reads: "`README.md`" }));
    expect(r.footprint).toEqual({ writes: ["src/a.ts", "src/b.ts"], reads: ["README.md"], confidence: "explicit", sources: ["writes-line"] });
    expect(r.editing).toBe(true);
    expect(r.lowConfidence).toBe(false);
    expect(r.evidence.filter((e) => e.access === "write").every((e) => e.rule === "writes-line" && e.line === 3)).toBe(true);
  });

  it("treats 'none' as explicit and empty", () => {
    const r = run(fi({ writes: "none", reads: "none", body: "Update `src/a.ts`" }));
    expect(r.footprint).toMatchObject({ writes: [], reads: [], confidence: "explicit", sources: ["writes-line"] });
  });

  it("creates new files and remembers them with their directories", () => {
    const created = new Set<string>();
    const r = run(fi({ writes: "`src/dir/new/file.ts`, `src/fresh.ts`" }), win(), [], created);
    expect(r.footprint.writes).toEqual(["src/dir/new/file.ts", "src/fresh.ts"]);
    expect([...created].sort()).toEqual(["src", "src/dir", "src/dir/new", "src/dir/new/file.ts", "src/fresh.ts"]);
    const next = run(fi({ writes: "`src/dir/new/other.ts`" }), win(), [], created);
    expect(next.footprint.writes).toEqual(["src/dir/new/other.ts"]);
  });

  it("expands a directory write to its files and keeps the directory", () => {
    const r = run(fi({ writes: "`src/dir/`" }));
    expect(r.footprint.writes).toEqual(["src/dir/x.ts", "src/dir/y.ts", "src/dir"]);
    expect(r.footprint.confidence).toBe("explicit");
  });

  it("falls to unknown when a directory is too big, empty or a glob has no base", () => {
    const big = run(fi({ writes: "`lib/`" }));
    expect(big.footprint.confidence).toBe("unknown");
    expect(big.ignored).toEqual([{ raw: "lib/", reason: "dir-write-unbounded", line: 3 }]);
    expect(big.footprint.sources).toEqual(["writes-line"]);
    expect(big.lowConfidence).toBe(true);
    const root = run(fi({ writes: "`D:\\repo\\`" }));
    expect(root.footprint.confidence).toBe("unknown");
    expect(root.ignored[0]).toMatchObject({ reason: "dir-write-unbounded" });
    const glob = run(fi({ writes: "`nodir/*.ts`" }));
    expect(glob.footprint.confidence).toBe("unknown");
    expect(glob.ignored[0]).toMatchObject({ reason: "dir-write-unbounded" });
  });

  it("expands globs over existing directories", () => {
    const r = run(fi({ writes: "`src/dir/*.ts`" }));
    expect(r.footprint.writes).toEqual(["src/dir/x.ts", "src/dir/y.ts", "src/dir"]);
  });

  it("writes every file of an ambiguous basename", () => {
    const r = run(fi({ writes: "`index.ts`" }));
    expect(r.footprint.writes).toEqual(["pkg1/index.ts", "pkg2/index.ts"]);
    expect(r.lowConfidence).toBe(true);
  });

  it("marks suffix matches as weak and reports foreign roots once", () => {
    const r = run(fi({ writes: "`C:\\other\\src\\a.ts` and `C:\\other\\src\\b.ts`" }));
    expect(r.footprint.writes).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.foreignRoots).toEqual(["C:\\other"]);
    expect(r.lowConfidence).toBe(true);
    const reads = run(fi({ reads: "`/other/place/src/a.ts`" }), posix());
    expect(reads.foreignRoots).toEqual(["/other/place"]);
  });

  it("ignores writes that leave the repository and keeps the rest", () => {
    const r = run(fi({ writes: "`E:\\x\\y.ts`, `../escape.ts`, `https://x.test/a.js`, `src/a.ts`" }));
    expect(r.footprint.writes).toEqual(["src/a.ts"]);
    expect(r.ignored.map((i) => [i.reason, i.write])).toEqual([["other-drive", true], ["escape", true], ["url", undefined]]);
  });

  it("falls to unknown when a write path cannot be represented", () => {
    const r = run(fi({ writes: "`a/b:c.ts`" }));
    expect(r.footprint.confidence).toBe("unknown");
    expect(r.ignored[0]).toMatchObject({ reason: "outside", write: true });
    const only = run(fi({ writes: "`\\\\host\\share\\x.ts`" }));
    expect(only.footprint.confidence).not.toBe("explicit");
    expect(only.ignored[0]).toMatchObject({ reason: "unc", write: true });
  });

  it("keeps declared reads, new reads and reports unusable ones", () => {
    const r = run(fi({ writes: "none", reads: "`src/a.ts`, `docs/missing/new.md`, `E:\\x\\y.ts`, `nodir/*.ts`, `D:\\repo`" }));
    expect(r.footprint.reads).toEqual(["src/a.ts", "docs/missing/new.md"]);
    expect(r.ignored.map((i) => i.reason)).toEqual(["other-drive", "not-found", "repo-root"]);
  });

  it("drops reads that are also written", () => {
    const r = run(fi({ writes: "`src/a.ts`", reads: "`src/a.ts`, `SRC/B.ts`" }), win(true));
    expect(r.footprint.reads).toEqual(["src/b.ts"]);
  });
});

describe("extractFootprint body mentions", () => {
  it("reads mentions as reads when nothing says write", () => {
    const r = run(fi({ body: "Look at `src/a.ts` and src/b.ts, also https://x.test/doc and D:\\repo\\README.md." }));
    expect(r.footprint.reads).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
    expect(r.footprint.writes).toEqual([]);
    expect(r.footprint.confidence).toBe("unknown");
    expect(r.ignored.some((i) => i.reason === "url")).toBe(true);
    expect(r.footprint.sources).toEqual(["path"]);
  });

  it("turns write verbs into writes", () => {
    const body = ["Update `src/a.ts`.", "Create `src/fresh.ts` for it.", "Add tests in `test/unit/a.test.ts`.", "Wire it in `src/b.ts`.", "In `src/dir/x.ts`: fix it."].join("\n");
    const r = run(fi({ body }));
    expect(r.footprint.writes).toEqual(["src/a.ts", "src/fresh.ts", "test/unit/a.test.ts", "src/b.ts", "src/dir/x.ts"]);
    expect(r.footprint.confidence).toBe("explicit");
    expect(r.evidence.map((e) => e.rule)).toEqual(["verb:update", "verb:create", "verb:tests-in", "verb:wire-in", "verb:in"]);
    expect(r.evidence[0]?.line).toBe(1);
    expect(r.evidence[4]?.line).toBe(5);
  });

  it("does not guess a write for an unknown bare name without a create context", () => {
    const r = run(fi({ body: "Update `Foo.bar` now." }));
    expect(r.footprint.writes).toEqual([]);
    expect(r.ignored).toEqual([{ raw: "Foo.bar", reason: "not-found", line: 1 }]);
    expect(r.footprint.confidence).toBe("unknown");
  });

  it("keeps an unknown path with a separator as a new write and honours (new)", () => {
    const r = run(fi({ body: "Update `src/zzz/fresh.ts`.\nSee `src/marked.ts` (new)." }));
    expect(r.footprint.writes).toEqual(["src/zzz/fresh.ts"]);
    expect(r.footprint.reads).toEqual(["src/marked.ts"]);
  });

  it("makes a task write top when a verb names an unrepresentable path or glob", () => {
    const glob = run(fi({ body: "Update `nodir/*.ts`." }));
    expect(glob.footprint.confidence).toBe("unknown");
    expect(glob.ignored[0]).toMatchObject({ reason: "dir-write-unbounded" });
    const bad = run(fi({ body: "Update `../../x.ts`." }));
    expect(bad.ignored[0]).toMatchObject({ reason: "escape", write: true });
    expect(bad.footprint.confidence).toBe("unknown");
    const colon = run(fi({ body: "Create `a/b:c.ts`." }));
    expect(colon.ignored[0]).toMatchObject({ reason: "outside", write: true });
    expect(colon.footprint.confidence).toBe("unknown");
    const dot = run(fi({ body: "Update `./`." }));
    expect(dot.ignored[0]).toMatchObject({ reason: "not-found" });
    expect(dot.footprint.confidence).toBe("unknown");
  });

  it("ignores bodies entirely once both lines are present", () => {
    const r = run(fi({ writes: "`src/a.ts`", reads: "`README.md`", body: "Update `src/b.ts` and read `docs/Guide.md`" }));
    expect(r.footprint.writes).toEqual(["src/a.ts"]);
    expect(r.footprint.reads).toEqual(["README.md"]);
  });

  it("lets mentions add reads only while the Reads line is missing", () => {
    const r = run(fi({ writes: "`src/a.ts`", body: "Update `src/b.ts`, see `docs/Guide.md`" }));
    expect(r.footprint.writes).toEqual(["src/a.ts"]);
    expect(r.footprint.reads).toEqual(["src/b.ts", "docs/Guide.md"]);
    const closed = run(fi({ reads: "`README.md`", body: "Update `src/b.ts`, see `docs/Guide.md`" }));
    expect(closed.footprint.writes).toEqual(["src/b.ts", "docs/Guide.md"]);
    expect(closed.footprint.reads).toEqual(["README.md"]);
  });

  it("scans bare drive, unc, posix and relative spellings", () => {
    const body = "See D:\\repo\\src\\a.ts, \\\\host\\share\\q.ts, /repo/src/b.ts and docs/Guide.md.";
    const r = run(fi({ body }), posix());
    expect(r.footprint.reads).toEqual(expect.arrayContaining(["src/b.ts", "docs/Guide.md"]));
    expect(r.ignored.some((i) => i.reason === "unc")).toBe(true);
    const w = run(fi({ body }));
    expect(w.footprint.reads).toContain("src/a.ts");
  });
});

describe("extractFootprint ownership and classification", () => {
  const rows: OwnershipInput[] = [{ path: "src/dir/", owners: ["P"], line: 9 }];

  it("adds ownership rows that a mentioned path falls under", () => {
    const r = run(fi({ body: "Look at `src/dir/x.ts`." }), win(), rows);
    expect(r.footprint.confidence).toBe("ownership");
    expect(r.footprint.writes).toEqual(["src/dir/x.ts", "src/dir/y.ts", "src/dir"]);
    expect(r.footprint.sources).toEqual(["path", "ownership"]);
    expect(r.evidence.find((e) => e.access === "write")).toMatchObject({ rule: "ownership-row", line: 9 });
    expect(r.ownershipAssumed).toBe(false);
  });

  it("uses a mention that cannot be read as an ownership guess", () => {
    const r = run(fi({ body: "Look at `src/dir/fresh.ts`." }), win(), rows);
    expect(r.footprint.confidence).toBe("ownership");
    const withReads = run(fi({ reads: "none", body: "Look at `src/dir/fresh.ts`." }), win(), rows);
    expect(withReads.footprint.confidence).toBe("ownership");
  });

  it("assumes the whole ownership set when an editing task has no evidence", () => {
    const r = run(fi({ body: "Do the thing." }), win(), rows);
    expect(r.footprint.confidence).toBe("inferred");
    expect(r.ownershipAssumed).toBe(true);
    expect(r.lowConfidence).toBe(true);
    expect(r.evidence[0]?.rule).toBe("ownership-phase");
  });

  it("does not assume ownership for non-editing, explicit, unbounded or ignored-write tasks", () => {
    expect(run(fi({ body: "Think.", route: { fields: { class: "review" } } }), win(), rows).footprint.confidence).toBe("inferred");
    expect(run(fi({ body: "Think.", route: { fields: { class: "review" } } }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ body: "Think.", route: { fields: { needs: ["shell"] } } }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ body: "Think.", route: { fields: { needs: ["edit"] } } }), win(), rows).ownershipAssumed).toBe(true);
    expect(run(fi({ body: "Think.", kind: "qa" }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ body: "Think.", manual: true }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ body: "Update `E:\\x\\y.ts`." }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ body: "Update `nodir/*.ts`." }), win(), rows).ownershipAssumed).toBe(false);
    expect(run(fi({ writes: "`src/a.ts`" }), win(), rows).ownershipAssumed).toBe(false);
  });

  it("skips ownership rows that do not resolve or name the root", () => {
    const odd: OwnershipInput[] = [{ path: "https://x.test/a", owners: [], line: 1 }, { path: "nodir/*.ts", owners: [], line: 2 }, { path: "D:\\repo", owners: [], line: 3 }, { path: "a/b:c", owners: [], line: 4 }];
    const r = run(fi({ body: "Do the thing." }), win(), odd);
    expect(r.footprint.confidence).toBe("unknown");
    expect(r.ownershipAssumed).toBe(false);
    const m = run(fi({ body: "Look at `src/a.ts`." }), win(), odd);
    expect(m.footprint.confidence).toBe("unknown");
  });

  it("classifies editing by kind, needs and class", () => {
    expect(run(fi({ kind: "qa" })).editing).toBe(false);
    expect(run(fi({ kind: "preflight" })).editing).toBe(false);
    expect(run(fi({ manual: true })).editing).toBe(false);
    expect(run(fi({ kind: "tests" })).editing).toBe(true);
    expect(run(fi({ route: { fields: { class: "search" } } })).editing).toBe(false);
    expect(run(fi({ route: { fields: { class: "implement" } } })).editing).toBe(true);
    expect(run(fi({ route: { fields: { needs: ["shell"] } } })).editing).toBe(false);
    expect(run(fi({ route: { fields: { needs: ["edit"] } } })).editing).toBe(true);
    expect(run(fi({ route: { fields: {} } })).editing).toBe(true);
    expect(run(fi({ route: null })).editing).toBe(true);
  });

  it("lets write evidence make a non-editing class edit", () => {
    const r = run(fi({ writes: "`src/a.ts`", route: { fields: { class: "review" } } }));
    expect(r.editing).toBe(true);
    const n = run(fi({ writes: "`src/a.ts`", route: { fields: { needs: [] } } }));
    expect(n.editing).toBe(true);
    const u = run(fi({ writes: "`lib/`", route: { fields: { class: "design" } } }));
    expect(u.editing).toBe(true);
  });

  it("gives non-editing tasks without evidence an inferred, non-low footprint", () => {
    const r = run(fi({ kind: "qa", body: "Review it." }));
    expect(r.footprint).toMatchObject({ writes: [], confidence: "inferred" });
    expect(r.lowConfidence).toBe(false);
  });

  it("exposes the top marker as a unique symbol", () => {
    expect(typeof UNKNOWN_WRITES).toBe("symbol");
  });
});
