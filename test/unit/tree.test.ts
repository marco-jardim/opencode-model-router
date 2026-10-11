import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { execGit, GitExitError, gitExitCode, snapshotTree, SNAPSHOT_GIT_MAX_BUFFER, SNAPSHOT_GIT_TIMEOUT_MS, type SnapshotGitOptions } from "../../src/verify/tree";

const state = vi.hoisted(() => ({
  head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false,
  /** Line 2 of `rev-parse HEAD --symbolic-full-name HEAD` (`HEAD` when detached); null = no second line. */
  branchRef: "refs/heads/main" as string | null,
  calls: [] as string[][], directories: [] as string[], binaries: [] as string[],
  priorities: [] as [number, number][], priorityThrows: false,
}));
vi.mock("node:os", async importOriginal => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: (await import("../setup/home-guard")).guardedHomedir, // keep the global home guard (QA-1.1-22)
  tmpdir: (await import("../setup/home-guard")).guardedTmpdir, // and the temp guard (QA-2.1-4)
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
        : command === "rev-parse HEAD --symbolic-full-name HEAD" ? state.head + (state.branchRef === null ? "" : `\n${state.branchRef}\n`)
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
/** QA-1 F4: the hardening a `hardened` snapshot takes from git-tools.ts (loaded only then), pinned here. */
const HARDENED = vi.hoisted(() => ({
  prefix: ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL"],
  trusted: ["-c", "safe.directory=D:/trusted"],
  /** Cross-repo QA round 2: the inherited line-ending settings (git-tools.ts inheritedConfigArgs), passed after `trusted`. */
  inherited: ["-c", "core.autocrlf=true", "-c", "core.eol=crlf"],
  inheritedCalls: [] as { executable: string; root: string; base: string[] }[],
  env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  executable: "C:/Program Files/Git/cmd/git.exe",
}));
vi.mock("../../src/router/git-tools", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/router/git-tools")>()),
  hardeningArgs: () => [...HARDENED.prefix],
  inheritedSafeDirectoryArgs: async () => [...HARDENED.trusted],
  inheritedConfigArgs: async (executable: string, root: string, base: readonly string[]) => {
    HARDENED.inheritedCalls.push({ executable, root, base: [...base] });
    return [...HARDENED.inherited];
  },
  gitEnvironment: () => ({ ...HARDENED.env }),
  gitExecutable: () => HARDENED.executable,
  workRootGuards: (root: string) => [root],
}));
beforeEach(() => Object.assign(state, {
  head: "head1", status: "", diff: "", index: "", untracked: "", content: "", stage: "", error: false,
  branchRef: "refs/heads/main",
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
    // rev-parse --show-toplevel, rev-parse HEAD --symbolic-full-name HEAD (head and branch in one process), status, diff x2,
    // ls-files --stage, ls-files --others.
    expect(seen).toHaveLength(7);
    for (const opts of seen) {
      expect(opts).toMatchObject({ lowPriority: true, timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER });
      expect(opts.signal).toBe(signal);
    }
    seen.length = 0;
    expect(await snapshotTree(process.cwd(), signal, { git })).toBeDefined();
    expect(seen.map(o => o.lowPriority)).toEqual(Array(7).fill(false));
  });
  it("QA-1 F4: hardened (opt-in) runs every git process hardened, by path, in the hardened environment; the default is unchanged", async () => {
    const prefix = [...HARDENED.prefix, ...HARDENED.trusted, ...HARDENED.inherited];
    HARDENED.inheritedCalls.length = 0;
    const seen: { args: readonly string[]; opts: SnapshotGitOptions }[] = [];
    // The child_process mock answers by the arguments after `--no-pager`: hand it the command without the hardening.
    const git = async (args: readonly string[], opts: SnapshotGitOptions) => {
      seen.push({ args, opts });
      const hardened = args.slice(0, prefix.length).join("\0") === prefix.join("\0");
      return execGit(["--no-pager", ...args.slice(hardened ? prefix.length : 1)], opts);
    };
    const signal = new AbortController().signal;
    expect(await snapshotTree(process.cwd(), signal, { hardened: true, git })).toBeDefined();
    expect(seen).toHaveLength(7);
    for (const { args, opts } of seen) {
      expect(args.slice(0, prefix.length)).toEqual(prefix);
      expect(opts.env).toEqual(HARDENED.env);
      expect(opts.executable).toBe(HARDENED.executable);
    }
    expect(state.binaries).toEqual(Array(7).fill(HARDENED.executable));
    // Cross-repo QA round 2: the inherited settings are read once per snapshot, for the snapshotted directory, with the
    // hardening and the trusted safe.directory values as the query's base; the default snapshot never reads them.
    expect(HARDENED.inheritedCalls).toEqual([{
      executable: HARDENED.executable, root: process.cwd(), base: [...HARDENED.prefix, ...HARDENED.trusted],
    }]);
    // Default (W's snapshot): `--no-pager` first, the process's own environment, git by name, as before.
    seen.length = 0;
    state.binaries = [];
    expect(await snapshotTree(process.cwd(), signal, { git })).toBeDefined();
    expect(seen).toHaveLength(7);
    for (const { args, opts } of seen) {
      expect(args[0]).toBe("--no-pager");
      expect(args).not.toContain("core.fsmonitor=false");
      expect("env" in opts || "executable" in opts).toBe(false);
    }
    expect(state.binaries).toEqual(Array(7).fill("git"));
    expect(HARDENED.inheritedCalls).toHaveLength(1);
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

  describe("the checked-out branch (I7, P0.2)", () => {
    const headCalls = () => state.calls.filter(args => args.slice(1).join(" ") === "rev-parse HEAD --symbolic-full-name HEAD");

    it("attached: the short name of refs/heads/<name>, from the one rev-parse process", async () => {
      state.branchRef = "refs/heads/feat/x";
      const snapshot = await capture();
      expect(snapshot?.head).toBe("head1");
      expect(snapshot?.branch).toBe("feat/x");
      expect(headCalls()).toHaveLength(1);
      expect(state.calls.some(args => args.includes("symbolic-ref"))).toBe(false);
    });

    it("detached (line 2 is HEAD): null, and the snapshot is kept", async () => {
      state.branchRef = "HEAD";
      const snapshot = await capture();
      expect(snapshot).toBeDefined();
      expect(snapshot?.head).toBe("head1");
      expect(snapshot?.branch).toBeNull();
    });

    it("unparsable line 2 (missing or empty): undefined, and the snapshot is kept", async () => {
      for (const ref of [null, ""]) {
        state.branchRef = ref;
        const snapshot = await capture();
        expect(snapshot).toBeDefined();
        expect(snapshot?.head).toBe("head1");
        expect(snapshot?.branch).toBeUndefined();
      }
    });

    it("another ref is kept whole", async () => {
      state.branchRef = "refs/remotes/origin/x";
      expect((await capture())?.branch).toBe("refs/remotes/origin/x");
    });

    it("through the seam: line 2 is read from the git output", async () => {
      const seam = (out: string) => async (args: readonly string[], opts: SnapshotGitOptions) =>
        args.includes("--symbolic-full-name") ? out : execGit(args, opts);
      const signal = new AbortController().signal;
      expect((await snapshotTree(process.cwd(), signal, { git: seam("abc\nHEAD\n") }))?.branch).toBeNull();
      expect((await snapshotTree(process.cwd(), signal, { git: seam("abc\r\nrefs/heads/a/b\r\n") }))?.branch).toBe("a/b");
      expect((await snapshotTree(process.cwd(), signal, { git: seam("abc\n") }))?.branch).toBeUndefined();
    });

    it("execGit rejects a non-zero exit with a GitExitError carrying the code, with the same message as before", async () => {
      state.error = true;
      const opts = { cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 30_000, maxBuffer: 1024, lowPriority: false };
      const err = await execGit(["--no-pager", "rev-parse", "HEAD"], opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitExitError);
      expect(err).toMatchObject({ exitCode: 1, message: "git exited with code 1" });
      expect(gitExitCode(err)).toBe(1);
      // The message is never parsed as the contract.
      expect(gitExitCode(new Error("git exited with code 1"))).toBeUndefined();
    });
  });
});
