import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import {
  dropPartialCredential, errorMessage, quoteGitPath, GIT_OPERATIONS, gitArgv, gitCandidates, gitEnvironment, gitExecutable, gitTools, hardeningArgs, inspectGit,
  linkedTrackedDirectories, numstatNames, parseInheritedConfig, runBoundedProcess, selectGitExecutable, stripUrlUserinfo, validatePath, validateRef,
  type GitInput, type GitInspectOptions, type GitOperation,
} from "../../src/router/git-tools";
import { sensitiveGitPathspecs, SENSITIVE_PATH_PATTERNS } from "../../src/router/sensitive-paths";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const WIN = process.platform === "win32";
const INHERITED_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"] as const;
let root: string;
let outside: string;
let savedEnv: Partial<Record<typeof INHERITED_ENV[number], string>>;

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset();
  root = mkdtempSync(join(tmpdir(), "router-git-"));
  outside = mkdtempSync(join(tmpdir(), "router-git-outside-"));
  savedEnv = {};
  for (const name of INHERITED_ENV) if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
  // System/global settings the tools inherit (G9) are isolated; G9 tests opt in.
  writeFileSync(join(outside, "empty.gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(outside, "empty.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_CONFIG_SYSTEM;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of INHERITED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const slash = (path: string) => path.replaceAll("\\", "/");
const gitIn = (cwd: string, ...args: string[]) => execFileSync(gitExecutable(), args, { cwd, env: gitEnvironment(), encoding: "utf8" });
const git = (...args: string[]) => gitIn(root, ...args);
/** Plain git with no read-only hardening: the positive control for every vector. */
function plain(cwd: string, ...args: string[]): string {
  const env = gitEnvironment();
  for (const name of ["GIT_OPTIONAL_LOCKS", "GIT_PAGER", "PAGER", "GIT_ATTR_NOSYSTEM"]) delete env[name];
  try {
    return execFileSync(gitExecutable(), args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (error) {
    return `failed: ${String(error)}`;
  }
}
function repository(dir = root) {
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.email", "test@example.invalid"); gitIn(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "file.txt"), "first\n");
  gitIn(dir, "add", "file.txt"); gitIn(dir, "commit", "-qm", "initial");
}
/** Content, size and mtime of every file under .git, plus the set of entries. */
function gitDirDigest(repo: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(`${relative(repo, path)}\0`);
      if (entry.isDirectory()) { walk(path); continue; }
      const stats = statSync(path);
      hash.update(`${stats.size}:${stats.mtimeMs}\0`).update(readFileSync(path));
    }
  };
  walk(join(repo, ".git"));
  return hash.digest("hex");
}
/** Every tool call is wrapped in a .git hash check: inspection must never write. */
async function inspect(operation: GitOperation, input: GitInput = {}, at: { dir?: string; repo?: string; options?: GitInspectOptions } = {}): Promise<string> {
  const repo = at.repo ?? root;
  const before = gitDirDigest(repo);
  try {
    return await inspectGit(operation, input, at.dir ?? root, undefined, at.options);
  } finally {
    expect(gitDirDigest(repo), `${operation} ${JSON.stringify(input)} changed .git`).toBe(before);
  }
}
const markerCommand = (marker: string) => `: > '${slash(marker)}'`;
function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return slash(path);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
const OLD = new Date(Date.now() - 86_400_000);

/** Deterministic transport faults without executing a replacement Git binary. */
function fakeGit(reply: (args: readonly string[]) => { code?: number; stdout?: string | Buffer; stderr?: string }) {
  return vi.mocked(childProcess.spawn).mockImplementation((_executable, args) => {
    const child = Object.assign(new childProcess.ChildProcess(), { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    const result = reply(Array.isArray(args) ? args : []);
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("exit", result.code ?? 0);
      child.emit("close", result.code ?? 0);
    });
    return child;
  });
}

function metadataReply(args: readonly string[]) {
  if (args.includes("--show-toplevel")) return { stdout: `${root}\n` };
  if (args.includes("config")) return { code: 1 };
  return { stdout: "" };
}

describe("shell-free git inspection", () => {
  it.each(["-o", "--output=x", "a b", "a;b", "a|b", "$(whoami)", "`whoami`", "x".repeat(201), ""])("rejects ref %s", ref => {
    expect(() => validateRef(ref)).toThrow();
  });
  it.each(["-o", "--output=x", "../secret", "a/../../secret", "a\\..\\secret", "/outside", "C:\\outside", "\\\\host\\share", "x".repeat(4097), "", "file.txt::$DATA", "C:foo"])("rejects path %s", path => {
    expect(() => validatePath(root, path)).toThrow();
  });
  it("accepts refs, ranges and literal relative paths; rejects invalid limits and modes", () => {
    expect(validateRef("HEAD~2..origin/main")).toBe("HEAD~2..origin/main");
    expect(validatePath(root, "folder/file name.ts")).toBe("folder/file name.ts");
    for (const limit of [0, -1, 51, 1.5, NaN]) expect(() => gitArgv("log", { limit }, root)).toThrow();
    expect(() => gitTools().router_git_diff!.args.mode?.parse("--output=x")).toThrow();
    expect(() => gitArgv("blame", {}, root)).toThrow("requires path");
  });
  it("rejects escaping directory symlinks/junctions and absolute paths inside the repo too", () => {
    symlinkSync(outside, join(root, "escape"), WIN ? "junction" : "dir");
    expect(() => validatePath(root, "escape/new.txt")).toThrow("escapes");
    expect(() => validatePath(root, join(root, "file.txt"))).toThrow("relative path");
  });
  it("rejects paths through a link even when it points inside the repository (G5)", () => {
    repository();
    symlinkSync(join(root, ".git"), join(root, "gitlink"), WIN ? "junction" : "dir");
    expect(() => validatePath(root, "gitlink/config")).toThrow("junction");
    expect(() => validatePath(root, "gitlink")).toThrow("junction");
    expect(validatePath(root, "file.txt")).toBe("file.txt");
  });
  it.each(["CON", "nul", "aux.txt", "COM1", "lpt9.log", "CONIN$", "conout$.x", "con/x", "dir/PRN", "COM\u00b9", "file.txt.", "file.txt ", "dir./x", "a\u00a0b", "x\u202e", "\u2066x", "x\u200f"])(
    "rejects Windows-unsafe path %j on win32 (G13)", path => {
      expect(() => validatePath(root, path, "win32")).toThrow("Invalid git path");
    });
  it("accepts names that only resemble Windows device names (G13)", () => {
    for (const path of ["CONFIG.md", "console/x.ts", "auxiliary.txt", "com10.txt", "lpt.txt", ".env.example", "./file.txt"]) {
      expect(validatePath(root, path, "win32")).toBe(path);
    }
    expect(validatePath(root, "CON", "linux")).toBe("CON");
  });
  it.each(GIT_OPERATIONS)("hardens %s argv and environment", operation => {
    const args = gitArgv(operation, { path: "file.txt" }, root);
    expect(args.slice(0, hardeningArgs().length)).toEqual(hardeningArgs());
    for (const flag of ["--no-optional-locks", "--no-pager", "core.pager=cat", "core.fsmonitor=false", "diff.external=", "protocol.allow=never",
      "log.showSignature=false", "gpg.program=", "gpg.ssh.program=", "diff.autoRefreshIndex=false", "core.splitIndex=false", "index.threads=1"]) expect(args).toContain(flag);
    expect(args.some(a => a.startsWith("core.hooksPath="))).toBe(true);
    if (["diff", "show", "log"].includes(operation)) {
      expect(args).toContain("--no-ext-diff"); expect(args).toContain("--no-textconv");
    }
    if (["show", "log"].includes(operation)) expect(args).toContain("--no-show-signature");
    if (operation === "blame") {
      expect(args).toContain("--no-ignore-revs-file");
      expect(args.slice(-2)).toEqual(["--", "file.txt"]);
    } else {
      expect(args.slice(args.indexOf("--"))).toEqual(["--", ":(literal)file.txt",
        ...(["show", "diff", "log"].includes(operation) ? sensitiveGitPathspecs() : [])]);
    }
    expect(gitArgv(operation, { path: "file.txt" }, root, { config: ["-c", "x.y=z"], exclude: ["linked"] }).join(" "))
      .toMatch(operation === "blame" ? /x\.y=z.* -- file\.txt$/ : /x\.y=z.* -- :\(literal\)file\.txt .*:\(exclude,literal\)linked$/);
    expect(gitEnvironment()).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" });
  });
  it("withholds committed sensitive content from patch tools and refuses explicit paths/blob refs (G8)", async () => {
    repository();
    mkdirSync(join(root, "nested")); mkdirSync(join(root, ".aws"));
    const secrets = [".env", "id_rsa", "nested/cert.pem", ".aws/credentials", ".env.e", ".env.exampl", ".env.example2",
      ...SENSITIVE_PATH_PATTERNS.map(pattern => `nested/${pattern.replaceAll("*", "fixture")}`)];
    for (const path of secrets) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "SECRET_G8_ORIGINAL\n");
    }
    writeFileSync(join(root, ".env.example"), "PUBLIC_EXAMPLE\n");
    writeFileSync(join(root, "file.txt"), "PUBLIC_ORDINARY\n");
    git("add", "."); git("commit", "-qm", "fixture");
    const blob = git("rev-parse", "HEAD:.env").trim();
    expect(git("show", "HEAD:.env")).toContain("SECRET_G8_ORIGINAL");
    for (const path of secrets) writeFileSync(join(root, path), "SECRET_G8_MODIFIED\n");
    writeFileSync(join(root, "file.txt"), "PUBLIC_CHANGED\n");
    for (const operation of ["show", "diff", "log"] as const) {
      const output = await inspect(operation);
      expect(output, operation).not.toContain("SECRET_G8");
      expect(output, operation).toContain("PUBLIC_");
      if (operation !== "diff") expect(output).toContain("PUBLIC_EXAMPLE");
    }
    expect(await inspect("blame", { path: "file.txt" })).toContain("PUBLIC_CHANGED");
    for (const operation of ["show", "diff", "log", "blame"] as const) {
      for (const path of [...secrets, ".aws/./credentials"]) await expect(inspect(operation, { path })).rejects.toThrow("use read");
    }
    for (const ref of ["HEAD:.env", ":0:.env", blob]) await expect(inspect("show", { ref })).rejects.toThrow("use read");
    if (WIN) {
      writeFileSync(join(root, "UPPER.PEM"), "SECRET_G8_UPPER\n");
      git("add", "UPPER.PEM"); git("commit", "-qm", "uppercase");
      expect(await inspect("show")).not.toContain("SECRET_G8");
    }
  }, 30_000);
  it("preserves in-tree text/eol/binary attributes without running drivers (R2-1)", async () => {
    repository(); git("config", "core.autocrlf", "false");
    writeFileSync(join(root, ".gitattributes"), "* text=auto\n*.bat text eol=crlf\n*.bin binary\npackage-lock.json -diff\n");
    for (const name of ["a.bat", "b.txt", "x.bin", "package-lock.json"]) writeFileSync(join(root, name), "one\ntwo\n");
    git("add", "-A"); git("commit", "-qm", "attributes");
    rmSync(join(root, "a.bat")); git("checkout", "--", "a.bat");
    expect(readFileSync(join(root, "a.bat"), "utf8")).toContain("\r\n");
    for (const name of ["a.bat", "b.txt"]) {
      utimesSync(join(root, name), OLD, OLD);
      expect(await inspect("blame", { path: name })).toBe(plain(root, "blame", "--", name));
    }
    expect(await inspect("status")).toBe(plain(root, "--no-optional-locks", "status", "--porcelain=v1"));
    for (const name of ["x.bin", "package-lock.json"]) writeFileSync(join(root, name), "changed\n");
    expect((await inspect("diff")).split("[router_git stderr]\n")[0]).toBe(plain(root, "diff"));
    expect(await inspect("diff")).toContain("Binary files");
  }, 30_000);
  it("retains sensitive-only history and annotated tag messages, rejecting non-commit targets and show ranges (R2-2/4)", async () => {
    repository();
    writeFileSync(join(root, "app.ts"), "a\n"); git("add", "app.ts"); git("commit", "-qm", "A");
    writeFileSync(join(root, ".env"), "SECRET_ONLY\n"); git("add", ".env"); git("commit", "-qm", "B");
    writeFileSync(join(root, "app.ts"), "c\n"); git("commit", "-qam", "C");
    const log = await inspect("log", { limit: 3 });
    expect([...log.matchAll(/^    (.+)$/gm)].map(match => match[1])).toEqual(["C", "B", "A"]);
    expect(log).toContain("changes to sensitive files withheld");
    expect(log).not.toContain("SECRET_ONLY");
    expect(await inspect("show", { ref: "HEAD~1" })).toContain("changes to sensitive files withheld");
    git("tag", "-a", "v1", "-m", "release notes");
    expect(await inspect("show", { ref: "v1" })).toContain("release notes");
    git("tag", "-a", "blob-tag", git("rev-parse", "HEAD:app.ts").trim(), "-m", "not a commit");
    for (const ref of ["blob-tag", "HEAD^{tree}", "missing"]) await expect(inspect("show", { ref })).rejects.toThrow("use read");
    await expect(inspect("show", { ref: "HEAD~2..HEAD" })).rejects.toThrow("not ranges");
    git("commit", "--allow-empty", "-qm", "empty");
    expect(await inspect("show")).not.toContain("withheld");
  }, 30_000);

  it("keeps path-limited log subjects equal to plain Git despite unrelated sensitive-only commits (R3-1)", async () => {
    repository();
    for (const [subject, path] of [["A", "app.ts"], ["B", "other.ts"], ["C", "app.ts"], ["D", ".env"], ["E", "app.ts"]] as const) {
      writeFileSync(join(root, path), `${subject}\n`);
      git("add", "--", path); git("commit", "-qm", subject);
    }
    for (const path of ["app.ts", "other.ts"]) {
      for (const limit of [1, 20]) {
        const output = await inspect("log", { path, limit });
        const subjects = [...output.matchAll(/^    (.+)$/gm)].map(match => match[1]);
        expect(subjects).toEqual(plain(root, "log", `--max-count=${limit}`, "--format=%s", "--", path).trim().split("\n"));
        expect(output).not.toContain("withheld");
      }
    }
  }, 30_000);

  describe("marker matrix: repository-configured programs never run (G1, G2, G14)", () => {
    /** Two commits, a signed tip, .gitattributes naming every driver, stale worktree changes. */
    function vectorRepository() {
      repository();
      writeFileSync(join(root, "b.dat"), "data one\n");
      writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil diff=evil\n*.dat filter=proc diff=evcmd\n");
      git("add", "-A"); git("commit", "-qm", "attributes");
      const tree = git("rev-parse", "HEAD^{tree}").trim();
      const parent = git("rev-parse", "HEAD").trim();
      const body = `tree ${tree}\nparent ${parent}\nauthor T <t@example.invalid> 1700000000 +0000\ncommitter T <t@example.invalid> 1700000000 +0000\n`
        + "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEAAAA\n -----END PGP SIGNATURE-----\n\nsigned\n";
      const signed = execFileSync(gitExecutable(), ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: root, env: gitEnvironment(), input: body, encoding: "utf8" }).trim();
      git("update-ref", "refs/heads/main", signed);
      writeFileSync(join(root, "file.txt"), "worktree change\n");
      writeFileSync(join(root, "b.dat"), "data two\n");
      for (const name of ["file.txt", "b.dat", ".gitattributes"]) utimesSync(join(root, name), OLD, OLD);
    }
    function includeFile(marker: string): string {
      const gpg = script(join(root, ".git", "include-gpg.sh"), `${markerCommand(marker)}\nexit 1`);
      const file = join(root, ".git", "included.config");
      writeFileSync(file, `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = "${gpg}"\n[filter "evil"]\n\tclean = "${markerCommand(marker)}; cat"\n`);
      return slash(file);
    }
    const ran = (...commands: string[][]) => (marker: string) => { for (const command of commands) plain(root, ...command); return existsSync(marker); };
    const vectors: Array<{ name: string; setup: (marker: string) => void; control: (marker: string) => boolean }> = [
      { name: "fsmonitor hook", setup: m => git("config", "core.fsmonitor", script(join(root, ".git", "fsmonitor.sh"), markerCommand(m))), control: ran(["status", "--porcelain"]) },
      { name: "hooks", setup: m => {
        const hooks = join(root, ".git", "evilhooks"); mkdirSync(hooks);
        for (const hook of ["post-index-change", "reference-transaction", "post-checkout", "pre-auto-gc"]) script(join(hooks, hook), markerCommand(m));
        git("config", "core.hooksPath", slash(hooks));
      }, control: ran(["status", "--porcelain"]) },
      // A pager only runs on a terminal, so the control proves the configuration is live.
      { name: "pager", setup: m => {
        git("config", "core.pager", `${markerCommand(m)}; cat`);
        for (const command of ["log", "show", "diff", "blame", "status"]) git("config", `pager.${command}`, `${markerCommand(m)}; cat`);
      }, control: m => plain(root, "var", "GIT_PAGER").includes(basename(m)) },
      { name: "external diff", setup: m => git("config", "diff.external", `${markerCommand(m)}; true`), control: ran(["diff"]) },
      { name: "textconv", setup: m => git("config", "diff.evil.textconv", `${markerCommand(m)}; cat`), control: ran(["diff"]) },
      { name: "diff driver command", setup: m => git("config", "diff.evcmd.command", `${markerCommand(m)}; true`), control: ran(["diff"]) },
      { name: "filter clean", setup: m => git("config", "filter.evil.clean", `${markerCommand(m)}; cat`), control: ran(["diff"]) },
      { name: "filter process", setup: m => { git("config", "filter.proc.process", markerCommand(m)); git("config", "filter.proc.required", "false"); }, control: ran(["diff"]) },
      { name: "filter smudge", setup: m => git("config", "filter.evil.smudge", `${markerCommand(m)}; cat`), control: ran(["cat-file", "--filters", "HEAD:file.txt"]) },
      // Both worktree and .git/info/attributes stay active; driver blanking stops these.
      { name: "filter clean via .git/info/attributes", setup: m => {
        mkdirSync(join(root, ".git", "info"), { recursive: true });
        writeFileSync(join(root, ".git", "info", "attributes"), "*.txt filter=infof diff=infod\n");
        git("config", "filter.infof.clean", `${markerCommand(m)}; cat`);
        git("config", "diff.infod.textconv", `${markerCommand(m)}; cat`);
      }, control: ran(["diff"]) },
      { name: "gpg.program via log.showSignature", setup: m => {
        git("config", "log.showSignature", "true");
        git("config", "gpg.program", script(join(root, ".git", "gpg.sh"), `${markerCommand(m)}\nexit 1`));
      }, control: ran(["log", "-1"]) },
      { name: "includeIf onbranch", setup: m => git("config", "includeIf.onbranch:main.path", includeFile(m)), control: ran(["log", "-1"], ["diff"]) },
      { name: "includeIf gitdir", setup: m => git("config", `includeIf.gitdir/i:**/${basename(root)}/.git.path`, includeFile(m)), control: ran(["log", "-1"], ["diff"]) },
      { name: "include.path", setup: m => git("config", "include.path", includeFile(m)), control: ran(["log", "-1"], ["diff"]) },
    ];
    const operations: Array<[GitOperation, GitInput]> = [
      ["status", {}], ["log", { limit: 3 }], ["diff", {}], ["diff", { mode: "stat" }], ["diff", { ref: "HEAD~1" }],
      ["show", {}], ["blame", { path: "file.txt" }], ["blame", { path: "b.dat" }], ["ls_files", {}],
    ];
    it.each(vectors)("$name: no marker from any tool, marker from plain git", async ({ setup, control }) => {
      vectorRepository();
      const marker = join(outside, "EXECUTED");
      setup(marker);
      for (const [operation, input] of operations) await inspect(operation, input);
      expect(existsSync(marker)).toBe(false);
      expect(control(marker)).toBe(true);
    }, 90_000);
  });

  it("status leaves a stale index's hash and mtime unchanged", async () => {
    repository();
    utimesSync(join(root, "file.txt"), new Date(0), new Date(0));
    const index = join(root, ".git", "index");
    const digest = () => createHash("sha256").update(readFileSync(index)).digest("hex");
    const before = { hash: digest(), mtime: statSync(index).mtimeMs };
    expect(await inspect("status")).toBe("");
    expect({ hash: digest(), mtime: statSync(index).mtimeMs }).toEqual(before);
  }, 30_000);
  it("never writes .git on split-index/manyFiles repositories with stale stat data (G3)", async () => {
    gitIn(root, "init", "-q", "-b", "main"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T");
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.txt`), `content ${i}\n`);
    git("add", "-A"); git("commit", "-qm", "base");
    git("config", "core.splitIndex", "true"); git("config", "feature.manyFiles", "true"); git("config", "splitIndex.maxPercentChange", "0");
    writeFileSync(join(root, "f9.txt"), "changed\n"); writeFileSync(join(root, "untracked.txt"), "u\n");
    for (let i = 0; i < 10; i++) utimesSync(join(root, `f${i}.txt`), OLD, OLD);
    for (const [operation, input] of [["status", {}], ["diff", {}], ["diff", { mode: "stat" }], ["diff", { ref: "HEAD" }], ["diff", { mode: "cached" }],
      ["show", {}], ["log", {}], ["blame", { path: "f1.txt" }], ["ls_files", {}]] as Array<[GitOperation, GitInput]>) await inspect(operation, input);
    expect(plain(root, "ls-files").trim().split("\n")).toHaveLength(10);
    expect(await inspect("diff", { mode: "name-only" })).toBe("f9.txt\n");
  }, 60_000);
  it("derives diff name-only from content-compared numstat, matching plain git (G3)", async () => {
    repository();
    writeFileSync(join(root, "other.txt"), "x\n"); git("add", "-A"); git("commit", "-qm", "two");
    git("mv", "file.txt", "renamed.txt"); writeFileSync(join(root, "other.txt"), "y\n");
    for (const input of [{ mode: "name-only" }, { mode: "name-only", ref: "HEAD" }, { mode: "name-only", ref: "HEAD", path: "other.txt" }] as GitInput[]) {
      expect(await inspect("diff", input)).toBe(plain(root, "diff", "--name-only", ...(input.ref ? [input.ref] : []), "--", ...(input.path ? [input.path] : [])));
    }
    expect(numstatNames("1\t1\tfile.txt\0-\t-\tbin.png\0" + "2\t0\t\0old.txt\0new.txt\0")).toEqual(["file.txt", "bin.png", "new.txt"]);
    expect(numstatNames("1\t1\ta.txt\0" + "1\t1\tpart", false)).toEqual(["a.txt"]);
  }, 30_000);
  it("resolves the session's repository root from a subdirectory of its worktree", async () => {
    repository(); mkdirSync(join(root, "sub"));
    expect(await inspect("ls_files", {}, { dir: join(root, "sub"), options: { worktree: root } })).toContain("file.txt");
  }, 30_000);
  it("does not discover a repository above the session worktree (G11)", async () => {
    repository(); mkdirSync(join(root, "proj"));
    await expect(inspect("ls_files", {}, { dir: join(root, "proj"), options: { worktree: join(root, "proj") } })).rejects.toThrow(/not a git repository/i);
    // No boundary (or an unrelated project) falls back to the nearest checkout.
    expect(await inspect("ls_files", {}, { dir: join(root, "proj"), options: { worktree: outside } })).toContain("file.txt");
    expect(await inspect("ls_files", {}, { dir: join(root, "proj"), options: { worktree: root } })).toContain("file.txt");
  }, 30_000);
  it("refuses a core.worktree that points outside the session worktree (G11)", async () => {
    repository();
    writeFileSync(join(outside, "victim.env"), "OUTSIDE_SECRET=1\n");
    git("config", "core.worktree", slash(outside));
    for (const operation of ["status", "ls_files", "diff"] as const) {
      await expect(inspect(operation)).rejects.toThrow("outside the session worktree");
    }
  }, 30_000);
  it("refuses a git executable inside the session repository before spawning it (G4)", async () => {
    repository();
    const bin = join(root, "node_modules", ".bin"); mkdirSync(bin, { recursive: true });
    const marker = join(outside, "FAKE_GIT_RAN");
    const fake = join(bin, WIN ? "git.exe" : "git");
    script(fake, `${markerCommand(marker)}\necho ${slash(root)}`);
    const real = gitExecutable();
    const candidates = gitCandidates({ ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
    expect(candidates).toContain(realpathSync.native(fake));
    if (WIN) expect(candidates[0]).not.toBe(realpathSync.native(fake)); // the Git for Windows install is preferred
    expect(selectGitExecutable(candidates, [root])).not.toBe(realpathSync.native(fake));
    expect(() => selectGitExecutable([realpathSync.native(fake)], [root])).toThrow("inside the session");
    expect(() => selectGitExecutable([], [root])).toThrow("not found");
    // Refused before anything runs (a spawned non-PE "git.exe" would fail differently).
    await expect(inspect("ls_files", {}, { options: { executables: [realpathSync.native(fake)] } })).rejects.toThrow("inside the session repository");
    await expect(inspect("ls_files", {}, { dir: join(root, "node_modules"), options: { executables: [realpathSync.native(fake)] } })).rejects.toThrow("inside the session repository");
    expect(await inspect("ls_files", {}, { options: { executables: [realpathSync.native(fake), real] } })).toContain("file.txt");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
  it("excludes tracked directories replaced by a junction/symlink (G5)", async () => {
    repository();
    mkdirSync(join(root, "escape", "deep"), { recursive: true });
    writeFileSync(join(root, "escape", "secret.txt"), "placeholder\n");
    writeFileSync(join(root, "escape", "deep", "more.txt"), "placeholder\n");
    writeFileSync(join(root, "ok.txt"), "ok\n");
    git("add", "-A"); git("commit", "-qm", "tracked directory");
    mkdirSync(join(outside, "jdir", "deep"), { recursive: true });
    writeFileSync(join(outside, "jdir", "secret.txt"), "TOPSECRET_OUTSIDE\n");
    writeFileSync(join(outside, "jdir", "deep", "more.txt"), "TOPSECRET_DEEP\n");
    rmSync(join(root, "escape"), { recursive: true });
    symlinkSync(join(outside, "jdir"), join(root, "escape"), WIN ? "junction" : "dir");
    writeFileSync(join(root, "ok.txt"), "ok changed\n");
    if (WIN) expect(plain(root, "diff")).toContain("TOPSECRET"); // positive control: plain git reads through the junction
    for (const [operation, input] of [["diff", {}], ["diff", { mode: "stat" }], ["diff", { mode: "name-only" }], ["diff", { ref: "HEAD" }], ["status", {}]] as Array<[GitOperation, GitInput]>) {
      const output = await inspect(operation, input);
      expect(output).not.toContain("TOPSECRET");
      expect(output).toContain("skipped tracked directories replaced by symlinks/junctions: escape");
    }
    expect(await inspect("diff", {})).toContain("+ok changed");
    await expect(inspect("blame", { path: "escape/secret.txt" })).rejects.toThrow();
    await expect(inspect("diff", { path: "escape" })).rejects.toThrow();
    expect(await inspect("diff", { mode: "cached" })).toBe("");
  }, 60_000);
  it("checks each tracked directory prefix once and bounds the number of checks (G5)", async () => {
    mkdirSync(join(root, "real", "nested"), { recursive: true });
    symlinkSync(outside, join(root, "link"), WIN ? "junction" : "dir");
    const paths = ["top.txt", "real/a.txt", "real/nested/b.txt", "real/nested/c.txt", "missing/x/y.txt", ...Array.from({ length: 500 }, (_, i) => `link/sub${i}/f.txt`)];
    expect(await linkedTrackedDirectories(root, paths)).toEqual(["link"]);
    await expect(linkedTrackedDirectories(root, Array.from({ length: 100_001 }, (_, i) => `d${i}/f.txt`))).rejects.toThrow(/Tracked-directory cap.*mode: cached.*range/);
  });
  it("never reads blame.ignoreRevsFile (G6)", async () => {
    repository();
    writeFileSync(join(outside, "ignore-revs.env"), "API_KEY=sk-live-IGNOREREVS-LEAK\n");
    git("config", "blame.ignoreRevsFile", slash(join(outside, "ignore-revs.env")));
    expect(plain(root, "blame", "--", "file.txt")).toContain("sk-live"); // positive control
    const output = await inspect("blame", { path: "file.txt" });
    expect(output).toContain("first");
    expect(output).not.toContain("sk-live");
  }, 30_000);
  it("inherits allowlisted system/global line-ending settings below repository settings (G9)", async () => {
    gitIn(root, "init", "-q", "-b", "main"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T");
    writeFileSync(join(root, "a.txt"), "one\r\ntwo\r\n");
    git("-c", "core.autocrlf=true", "add", "a.txt"); git("commit", "-qm", "crlf checkout");
    utimesSync(join(root, "a.txt"), OLD, OLD);
    // Without Git for Windows' system core.autocrlf=true, the CRLF checkout looks modified.
    expect(await inspect("status")).toContain("a.txt");
    expect(await inspect("blame", { path: "a.txt" })).toContain("Not Committed Yet");
    const global = join(outside, "autocrlf.gitconfig");
    writeFileSync(global, `[core]\n\tautocrlf = true\n\tpager = "${markerCommand(join(outside, "PAGER_RAN"))}"\n[safe]\n\tdirectory = *\n`);
    process.env.GIT_CONFIG_GLOBAL = global;
    expect(await inspect("status")).toBe("");
    expect(await inspect("blame", { path: "a.txt" })).not.toContain("Not Committed Yet");
    git("config", "core.autocrlf", "false"); // a repository value keeps precedence
    expect(await inspect("blame", { path: "a.txt" })).toContain("Not Committed Yet");
    expect(existsSync(join(outside, "PAGER_RAN"))).toBe(false);
  }, 30_000);
  it("parses only allowlisted, non-executing inherited settings (G9)", () => {
    expect(parseInheritedConfig("core.autocrlf\ntrue\0core.pager\nevil\0safe.directory\n*\0core.eol\nbogus\0core.longpaths\0filter.x.clean\ncat\0core.safecrlf\nwarn\0safe.directory\0core.eol\nlf\0"))
      .toEqual(["core.autocrlf=true", "safe.directory=*", "core.longpaths=true", "core.safecrlf=warn", "core.eol=lf"]);
    expect(parseInheritedConfig("__proto__\nx\0safe.directory\nbad\nvalue\0")).toEqual([]);
  });
  it.each([
    ["https://user:token@host/repo", "https://host/repo"],
    ["https://user:p@ss@host/r", "https://host/r"],
    ["https://user:pa/ss@host/r", "https://host/r"],
    ["ssh://git:pw@host:22/r", "ssh://host:22/r"],
    ["user:pass@host:repo", "host:repo"],
    ["git@github.com:org/repo", "github.com:org/repo"],
    ["url=\"deploy:hunter2@host:repo\"", "url=\"host:repo\""],
    ["HTTPS://U:P@H/x", "HTTPS://H/x"],
    ["postgres://admin:hunter2@db:5432/x", "postgres://db:5432/x"],
    ["url = https://ghp_TOKEN@github.com/o/r.git", "url = https://github.com/o/r.git"],
    ["https://user:secret%40x@host/", "https://host/"],
    ["https://host/r?access_token=SECRET&x=1", "https://host/r?access_token=***&x=1"],
    ["https://host/r?token=SECRET", "https://host/r?token=***"],
    ["https://host/login?user=a&password=hunter2", "https://host/login?user=a&password=***"],
    ["see https://example.com/a,https://u:p@h/x", "see https://example.com/a,https://h/x"],
    ["Reported-by: alice@example.com: fixed", "Reported-by: alice@example.com: fixed"],
    ["FROM node@sha256:abcdef0123", "FROM node@sha256:abcdef0123"],
    ["https://registry.npmjs.org/@babel/core", "https://registry.npmjs.org/@babel/core"],
    ["Signed-off-by: A <a@b.c>", "Signed-off-by: A <a@b.c>"],
  ])("redacts URL credentials: %s (G10)", (input, expected) => {
    expect(stripUrlUserinfo(input)).toBe(expected);
  });
  it("strips URL credentials including scp-style remotes", () => {
    expect(stripUrlUserinfo("https://user:token@host/repo ssh://git@host/repo git@host:repo")).toBe("https://host/repo ssh://host/repo host:repo");
  });
  it("drops only a final token that may hold a partial credential (G10)", () => {
    expect(dropPartialCredential("safe https://user:secr")).toBe("safe ");
    expect(dropPartialCredential("x deploy:hunt")).toBe("x ");
    expect(dropPartialCredential("x deploy@ho")).toBe("x ");
    expect(dropPartialCredential("var x={a:1,b:2}")).toBe("var x={a:1,");
    expect(dropPartialCredential("plain words only")).toBe("plain words only");
    expect(dropPartialCredential("a".repeat(5000))).toBe("a".repeat(5000));
    const started = performance.now();
    stripUrlUserinfo(`${"a.b,c:d;".repeat(8000)}`);
    dropPartialCredential(`${"a.b,c:d;".repeat(8000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  it("bounds output, reports truncation and cannot leak a partial credential", async () => {
    const out = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('safe https://user:secret@host/' + 'x'.repeat(100000))"], root, { maxBytes: 24 });
    expect(out).toContain("truncated"); expect(out).not.toContain("secret"); expect(out.length).toBeLessThan(100);
  });
  it("still returns content from a truncated minified single-line file (G10)", async () => {
    repository();
    writeFileSync(join(root, "minified.js"), "a".repeat(200_000));
    git("add", "-A"); git("commit", "-qm", "minified");
    const output = await inspect("show", { ref: "HEAD", path: "minified.js" });
    expect(output).toContain("a".repeat(60_000));
    expect(output).toContain("[truncated");
  }, 30_000);
  it("times out and aborts the process tree", async () => {
    await expect(runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, { timeoutMs: 100 })).rejects.toThrow("timed out");
    const controller = new AbortController();
    const result = runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, { signal: controller.signal });
    controller.abort(); await expect(result).rejects.toThrow("aborted");
    await expect(runBoundedProcess(process.execPath, [], root, { signal: controller.signal })).rejects.toThrow("aborted");
  });
  it("settles after a timeout although a re-parented grandchild keeps the pipes open (G7)", async () => {
    const pidFile = join(root, "grandchild.pid");
    // parent -> middle (exits) -> grandchild (detached, inherits stdout/stderr). taskkill /T and
    // POSIX group kill cannot reach the orphan, so `close` never fires.
    const middle = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));g.unref();`;
    const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
    const started = performance.now();
    try {
      await expect(runBoundedProcess(process.execPath, ["-e", parent], root, { timeoutMs: 2_000 })).rejects.toThrow("timed out");
      expect(performance.now() - started).toBeLessThan(6_000);
      expect(existsSync(pidFile)).toBe(true);
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(true); // the pipe holder really survived
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  }, 30_000);
  it("does not start a sleeping filter and settles well inside the deadline (G1, G7)", async () => {
    repository();
    const marker = join(outside, "SLOW_FILTER_RAN");
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=slow\n");
    writeFileSync(join(root, ".git", "info", "attributes"), "*.txt filter=slow\n");
    git("add", "-A"); git("commit", "-qm", "slow filter");
    git("config", "filter.slow.clean", `${markerCommand(marker)}; sleep 30; cat`);
    writeFileSync(join(root, "file.txt"), "changed\n");
    const started = performance.now();
    for (const [operation, input] of [["blame", { path: "file.txt" }], ["diff", {}], ["status", {}]] as Array<[GitOperation, GitInput]>) await inspect(operation, input);
    expect(performance.now() - started).toBeLessThan(16_000);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
  it("does not grant a second 15-second budget after repository discovery", async () => {
    repository();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const result = inspectGit("status", {}, root);
      clock.mockReturnValue(15_001);
      await expect(result).rejects.toThrow("timed out");
    } finally { clock.mockRestore(); }
  });
  it("kills a spawned descendant, not just its parent, on abort", async () => {
    const pidFile = join(root, "child.pid");
    const controller = new AbortController();
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
    const result = runBoundedProcess(process.execPath, ["-e", script], root, { signal: controller.signal });
    // Attach the rejection handler immediately; startup may fail before the file appears.
    const settled = result.catch(error => String(error));
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    controller.abort();
    expect(await settled).toContain("aborted");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(false);
  });
  it("checks the working directory before spawning (G12)", async () => {
    await expect(runBoundedProcess(process.execPath, ["-e", ""], join(root, "missing"))).rejects.toThrow("does not exist");
    await expect(inspectGit("status", {}, join(root, "missing"))).rejects.toThrow("does not exist");
    await expect(runBoundedProcess(process.execPath, ["-e", "console.error('fatal: https://alice:hunter2@example.com/r'); process.exit(3)"], root))
      .rejects.toThrow(/failed \(3\): fatal: https:\/\/example\.com\/r/);
  });
  it("resolves candidates per platform: Git for Windows install first, then absolute PATH entries only (G4)", () => {
    const fakeRoot = join(outside, "Program Files");
    mkdirSync(join(fakeRoot, "Git", "cmd"), { recursive: true });
    writeFileSync(join(fakeRoot, "Git", "cmd", "git.exe"), "");
    const bin = join(outside, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\n", { mode: 0o755 }); writeFileSync(join(bin, "git.exe"), "");
    mkdirSync(join(outside, "dir-named-git", "git"), { recursive: true });
    const real = (path: string) => realpathSync.native(path);
    expect(gitCandidates({ PATH: ["relative", `"${bin}"`, "", join(outside, "dir-named-git"), join(outside, "missing")].join(":") }, "linux"))
      .toEqual(WIN ? [] : [real(join(bin, "git"))]);
    const windows = gitCandidates({ ProgramFiles: fakeRoot, Path: `bin;"${bin}";${bin}` }, "win32");
    expect(windows).toEqual([real(join(fakeRoot, "Git", "cmd", "git.exe")), real(join(bin, "git.exe"))]);
    // Without a Program Files install the installer's registry key is consulted (none off Windows).
    const registry = gitCandidates({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows", Path: "" }, "win32");
    if (!WIN) expect(registry).toEqual([]);
    else for (const candidate of registry) expect(candidate).toMatch(/git\.exe$/i);
  });
  it("rejects a failed spawn and an aborted directory scan", async () => {
    await expect(runBoundedProcess(join(outside, "no-such-git.exe"), [], root)).rejects.toThrow();
    const aborted = new AbortController(); aborted.abort();
    await expect(linkedTrackedDirectories(root, ["a/b.txt"], { signal: aborted.signal, timeoutMs: () => 1_000 })).rejects.toThrow("aborted");
  });
  it("reads inherited settings from the system config unless GIT_CONFIG_NOSYSTEM is set (G9)", async () => {
    gitIn(root, "init", "-q", "-b", "main"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T");
    writeFileSync(join(root, "a.txt"), "one\r\ntwo\r\n");
    git("-c", "core.autocrlf=true", "add", "a.txt"); git("commit", "-qm", "crlf checkout");
    const system = join(outside, "system.gitconfig");
    writeFileSync(system, "[core]\n\tautocrlf = true\n");
    process.env.GIT_CONFIG_SYSTEM = system;
    process.env.GIT_CONFIG_NOSYSTEM = "yes";
    expect(await inspect("blame", { path: "a.txt" })).toContain("Not Committed Yet");
    delete process.env.GIT_CONFIG_NOSYSTEM;
    expect(await inspect("blame", { path: "a.txt" })).not.toContain("Not Committed Yet");
  }, 30_000);
  it("refuses a repository whose driver name cannot be neutralized with -c (G1)", async () => {
    repository();
    git("config", "filter.a=b.clean", "cat");
    await expect(inspect("status")).rejects.toThrow("cannot be neutralized");
  }, 30_000);
  it("resolves a filesystem-root worktree to the nearest checkout (R2-5)", async () => {
    repository(); mkdirSync(join(root, "sub"));
    const fsRoot = realpathSync.native(root).slice(0, WIN ? 3 : 1);
    expect(await inspect("ls_files", {}, { dir: join(root, "sub"), options: { worktree: fsRoot } })).toBe("file.txt\n");
    expect(await inspect("ls_files", {}, { options: { worktree: fsRoot } })).toBe("file.txt\n");
  }, 30_000);
  it("execute reports redacted errors instead of throwing into the session (G12)", async () => {
    repository();
    const tools = gitTools();
    type Execute = (args: unknown, context: Parameters<typeof tools[string]["execute"]>[1]) => Promise<unknown>;
    const context = { sessionID: "s", messageID: "m", agent: "fast", directory: root, worktree: root, abort: new AbortController().signal,
      metadata: () => undefined, ask: async () => undefined };
    const run = (name: string, args: unknown, directory = root) => (tools[name]!.execute as Execute)(args, { ...context, directory });
    expect(await run("router_git_log", { ref: "--output=x" })).toBe("[router_git] error: Invalid git ref: use at most 200 ref characters, never an option or rev:path; use read for sensitive files (asks for approval)");
    const zod = String(await run("router_git_diff", { mode: "https://alice:hunter2@example.com/x" }));
    expect(zod).toMatch(/^\[router_git\] error: /); expect(zod).not.toContain("hunter2"); expect(zod).not.toMatch(/[\r\n]/);
    expect(String(await run("router_git_log", { ref: "doesnotexist" }))).toMatch(/^\[router_git\] error: Git inspection failed \(128\)/);
    expect(await run("router_git_status", {}, join(root, "missing"))).toBe("[router_git] error: Session directory does not exist");
    expect(await run("router_git_ls_files", {})).toBe("file.txt\n");
  }, 30_000);
  it("resolves linked worktrees from session subdirectories with missing, main-checkout or drive-root context (R2-5)", async () => {
    repository();
    const linked = join(outside, "linked");
    git("worktree", "add", "--detach", linked);
    mkdirSync(join(linked, "sub"));
    const before = gitDirDigest(root);
    for (const worktree of [undefined, root, linked, realpathSync.native(root).slice(0, WIN ? 3 : 1)]) {
      expect(await inspectGit("ls_files", {}, join(linked, "sub"), undefined, { worktree })).toBe("file.txt\n");
    }
    expect(gitDirDigest(root)).toBe(before);
  }, 30_000);
  it("matches Git C-style pathname quoting, including non-ASCII and newlines (R2-9)", async () => {
    repository();
    const names = ["é.txt", "space name.txt", ...(WIN ? [] : ['line\nbreak.txt', 'quote".txt'])];
    for (const name of names) writeFileSync(join(root, name), "original\n");
    git("add", "-A"); git("commit", "-qm", "names");
    for (const name of names) writeFileSync(join(root, name), "modified\n");
    for (const value of ["true", "false"]) {
      git("config", "core.quotePath", value);
      expect(await inspect("diff", { mode: "name-only" })).toBe(plain(root, "diff", "--name-only"));
    }
    expect(quoteGitPath("line\nbreak.txt")).toBe('"line\\nbreak.txt"');
    expect(quoteGitPath('é\n"\\\x01\x7f', false)).toBe('"é\\n\\"\\\\\\001\\177"');
    expect(quoteGitPath("é.txt")).toBe('"\\303\\251.txt"');
    expect(errorMessage("bad\n thing")).toBe("bad thing");
  }, 30_000);
  it("labels stderr independently of stdout (R2-10)", async () => {
    expect(await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('content');process.stderr.write('warning: CRLF\\n')"], root))
      .toBe("content\n[router_git stderr]\nwarning: CRLF\n");
  });
  it("settles even when tree termination and direct kill both fail (R2-8)", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new childProcess.ChildProcess(), { pid: 987654, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { throw new Error("kill denied"); }) });
    const spawn = vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
    // Windows taskkill spawn rejects; POSIX process-group kill rejects.
    spawn.mockImplementation(() => { throw new Error("tree kill denied"); });
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("tree kill denied"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = runBoundedProcess(process.execPath, [], root, { timeoutMs: 10 });
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not kill the git process tree"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not terminate git directly"));
    expect(child.kill).toHaveBeenCalled();
  });
  it.skipIf(!WIN)("falls back when taskkill emits an error (R2-8)", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new childProcess.ChildProcess(), { pid: 987654, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    const killer = new childProcess.ChildProcess();
    vi.mocked(childProcess.spawn).mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = runBoundedProcess(process.execPath, [], root, { timeoutMs: 10 });
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    killer.emit("error", new Error("taskkill unavailable"));
    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_500);
    await rejected;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("taskkill failed to start"));
    expect(child.kill).toHaveBeenCalled();
  });
  it("reports the index listing size cap with actionable alternatives (R2-6)", async () => {
    repository();
    fakeGit(args => args.includes("ls-files") ? { stdout: Buffer.alloc(32 * 1024 * 1024 + 1, 120) } : metadataReply(args));
    await expect(inspectGit("status", {}, root)).rejects.toThrow(/Tracked-index listing size cap.*mode: cached.*range/);
  });
  it.each([
    ["configuration", "ls_files", (args: readonly string[]) => args.includes("--name-only"), "Cannot read repository configuration"],
    ["tracked listing", "status", (args: readonly string[]) => args.includes("ls-files"), "Cannot list tracked files"],
    ["path quoting", "diff", (args: readonly string[]) => args.includes("--type=bool"), "Cannot read path quoting configuration"],
    ["diff names", "diff", (args: readonly string[]) => args.includes("diff"), "Git inspection failed"],
  ] as const)("reports %s query failures with redacted stderr (R2-8)", async (_label, operation, matches, error) => {
    repository();
    fakeGit(args => matches(args) ? { code: 3, stderr: "failure https://user:password@host/repo\n" } : metadataReply(args));
    await expect(inspectGit(operation, { mode: "name-only" }, root)).rejects.toThrow(`${error} (3): failure https://host/repo`);
  });
  it("rejects oversized metadata and invalid discovery output (R2-8)", async () => {
    repository();
    const mock = fakeGit(args => args.includes("--name-only") ? { stdout: "a".repeat(1024 * 1024 + 1) } : metadataReply(args));
    await expect(inspectGit("ls_files", {}, root)).rejects.toThrow("metadata exceeds its size bound");
    mock.mockRestore();
    fakeGit(args => args.includes("--show-toplevel") ? { stdout: "not-an-absolute-path\n" } : metadataReply(args));
    await expect(inspectGit("ls_files", {}, root)).rejects.toThrow("Cannot resolve repository toplevel");
  });
  it("covers invalid programmatic inputs and incomplete numstat records (R2-8)", () => {
    expect(() => gitArgv("unknown" as GitOperation, {}, root)).toThrow("Invalid git operation");
    expect(() => gitArgv("diff", { mode: "invalid" } as unknown as GitInput, root)).toThrow("Invalid git diff mode");
    expect(numstatNames("garbage\0\t\t\0old\0")).toEqual([]);
    expect(quoteGitPath("plain.txt", false)).toBe("plain.txt");
    expect(errorMessage(new Error("line one\n  line two"))).toBe("line one line two");
  });
  it("bounds name-only output without returning a partial filename (R2-8)", async () => {
    repository();
    fakeGit(args => args.includes("diff") ? { stdout: `1\t0\tcomplete.txt\0${"1\t0\tlong-name.txt\0".repeat(5_000)}` } : metadataReply(args));
    const output = await inspectGit("diff", { mode: "name-only" }, root);
    expect(output).toContain("complete.txt\n");
    expect(output).toContain("[truncated: output exceeds 65536 bytes]");
    expect(output).not.toContain("1\t0\t");
  });
  it("reports failed hidden-change metadata and failed object typing (R2-8)", async () => {
    repository();
    const oid = "1".repeat(40);
    const mock = fakeGit(args => args.includes("log") ? { stdout: `commit ${oid}\nAuthor: T\n\n    only secrets\n` }
      : args.includes("diff-tree") ? { code: 1, stderr: "object disappeared\n" } : metadataReply(args));
    await expect(inspectGit("log", {}, root)).rejects.toThrow("Cannot inspect withheld changes (1)");
    mock.mockRestore();
    fakeGit(args => args.includes("--verify") ? { stdout: oid } : args.includes("cat-file") ? { code: 1 } : metadataReply(args));
    await expect(inspectGit("show", {}, root)).rejects.toThrow("not a blob/tree");
  });
  it("caps linked-directory exclusions and abbreviates a long skip summary (R2-6/8)", async () => {
    repository();
    const paths = Array.from({ length: 201 }, (_, index) => `link${index}/file.txt`);
    for (const path of paths) symlinkSync(outside, join(root, dirname(path)), WIN ? "junction" : "dir");
    let selected = paths.slice(0, 21);
    fakeGit(args => args.includes("ls-files") ? { stdout: selected.join("\0") + "\0" }
      : args.includes("diff") ? { stdout: "content without newline" } : metadataReply(args));
    expect(await inspectGit("diff", {}, root)).toMatch(/content without newline\n\[router_git\] skipped .*\.\.\.$/);
    selected = paths;
    await expect(inspectGit("status", {}, root)).rejects.toThrow(/too many tracked directories were replaced by links.*mode: cached/);
  });
});
