import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { execGit, snapshotTree, SNAPSHOT_GIT_MAX_BUFFER, SNAPSHOT_GIT_TIMEOUT_MS, type SnapshotGitOptions } from "../../src/verify/tree";

const state = vi.hoisted(() => ({
  head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false,
  calls: [] as string[][], directories: [] as string[], binaries: [] as string[],
  priorities: [] as [number, number][], priorityThrows: false,
}));
vi.mock("node:os", async importOriginal => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: (await import("../setup/home-guard")).guardedHomedir, // keep the global home guard (QA-1.1-22)
  setPriority: (pid: number, priority: number) => {
    state.priorities.push([pid, priority]);
    if (state.priorityThrows) throw new Error("ESRCH");
  },
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (binary: string, rawArgs: string[], options: { cwd: string }) => {
      state.binaries.push(binary);
      // POSIX low priority: `nice -n 10 -- git …`; record git's own argv either way.
      const args = binary === "nice" ? rawArgs.slice(4) : rawArgs;
      state.calls.push(args);
      state.directories.push(options.cwd);
      const command = args.slice(1).join(" ");
      const output = command === "rev-parse --show-toplevel" ? process.cwd()
        : command === "rev-parse HEAD" ? state.head
        : command.startsWith("status") ? state.status
        : command.startsWith("diff HEAD") ? state.diff
        : command.startsWith("diff --cached") ? state.index
        : command === "ls-files --stage" ? state.stage : state.untracked;
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter() });
      setImmediate(() => {
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.emit("close", state.error ? 1 : 0, null);
      });
      return child;
    },
  };
});
vi.mock("node:fs/promises", () => ({
  realpath: async (path: string) => path,
  lstat: async () => ({ mode: 33188, size: 4, isFile: () => true, isSymbolicLink: () => false }),
  readFile: async () => state.content,
  readlink: async () => "target",
}));
beforeEach(() => Object.assign(state, {
  head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false,
  calls: [], directories: [], binaries: [], priorities: [], priorityThrows: false,
}));
const capture = () => snapshotTree(process.cwd(), new AbortController().signal);
describe("Git tree fingerprint adapter", () => {
  it("fingerprints the whole repository even when tests run in a subdirectory", async () => {
    const cwd = resolve("packages/app");
    const snapshot = await snapshotTree(cwd, new AbortController().signal);
    expect(snapshot?.cwd).toBe(cwd);
    expect(state.directories[0]).toBe(cwd);
    expect(state.directories.slice(1).every(dir => dir === process.cwd())).toBe(true);
  });
  it.each(["diff", "index", "status", "content"] as const)("hash changes with %s, including same-path untracked content edits", async field => {
    state.untracked = "untracked.txt\0";
    const first = await capture(); state[field] = "changed";
    expect((await capture())?.fingerprint).not.toBe(first?.fingerprint);
    expect(state.calls.every(args => args[0] === "--no-pager")).toBe(true);
  });
  it("retains HEAD, dirty flag, and absolute changed paths including rename destinations", async () => {
    state.status = " M old.ts\0R  new.ts\0before.ts\0?? untracked.txt\0";
    const snapshot = await capture();
    expect(snapshot).toMatchObject({ head: "head1", dirty: true });
    expect(snapshot?.files.map(f => f.path)).toEqual([resolve("old.ts"), resolve("new.ts"), resolve("untracked.txt")]);
  });
  it("returns unavailable for Git errors, aborted captures, and submodules", async () => {
    state.error = true; expect(await capture()).toBeUndefined();
    state.error = false; state.stage = "160000 commit 0\tsubmodule";
    expect(await capture()).toBeUndefined(); state.stage = "";
    const controller = new AbortController(); controller.abort();
    expect(await snapshotTree(process.cwd(), controller.signal)).toBeUndefined();
  });
  it("QA-3.1-8: every git process of a snapshot gets lowPriority through the seam (default off)", async () => {
    const seen: SnapshotGitOptions[] = [];
    const git = async (args: readonly string[], opts: SnapshotGitOptions) => {
      seen.push(opts);
      return execGit(args, opts);
    };
    const signal = new AbortController().signal;
    expect(await snapshotTree(process.cwd(), signal, { lowPriority: true, git })).toBeDefined();
    // rev-parse x2, status, diff x2, ls-files --stage, ls-files --others.
    expect(seen).toHaveLength(7);
    for (const opts of seen) {
      expect(opts).toMatchObject({ lowPriority: true, timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER });
      expect(opts.signal).toBe(signal);
    }
    seen.length = 0;
    expect(await snapshotTree(process.cwd(), signal, { git })).toBeDefined();
    expect(seen.map(o => o.lowPriority)).toEqual(Array(7).fill(false));
  });
  it("QA-3.1-8: the default git seam lowers the process's priority as exec.ts does", async () => {
    // Generous timeout: this test is about priority, and a 5 ms timer could fire on a slow
    // runner before the fake child closes, reaching the unmocked taskkill path.
    const opts = { cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 30_000, maxBuffer: 5, lowPriority: true };
    expect(await execGit(["--no-pager", "rev-parse", "HEAD"], opts)).toBe("head1");
    if (process.platform === "win32") {
      // The child is spawned as git and lowered right after the spawn.
      expect(state.binaries).toEqual(["git"]);
      expect(state.priorities).toEqual([[4242, osConstants.priority.PRIORITY_BELOW_NORMAL]]);
      // A child that already exited cannot be lowered: the run itself is unaffected.
      state.priorityThrows = true;
      expect(await execGit(["--no-pager", "rev-parse", "HEAD"], opts)).toBe("head1");
    } else {
      expect(state.binaries).toEqual(["nice"]);
      expect(state.priorities).toEqual([]);
    }
    expect(state.calls[0]).toEqual(["--no-pager", "rev-parse", "HEAD"]);
    // Normal priority: plain git, nothing lowered.
    state.binaries = []; state.priorities = [];
    expect(await execGit(["--no-pager", "rev-parse", "HEAD"], { ...opts, lowPriority: false })).toBe("head1");
    expect(state.binaries).toEqual(["git"]);
    expect(state.priorities).toEqual([]);
  });
});
