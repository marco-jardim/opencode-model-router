import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import {
  dropPartialCredential, errorMessage, quoteGitPath, GIT_OPERATIONS, gitArgv, gitCandidates, gitEnvironment, gitExecutable, gitTools, hardeningArgs, inspectGit,
  linkedTrackedDirectories, numstatNames, parseInheritedConfig, PROTOCOL_HARDENING, repositoryDriverArgs, repositoryOnlyDriverArgs, runBoundedProcess,
  selectGitExecutable, stripUrlUserinfo, validatePath, validateRef, workRootReadArgs, driverListingEnvironment, collectRepositoryDriverArgs,
  DRIVER_SCOPE_ARGS, type DriverQuery, type GitInput, type GitInspectOptions, type GitOperation,
} from "../../src/router/git-tools";
import { sensitiveGitPathspecs, SENSITIVE_PATH_PATTERNS } from "../../src/router/sensitive-paths";
import { createGitRunner, withRepositoryDrivers } from "../../src/executor/git";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
// Pass-through: one test holds the include-target check (an async stat) past the listing's deadline.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
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
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const slash = (path: string) => path.replaceAll("\\", "/");
function gitIn(cwd: string, ...args: string[]): string {
  // Fixture writes must not leave detached maintenance racing the .git snapshots.
  // Command-line overrides also protect commits in tests that alter repository config.
  const run = (argv: string[]) => execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...argv],
    { cwd, env: gitEnvironment(), encoding: "utf8" });
  const output = run(args);
  if (args[0] === "init") {
    for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"], ["gc.autoDetach", "false"]] as const) {
      run(["config", key, value]);
    }
  }
  return output;
}
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
function gitDirDigest(repo: string, readContents: (path: string) => Buffer = readFileSync): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { hash.update(`${relative(repo, path)}\0`); walk(path); continue; }
      try {
        const stats = statSync(path);
        const contents = readContents(path);
        // Hash only after both reads succeed, so a disappearing lock leaves no partial entry.
        hash.update(`${relative(repo, path)}\0${stats.size}:${stats.mtimeMs}\0`).update(contents);
      } catch (error) {
        if (entry.name.endsWith(".lock") && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
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
function isZombieProcStat(stat: string): boolean {
  // /proc's comm field is parenthesized and may itself contain spaces or parentheses.
  return /^\s+Z(?:\s|$)/.test(stat.slice(stat.lastIndexOf(")") + 1));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform === "linux") {
    try {
      // kill(pid, 0) succeeds for zombies; CI container init may reap them much later.
      return !isZombieProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch (error) {
      // It may have been reaped between kill(0) and readFile. Other errors do not prove death.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
  }
  return true;
}
const OLD = new Date(Date.now() - 86_400_000);
/** Real Git LFS on this machine (`git lfs version` succeeds); the test that needs it is skipped otherwise. */
const HAS_GIT_LFS = (() => {
  try {
    execFileSync(gitExecutable(), ["lfs", "version"], { env: gitEnvironment(), stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

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
  it("recognizes Linux zombies without confusing the process name with the state", () => {
    expect(isZombieProcStat("123 (node) Z 1 123 123 0")).toBe(true);
    expect(isZombieProcStat("123 (worker (nested) name)) Z 1 123 123 0")).toBe(true);
    expect(isZombieProcStat("123 (worker Z) S 1 123 123 0")).toBe(false);
    expect(isZombieProcStat("123 (node) R 1 123 123 0")).toBe(false);
  });
  it("disables maintenance in every initialized fixture and preserves plain Git output", async () => {
    repository();
    gitIn(outside, "init", "-q", "-b", "main");
    for (const dir of [root, outside]) {
      for (const [key, value] of [["gc.auto", "0"], ["maintenance.auto", "false"], ["gc.autoDetach", "false"]] as const) {
        expect(plain(dir, "config", "--get", key).trim()).toBe(value);
      }
    }
    writeFileSync(join(root, "file.txt"), "changed\n");
    expect(await inspect("status")).toBe(plain(root, "--no-optional-locks", "status", "--porcelain=v1"));
    expect(await inspect("diff")).toBe(plain(root, "diff"));
  }, 30_000);
  it("tolerates only vanished lock files in .git snapshots, never missing or changed real files", () => {
    repository();
    const baseline = gitDirDigest(root);
    const lock = join(root, ".git", "maintenance.lock");
    writeFileSync(lock, "temporary lock");
    expect(gitDirDigest(root)).not.toBe(baseline); // Existing locks are still included.
    const removeBeforeReading = (target: string) => (path: string) => {
      if (path === target) rmSync(path);
      return readFileSync(path);
    };
    expect(gitDirDigest(root, removeBeforeReading(lock))).toBe(baseline);
    const real = join(root, ".git", "fixture-data");
    writeFileSync(real, "real data");
    const before = gitDirDigest(root);
    writeFileSync(real, "different real data");
    expect(gitDirDigest(root)).not.toBe(before);
    expect(() => gitDirDigest(root, removeBeforeReading(real))).toThrow(/ENOENT/);
  });
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
      "log.showSignature=false", "gpg.program=", "gpg.ssh.program=", "gpg.ssh.defaultKeyCommand=", "diff.autoRefreshIndex=false", "core.splitIndex=false", "index.threads=1",
      "gc.auto=0", "maintenance.auto=false",
      // Phase 4 QA (m5): every transport refused on the command line, so a repository's protocol.<name>.allow cannot re-enable one.
      "protocol.ext.allow=never", "protocol.file.allow=never", "protocol.ssh.allow=never", "protocol.git.allow=never",
      "protocol.http.allow=never", "protocol.https.allow=never"]) expect(args).toContain(flag);
    // Each refusal is a `-c` value.
    for (const name of ["ext", "file", "ssh", "git", "http", "https"]) {
      expect(args[args.indexOf(`protocol.${name}.allow=never`) - 1]).toBe("-c");
    }
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
    rmSync(join(root, "escape"), { recursive: true, maxRetries: 10, retryDelay: 200 });
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
  it("workRootReadArgs: no fsmonitor, the null-device hooksPath, no ssh key command, every transport refused; never diff.autoRefreshIndex", () => {
    const args = workRootReadArgs();
    const nul = WIN ? "NUL" : "/dev/null";
    expect(args).toEqual(["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${nul}`, "-c", "gpg.ssh.defaultKeyCommand=", "-c", "diff.external=",
      ...PROTOCOL_HARDENING]);
    expect(args.some(arg => arg.startsWith("diff.autoRefreshIndex"))).toBe(false);
    for (const name of ["ext", "file", "ssh", "git", "http", "https", "ftp", "ftps"]) expect(PROTOCOL_HARDENING).toContain(`protocol.${name}.allow=never`);
    // The same null device as hardeningArgs(), which also blanks the ssh key command now.
    expect(hardeningArgs()).toContain(`core.hooksPath=${nul}`);
    expect(hardeningArgs()[hardeningArgs().indexOf("gpg.ssh.defaultKeyCommand=") - 1]).toBe("-c");
  });
  it("repositoryOnlyDriverArgs blanks only the drivers the repository alone sets (scoped listing)", () => {
    const entry = (scope: string, key: string, value?: string) => `${scope}\0file:.git/config\0${key}${value === undefined ? "" : `\n${value}`}\0`;
    const lfs = "git-lfs clean -- %f";
    expect(repositoryOnlyDriverArgs("")).toEqual([]);
    // A global LFS filter and its `git lfs install --local` copy: kept, no argument at all.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.lfs.clean", lfs) + entry("local", "filter.lfs.clean", lfs)
      + entry("system", "filter.lfs.process", "git-lfs filter-process") + entry("local", "filter.lfs.process", "git-lfs filter-process"))).toEqual([]);
    // A system/global/command-line value alone is the user's.
    expect(repositoryOnlyDriverArgs(entry("system", "filter.a.smudge", "x") + entry("command", "merge.m.driver", "y"))).toEqual([]);
    // Repository-only programs (local, worktree, an unknown scope), a changed local copy, a merge driver, a value-less key: blanked.
    expect(repositoryOnlyDriverArgs(
      entry("global", "filter.lfs.clean", lfs) + entry("local", "filter.lfs.clean", `${lfs}; evil`)
      + entry("local", "filter.evil.process", "evil") + entry("worktree", "filter.wt.smudge", "evil") + entry("unknown", "filter.u.clean", "evil")
      + entry("local", "merge.evil.driver", "evil %A") + entry("local", "filter.bare.clean"),
    )).toEqual([
      "-c", "filter.lfs.clean=", "-c", "filter.evil.process=", "-c", "filter.wt.smudge=", "-c", "filter.u.clean=", "-c", "merge.evil.driver=",
      "-c", "filter.bare.clean=",
      "-c", "filter.lfs.required=false", "-c", "filter.evil.required=false", "-c", "filter.wt.required=false", "-c", "filter.u.required=false",
      "-c", "filter.bare.required=false",
    ]);
    // The last value wins, as for git: a command-line value after the local one is the user's; a local one after a global one is not.
    expect(repositoryOnlyDriverArgs(entry("local", "filter.x.clean", "evil") + entry("command", "filter.x.clean", "mine"))).toEqual([]);
    expect(repositoryOnlyDriverArgs(entry("global", "filter.x.clean", "mine") + entry("local", "filter.x.clean", "evil")))
      .toEqual(["-c", "filter.x.clean=", "-c", "filter.x.required=false"]);
    // Subsections keep their case and spaces; other keys (diff drivers, required, junk) are not this helper's.
    expect(repositoryOnlyDriverArgs(entry("local", "filter.My Filter.clean", "evil") + entry("local", "filter.x.required", "true")
      + entry("local", "diff.x.textconv", "evil") + "junk\0"))
      .toEqual(["-c", "filter.My Filter.clean=", "-c", "filter.My Filter.required=false"]);
    // `-c` splits at the first '=': such a name cannot be blanked, so the repository is refused.
    expect(() => repositoryOnlyDriverArgs(entry("local", "filter.a=b.clean", "evil"))).toThrow(/cannot be neutralized/);
    // Where git writes, a blanked filter is required, so git refuses instead of writing unfiltered content.
    expect(repositoryOnlyDriverArgs(entry("local", "filter.x.clean", "evil") + entry("global", "filter.lfs.clean", lfs)
      + entry("local", "filter.lfs.clean", lfs), { required: true })).toEqual(["-c", "filter.x.clean=", "-c", "filter.x.required=true"]);
    // The repository's own protocol.<name>.allow (a remote helper) is set to never; the user's and the hardening's are not touched.
    expect(repositoryOnlyDriverArgs(entry("local", "protocol.foo.allow", "always") + entry("worktree", "protocol.file.allow", "always")
      + entry("command", "protocol.ext.allow", "never") + entry("global", "protocol.bar.allow", "always")))
      .toEqual(["-c", "protocol.foo.allow=never", "-c", "protocol.file.allow=never"]);
    // Keys of an include target (whatever its condition) are blanked too, unless identical to the user's value.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.lfs.clean", lfs), {
      included: [{ key: "filter.inc.smudge", value: "evil" }, { key: "filter.lfs.clean", value: lfs }, { key: "merge.m.driver", value: "evil" },
        { key: "protocol.baz.allow", value: "always" }, { key: "core.pager", value: "evil" }],
    })).toEqual(["-c", "filter.inc.smudge=", "-c", "merge.m.driver=", "-c", "filter.inc.required=false", "-c", "protocol.baz.allow=never"]);
  });
  it("repositoryOnlyDriverArgs forwardUser (#162): the user's effective drivers are passed on; nothing of the repository's is", () => {
    const entry = (scope: string, key: string, value?: string) => `${scope}\0file:x\0${key}${value === undefined ? "" : `\n${value}`}\0`;
    const lfs = entry("global", "filter.lfs.clean", "git-lfs clean -- %f") + entry("global", "filter.lfs.smudge", "git-lfs smudge -- %f")
      + entry("global", "filter.lfs.process", "git-lfs filter-process") + entry("global", "filter.lfs.required", "true");
    // Off (the snapshot, the reference): exactly as before, a user-only filter gets no argument.
    expect(repositoryOnlyDriverArgs(lfs)).toEqual([]);
    expect(repositoryOnlyDriverArgs(lfs, { required: true })).toEqual([]);
    // On (the executor): every user-only key, `required` included, as plain git sees it (system, global, command line).
    expect(repositoryOnlyDriverArgs(lfs + entry("system", "merge.m.driver", "mine %A") + entry("command", "filter.c.smudge", "cmd"),
      { required: true, forwardUser: true })).toEqual([
      "-c", "filter.lfs.clean=git-lfs clean -- %f", "-c", "filter.lfs.smudge=git-lfs smudge -- %f", "-c", "filter.lfs.process=git-lfs filter-process",
      "-c", "filter.lfs.required=true", "-c", "merge.m.driver=mine %A", "-c", "filter.c.smudge=cmd",
    ]);
    // The effective value only: a later global value wins over a system one; a value-less key is git's boolean true (`-c <key>`).
    expect(repositoryOnlyDriverArgs(entry("system", "filter.x.clean", "old") + entry("global", "filter.x.clean", "new") + entry("global", "filter.v.required"),
      { forwardUser: true })).toEqual(["-c", "filter.x.clean=new", "-c", "filter.v.required"]);
    // An identical repository copy (`git lfs install --local`) is the effective value, which git reads itself: no argument.
    const local = lfs.replaceAll("global\0", "local\0");
    expect(repositoryOnlyDriverArgs(lfs + local, { required: true, forwardUser: true })).toEqual([]);
    // A partial copy: git reads the copied key, the others are still the user's and are passed on.
    expect(repositoryOnlyDriverArgs(lfs + entry("local", "filter.lfs.clean", "git-lfs clean -- %f"), { required: true, forwardUser: true })).toEqual([
      "-c", "filter.lfs.smudge=git-lfs smudge -- %f", "-c", "filter.lfs.process=git-lfs filter-process", "-c", "filter.lfs.required=true",
    ]);
    // Repository-only drivers: still blanked; a repository `required` is neither blanked nor forwarded; protocols are never forwarded.
    expect(repositoryOnlyDriverArgs(entry("local", "filter.evil.clean", "evil") + entry("local", "filter.evil.required", "false")
      + entry("worktree", "merge.w.driver", "evil") + entry("global", "protocol.foo.allow", "always"), { required: true, forwardUser: true }))
      .toEqual(["-c", "filter.evil.clean=", "-c", "merge.w.driver=", "-c", "filter.evil.required=true"]);
    // A filter with a blanked key: none of its user keys is passed on (its blank and required=true stand); a blanked merge driver neither.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.x.clean", "mine") + entry("global", "filter.x.smudge", "mine-s")
      + entry("global", "filter.x.required", "false") + entry("local", "filter.x.clean", "evil")
      + entry("global", "merge.m.driver", "mine") + entry("local", "merge.m.driver", "evil"), { required: true, forwardUser: true }))
      .toEqual(["-c", "filter.x.clean=", "-c", "merge.m.driver=", "-c", "filter.x.required=true"]);
    // An include target's key (whatever its condition) blanks the user's value unless identical, which is then forwarded.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.i.clean", "mine"), { required: true, forwardUser: true, included: [{ key: "filter.i.clean", value: "evil" }] }))
      .toEqual(["-c", "filter.i.clean=", "-c", "filter.i.required=true"]);
    expect(repositoryOnlyDriverArgs(entry("global", "filter.i.clean", "mine"), { required: true, forwardUser: true, included: [{ key: "filter.i.clean", value: "mine" }] }))
      .toEqual(["-c", "filter.i.clean=mine"]);
    // A value `-c` would not pass on as git read it (a line break, CR included, or U+FFFD: a byte that is not UTF-8 in the
    // decoded listing) blanks that key and requires its filter, even with required=false; no other key of that filter is
    // forwarded, and every other filter still is (one bad value never breaks every call).
    for (const value of ["a\nb", "a\rb", "cat \uFFFD"]) {
      expect(repositoryOnlyDriverArgs(entry("global", "filter.n.clean", value) + entry("global", "filter.n.smudge", "ok")
        + entry("global", "filter.n.required", "false") + entry("global", "filter.ok.clean", "fine"), { forwardUser: true }), JSON.stringify(value))
        .toEqual(["-c", "filter.ok.clean=fine", "-c", "filter.n.clean=", "-c", "filter.n.required=true"]);
    }
    // An unforwardable `required` is not blanked (a blank reads as false): its filter is required, its program not forwarded.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.r.clean", "ok") + entry("global", "filter.r.required", "tr\nue"), { forwardUser: true }))
      .toEqual(["-c", "filter.r.required=true"]);
    // An unforwardable merge driver is blanked; a name holding U+FFFD is not forwarded under that other name either.
    expect(repositoryOnlyDriverArgs(entry("global", "merge.m.driver", "x\ny") + entry("global", "filter.caf\uFFFD.clean", "cat"), { forwardUser: true }))
      .toEqual(["-c", "merge.m.driver=", "-c", "filter.caf\uFFFD.clean=", "-c", "filter.caf\uFFFD.required=true"]);
    // A name `-c` would split still refuses the call.
    expect(() => repositoryOnlyDriverArgs(entry("global", "filter.a=b.clean", "x"), { forwardUser: true })).toThrow(/its name contains '='/);
    // Off, the same user keys are not this helper's, as before.
    expect(repositoryOnlyDriverArgs(entry("global", "filter.n.clean", "a\nb") + entry("global", "filter.a=b.clean", "x")
      + entry("global", "filter.f.clean", "cat \uFFFD"))).toEqual([]);
  });
  it("driverListingEnvironment: the run's own variables, the user's config locations, never the legacy GIT_CONFIG", () => {
    const user = process.env.GIT_CONFIG_GLOBAL;
    const env = driverListingEnvironment({ PATH: "p", GIT_DIR: "/d", GIT_CONFIG_PARAMETERS: "'a.b'='c'", GIT_CONFIG: "/evil",
      git_config_global: "NUL", GIT_CONFIG_NOSYSTEM: "1" });
    expect(env).toMatchObject({ PATH: "p", GIT_DIR: "/d", GIT_CONFIG_PARAMETERS: "'a.b'='c'", GIT_NO_LAZY_FETCH: "1" });
    expect(Object.keys(env).some(key => key.toUpperCase() === "GIT_CONFIG")).toBe(false);
    expect(Object.keys(env).filter(key => /^git_config_global$/i.test(key))).toEqual(user === undefined ? [] : ["GIT_CONFIG_GLOBAL"]);
    expect(env.GIT_CONFIG_GLOBAL).toBe(user);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe(process.env.GIT_CONFIG_NOSYSTEM); // "1" in these tests: the process's own value
    // Default: this process's environment.
    expect(driverListingEnvironment().PATH ?? driverListingEnvironment().Path).toBe(process.env.PATH);
  });
  it("collectRepositoryDriverArgs (real git): include targets of any condition are read and blanked; a missing one is skipped", async () => {
    repository();
    const target = join(outside, "inc.gitconfig");
    const nested = join(outside, "nested.gitconfig");
    writeFileSync(target, `[filter "inc"]\n\tclean = evil\n[protocol "helper"]\n\tallow = always\n[include]\n\tpath = nested.gitconfig\n`);
    writeFileSync(nested, `[merge "deep"]\n\tdriver = evil %A\n`);
    git("config", "includeIf.onbranch:never-checked-out.path", slash(target)); // the condition is false here
    git("config", "--add", "include.path", slash(join(outside, "missing.gitconfig")));
    expect(await repositoryDriverArgs(root)).toEqual([
      "-c", "filter.inc.clean=", "-c", "merge.deep.driver=", "-c", "filter.inc.required=false", "-c", "protocol.helper.allow=never",
    ]);
    // An include target that exists but cannot be read fails closed (a directory here).
    mkdirSync(join(outside, "dir.gitconfig"));
    git("config", "--add", "include.path", slash(join(outside, "dir.gitconfig")));
    await expect(repositoryDriverArgs(root)).rejects.toThrow();
  }, 30_000);
  /** A driver query whose listing holds `entries` (scope local) and whose `config --file` reads are recorded and answered by `files`. */
  function fakeDriverQuery(entries: readonly string[], reads: string[], files: Record<string, { code: number; stdout: string }> = {}): DriverQuery {
    return async (args) => {
      const file = args.indexOf("--file");
      if (file === -1) return { code: 0, stdout: entries.map(entry => `local\0file:.git/config\0${entry}\0`).join("") };
      const path = args[file + 1] ?? "";
      reads.push(path);
      return files[path] ?? { code: 128, stdout: "" };
    };
  }
  it.skipIf(!WIN)("collectRepositoryDriverArgs: an include target naming a reserved Windows device is refused before git reads it (G13)", async () => {
    const reads: string[] = [];
    for (const name of ["NUL", "nul.gitconfig", "con ", "COM1", "COM\u00b9", "com1.cfg", "lpt9.x", "aux:", "CONOUT$", "prn. txt"]) {
      await expect(collectRepositoryDriverArgs(fakeDriverQuery([`include.path\n${join(outside, name)}`], reads), root), name)
        .rejects.toThrow(/names a reserved Windows device/);
    }
    expect(reads).toEqual([]);
    // Nested (relative to the including file) too. A name that only starts like a device, an empty base name or an alternate
    // data stream of an ordinary file is an ordinary, here missing, target: skipped, never refused.
    const parent = join(outside, "inc.gitconfig");
    writeFileSync(parent, "");
    const nested = { [parent]: { code: 0, stdout: "include.path\nsub\\aux.cfg\0" } };
    await expect(collectRepositoryDriverArgs(fakeDriverQuery([`include.path\n${parent}`], reads, nested), root))
      .rejects.toThrow(/names a reserved Windows device/);
    expect(reads).toEqual([parent]);
    const ordinary = ["nullish.gitconfig", "com10", "console.cfg", ".gitconfig", "inc.gitconfig:stream"];
    expect(await collectRepositoryDriverArgs(fakeDriverQuery(ordinary.map(name => `include.path\n${join(outside, name)}`), reads), root))
      .toEqual([]);
    expect(reads).toEqual([parent]);
  });
  it("collectRepositoryDriverArgs: a dangling-link include target is skipped, as git skips a missing one", async (ctx) => {
    const gone = join(outside, "gone.gitconfig");
    const link = join(outside, "dangling.gitconfig");
    try { symlinkSync(gone, link, "file"); } catch (error) {
      // A file symlink needs Developer Mode or SeCreateSymbolicLinkPrivilege on win32 (no junction for a file).
      if (WIN && (error as NodeJS.ErrnoException).code === "EPERM") ctx.skip("file symlinks are not available on this machine"); // throws
      throw error;
    }
    const reads: string[] = [];
    const query = fakeDriverQuery([`include.path\n${link}`, "filter.x.clean\nevil"], reads);
    expect(await collectRepositoryDriverArgs(query, root)).toEqual(["-c", "filter.x.clean=", "-c", "filter.x.required=false"]);
    expect(reads).toEqual([]);
    if (!WIN) {
      // POSIX git skips it as well (its access() follows the link). Git for Windows is not checked: its access() may not follow
      // the link, and it may fail on it instead of skipping it.
      repository();
      git("config", "include.path", slash(link));
      expect(await repositoryDriverArgs(root)).toEqual([]);
    }
    // Once the link resolves it is an ordinary include and is read; a read that fails (the injected query answers 128 here,
    // whatever real git would do with this file) fails closed.
    writeFileSync(gone, "");
    await expect(collectRepositoryDriverArgs(query, root)).rejects.toThrow(/Cannot read the config include/);
    expect(reads).toEqual([link]);
  }, 30_000);
  it("collectRepositoryDriverArgs: the listing reads filter.<name>.required only with forwardUser (the snapshot's and reference's is unchanged)", async () => {
    const asked: string[][] = [];
    const query: DriverQuery = async (args) => {
      asked.push([...args]);
      return { code: 0, stdout: "global\0file:x\0filter.lfs.clean\ngit-lfs clean -- %f\0global\0file:x\0filter.lfs.required\ntrue\0" };
    };
    expect(await collectRepositoryDriverArgs(query, root, { required: true })).toEqual([]);
    expect(asked).toEqual([[...DRIVER_SCOPE_ARGS]]);
    expect(DRIVER_SCOPE_ARGS.at(-1)).toBe("^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|protocol\\..+\\.allow|include\\.path|includeif\\..+\\.path)$");
    expect(await collectRepositoryDriverArgs(query, root, { required: true, forwardUser: true }))
      .toEqual(["-c", "filter.lfs.clean=git-lfs clean -- %f", "-c", "filter.lfs.required=true"]);
    expect(asked[1]).toEqual([...DRIVER_SCOPE_ARGS.slice(0, -1),
      "^(filter\\..+\\.(clean|smudge|process|required)|merge\\..+\\.driver|protocol\\..+\\.allow|include\\.path|includeif\\..+\\.path)$"]);
  });
  it("collectRepositoryDriverArgs: the include-target check is an async stat bounded by the listing's deadline", async () => {
    const target = join(outside, "inc.gitconfig");
    writeFileSync(target, "");
    const reads: string[] = [];
    const query = fakeDriverQuery([`include.path\n${target}`, "filter.x.clean\nevil"], reads, { [target]: { code: 1, stdout: "" } });
    const blanked = ["-c", "filter.x.clean=", "-c", "filter.x.required=false"];
    // Time left: as before, the existing target is checked (asynchronously) and read; without a deadline (the reference) too.
    const stat = vi.mocked(fsPromises.stat);
    stat.mockClear();
    expect(await collectRepositoryDriverArgs(query, root, { deadline: performance.now() + 30_000 })).toEqual(blanked);
    expect(await collectRepositoryDriverArgs(query, root)).toEqual(blanked);
    expect(stat.mock.calls.map(call => call[0])).toEqual([target, target]);
    expect(reads).toEqual([target, target]);
    // A check still pending at the deadline fails the listing closed; the target is not read.
    stat.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const started = performance.now();
    await expect(collectRepositoryDriverArgs(query, root, { deadline: started + 300 })).rejects.toThrow(/timed out/);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(10_000);
    // A deadline already past: no check, no read.
    await expect(collectRepositoryDriverArgs(query, root, { deadline: performance.now() - 1 })).rejects.toThrow(/timed out/);
    expect(stat).toHaveBeenCalledTimes(3);
    expect(reads).toEqual([target, target]);
    // A missing target is still skipped within the deadline, and a failing check (not a missing path) still fails closed.
    rmSync(target);
    expect(await collectRepositoryDriverArgs(query, root, { deadline: performance.now() + 30_000 })).toEqual(blanked);
    stat.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })));
    await expect(collectRepositoryDriverArgs(query, root, { deadline: performance.now() + 30_000 })).rejects.toThrow(/denied/);
    expect(reads).toEqual([target, target]);
  });
  it("withRepositoryDrivers (real git, #162): a filter set only in the user's global config is applied: clean on commit, smudge on checkout", async () => {
    repository();
    writeFileSync(join(root, ".gitattributes"), "*.bin filter=omr -text\n");
    git("add", ".gitattributes"); git("commit", "-qm", "attributes");
    // A deterministic, reversible filter (no git-lfs needed): clean stores `OMR-CLEAN <hex>`, smudge decodes it.
    const filter = join(outside, "omr-filter.cjs");
    writeFileSync(filter, [
      "const chunks = [];",
      "process.stdin.on('data', chunk => chunks.push(chunk));",
      "process.stdin.on('end', () => {",
      "  const input = Buffer.concat(chunks);",
      "  if (process.argv[2] === 'clean') { process.stdout.write('OMR-CLEAN ' + input.toString('hex') + '\\n'); return; }",
      "  const text = input.toString('latin1');",
      "  process.stdout.write(text.startsWith('OMR-CLEAN ') ? Buffer.from(text.slice(10).trim(), 'hex') : input);",
      "});",
    ].join("\n"));
    const command = (mode: string) => `"${slash(process.execPath)}" "${slash(filter)}" ${mode}`;
    const global = process.env.GIT_CONFIG_GLOBAL ?? "";
    const setGlobal = (key: string, value: string) => execFileSync(gitExecutable(), ["config", "--file", global, key, value], { cwd: outside, env: gitEnvironment() });
    setGlobal("filter.omr.clean", command("clean"));
    setGlobal("filter.omr.smudge", command("smudge"));
    setGlobal("filter.omr.required", "true");
    // The snapshot's and the reference's listing (no forwarding) is unchanged: nothing of the user's is passed on.
    expect(await repositoryDriverArgs(root)).toEqual([]);
    expect(await repositoryDriverArgs(root, { required: true })).toEqual([]);
    expect(await repositoryDriverArgs(root, { required: true, forwardUser: true })).toEqual([
      "-c", `filter.omr.clean=${command("clean")}`, "-c", `filter.omr.smudge=${command("smudge")}`, "-c", "filter.omr.required=true",
    ]);
    const content = "hello executor\n";
    const cleaned = `OMR-CLEAN ${Buffer.from(content).toString("hex")}\n`;
    writeFileSync(join(root, "data.bin"), content);
    const call = { cwd: root, timeoutMs: 30_000 };
    // Control (the bug): the hardened git alone hides the global filter and would store the raw content.
    const bare = createGitRunner({ mode: "hardened", toplevel: root });
    const rawId = await bare.run([...hardeningArgs(), "hash-object", "--path=data.bin", "data.bin"], call);
    expect(rawId.stdout.trim()).toBe(git("hash-object", "--no-filters", "data.bin").trim());
    const runner = withRepositoryDrivers(createGitRunner({ mode: "hardened", toplevel: root }), root);
    const added = await runner.run([...hardeningArgs(), "add", "data.bin"], call);
    expect(added.code, added.stderr).toBe(0);
    const committed = await runner.run([...hardeningArgs(), "commit", "-qm", "data"], call);
    expect(committed.code, committed.stderr).toBe(0);
    expect(git("cat-file", "blob", "HEAD:data.bin")).toBe(cleaned);
    // The checkout runs the user's smudge: the working file is the original content again.
    rmSync(join(root, "data.bin"));
    const checkout = await runner.run([...hardeningArgs(), "checkout", "HEAD", "--", "data.bin"], call);
    expect(checkout.code, checkout.stderr).toBe(0);
    expect(readFileSync(join(root, "data.bin"), "utf8")).toBe(content);
    // `required` is passed on too: a failing clean makes git refuse instead of storing the raw content.
    setGlobal("filter.omr.clean", "false");
    writeFileSync(join(root, "data.bin"), "changed\n");
    const refused = await runner.run([...hardeningArgs(), "add", "data.bin"], call);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/clean filter 'omr' failed/);
    expect(git("cat-file", "blob", ":data.bin")).toBe(cleaned);
  }, 60_000);
  it("withRepositoryDrivers (real git, #162): a user value -c cannot carry (a byte that is not UTF-8) blanks only that filter, required", async () => {
    repository();
    writeFileSync(join(root, ".gitattributes"), "*.bin filter=omr -text\n");
    git("add", ".gitattributes"); git("commit", "-qm", "attributes");
    // `cat \xE9` in the user's global config: the UTF-8-decoded listing reads `cat \uFFFD`, which would name another command.
    writeFileSync(process.env.GIT_CONFIG_GLOBAL ?? "", Buffer.concat([Buffer.from("[filter \"omr\"]\n\tclean = cat "), Buffer.from([0xe9]),
      Buffer.from("\n\tsmudge = cat\n[filter \"ok\"]\n\tclean = cat\n")]));
    expect(await repositoryDriverArgs(root, { required: true, forwardUser: true }))
      .toEqual(["-c", "filter.ok.clean=cat", "-c", "filter.omr.clean=", "-c", "filter.omr.required=true"]);
    const runner = withRepositoryDrivers(createGitRunner({ mode: "hardened", toplevel: root }), root);
    const call = { cwd: root, timeoutMs: 30_000 };
    // Where the filter is used, git refuses instead of storing the raw content.
    writeFileSync(join(root, "data.bin"), "raw\n");
    const refused = await runner.run([...hardeningArgs(), "add", "data.bin"], call);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/clean filter 'omr' failed/);
    // Every other call still runs.
    writeFileSync(join(root, "other.txt"), "other\n");
    const added = await runner.run([...hardeningArgs(), "add", "other.txt"], call);
    expect(added.code, added.stderr).toBe(0);
    const status = await runner.run([...hardeningArgs(), "status", "--porcelain"], call);
    expect(status.code, status.stderr).toBe(0);
    expect(git("ls-files", "--", "data.bin", "other.txt").trim().split(/\r?\n/)).toEqual(["other.txt"]);
  }, 60_000);
  it.skipIf(!HAS_GIT_LFS)("withRepositoryDrivers (real git-lfs, #162): Git LFS configured only globally stores a pointer and smudges it back", async () => {
    repository();
    writeFileSync(join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    git("add", ".gitattributes"); git("commit", "-qm", "attributes");
    const global = process.env.GIT_CONFIG_GLOBAL ?? "";
    for (const [key, value] of [["filter.lfs.clean", "git-lfs clean -- %f"], ["filter.lfs.smudge", "git-lfs smudge -- %f"],
      ["filter.lfs.process", "git-lfs filter-process"], ["filter.lfs.required", "true"]] as const) {
      execFileSync(gitExecutable(), ["config", "--file", global, key, value], { cwd: outside, env: gitEnvironment() });
    }
    const content = Buffer.alloc(4096, 0x5a);
    writeFileSync(join(root, "data.bin"), content);
    const call = { cwd: root, timeoutMs: 60_000 };
    const runner = withRepositoryDrivers(createGitRunner({ mode: "hardened", toplevel: root }), root);
    const added = await runner.run([...hardeningArgs(), "add", "data.bin"], call);
    expect(added.code, added.stderr).toBe(0);
    const committed = await runner.run([...hardeningArgs(), "commit", "-qm", "data"], call);
    expect(committed.code, committed.stderr).toBe(0);
    const pointer = git("cat-file", "blob", "HEAD:data.bin");
    expect(pointer).toMatch(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 4096\n$/);
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1] ?? "";
    expect(existsSync(join(root, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toBe(true);
    rmSync(join(root, "data.bin"));
    const checkout = await runner.run([...hardeningArgs(), "checkout", "HEAD", "--", "data.bin"], call);
    expect(checkout.code, checkout.stderr).toBe(0);
    expect(readFileSync(join(root, "data.bin")).equals(content)).toBe(true);
  }, 120_000);
  it("withRepositoryDrivers (real git): a write under a repository-only filter fails closed; the global filter's copy still runs", async () => {
    repository();
    const evil = join(outside, "EVIL_RAN");
    const dup = join(outside, "DUP_RAN");
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n*.dat filter=dup\n");
    writeFileSync(join(root, "b.dat"), "one\n");
    git("add", "-A"); git("commit", "-qm", "drivers");
    // No racily clean entry: an index write would re-check it through its (required, blanked) filter and refuse.
    for (const name of ["file.txt", "b.dat", ".gitattributes"]) utimesSync(join(root, name), OLD, OLD);
    git("update-index", "-q", "--refresh");
    const clean = (marker: string) => `${markerCommand(marker)}; cat`;
    git("config", "filter.evil.clean", clean(evil));
    git("config", "filter.dup.clean", clean(dup));
    execFileSync(gitExecutable(), ["config", "--file", process.env.GIT_CONFIG_GLOBAL ?? "", "filter.dup.clean", clean(dup)], { cwd: outside, env: gitEnvironment() });
    const runner = withRepositoryDrivers(createGitRunner({ mode: "hardened", toplevel: root }), root);
    writeFileSync(join(root, "b.dat"), "changed\n");
    const kept = await runner.run([...hardeningArgs(), "add", "b.dat"], { cwd: root, timeoutMs: 30_000 });
    expect(kept.code).toBe(0);
    expect(existsSync(dup)).toBe(true);
    // From outside the repository through -C: the listing runs where the call runs.
    writeFileSync(join(root, "file.txt"), "changed\n");
    const refused = await runner.run([...hardeningArgs(), "-C", root, "add", "file.txt"], { cwd: outside, timeoutMs: 30_000 });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/clean filter 'evil' failed/);
    expect(existsSync(evil)).toBe(false);
    // An unreadable configuration: E_GIT, and the call does not run.
    await expect(runner.run(["status"], { cwd: join(outside, "missing"), timeoutMs: 30_000 })).rejects.toMatchObject({ code: "E_GIT" });
  }, 30_000);
  it("repositoryDriverArgs (real git): a repository-only filter is blanked and never runs; a global filter's local copy runs", async () => {
    repository();
    const evil = join(outside, "EVIL_RAN");
    const dup = join(outside, "DUP_RAN");
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n*.dat filter=dup\n");
    writeFileSync(join(root, "b.dat"), "one\n");
    git("add", "-A"); git("commit", "-qm", "drivers");
    expect(await repositoryDriverArgs(root)).toEqual([]); // nothing configured: no argument
    const clean = (marker: string) => `${markerCommand(marker)}; cat`;
    git("config", "filter.evil.clean", clean(evil));
    git("config", "filter.dup.clean", clean(dup));
    git("config", "merge.evil.driver", `${markerCommand(evil)}; false`);
    // The user's global configuration (GIT_CONFIG_GLOBAL, honoured as plain git does), written by git as the local copy.
    const global = process.env.GIT_CONFIG_GLOBAL ?? "";
    execFileSync(gitExecutable(), ["config", "--file", global, "filter.dup.clean", clean(dup)], { cwd: outside, env: gitEnvironment() });
    const args = await repositoryDriverArgs(root);
    expect(args).toEqual(["-c", "filter.evil.clean=", "-c", "merge.evil.driver=", "-c", "filter.evil.required=false"]);
    // A hardened run (no system/global config) with those arguments: the repository's filter never runs, its copy of the
    // user's filter does.
    writeFileSync(join(root, "file.txt"), "changed\n");
    writeFileSync(join(root, "b.dat"), "changed\n");
    execFileSync(gitExecutable(), [...hardeningArgs(), ...args, "diff", "--no-ext-diff", "HEAD"], { cwd: root, env: gitEnvironment(), encoding: "utf8" });
    expect(existsSync(evil)).toBe(false);
    expect(existsSync(dup)).toBe(true);
    // Control: without them the repository's filter runs.
    plain(root, "diff", "HEAD");
    expect(existsSync(evil)).toBe(true);
    // Not a repository: nothing the repository could set. An unreadable listing throws (the caller fails closed).
    expect(await repositoryDriverArgs(outside)).toEqual([]);
    await expect(repositoryDriverArgs(join(outside, "missing"))).rejects.toThrow();
  }, 30_000);
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
    let grandchildPid: number | undefined;
    // parent -> middle (exits) -> grandchild (detached, inherits stdout/stderr). taskkill /T and
    // POSIX group kill cannot reach the orphan, so `close` never fires.
    const middle = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:${JSON.stringify(tmpdir())},detached:true,stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));g.unref();`;
    const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
    const started = performance.now();
    try {
      await expect(runBoundedProcess(process.execPath, ["-e", parent], root, { timeoutMs: 2_000 })).rejects.toThrow("timed out");
      expect(performance.now() - started).toBeLessThan(6_000);
      expect(existsSync(pidFile)).toBe(true);
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(grandchildPid)).toBe(true); // the pipe holder really survived
    } finally {
      if (grandchildPid === undefined && existsSync(pidFile)) grandchildPid = Number(readFileSync(pidFile, "utf8"));
      if (grandchildPid !== undefined && alive(grandchildPid)) {
        if (WIN) {
          try {
            execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(grandchildPid), "/T", "/F"],
              { cwd: tmpdir(), stdio: "ignore", windowsHide: true, timeout: 10_000 });
          } catch (error) {
            if (alive(grandchildPid)) throw error; // Ignore only a process that has already exited.
          }
        } else {
          try { process.kill(grandchildPid, "SIGKILL"); } catch (error) {
            if (alive(grandchildPid)) throw error;
          }
        }
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
    const stoppedBy = Date.now() + 3_000;
    while (alive(pid) && Date.now() < stoppedBy) await new Promise(done => setTimeout(done, 20));
    expect(alive(pid)).toBe(false);
  }, 30_000);
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
