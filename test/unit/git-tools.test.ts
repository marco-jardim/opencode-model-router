import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_OPERATIONS, gitArgv, gitEnvironment, gitExecutable, gitTools, hardeningArgs, inspectGit, runBoundedProcess, stripUrlUserinfo, validatePath, validateRef } from "../../src/router/git-tools";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "router-git-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const git = (...args: string[]) => execFileSync(gitExecutable(), args, { cwd: root, env: gitEnvironment(), encoding: "utf8" });
function repository() {
  git("init", "-q");
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(root, "file.txt"), "first\n");
  git("add", "file.txt"); git("commit", "-qm", "initial");
}

describe("shell-free git inspection", () => {
  it.each(["-o", "--output=x", "a b", "a;b", "a|b", "$(whoami)", "`whoami`", "x".repeat(201), ""])("rejects ref %s", ref => {
    expect(() => validateRef(ref)).toThrow();
  });
  it.each(["-o", "--output=x", "../secret", "a/../../secret", "a\\..\\secret", "/outside", "C:\\outside", "\\\\host\\share", "x".repeat(4097), ""])("rejects path %s", path => {
    expect(() => validatePath(root, path)).toThrow();
  });
  it("accepts refs, ranges and literal relative paths; rejects invalid limits and modes", () => {
    expect(validateRef("HEAD~2..origin/main")).toBe("HEAD~2..origin/main");
    expect(validatePath(root, "folder/file name.ts")).toBe("folder/file name.ts");
    for (const limit of [0, -1, 51, 1.5, NaN]) expect(() => gitArgv("log", { limit }, root)).toThrow();
    expect(() => gitTools().router_git_diff.args.mode?.parse("--output=x")).toThrow();
    expect(() => gitArgv("blame", {}, root)).toThrow("requires path");
  });
  it.each(GIT_OPERATIONS)("hardens %s argv and environment", operation => {
    const args = gitArgv(operation, { path: "file.txt" }, root);
    expect(args.slice(0, hardeningArgs().length)).toEqual(hardeningArgs());
    for (const flag of ["--no-optional-locks", "core.pager=cat", "core.fsmonitor=false", "diff.external=", "protocol.allow=never"]) expect(args).toContain(flag);
    expect(args.some(a => a.startsWith("core.hooksPath="))).toBe(true);
    if (["diff", "show", "log"].includes(operation)) {
      expect(args).toContain("--no-ext-diff"); expect(args).toContain("--no-textconv");
    }
    expect(args.slice(-2)).toEqual(["--", "file.txt"]);
    expect(gitEnvironment()).toMatchObject({ GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" });
  });
  it("never executes malicious fsmonitor, external diff, textconv or hooks", async () => {
    repository();
    const marker = join(root, "EXECUTED");
    const script = join(root, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho executed > '${marker.replaceAll("\\", "/")}'\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", script.replaceAll("\\", "/"));
    git("config", "diff.external", script.replaceAll("\\", "/"));
    git("config", "diff.evil.textconv", script.replaceAll("\\", "/"));
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
    const hooks = join(root, "hooks"); mkdirSync(hooks);
    writeFileSync(join(hooks, "post-index-change"), readFileSync(script), { mode: 0o755 });
    git("config", "core.hooksPath", hooks.replaceAll("\\", "/"));
    writeFileSync(join(root, "file.txt"), "second\n");
    for (const operation of GIT_OPERATIONS) await inspectGit(operation, { path: "file.txt" }, root);
    expect(existsSync(marker)).toBe(false);
  });
  it("status leaves a stale index's hash and mtime unchanged", async () => {
    repository();
    utimesSync(join(root, "file.txt"), new Date(0), new Date(0));
    const index = join(root, ".git", "index");
    const digest = () => createHash("sha256").update(readFileSync(index)).digest("hex");
    const before = { hash: digest(), mtime: statSync(index).mtimeMs };
    expect(await inspectGit("status", {}, root)).toBe("");
    expect({ hash: digest(), mtime: statSync(index).mtimeMs }).toEqual(before);
  });
  it("resolves the session's repository root from a subdirectory", async () => {
    repository(); mkdirSync(join(root, "sub"));
    expect(await inspectGit("ls_files", {}, join(root, "sub"))).toContain("file.txt");
  });
  it("strips URL credentials including scp-style remotes", () => {
    expect(stripUrlUserinfo("https://user:token@host/repo ssh://git@host/repo git@host:repo")).toBe("https://host/repo ssh://host/repo host:repo");
  });
  it("bounds output, reports truncation and cannot leak a partial credential", async () => {
    const out = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('safe https://user:secret@host/' + 'x'.repeat(100000))"], root, { maxBytes: 24 });
    expect(out).toContain("truncated"); expect(out).not.toContain("secret"); expect(out.length).toBeLessThan(100);
  });
  it("times out and aborts the process tree", async () => {
    await expect(runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, { timeoutMs: 100 })).rejects.toThrow("timed out");
    const controller = new AbortController();
    const result = runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], root, { signal: controller.signal });
    controller.abort(); await expect(result).rejects.toThrow("aborted");
    await expect(runBoundedProcess(process.execPath, [], root, { signal: controller.signal })).rejects.toThrow("aborted");
  });
});
