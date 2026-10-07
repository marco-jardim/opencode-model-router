import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, type SnapshotGitOptions } from "../../src/verify/tree";

// QA-G-6: real git, real processes. A `core.fsmonitor` hook is a process git spawns (through its
// shell) on `git status`; here it records its PID and never exits, standing in for a hung
// fsmonitor hook or filter (git-lfs). Ending the snapshot's git must end it too.

const dirs: string[] = [];
const hooks: number[] = [];

afterEach(() => {
  for (const pid of hooks.splice(0)) if (alive(pid)) process.kill(pid);
  for (const d of dirs.splice(0)) removeScratch(d);
});

// Windows can hold a handle on the scratch repo briefly after the killed process tree exits
// (EBUSY on rmdir). Retry, then leave the temp dir behind with a warning rather than fail the test.
function removeScratch(d: string): void {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
    console.warn(`tree-kill: left scratch dir ${d} behind after retries (${code})`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(check: () => boolean, limitMs: number): Promise<boolean> {
  for (const end = Date.now() + limitMs; ;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}

/** A committed repo whose fsmonitor hook writes its PID to `hook.pid` and then hangs. */
function repoWithHungHook() {
  const dir = mkdtempSync(join(tmpdir(), "omr-tree-kill-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const pidFile = join(dir, "hook.pid");
  const hook = join(dir, "hook.cjs");
  writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const slash = (p: string) => p.replace(/\\/g, "/");
  git("config", "core.fsmonitor", `"${slash(process.execPath)}" "${slash(hook)}"`);
  const hookPid = () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "" ? Number(readFileSync(pidFile, "utf8")) : 0;
  return { repo, hookPid };
}

const options = (cwd: string, signal: AbortSignal, timeoutMs = 30_000): SnapshotGitOptions =>
  ({ cwd, signal, timeoutMs, maxBuffer: 1024 * 1024, lowPriority: true });

describe("QA-G-6: the snapshot's git is ended with its whole tree", () => {
  it("an abort rejects at once and ends what git spawned within 3 s", async () => {
    const { repo, hookPid } = repoWithHungHook();
    const controller = new AbortController();
    const pending = execGit(["--no-pager", "status", "--porcelain=v1"], options(repo, controller.signal));
    pending.catch(() => undefined);
    expect(await waitFor(() => hookPid() > 0, 20_000)).toBe(true);
    const pid = hookPid();
    hooks.push(pid);
    expect(alive(pid)).toBe(true);
    const abortedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
  }, 40_000);

  it("the timeout ends what git spawned too", async () => {
    const { repo, hookPid } = repoWithHungHook();
    const pending = execGit(["--no-pager", "status", "--porcelain=v1"], options(repo, new AbortController().signal, 3000));
    pending.catch(() => undefined);
    expect(await waitFor(() => hookPid() > 0, 20_000)).toBe(true);
    hooks.push(hookPid());
    await expect(pending).rejects.toThrow(/timed out after 3000 ms/);
    expect(await waitFor(() => !alive(hookPid()), 3000)).toBe(true);
  }, 40_000);

  it("resolves stdout, rejects a non-zero exit, output past maxBuffer and an already-aborted signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-tree-kill-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    const signal = new AbortController().signal;
    expect((await execGit(["rev-parse", "--is-inside-work-tree"], options(dir, signal))).trim()).toBe("true");
    await expect(execGit(["rev-parse", "HEAD"], options(dir, signal))).rejects.toThrow(/exited with code/);
    await expect(execGit(["rev-parse", "--is-inside-work-tree"], { ...options(dir, signal), maxBuffer: 2 })).rejects.toThrow(/exceeded 2 bytes/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(execGit(["rev-parse", "--is-inside-work-tree"], options(dir, aborted.signal))).rejects.toThrow(/before it started/);
  }, 40_000);
});
