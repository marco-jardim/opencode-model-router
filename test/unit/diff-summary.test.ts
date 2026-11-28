/**
 * #108 slice 1: the stat-first router_git_diff of OpenCode v2 roles mode (role sessions only). Pure helpers, then real git
 * through the tool: excluded kinds (P10), sensitive names (P4), the 4 KiB bound with exact omitted counts (P5), role-only
 * gating (P6), no content hash (P12), and the 8 KiB threshold / path / stat rules.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODE_EXTENSIONS, DIFF_SUMMARY_THRESHOLD_BYTES, entryExcludedKind, excludedKind, LOCKFILE_NAMES, parseNumstat, renderDiffSummary, renderExcludedList,
  SUMMARY_MAX_BYTES, summaryLine, type SummaryEntry,
} from "../../src/router/diff-summary";
import { gitEnvironment, gitExecutable, gitTools, type GitRootResolver, type GitToolsOptions, type WorkRootAnswer } from "../../src/router/git-tools";

const WIN = process.platform === "win32";

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const INHERITED_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"] as const;
const HEX_HASH = /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/;
const bytes = (text: string) => Buffer.byteLength(text);
const display = (path: string) => path;

describe("diff-summary helpers (#108)", () => {
  it("P10: the fixed list of excluded kinds, by repository-relative path", () => {
    for (const name of LOCKFILE_NAMES) {
      expect(excludedKind(name), name).toBe("lockfile");
      expect(excludedKind(`packages/app/${name}`), name).toBe("lockfile");
    }
    expect(excludedKind("src/__snapshots__/view.test.ts.snap")).toBe("snapshot");
    expect(excludedKind("src/__snapshots__/data.json")).toBe("snapshot");
    expect(excludedKind("ui/button.snap")).toBe("snapshot");
    expect(excludedKind("test/golden/v1-tools.json")).toBe("golden");
    expect(excludedKind("test/fixtures/project/package.json")).toBe("fixture");
    expect(excludedKind("packages/x/fixtures/a.txt")).toBe("fixture");
    for (const path of ["src/index.ts", "package.json", "yarn.lock.md", "golden/x.json", "lib/test/golden/x", "fixtures", "src/fixtures.ts",
      "test/golden", "my-package-lock.json", "snapshots/a.txt"]) {
      expect(excludedKind(path), path).toBeUndefined();
    }
  });

  it("finding 1: goldens and fixtures never exclude code or tests; entries are classified by their new path only", () => {
    for (const path of ["test/golden/view.test.ts", "test/golden/tools.spec.js", "test/fixtures/helper.ts", "test/fixtures/app/main.PY",
      "pkg/fixtures/run.sh", "test/fixtures/setup.ps1", "test/fixtures/x.data.test.json", "test/golden/gen.mjs"]) {
      expect(excludedKind(path), path).toBeUndefined();
    }
    for (const [path, kind] of [["test/fixtures/data.json", "fixture"], ["test/fixtures/page.html", "fixture"], ["test/golden/v1.txt", "golden"],
      ["src/__snapshots__/a.test.ts.snap", "snapshot"], ["test/fixtures/package-lock.json", "lockfile"]] as const) {
      expect(excludedKind(path), path).toBe(kind);
    }
    expect(CODE_EXTENSIONS).toContain(".ts");
    expect(entryExcludedKind({ path: "src/auth.ts", from: "test/fixtures/x.json" })).toBeUndefined();
    expect(entryExcludedKind({ path: "src/data.json", from: "test/fixtures/data.json" })).toBeUndefined();
    expect(entryExcludedKind({ path: "test/fixtures/data.json", from: "src/data.json" })).toBe("fixture");
  });

  it("parses --numstat -z records: plain, binary and renamed", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0" + "2\t0\t\0old name.ts\0new name.ts\0" + "0\t0\tsp ace\ttab.ts\0")).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "img.png" },
      { path: "new name.ts", from: "old name.ts", added: 2, removed: 0 },
      { path: "sp ace\ttab.ts", added: 0, removed: 0 },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });

  it("P4: a sensitive line never shows counts; excluded lines show kind and counts", () => {
    expect(summaryLine({ path: "src/a.ts", added: 3, removed: 1 }, display)).toBe("src/a.ts | +3 -1");
    expect(summaryLine({ path: "img.png" }, display)).toBe("img.png | binary");
    expect(summaryLine({ path: "b.ts", from: "a.ts", added: 1, removed: 2 }, display)).toBe("a.ts => b.ts | +1 -2");
    expect(summaryLine({ path: "yarn.lock", added: 80, removed: 30, excluded: "lockfile" }, display)).toBe("yarn.lock | content excluded (lockfile, +80/-30)");
    expect(summaryLine({ path: "bun.lockb", excluded: "lockfile" }, display)).toBe("bun.lockb | content excluded (lockfile, binary)");
    expect(summaryLine({ path: ".env", added: 5, removed: 5, sensitive: true }, display)).toBe(".env | sensitive: content withheld");
  });

  it("P5: a summary stays within 4096 bytes and gives the exact count of what it leaves out, by category", () => {
    const entries: SummaryEntry[] = [
      ...Array.from({ length: 300 }, (_, i) => ({ path: `src/module-${String(i).padStart(3, "0")}.ts`, added: i, removed: 1 })),
      ...Array.from({ length: 40 }, (_, i) => ({ path: `test/fixtures/f${i}.json`, added: 1, removed: 1, excluded: "fixture" as const })),
      { path: "deploy/prod.env", sensitive: true },
    ];
    const text = renderDiffSummary(entries, display, { reason: "large", footer: `[router_git stderr]\n${"w".repeat(3000)}\n` });
    expect(bytes(text)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    const listed = text.split("\n").filter(line => / \| /.test(line)).length;
    const omitted = /\[router_git\] (\d+) more entries not shown \(([^)]*)\)/.exec(text);
    expect(omitted, text).not.toBeNull();
    expect(listed + Number(omitted![1])).toBe(entries.length);
    expect(omitted![2]).toMatch(/content excluded, 1 sensitive$/);
    expect(text).toMatch(/^\[router_git\] diff summary: 341 files \(300 changed, 40 content excluded, 1 sensitive\), \+44890 -340 outside sensitive files; /);
    expect(text).toContain("[router_git] notes cut");
    // Everything fits: no omitted line.
    const small = renderDiffSummary(entries.slice(0, 3), display, { reason: "large" });
    expect(small).not.toContain("not shown");
    expect(small.trimEnd().split("\n")).toHaveLength(4);
    // The excluded list after a small patch has the same bound and count.
    const list = renderExcludedList(entries.slice(300).concat(Array.from({ length: 200 }, (_, i) => ({ path: `pkg${i}/package-lock.json`, added: 9, removed: 9, excluded: "lockfile" as const }))), display);
    expect(bytes(list)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    const rest = /(\d+) more excluded entries not shown/.exec(list);
    expect(list.split("\n").filter(line => / \| content excluded/.test(line)).length + Number(rest![1])).toBe(240);
    expect(renderExcludedList([], display)).toBe("");
  });
});

let root: string;
let outside: string;
let savedEnv: Partial<Record<typeof INHERITED_ENV[number], string>>;

function git(...args: string[]): string {
  return execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: root, env: gitEnvironment(), encoding: "utf8" });
}
/** git with `input` on stdin, in `cwd` (default the repository). */
function gitInput(input: string, args: string[], cwd = root): string {
  return execFileSync(gitExecutable(), ["-c", "gc.auto=0", ...args], { cwd, env: gitEnvironment(), encoding: "utf8", input });
}
/** Seventeen committed sources under `dir`, rewritten by {@link bulkChange}: a patch well above 8 KiB, so the summary applies. */
function bulkBase(dir = "src") {
  for (let i = 0; i < 17; i++) write(`${dir}/bulk${String(i).padStart(2, "0")}.ts`, lines(`old ${i}`, 12));
}
function bulkChange(dir = "src") {
  for (let i = 0; i < 17; i++) write(`${dir}/bulk${String(i).padStart(2, "0")}.ts`, lines(`new ${i}`, 12));
}
function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
const lines = (prefix: string, count: number) => `${Array.from({ length: count }, (_, i) => `${prefix} line ${i} ${"x".repeat(24)}`).join("\n")}\n`;
type Execute = (args: unknown, context: unknown) => Promise<string>;
const context = (directory: string) => ({ sessionID: "child", messageID: "m", agent: "explorer", directory, worktree: directory,
  abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined });
const ROLE: GitToolsOptions = { resolveWorkRoot: (): WorkRootAnswer => ({ role: true, root }), summarizeDiffs: true };
/** router_git_diff as a session of `options` sees it. */
const diff = (args: Record<string, unknown> = {}, options: GitToolsOptions = ROLE) =>
  (gitTools(options).router_git_diff!.execute as unknown as Execute)(args, context(root));

/** Twenty tracked files, committed, then rewritten: 17 sources, a lockfile, a fixture and a sensitive file. */
function twentyFileChange() {
  for (let i = 0; i < 17; i++) write(`src/file${String(i).padStart(2, "0")}.ts`, lines(`old ${i}`, 12));
  write("package-lock.json", lines("lock old", 30));
  write("test/fixtures/data.json", lines("fixture old", 5));
  write(".env", "TOKEN=old-secret-value\n");
  git("add", "-A"); git("commit", "-qm", "base");
  for (let i = 0; i < 17; i++) write(`src/file${String(i).padStart(2, "0")}.ts`, lines(`new ${i}`, 12));
  write("package-lock.json", lines("lock new", 31));
  write("test/fixtures/data.json", lines("fixture new", 5));
  write(".env", "TOKEN=new-secret-value\n");
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "router-diff-summary-")));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "router-diff-summary-outside-")));
  savedEnv = {};
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
  writeFileSync(join(outside, "empty.gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(outside, "empty.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_CONFIG_SYSTEM;
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.email", "t@example.invalid"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"], ["core.autocrlf", "false"]]) {
    git("config", key!, value!);
  }
  write("README.md", "readme\n");
  git("add", "-A"); git("commit", "-qm", "init");
});
afterEach(() => {
  for (const name of INHERITED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, RM);
  rmSync(outside, RM);
});

describe("role router_git_diff summary (real git, #108)", () => {
  it("acceptance 1: a 20-file change above 8 KiB is under 2 KiB and lists every file, excluded and sensitive ones included", async () => {
    twentyFileChange();
    const full = await diff({}, {});
    expect(bytes(full)).toBeGreaterThan(DIFF_SUMMARY_THRESHOLD_BYTES);
    const text = await diff();
    expect(bytes(text), text).toBeLessThan(2048);
    expect(text).toMatch(/^\[router_git\] diff summary: 20 files \(17 changed, 2 content excluded, 1 sensitive\), \+240 -239 outside sensitive files; the patch exceeds 8 KiB/);
    for (let i = 0; i < 17; i++) expect(text).toContain(`src/file${String(i).padStart(2, "0")}.ts | +12 -12\n`);
    expect(text).toContain("package-lock.json | content excluded (lockfile, +31/-30)\n");
    expect(text).toContain("test/fixtures/data.json | content excluded (fixture, +5/-5)\n");
    expect(text).toContain(".env | sensitive: content withheld\n");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("@@");
    expect(text).not.toContain("not shown");
    expect(text).not.toMatch(HEX_HASH); // P12: no content hash in slice 1
  }, 60_000);

  it("mode cached is summarized the same way; a range too", async () => {
    twentyFileChange();
    git("add", "-A");
    const cached = await diff({ mode: "cached" });
    expect(cached).toMatch(/^\[router_git\] diff summary: 20 files /);
    expect(cached).toContain(".env | sensitive: content withheld\n");
    git("commit", "-qm", "rewrite");
    const range = await diff({ ref: "HEAD~1..HEAD" });
    expect(range).toMatch(/^\[router_git\] diff summary: 20 files /);
    expect(range).toContain("package-lock.json | content excluded (lockfile, +31/-30)\n");
  }, 60_000);

  it("P10: a small patch keeps its hunks and lists the excluded files after it instead of theirs", async () => {
    write("src/a.ts", "a\n"); write("pnpm-lock.yaml", lines("lock", 3)); write("src/__snapshots__/a.snap", "snap\n");
    git("add", "-A"); git("commit", "-qm", "base");
    write("src/a.ts", "b\n"); write("pnpm-lock.yaml", lines("lock2", 4)); write("src/__snapshots__/a.snap", "snap2\n");
    const text = await diff();
    expect(text).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(text).toContain("+b\n");
    expect(text).not.toContain("diff --git a/pnpm-lock.yaml");
    expect(text).not.toContain("lock2");
    expect(text).toContain("[router_git] content excluded from this patch (call router_git_diff again with path to see one):\n"
      + "pnpm-lock.yaml | content excluded (lockfile, +4/-3)\nsrc/__snapshots__/a.snap | content excluded (snapshot, +1/-1)\n");
    // With path, the excluded file's own patch.
    expect(await diff({ path: "pnpm-lock.yaml" })).toContain("+lock2 line 3");
  }, 60_000);

  it("a small patch without excluded files is byte-identical to today's; path, stat and name-only are unchanged", async () => {
    write("src/a.ts", "a\n"); git("add", "-A"); git("commit", "-qm", "base"); write("src/a.ts", "b\n");
    expect(await diff()).toBe(await diff({}, {}));
    twentyFileChange();
    for (const args of [{ mode: "stat" }, { mode: "name-only" }, { path: "src/file03.ts" }, { path: "package-lock.json" }]) {
      expect(await diff(args), JSON.stringify(args)).toBe(await diff(args, {}));
    }
    expect(await diff({ path: "src/file03.ts" })).toContain("@@");
  }, 60_000);

  it("P6: only a role session of roles mode gets it; a non-role session and the tools without the option keep the full patch", async () => {
    twentyFileChange();
    const full = await diff({}, {});
    expect(full).toContain("@@");
    expect(full).not.toContain("diff summary");
    expect(await diff({}, { resolveWorkRoot: () => ({ role: false }), summarizeDiffs: true })).toBe(full);
    expect(await diff({}, { resolveWorkRoot: () => ({ role: true, root }) })).toBe(full);
    expect(await diff()).toMatch(/^\[router_git\] diff summary: /);
  }, 60_000);

  it("P5: a change of hundreds of files stays within 4096 bytes with the exact count of the files left out", async () => {
    for (let i = 0; i < 400; i++) write(`src/m${i}.ts`, `v1 ${i}\n`);
    git("add", "-A"); git("commit", "-qm", "base");
    for (let i = 0; i < 400; i++) write(`src/m${i}.ts`, `v2 ${i}\n`);
    const text = await diff();
    expect(bytes(text)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    const listed = text.split("\n").filter(line => / \| \+1 -1$/.test(line)).length;
    const omitted = Number(/\[router_git\] (\d+) more entries not shown \(\1 changed\)/.exec(text)?.[1]);
    expect(listed).toBeGreaterThan(50);
    expect(listed + omitted).toBe(400);
  }, 60_000);

  it("finding 1: a golden test and a fixture source are shown in full, a rename out of fixtures is shown, a JSON fixture stays excluded", async () => {
    write("test/golden/view.test.ts", "a\n"); write("test/fixtures/helper.ts", "a\n"); write("test/fixtures/x.ts", "moved\n".repeat(5));
    write("test/fixtures/data.json", "{}\n");
    git("add", "-A"); git("commit", "-qm", "base");
    write("test/golden/view.test.ts", "b\n"); write("test/fixtures/helper.ts", "b\n"); write("test/fixtures/data.json", "{\"a\":1}\n");
    mkdirSync(join(root, "src"), { recursive: true });
    git("mv", "test/fixtures/x.ts", "src/auth.ts");
    git("add", "-A");
    const text = await diff({ mode: "cached" });
    expect(text).toContain("diff --git a/test/golden/view.test.ts b/test/golden/view.test.ts");
    expect(text).toContain("diff --git a/test/fixtures/helper.ts b/test/fixtures/helper.ts");
    expect(text).toContain("diff --git a/test/fixtures/x.ts b/src/auth.ts\nsimilarity index 100%\nrename from test/fixtures/x.ts\nrename to src/auth.ts\n");
    expect(text).not.toContain("diff --git a/test/fixtures/data.json");
    expect(text).toContain("[router_git] content excluded from this patch (call router_git_diff again with path to see one):\n"
      + "test/fixtures/data.json | content excluded (fixture, +1/-1)\n");
  }, 60_000);

  it("N1: with diff.renames=copies, a file copied into fixtures is excluded but its still-listed source keeps its hunks", async () => {
    git("config", "diff.renames", "copies");
    const json = (first: string) => `${[first, ...Array.from({ length: 9 }, (_, i) => `  "k${i}": "value number ${i}",`)].join("\n")}\n`;
    write("src/a.json", json("{ \"base\": 1,"));
    git("add", "-A"); git("commit", "-qm", "base");
    write("test/fixtures/a.json", json("{ \"base\": 1,")); // a copy of src/a.json's committed content
    write("src/a.json", json("{ \"base\": 2,"));          // and the source itself modified
    git("add", "-A");
    const text = await diff({ mode: "cached" });
    expect(text).toContain("diff --git a/src/a.json b/src/a.json");
    expect(text).toContain("-{ \"base\": 1,\n+{ \"base\": 2,\n");
    expect(text).not.toContain("b/test/fixtures/a.json");
    expect(text).toContain("src/a.json => test/fixtures/a.json | content excluded (fixture, +0/-0)\n");
  }, 60_000);

  it("finding 2: an excluded file with a sensitive name is listed without counts after a small patch", async ctx => {
    // A name only sensitive-paths.ts flags (the pathspec does not: the backslash is part of one file name), staged index-only.
    const blob = gitInput("aws_secret_access_key=abc123\n", ["hash-object", "-w", "--stdin"]).trim();
    try {
      git("-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},test/fixtures/.aws\\credentials`);
    } catch (error) {
      if (WIN) ctx.skip(`git refuses a backslash in an index path here: ${String(error)}`);
      throw error;
    }
    write("src/a.ts", "a\n"); git("add", "src/a.ts");
    const text = await diff({ mode: "cached" });
    expect(text).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(text).toMatch(/\.aws\\{1,2}credentials"? \| sensitive: content withheld\n/);
    expect(text).not.toMatch(/credentials"? \| content excluded/);
    expect(text).not.toMatch(/credentials"? \| \+/);
    expect(text).not.toContain("abc123");
  }, 60_000);

  it("finding 4: a sensitive rename in the summary is listed by name only, in both directions", async () => {
    bulkBase(); write(".env", "SECRET_TOKEN=one\n".repeat(20)); write("a.txt", "SHARED=two\n".repeat(20));
    git("add", "-A"); git("commit", "-qm", "base");
    bulkChange();
    git("mv", ".env", "b.txt"); // sensitive => plain
    git("rm", "-q", "a.txt"); write("prod.env", "SHARED=two\n".repeat(20)); // plain deleted, sensitive added with its content
    git("add", "-A");
    const text = await diff({ mode: "cached" });
    expect(text).toMatch(/^\[router_git\] diff summary: /);
    expect(text).toContain(".env => b.txt | sensitive: content withheld\n");
    expect(text).toContain("a.txt => prod.env | sensitive: content withheld\n");
    expect(text).not.toMatch(/(?:b\.txt|a\.txt|prod\.env) \| [+b]/);
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("SHARED");
  }, 60_000);

  it("finding 4: a scoped work root's summary keeps its scope and its linked-directory excludes, and carries the note", async () => {
    bulkBase("pkg"); write("pkg/linked/x.txt", "tracked\n"); write("other/o.ts", lines("outside old", 40));
    git("add", "-A"); git("commit", "-qm", "base");
    bulkChange("pkg"); write("other/o.ts", lines("outside new", 40));
    const target = join(outside, "target");
    mkdirSync(target); writeFileSync(join(target, "y.txt"), "elsewhere\n");
    rmSync(join(root, "pkg", "linked"), RM);
    const link = join(root, "pkg", "linked");
    symlinkSync(target, link, WIN ? "junction" : "dir");
    try {
      const text = await diff({}, { resolveWorkRoot: () => ({ role: true, root: join(root, "pkg") }), summarizeDiffs: true });
      expect(text).toMatch(/^\[router_git\] diff summary: 17 files \(17 changed\), \+204 -204; the patch exceeds 8 KiB/);
      expect(text).not.toContain("other/o.ts");
      expect(text).not.toContain("pkg/linked/");
      expect(text.trimEnd().endsWith("[router_git] skipped tracked directories replaced by symlinks/junctions: pkg/linked")).toBe(true);
      expect(bytes(text)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    } finally {
      try { unlinkSync(link); } catch { rmdirSync(link); }
    }
  }, 60_000);

  it("finding 4: the summary applies through root= (another admitted repository), after its provenance line", async () => {
    const lib = realpathSync.native(mkdtempSync(join(tmpdir(), "router-diff-summary-lib-")));
    try {
      const inLib = (...args: string[]) => execFileSync(gitExecutable(), ["-c", "gc.auto=0", ...args], { cwd: lib, env: gitEnvironment(), encoding: "utf8" });
      inLib("init", "-q", "-b", "main");
      for (const [key, value] of [["user.email", "t@example.invalid"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) inLib("config", key!, value!);
      for (let i = 0; i < 17; i++) writeFileSync(join(lib, `l${i}.ts`), lines(`lib old ${i}`, 12));
      inLib("add", "-A"); inLib("commit", "-qm", "base");
      for (let i = 0; i < 17; i++) writeFileSync(join(lib, `l${i}.ts`), lines(`lib new ${i}`, 12));
      const provenance = "[router: read from lib (main) at somewhere — read-only in this dispatch]";
      const resolveRoot: GitRootResolver = async () => ({ ok: true, inWorkRoot: false, root: lib, repository: lib, name: "lib", branch: "main", workRoot: root, provenance });
      const text = await diff({ root: lib }, { ...ROLE, resolveRoot });
      expect(text.startsWith(`${provenance}\n[router_git] diff summary: 17 files (17 changed), +204 -204; the patch exceeds 8 KiB`)).toBe(true);
      expect(await diff({ root: lib }, { resolveWorkRoot: ROLE.resolveWorkRoot!, resolveRoot })).toContain("@@");
    } finally {
      rmSync(lib, RM);
    }
  }, 60_000);

  it("finding 4/7: more than 200 excluded paths, or excludes past the argv bound, give the many-excluded summary", async () => {
    for (let i = 0; i < 201; i++) write(`test/fixtures/f${i}.json`, `{"v":1}\n`);
    git("add", "-A"); git("commit", "-qm", "base");
    for (let i = 0; i < 201; i++) write(`test/fixtures/f${i}.json`, `{"v":2}\n`);
    const many = await diff();
    expect(many).toMatch(/^\[router_git\] diff summary: 201 files \(201 content excluded\), \+201 -201; too many files with excluded content to leave out of the patch/);
    expect(bytes(many)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    git("checkout", "--", ".");
    // 150 excluded paths (under the count bound) whose literal excludes pass 30000 argv characters: index-only, no worktree files.
    const blob = gitInput("x\n", ["hash-object", "-w", "--stdin"]).trim();
    const names = Array.from({ length: 150 }, (_, i) => `test/fixtures/${"d".repeat(190)}-${i}.json`);
    gitInput(names.map(name => `100644 ${blob} 0\t${name}\n`).join(""), ["update-index", "--add", "--index-info"]);
    const long = await diff({ mode: "cached" });
    expect(long).toMatch(/^\[router_git\] diff summary: 150 files \(150 content excluded\), \+150 -0; too many files with excluded content/);
    expect(bytes(long)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
  }, 120_000);

  it("finding 4: a patch of exactly 8192 bytes is returned as is; one byte more is summarized", async () => {
    write("big.txt", "a\n"); git("add", "-A"); git("commit", "-qm", "base");
    const sized = (length: number) => write("big.txt", `${"z".repeat(length)}\n`);
    sized(4000);
    const base = bytes(await diff({}, {}));
    const exact = 4000 + DIFF_SUMMARY_THRESHOLD_BYTES - base;
    sized(exact);
    const at = await diff({}, {});
    expect(bytes(at)).toBe(DIFF_SUMMARY_THRESHOLD_BYTES);
    expect(await diff()).toBe(at);
    sized(exact + 1);
    expect(bytes(await diff({}, {}))).toBe(DIFF_SUMMARY_THRESHOLD_BYTES + 1);
    expect(await diff()).toMatch(/^\[router_git\] diff summary: 1 file \(1 changed\), \+1 -1; the patch exceeds 8 KiB/);
  }, 60_000);

  it("finding 4: non-ASCII names shown raw (core.quotePath=false) stay within the 4096-byte cap", async () => {
    git("config", "core.quotePath", "false");
    for (let i = 0; i < 300; i++) write(`src/日本語-ファイル-ação-${i}.ts`, `v1 ${i}\n`);
    git("add", "-A"); git("commit", "-qm", "base");
    for (let i = 0; i < 300; i++) write(`src/日本語-ファイル-ação-${i}.ts`, `v2 ${i}\n`);
    const text = await diff();
    expect(text).toContain("src/日本語-ファイル-ação-0.ts | +1 -1\n");
    expect(bytes(text)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(text.length).toBeLessThan(bytes(text));
    const listed = text.split("\n").filter(line => / \| \+1 -1$/.test(line)).length;
    const omitted = Number(/\[router_git\] (\d+) more entries not shown \(\1 changed\)/.exec(text)?.[1]);
    expect(listed + omitted).toBe(300);
  }, 120_000);
});
