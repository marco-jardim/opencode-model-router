import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// Cross-repo P2.6 (SD11, F8). Real git in a real temp repository: the file-wide mocks above (child_process, fs/promises and
// git-tools) are lifted for this block, which is last in the file, and tree.ts is loaded afresh without them.
describe("snapshotTree — ignored-files digest (P2.6)", () => {
  type TreeModule = typeof import("../../src/verify/tree");
  let tree: TreeModule;
  let repo: string;
  let write: (rel: string, content: string) => Promise<void>;
  let gitIn: (...args: string[]) => void = () => undefined;
  const signal = new AbortController().signal;
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  beforeAll(async () => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../src/router/git-tools");
    vi.resetModules();
    tree = await import("../../src/verify/tree");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "omr-ignored-"));
    write = async (rel, content) => {
      const file = path.join(repo, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    };
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) => cp.execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, stdio: "ignore" });
    gitIn = git;
    await write(".gitignore", "dist/\nnode_modules/\n");
    await write("src/a.ts", "export const a = 1;\n");
    cleanup = () => fs.rm(repo, { recursive: true, force: true });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  }, 60_000);

  const ignoredOf = async (options: import("../../src/verify/tree").SnapshotOptions = {}) =>
    (await tree.snapshotTree(repo, signal, { ignoredDigest: true, ...options }))?.ignored;

  it("(a) editing an ignored dist file changes the digest", async () => {
    await write("dist/index.js", "one");
    const before = await ignoredOf();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(await ignoredOf()).toBe(before); // stable while nothing changes
    await write("dist/index.js", "two");
    const after = await ignoredOf();
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  }, 60_000);

  it("(b) editing a file under node_modules does not change the digest", async () => {
    await write("node_modules/x/y.js", "one");
    const before = await ignoredOf();
    await write("node_modules/x/y.js", "a different and longer content");
    await write("node_modules/x/z.js", "new");
    expect(await ignoredOf()).toBe(before);
  }, 60_000);

  it("(c) editing a tracked file does not change `ignored`", async () => {
    const before = await ignoredOf();
    await write("src/a.ts", "export const a = 2;\n");
    expect(await ignoredOf()).toBe(before);
  }, 60_000);

  it("(d) more ignored files or bytes than a bound is \"over-bounds\" (node_modules not counted)", async () => {
    await write("dist/index.js", "12345");
    await write("dist/other.js", "67890");
    for (let i = 0; i < 5; i++) await write(`node_modules/n/${i}.js`, "x".repeat(100));
    expect(await ignoredOf({ maxIgnoredFiles: 2, maxIgnoredBytes: 10 })).toMatch(/^[0-9a-f]{64}$/); // exactly at the bounds
    expect(await ignoredOf({ maxIgnoredFiles: 1 })).toBe("over-bounds");
    expect(await ignoredOf({ maxIgnoredBytes: 9 })).toBe("over-bounds");
  }, 60_000);

  it("(e) the ignored listing goes through the hardened runner when hardened", async () => {
    const seen: { args: readonly string[]; opts: import("../../src/verify/tree").SnapshotGitOptions }[] = [];
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      seen.push({ args, opts });
      return tree.execGit(args, opts);
    };
    const snapshot = await tree.snapshotTree(repo, signal, { hardened: true, ignoredDigest: true, git });
    expect(snapshot?.ignored).toMatch(/^[0-9a-f]{64}$/);
    const listing = seen.filter(c => c.args.includes("--ignored"));
    expect(listing).toHaveLength(1);
    expect(listing[0]?.args).toEqual(expect.arrayContaining(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "core.fsmonitor=false"]));
    expect(listing[0]?.opts.env).toBeDefined();
    expect(listing[0]?.opts.executable).toBeDefined();
    // Every process of the snapshot carried the hardening, the listing included.
    for (const c of seen) expect(c.args).toContain("core.fsmonitor=false");
  }, 60_000);

  it("a failing listing leaves `ignored` absent and the snapshot intact; it never throws", async () => {
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      if (args.includes("--ignored")) throw new Error("boom");
      return tree.execGit(args, opts);
    };
    const snapshot = await tree.snapshotTree(repo, signal, { ignoredDigest: true, git });
    expect(snapshot).toBeDefined();
    expect(snapshot && "ignored" in snapshot).toBe(false);
  }, 60_000);

  it("(f) without the option `ignored` is absent and git is not asked for the ignored files", async () => {
    const seen: (readonly string[])[] = [];
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      seen.push(args);
      return tree.execGit(args, opts);
    };
    const snapshot = await tree.snapshotTree(repo, signal, { git });
    expect(snapshot).toBeDefined();
    expect(snapshot && "ignored" in snapshot).toBe(false);
    expect(seen.some(a => a.includes("--ignored"))).toBe(false);
    expect(seen.some(a => a.includes("-v"))).toBe(false); // nor for the index tags (QA-2 #9b)
  }, 60_000);

  it("(g) QA-2 #4: git never lists inside node_modules (--directory, node_modules pathspec excludes); ignored directories are walked", async () => {
    await write("node_modules/x/y.js", "one");
    await write("dist/sub/deep.js", "one");
    const seen: (readonly string[])[] = [];
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      seen.push(args);
      return tree.execGit(args, opts);
    };
    const before = (await tree.snapshotTree(repo, signal, { ignoredDigest: true, git }))?.ignored;
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const listing = seen.filter(a => a.includes("--ignored"));
    expect(listing).toHaveLength(1);
    const args = listing[0] ?? [];
    expect(args).toContain("--directory");
    // The pathspec follows `--`: everything, minus every node_modules (top-level and nested) and its contents.
    expect(args.slice(args.indexOf("--"))).toEqual(["--", ".", ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**"]);
    expect([...tree.IGNORED_LIST_ARGS]).toEqual(args.slice(args.indexOf("ls-files")));
    // What git itself prints for that listing never names a path inside node_modules (git did not walk it): at most the bare
    // ignored directory, which the digest drops. dist/ is reported whole too, and walked by the digest.
    const raw = (await tree.execGit([...tree.IGNORED_LIST_ARGS], {
      cwd: repo, signal, timeoutMs: tree.SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: tree.SNAPSHOT_GIT_MAX_BUFFER, lowPriority: false,
    })).split("\0").filter(Boolean);
    expect(raw.filter(p => p.includes("node_modules") && p !== "node_modules/")).toEqual([]);
    expect(raw).toContain("dist/");
    expect(raw.some(p => p.startsWith("dist/") && p !== "dist/")).toBe(false);
    // The walk of an ignored directory sees nested files, and skips a node_modules inside it.
    await write("dist/sub/deep.js", "two");
    const after = await ignoredOf();
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    await write("dist/node_modules/k.js", "one");
    expect(await ignoredOf()).toBe(after);
    await write("dist/node_modules/k.js", "a different and longer content");
    expect(await ignoredOf()).toBe(after);
  }, 60_000);

  it("(h) QA-2 #9b: a skip-worktree entry makes the digest \"over-bounds\" (the fingerprint cannot see its edits)", async () => {
    expect(await ignoredOf()).toMatch(/^[0-9a-f]{64}$/);
    gitIn("update-index", "--skip-worktree", "src/a.ts");
    try {
      expect(await ignoredOf()).toBe("over-bounds");
    } finally {
      gitIn("update-index", "--no-skip-worktree", "src/a.ts");
    }
    expect(await ignoredOf()).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("(i) QA-2 #9b: an assume-unchanged entry makes the digest \"over-bounds\"", async () => {
    gitIn("update-index", "--assume-unchanged", "src/a.ts");
    try {
      expect(await ignoredOf()).toBe("over-bounds");
    } finally {
      gitIn("update-index", "--no-assume-unchanged", "src/a.ts");
    }
    expect(await ignoredOf()).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("(j) QA-2 #9b: the index tags are read only when the digest is asked for, through the same runner", async () => {
    const seen: (readonly string[])[] = [];
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      seen.push(args);
      return tree.execGit(args, opts);
    };
    await tree.snapshotTree(repo, signal, { ignoredDigest: true, git });
    expect(seen.filter(a => a.join(" ").endsWith(tree.INDEX_TAGS_ARGS.join(" ")))).toHaveLength(1);
  }, 60_000);

  it("(k) QA-2 #9b: a failing index-tags listing leaves `ignored` absent and the snapshot intact; it never throws", async () => {
    const git = async (args: readonly string[], opts: import("../../src/verify/tree").SnapshotGitOptions) => {
      if (args.join(" ").endsWith(tree.INDEX_TAGS_ARGS.join(" "))) throw new Error("boom");
      return tree.execGit(args, opts);
    };
    const snapshot = await tree.snapshotTree(repo, signal, { ignoredDigest: true, git });
    expect(snapshot).toBeDefined();
    expect(snapshot && "ignored" in snapshot).toBe(false);
  }, 60_000);
});

// Cross-repo P3a (D23, OD-P3a-2 b, finding X6): the linked repository's git-ignored modules (its build output) a cross-link
// run adds to its related inputs. Real git in real temp directories, without the file-wide mocks (as the block above).
describe("listIgnoredModules — the linked repository's ignored modules (cross-repo P3a, D23)", () => {
  type TreeModule = typeof import("../../src/verify/tree");
  type GitOptions = import("../../src/verify/tree").SnapshotGitOptions;
  let tree: TreeModule;
  let repo: string;
  let outside: string;
  let write: (rel: string, content: string) => Promise<void>;
  /** Sets a fixture file's own atime and mtime (fs.utimesSync). */
  let touch: (rel: string, at: Date) => void;
  let readIndex: () => Promise<Buffer>;
  const signal = new AbortController().signal;
  let cleanup: (() => Promise<void>) | undefined;
  /** The module files the fixture writes, relative to the repository (sorted as the lister sorts absolute paths). */
  const MODULES = [
    "dist/a.cts", "dist/a.mts", "dist/c.tsx", "dist/cjs/index.cjs", "dist/d.jsx", "dist/esm/index.mjs",
    "dist/index.js", "dist/package.json", "generated.json",
  ];
  /** QA M4: declaration files the fixture writes under the ignored `dist/`: never listed. */
  const DECLARATIONS = ["dist/index.d.ts", "dist/esm/index.d.mts", "dist/cjs/index.d.cts", "dist/upper.D.TS"];
  /** QA M4: modules inside a nested repository (`.git` directory) and a worktree (`.git` file) under `dist/`: never listed. */
  const NESTED = ["dist/nested/x.js", "dist/nested/deep/y.js", "dist/wt/z.js", "dist/wt/sub/w.json"];

  afterAll(async () => {
    await cleanup?.();
  });

  beforeAll(async () => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../src/router/git-tools");
    vi.resetModules();
    tree = await import("../../src/verify/tree");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const os = await vi.importActual<typeof import("node:os")>("node:os");
    const path = await vi.importActual<typeof import("node:path")>("node:path");
    const fsSync = await vi.importActual<typeof import("node:fs")>("node:fs");
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "omr-ignored-modules-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "omr-not-a-repo-"));
    write = async (rel, content) => {
      const file = path.join(repo, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    };
    touch = (rel, at) => fsSync.utimesSync(path.join(repo, rel), at, at);
    readIndex = () => fs.readFile(path.join(repo, ".git", "index"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) => cp.execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, stdio: "ignore" });
    await write(".gitignore", "dist/\nnode_modules/\ngenerated.json\n*.log\n");
    await write("src/a.ts", "export const a = 1;\n");
    await write("package.json", "{}\n");
    cleanup = async () => {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    };
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    for (const rel of MODULES) await write(rel, "x");
    // Ignored, but not modules: never listed.
    for (const rel of ["dist/index.js.map", "dist/README.md", "dist/style.css", "debug.log"]) await write(rel, "x");
    // Modules under a node_modules segment (top-level and inside an ignored directory): never listed.
    for (const rel of ["node_modules/x/y.js", "node_modules/x/package.json", "dist/node_modules/k/index.js"]) await write(rel, "x");
    // Untracked but not ignored, and tracked: not the lister's (W's change set already holds them).
    await write("src/new.ts", "export const n = 1;\n");
    // QA M4: declaration files are never loaded modules.
    for (const rel of DECLARATIONS) await write(rel, "x");
    // QA M4: a nested repository (a `.git` directory) and a worktree (a `.git` file) under the ignored `dist/`: skipped whole.
    await write("dist/nested/.git/HEAD", "ref: refs/heads/main\n");
    await write("dist/wt/.git", "gitdir: ../../.git/worktrees/wt\n");
    for (const rel of NESTED) await write(rel, "x");
  }, 60_000);

  const abs = (rels: readonly string[]) => rels.map(rel => resolve(repo, rel)).sort();

  it("lists the ignored .js/.cjs/.mjs/.ts/.cts/.mts/.tsx/.jsx/.json files under the root as absolute paths, never under node_modules", async () => {
    expect([...tree.IGNORED_MODULE_EXTENSIONS].sort()).toEqual([".cjs", ".cts", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
    const result = await tree.listIgnoredModules(repo, { signal });
    expect(result).toEqual({ files: abs(MODULES) });
    const files = "files" in result ? result.files : [];
    expect(files.every(file => !file.split(/[\\/]/).includes("node_modules"))).toBe(true);
    expect(files).not.toContain(resolve(repo, "src/a.ts")); // tracked
    expect(files).not.toContain(resolve(repo, "src/new.ts")); // untracked, not ignored
    expect(files).not.toContain(resolve(repo, "dist/index.js.map"));
  }, 60_000);

  it("is bounded by file count, total path bytes and walked entries (exported constants); over a bound → overBounds, never truncated", async () => {
    expect(tree.MAX_IGNORED_MODULES).toBe(2_000);
    expect(tree.MAX_IGNORED_MODULE_PATH_BYTES).toBe(256 * 1024);
    expect(tree.MAX_IGNORED_WALK_ENTRIES).toBe(50_000);
    const bytes = abs(MODULES).reduce((sum, file) => sum + Buffer.byteLength(file, "utf8"), 0);
    // Exactly at the bounds (node_modules and non-module files not counted): the whole list.
    expect(await tree.listIgnoredModules(repo, { signal, maxFiles: MODULES.length, maxPathBytes: bytes })).toEqual({ files: abs(MODULES) });
    expect(await tree.listIgnoredModules(repo, { signal, maxFiles: MODULES.length - 1 })).toEqual({ overBounds: true });
    expect(await tree.listIgnoredModules(repo, { signal, maxPathBytes: bytes - 1 })).toEqual({ overBounds: true });
    expect(await tree.listIgnoredModules(repo, { signal, maxWalkEntries: 1 })).toEqual({ overBounds: true });
  }, 60_000);

  it("runs the ignored listing (IGNORED_LIST_ARGS) hardened, once, and leaves the index untouched", async () => {
    const seen: { args: readonly string[]; opts: GitOptions }[] = [];
    const git = async (args: readonly string[], opts: GitOptions) => {
      seen.push({ args, opts });
      return tree.execGit(args, opts);
    };
    const index = await readIndex();
    expect(await tree.listIgnoredModules(repo, { signal, git, lowPriority: true })).toEqual({ files: abs(MODULES) });
    expect(seen).toHaveLength(1);
    const { args, opts } = seen[0] as { args: readonly string[]; opts: GitOptions };
    expect(args.slice(args.indexOf("ls-files"))).toEqual([...tree.IGNORED_LIST_ARGS]);
    expect(args.slice(0, args.indexOf("ls-files"))).toEqual(expect.arrayContaining(["--no-optional-locks", "core.fsmonitor=false"]));
    expect(args.some(arg => arg.startsWith("core.hooksPath="))).toBe(true);
    expect(opts).toMatchObject({ cwd: repo, lowPriority: true, timeoutMs: tree.SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: tree.SNAPSHOT_GIT_MAX_BUFFER });
    expect(opts.env).toBeDefined();
    expect(opts.executable).toBeDefined();
    expect((await readIndex()).equals(index)).toBe(true);
  }, 60_000);

  it("fails closed: a non-repository, a git failure or an abort → unavailable, never a throw", async () => {
    expect(await tree.listIgnoredModules(outside, { signal })).toEqual({ unavailable: true });
    const failing = async () => {
      throw new Error("boom");
    };
    expect(await tree.listIgnoredModules(repo, { signal, git: failing })).toEqual({ unavailable: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(await tree.listIgnoredModules(repo, { signal: aborted.signal })).toEqual({ unavailable: true });
  }, 60_000);

  it("drops declaration files (.d.ts, .d.mts, .d.cts, any case) — QA M4", async () => {
    const result = await tree.listIgnoredModules(repo, { signal });
    const files = "files" in result ? result.files : [];
    expect(files.length).toBeGreaterThan(0);
    for (const declaration of abs(DECLARATIONS)) expect(files).not.toContain(declaration);
    expect(files.some(file => /\.d\.[cm]?ts$/i.test(file))).toBe(false);
    // Not a declaration: an ordinary .ts/.mts/.cts module is still listed.
    expect(files).toContain(resolve(repo, "dist/a.mts"));
    expect(files).toContain(resolve(repo, "dist/a.cts"));
  }, 60_000);

  it("skips a directory holding a .git entry (nested repository or worktree) entirely, its subtree included — QA M4", async () => {
    const result = await tree.listIgnoredModules(repo, { signal });
    expect(result).toEqual({ files: abs(MODULES) });
    const files = "files" in result ? result.files : [];
    for (const nested of abs(NESTED)) expect(files).not.toContain(nested);
    expect(files.some(file => file.split(/[\\/]/).includes(".git"))).toBe(false);
  }, 60_000);

  it("with since: keeps only the files whose own mtime is at or after it (fs.utimesSync) — QA C1, D23 as amended", async () => {
    const since = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
    const old = new Date(Date.UTC(2001, 0, 1, 0, 0, 0));
    const fresh = new Date(Date.UTC(2021, 0, 1, 0, 0, 0));
    const stale = ["dist/index.js", "dist/esm/index.mjs", "generated.json"];
    for (const rel of stale) touch(rel, old);
    for (const rel of MODULES.filter(rel => !stale.includes(rel))) touch(rel, fresh);
    touch("dist/d.jsx", since); // exactly at `since`: kept (>=)
    const kept = MODULES.filter(rel => !stale.includes(rel));
    expect(await tree.listIgnoredModules(repo, { signal, since: since.getTime() })).toEqual({ files: abs(kept) });
    // An old build output is excluded, a fresh one included; nothing at all when every file predates `since`.
    expect(await tree.listIgnoredModules(repo, { signal, since: fresh.getTime() + 1_000 })).toEqual({ files: [] });
    // Without since: no mtime filter (the hook never calls without one).
    expect(await tree.listIgnoredModules(repo, { signal })).toEqual({ files: abs(MODULES) });
    // The bounds count only the kept files.
    expect(await tree.listIgnoredModules(repo, { signal, since: since.getTime(), maxFiles: kept.length })).toEqual({ files: abs(kept) });
  }, 60_000);
});
