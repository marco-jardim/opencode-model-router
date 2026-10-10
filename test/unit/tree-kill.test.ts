import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import { execGit, type SnapshotGitOptions } from "../../src/verify/tree";

// QA-G-6: real git, real processes. A `core.fsmonitor` hook is a process git spawns (through its
// shell) on `git status`; here it records its PID and never exits, standing in for a hung
// fsmonitor hook or filter (git-lfs). Ending the snapshot's git must end it too.

const dirs: string[] = [];
const hooks: number[] = [];

// The hook (and git, and the shell between them) runs with the scratch repo as its current directory, and on Windows
// a directory cannot be removed while a process has it as cwd. So the scratch dirs are removed only once every PID of
// the tree is gone (the registered hook PIDs), and a dir that still cannot be removed fails the hook with its path
// instead of being left behind (the leftover would only fail the whole file later, in the home-guard's afterAll).
//
// The removal has its own 8 s budget (REMOVE_DIR_BUDGET_MS); the explicit 30 s hook timeout stays well above it, so the
// helper's error naming the path is what surfaces, never "Hook timed out".
afterEach(async () => {
  const pids = hooks.splice(0);
  const failures: string[] = [];
  for (const d of dirs.splice(0)) {
    try {
      await removeDirWhenReleased(d, { pids });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}, 30_000);

/** Drops a hook PID the test has confirmed dead, so the cleanup can never kill a PID the OS has recycled since. */
function forget(pid: number): void {
  const at = hooks.indexOf(pid);
  if (at >= 0) hooks.splice(at, 1);
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
    forget(pid);
  }, 40_000);

  it("the timeout ends what git spawned too", async () => {
    const { repo, hookPid } = repoWithHungHook();
    const pending = execGit(["--no-pager", "status", "--porcelain=v1"], options(repo, new AbortController().signal, 3000));
    pending.catch(() => undefined);
    expect(await waitFor(() => hookPid() > 0, 20_000)).toBe(true);
    const pid = hookPid();
    hooks.push(pid);
    await expect(pending).rejects.toThrow(/timed out after 3000 ms/);
    expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
    forget(pid);
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
