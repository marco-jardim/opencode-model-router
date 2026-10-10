import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  assertSafeRefDir,
  captureReference,
  gcStaleReferences,
  isStrictlyInside,
  materialize,
  nodeReferenceFs,
  referenceLockReason,
  UnsafeReferencePathError,
  type CaptureDeps,
  type DispatchReference,
  type MaterializedReference,
  type ReferenceDeps,
} from "../../src/verify/reference";

const isWin = process.platform === "win32";
const linkType = isWin ? "junction" : "dir";

type SeamOptions = Parameters<CaptureDeps["argv"]>[2];

/** Kill a process and all its descendants (what runArgv (1.2) does on abort or timeout). */
function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (isWin) {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      // ESRCH: the group already exited, nothing left to kill.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    resolve();
  });
}

// Test-only ArgvSeam, production-like: env merged over process.env, and a tree kill on
// abort or timeout; resolves only after the process has exited (reference.ts never
// imports child_process).
const argv: CaptureDeps["argv"] = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk));
    const kill = () => {
      if (killed || child.pid === undefined || child.exitCode !== null) return;
      killed = true;
      void treeKill(child.pid);
    };
    const timer = opts?.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    opts?.signal?.addEventListener("abort", kill, { once: true });
    if (opts?.signal?.aborted) kill();
    const done = (code: number) => {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr, timedOut: killed });
    };
    child.on("error", (error) => {
      stderr += String(error);
      done(-1);
    });
    child.on("close", (code) => done(code ?? 1));
  });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await argv("git", args, { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

interface CwdHolder {
  release(): Promise<void>;
}

/**
 * A process whose cwd is `cwd`: on win32 a cwd handle blocks deleting that directory
 * (a Node file handle does not). Resolves only once the child has printed READY, i.e.
 * it runs with that cwd; the `spawn` event fires before the child has opened its cwd,
 * and a holder gated on it lost that race (QA-1.5-14).
 */
async function holdCwd(cwd: string): Promise<CwdHolder> {
  const holder = spawn(process.execPath, ["-e", "process.stdout.write('READY\\n'); setTimeout(() => {}, 120000)"], {
    cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => {
    holder.once("close", () => resolve());
    holder.once("error", () => resolve());
  });
  const release = async () => {
    holder.kill();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("READY")) resolve();
      });
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`cwd holder exited before READY (code ${code})`)));
    });
  } catch (error) {
    await release();
    throw error;
  }
  return { release };
}

let base: string;
let repo: string;
let tmp: string;
let warnings: string[];

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function repoState(cwd: string) {
  return {
    status: await git(cwd, "status", "--porcelain"),
    stash: await git(cwd, "stash", "list"),
    refs: await git(cwd, "for-each-ref"),
    index: await git(cwd, "ls-files", "-s"),
  };
}

async function worktreeCount(cwd: string): Promise<number> {
  return (await git(cwd, "worktree", "list", "--porcelain")).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
}

async function refDirsIn(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).filter((name) => name.startsWith("omr-ref-"));
}

function deps(over: Partial<ReferenceDeps> = {}): ReferenceDeps {
  return { argv, fs: nodeReferenceFs, tmpdir: tmp, logger: { warn: (m) => void warnings.push(m) }, ...over };
}

function captureDeps(over: Partial<CaptureDeps> = {}): CaptureDeps {
  return { argv, fs: nodeReferenceFs, tmpdir: tmp, ...over };
}

async function capture(signal = new AbortController().signal): Promise<DispatchReference> {
  const ref = await captureReference(repo, signal, captureDeps());
  if (!ref) throw new Error("capture returned undefined");
  return ref;
}

async function mat(ref: DispatchReference, over: Partial<ReferenceDeps> = {}): Promise<MaterializedReference> {
  const result = await materialize(ref, undefined, new AbortController().signal, deps(over));
  if (!result.ok) throw new Error(`materialize failed: ${result.reason} ${result.detail}`);
  return result.reference;
}

beforeEach(async () => {
  warnings = [];
  base = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr refs ü テスト "));
  repo = join(base, "repo ü dir");
  tmp = join(base, "tmp ä dir");
  await fsp.mkdir(repo);
  await fsp.mkdir(tmp);
  await git(repo, "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    await git(repo, "config", k, v);
  }
  await fsp.mkdir(join(repo, "packages", "a"), { recursive: true });
  await fsp.writeFile(join(repo, "a.txt"), "a0\n");
  await fsp.writeFile(join(repo, "b.txt"), "b0\n");
  await fsp.writeFile(join(repo, "package.json"), '{"name":"root"}\n');
  await fsp.writeFile(join(repo, "packages", "a", "index.js"), "module.exports = 0;\n");
  await fsp.writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  for (const nm of [join(repo, "node_modules"), join(repo, "packages", "a", "node_modules")]) {
    await fsp.mkdir(nm);
    await fsp.writeFile(join(nm, "sentinel.txt"), "keep me");
  }
});

afterEach(async () => {
  try {
    expect(await worktreeCount(repo)).toBe(1);
    expect(await refDirsIn(tmp)).toEqual([]);
  } finally {
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe("captureReference", { timeout: 60_000 }, () => {
  it("clean tree -> commit is HEAD", async () => {
    const ref = await capture();
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    expect(ref.head).toBe(head);
    expect(ref.commit).toBe(head);
    expect(ref.untracked.size).toBe(0);
    expect(ref.root.toLowerCase()).toBe(repo.toLowerCase());
  });

  it("dirty tracked -> stash commit holds the dirty content; repo state unchanged", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const before = await repoState(repo);
    const ref = await capture();
    expect(await repoState(repo)).toEqual(before);
    expect(ref.commit).not.toBe(ref.head);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-dirty\n");
  });

  it("staged + unstaged mixed; stash list, refs and index content unchanged", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-staged\n");
    await git(repo, "add", "a.txt");
    await fsp.writeFile(join(repo, "b.txt"), "b-unstaged\n");
    const before = await repoState(repo);
    const ref = await capture();
    expect(await repoState(repo)).toEqual(before);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-staged\n");
    expect(await git(repo, "show", `${ref.commit}:b.txt`)).toBe("b-unstaged\n");
    expect(before.stash).toBe("");
  });

  it("records untracked files by sha256, excludes ignored ones", async () => {
    await fsp.writeFile(join(repo, "u.txt"), "u");
    await fsp.writeFile(join(repo, ".env"), "SECRET=1");
    const ref = await capture();
    expect([...ref.untracked.keys()]).toEqual(["u.txt"]);
    expect(ref.untracked.get("u.txt")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submodules -> undefined", async () => {
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
    expect(await captureReference(repo, new AbortController().signal, captureDeps())).toBeUndefined();
  });

  it("outside a git repo -> undefined", async () => {
    const outside = join(base, "not a repo");
    await fsp.mkdir(outside);
    expect(await captureReference(outside, new AbortController().signal, captureDeps())).toBeUndefined();
  });

  it("abort mid-capture -> undefined, no partial state", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const before = await repoState(repo);
    const controller = new AbortController();
    const aborting: CaptureDeps["argv"] = async (file, args, opts) => {
      const result = await argv(file, args, opts);
      if (args.includes("stash")) controller.abort();
      return result;
    };
    expect(await captureReference(repo, controller.signal, captureDeps({ argv: aborting }))).toBeUndefined();
    expect(await captureReference(repo, AbortSignal.abort(), captureDeps())).toBeUndefined();
    expect(await repoState(repo)).toEqual(before);
  });

  it("QA-1.5-1: a tree kill of `git stash create` while it holds the index lock leaves the user's index untouched", async () => {
    // A slow clean filter keeps stash create inside its stat refresh, which holds the
    // index lock, so the kill below lands while the lock is held.
    await fsp.writeFile(join(repo, ".gitattributes"), "slow.txt filter=slow\n");
    await fsp.writeFile(join(repo, "slow.txt"), "slow\n");
    await git(repo, "add", ".gitattributes", "slow.txt");
    await git(repo, "commit", "-q", "-m", "slow");
    // Short: on win32 the MSYS `sleep` escapes `taskkill /T` (its parent is a fork stub)
    // and holds git's stderr pipe until it exits, so the seam resolves only after it.
    await git(repo, "config", "filter.slow.clean", "sleep 3; cat");
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(join(repo, "slow.txt"), past, past); // stat-dirty, same size: the refresh re-cleans it
    const userIndex = join(repo, ".git", "index");
    const indexBefore = await fsp.readFile(userIndex);
    const controller = new AbortController();
    let stashOpts: SeamOptions;
    let lockSeen = false;
    const killing: CaptureDeps["argv"] = async (file, args, opts) => {
      if (!args.includes("stash")) return argv(file, args, opts);
      stashOpts = opts;
      const kill = new AbortController();
      const running = argv(file, args, { ...opts, signal: kill.signal });
      const lock = `${opts?.env?.GIT_INDEX_FILE ?? userIndex}.lock`;
      lockSeen = await waitFor(() => exists(lock), 15_000);
      controller.abort(); // the caller gives up...
      kill.abort(); // ...and git is tree-killed while it holds the lock, as a timeout would do
      return running;
    };
    const started = Date.now();
    expect(await captureReference(repo, controller.signal, captureDeps({ argv: killing }))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(lockSeen).toBe(true);
    expect(stashOpts?.signal).toBeUndefined();
    const privateIndex = stashOpts?.env?.GIT_INDEX_FILE ?? "";
    expect(privateIndex.toLowerCase().startsWith(tmp.toLowerCase())).toBe(true);
    expect(await exists(`${userIndex}.lock`)).toBe(false);
    expect(Buffer.compare(await fsp.readFile(userIndex), indexBefore)).toBe(0);
    expect((await fsp.readdir(join(repo, ".git"))).filter((name) => name.startsWith("index.stash."))).toEqual([]);
    // The producer's next index write still works.
    await git(repo, "config", "--unset", "filter.slow.clean");
    await git(repo, "add", "slow.txt");
  });

  it("private index keeps racy-git detection: stat-identical same-size edits are captured and seen as drift", async () => {
    const userIndex = join(repo, ".git", "index");
    // Make an edit only a content check can see: same size, same mtime as the index entry,
    // and the index file no newer than that mtime (racily clean). Git re-reads such an
    // entry only while the index file is not newer; a fresh copy of the index would be.
    const statIdenticalEdit = async (rel: string, content: string) => {
      const file = join(repo, rel);
      const { mtime } = await fsp.stat(file);
      await fsp.writeFile(file, content);
      await fsp.utimes(file, mtime, mtime);
      await fsp.utimes(userIndex, mtime, mtime);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // any copy made now is in a later second
    };
    await statIdenticalEdit("a.txt", "a1\n");
    const ref = await capture();
    expect(ref.commit).not.toBe(ref.head);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a1\n");
    await statIdenticalEdit("package.json", '{"name":"toor"}\n');
    const handle = await mat(ref);
    try {
      expect(handle.inexactReasons).toContainEqual({ cause: "dependency-drift", path: "package.json" });
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-2: every git call carries --no-optional-locks; capture and materialize never write the user's index", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(join(repo, "b.txt"), past, past); // stat-only change: a refresh would rewrite the index
    const userIndex = join(repo, ".git", "index");
    const indexBefore = await fsp.readFile(userIndex);
    const calls: string[][] = [];
    const recording: CaptureDeps["argv"] = (file, args, opts) => {
      calls.push([...args]);
      return argv(file, args, opts);
    };
    const ref = await captureReference(repo, new AbortController().signal, captureDeps({ argv: recording }));
    expect(ref).toBeDefined();
    if (!ref) return;
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-dirty\n");
    const handle = await mat(ref, { argv: recording });
    await handle.dispose();
    expect(calls.length).toBeGreaterThan(5);
    for (const args of calls) expect(args[0]).toBe("--no-optional-locks");
    expect(Buffer.compare(await fsp.readFile(userIndex), indexBefore)).toBe(0);
  });

  it("QA-1.5-18/22: every git call resets the four pathspec env switches to \"0\"; caller keys still arrive", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const recording: CaptureDeps["argv"] = (file, args, opts) => {
      envs.push(opts?.env);
      return argv(file, args, opts);
    };
    const ref = await captureReference(repo, new AbortController().signal, captureDeps({ argv: recording }));
    expect(ref).toBeDefined();
    if (!ref) return;
    const handle = await mat(ref, { argv: recording });
    await handle.dispose();
    expect(envs.length).toBeGreaterThan(5);
    for (const env of envs) {
      expect(env).toMatchObject({
        GIT_LITERAL_PATHSPECS: "0",
        GIT_GLOB_PATHSPECS: "0",
        GIT_NOGLOB_PATHSPECS: "0",
        GIT_ICASE_PATHSPECS: "0",
      });
    }
    expect(envs.some((env) => typeof env?.GIT_INDEX_FILE === "string" && env.GIT_INDEX_FILE !== "")).toBe(true);
  });
});

describe("materialize / dispose", { timeout: 60_000 }, () => {
  it("untracked: unchanged copied exactly; modified/deleted -> inexact; new after dispatch not copied", async () => {
    await fsp.writeFile(join(repo, "keep.txt"), "keep");
    await fsp.writeFile(join(repo, "mod.txt"), "mod0");
    await fsp.writeFile(join(repo, "del.txt"), "del");
    const ref = await capture();
    await fsp.writeFile(join(repo, "mod.txt"), "mod1");
    await fsp.rm(join(repo, "del.txt"));
    await fsp.writeFile(join(repo, "new.txt"), "new");
    const handle = await mat(ref);
    try {
      expect(await fsp.readFile(join(handle.dir, "keep.txt"), "utf8")).toBe("keep");
      expect(await exists(join(handle.dir, "mod.txt"))).toBe(false);
      expect(await exists(join(handle.dir, "new.txt"))).toBe(false);
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toEqual(
        expect.arrayContaining([
          { cause: "untracked-modified", path: "mod.txt" },
          { cause: "untracked-deleted", path: "del.txt" },
        ]),
      );
      expect(handle.inexactReasons.some((r) => r.path === "new.txt")).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("new untracked after dispatch does not affect exactness; dirty tracked content is checked out", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    await fsp.writeFile(join(repo, ".env"), "SECRET=1");
    const ref = await capture();
    await fsp.writeFile(join(repo, "later.txt"), "later");
    const handle = await mat(ref);
    try {
      expect(handle.exact).toBe(true);
      expect(await exists(join(handle.dir, "later.txt"))).toBe(false);
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a-dirty\n");
      expect(handle.unreproduced).toContain(".env");
      expect(await exists(join(handle.dir, ".env"))).toBe(false);
      expect(handle.dir.startsWith(tmp)).toBe(true);
      expect(handle.toRefPath(join(repo, "packages", "a"))).toBe(join(handle.dir, "packages", "a"));
      expect(handle.toRefPath(join(base, "elsewhere"))).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });

  it("KEY SAFETY: node_modules linked; dispose leaves the real node_modules and sentinels intact", async () => {
    const ref = await capture();
    const handle = await mat(ref);
    expect(handle.links.map((l) => l.slice(handle.dir.length + 1).replaceAll("\\", "/")).sort()).toEqual([
      "node_modules",
      "packages/a/node_modules",
    ]);
    for (const link of handle.links) {
      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fsp.readFile(join(link, "sentinel.txt"), "utf8")).toBe("keep me");
    }
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    for (const nm of [join(repo, "node_modules"), join(repo, "packages", "a", "node_modules")]) {
      expect((await fsp.lstat(nm)).isDirectory()).toBe(true);
      expect(await fsp.readFile(join(nm, "sentinel.txt"), "utf8")).toBe("keep me");
    }
  });

  it("dispose with extra links created inside the worktree leaves their targets intact", async () => {
    const outside = join(base, "outside target");
    await fsp.mkdir(outside);
    await fsp.writeFile(join(outside, "sentinel.txt"), "outside");
    const handle = await mat(await capture());
    await fsp.symlink(outside, join(handle.dir, "extra-link"), linkType);
    await fsp.symlink(join(repo, "node_modules"), join(handle.dir, "packages", "a", "deep-link"), linkType);
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    expect(await fsp.readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-3: a link created after the sweep never costs its target; git runs only once the dir is gone", async () => {
    const victim = join(base, "victim");
    await fsp.mkdir(join(victim, "pkg"), { recursive: true });
    await fsp.writeFile(join(victim, "pkg", "sentinel.txt"), "real data");
    let refDir = "";
    let dirAtGitRemove: boolean | undefined;
    const lateLinkFs: ReferenceDeps["fs"] = {
      ...nodeReferenceFs,
      rm: async (path, options) => {
        // The race: a junction appears between the sweep and the recursive removal.
        if (await exists(join(path, ".git"))) await fsp.symlink(victim, join(path, "packages", "late-link"), linkType);
        return nodeReferenceFs.rm(path, options);
      },
    };
    const watching: CaptureDeps["argv"] = async (file, args, opts) => {
      if (refDir && args.includes("worktree") && args.includes("remove")) {
        dirAtGitRemove = await exists(refDir);
        if (dirAtGitRemove) await fsp.symlink(victim, join(refDir, "late-link-2"), linkType);
      }
      return argv(file, args, opts);
    };
    const handle = await mat(await capture(), { fs: lateLinkFs, argv: watching });
    refDir = handle.dir;
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    expect(dirAtGitRemove).toBe(false);
    expect(await fsp.readFile(join(victim, "pkg", "sentinel.txt"), "utf8")).toBe("real data");
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-10: the dir exists, empty and private (0o700 on POSIX), before git checks out into it", async () => {
    let seen: { isDir: boolean; entries: string[]; mode: number } | undefined;
    const checking: CaptureDeps["argv"] = async (file, args, opts) => {
      if (args.includes("worktree") && args.includes("add")) {
        const target = args[args.length - 2]; // `... add --detach --lock --reason <r> <dir> <commit>`
        const stats = await fsp.lstat(target);
        seen = { isDir: stats.isDirectory(), entries: await fsp.readdir(target), mode: stats.mode & 0o777 };
      }
      return argv(file, args, opts);
    };
    const handle = await mat(await capture(), { argv: checking });
    try {
      expect(seen).toMatchObject({ isDir: true, entries: [] });
      if (!isWin) {
        expect(seen?.mode).toBe(0o700);
        expect((await fsp.lstat(handle.dir)).mode & 0o777).toBe(0o700);
      }
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\n");
    } finally {
      await handle.dispose();
    }
  });

  it("an existing dir with the chosen name is refused and left alone", async () => {
    const suffix = "0123456789abcdef";
    const existing = join(tmp, `omr-ref-${process.pid}-${suffix}`);
    await fsp.mkdir(existing);
    await fsp.writeFile(join(existing, "foreign.txt"), "not ours");
    const result = await materialize(await capture(), undefined, new AbortController().signal, deps({ randomSuffix: () => suffix }));
    expect(result).toMatchObject({ ok: false, reason: "unsafe-path" });
    expect(await fsp.readFile(join(existing, "foreign.txt"), "utf8")).toBe("not ours");
    await fsp.rm(existing, { recursive: true, maxRetries: 10, retryDelay: 200 });
  });

  it("dispose twice returns the same promise and never rejects", async () => {
    const handle = await mat(await capture());
    const first = handle.dispose();
    expect(handle.dispose()).toBe(first);
    await first;
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
  });

  it("dispose after the dir was deleted externally drops the admin entry", async () => {
    const handle = await mat(await capture());
    for (const link of handle.links) await fsp.unlink(link);
    await fsp.rm(handle.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await handle.dispose();
    expect(await worktreeCount(repo)).toBe(1);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it.runIf(isWin)("QA-1.5-9a: a process whose cwd is inside the reference -> dispose resolves bounded and warns; GC removes it later", async () => {
    const handle = await mat(await capture());
    let holder: CwdHolder | undefined;
    try {
      holder = await holdCwd(join(handle.dir, "packages")); // READY-gated (QA-1.5-14)
      const started = Date.now();
      await expect(handle.dispose()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10_000); // nested fs.rm retries took ~11 s here (QA-1.5-11)
      expect(warnings.some((w) => w.startsWith("reference worktree left in place"))).toBe(true);
      expect(await exists(handle.dir)).toBe(true);
      expect(await worktreeCount(repo)).toBe(2); // git never ran on the existing dir
      for (const link of handle.links) expect(await exists(link)).toBe(false); // links went first
    } finally {
      await holder?.release();
    }
    // The released dir is ours and stale at once, although this process is alive and it is fresh.
    const report = await gcStaleReferences(repo, deps());
    expect(report.removed.map((d) => d.toLowerCase())).toEqual([handle.dir.toLowerCase()]);
    expect(await exists(handle.dir)).toBe(false);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it.runIf(isWin)("QA-1.5-11: a cwd holder two levels deep -> dispose stays bounded, and GC stops at its budget", async () => {
    const handle = await mat(await capture());
    let holder: CwdHolder | undefined;
    try {
      // Depth 2 (packages/a): Node's nested fs.rm retries took 66 s here, for dispose and again for GC.
      holder = await holdCwd(join(handle.dir, "packages", "a"));
      const started = Date.now();
      await expect(handle.dispose()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(warnings.some((w) => w.startsWith("reference worktree left in place"))).toBe(true);
      expect(await exists(handle.dir)).toBe(true);
      // Still held: the released dir is a GC candidate whose fs.rm keeps failing. Without the
      // budget check, the flat loop alone would sleep 3.1 s.
      const gcStarted = Date.now();
      const held = await gcStaleReferences(repo, deps({ timeoutMs: 1_500 }));
      expect(Date.now() - gcStarted).toBeLessThan(3_000);
      expect(held.failed.map((d) => d.toLowerCase())).toEqual([handle.dir.toLowerCase()]);
      expect(held.removed).toEqual([]);
      expect(await exists(handle.dir)).toBe(true);
    } finally {
      await holder?.release();
    }
    const report = await gcStaleReferences(repo, deps());
    expect(report.removed.map((d) => d.toLowerCase())).toEqual([handle.dir.toLowerCase()]);
    expect(await exists(handle.dir)).toBe(false);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-9b: tmpdir given in os.tmpdir()'s own form (8.3 on this host): capture, materialize, GC and dispose agree", async () => {
    const osTmp = tmpdir();
    const shortTmp = join(osTmp, relative(await fsp.realpath(osTmp), tmp));
    expect(await fsp.realpath(shortTmp)).toBe(tmp);
    const ref = await captureReference(repo, new AbortController().signal, captureDeps({ tmpdir: shortTmp }));
    expect(ref).toBeDefined();
    if (!ref) return;
    const handle = await mat(ref, { tmpdir: shortTmp });
    try {
      expect(handle.dir.startsWith(tmp)).toBe(true); // created under the long form
      const report = await gcStaleReferences(repo, deps({ tmpdir: shortTmp, now: () => Date.now() + 10 * 60 * 60 * 1000 }));
      expect(report.kept.map((d) => d.toLowerCase())).toEqual([handle.dir.toLowerCase()]);
    } finally {
      await handle.dispose();
    }
    expect(await exists(handle.dir)).toBe(false);
    // A dead owner's worktree added through the short form is still found and collected.
    const dead = join(shortTmp, "omr-ref-111111-0123456789abcdef");
    await git(repo, "worktree", "add", "-q", "--detach", dead, "HEAD");
    const report = await gcStaleReferences(repo, deps({ tmpdir: shortTmp, isAlive: () => false }));
    expect(report.removed).toHaveLength(1);
    expect(report.failed).toEqual([]);
    expect(await exists(dead)).toBe(false);
  });

  it("dependency drift -> inexact with reason", async () => {
    const ref = await capture();
    await fsp.writeFile(join(repo, "package.json"), '{"name":"root","dependencies":{"x":"1"}}\n');
    const handle = await mat(ref);
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "dependency-drift", path: "package.json" });
    } finally {
      await handle.dispose();
    }
  });

  it("workspace-link drift -> inexact with reason", async () => {
    await fsp.mkdir(join(repo, "node_modules", "@s"));
    await fsp.symlink(join(repo, "packages", "a"), join(repo, "node_modules", "@s", "a"), linkType);
    const ref = await capture();
    await fsp.writeFile(join(repo, "packages", "a", "index.js"), "module.exports = 1;\n");
    const handle = await mat(ref);
    try {
      expect(handle.inexactReasons).toContainEqual({ cause: "workspace-link-drift", path: "packages/a" });
    } finally {
      await handle.dispose();
    }
    expect(await fsp.readFile(join(repo, "packages", "a", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("QA-1.5-6a: core.autocrlf=true or input -> inexact checkout-conversion", async () => {
    for (const value of ["true", "input"]) {
      await git(repo, "config", "core.autocrlf", value);
      const handle = await mat(await capture());
      try {
        if (value === "true") expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\r\n");
        expect(handle.exact).toBe(false);
        expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "" });
      } finally {
        await handle.dispose();
      }
    }
  });

  it("QA-1.5-6a: a dirty file whose checkout differs from the live bytes (eol attribute) -> inexact for that path", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "eol");
    await fsp.writeFile(join(repo, "a.txt"), "x\ny\n");
    const ref = await capture();
    expect([...ref.tracked.keys()]).toEqual(["a.txt"]);
    const handle = await mat(ref);
    try {
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("x\r\ny\r\n");
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-13: a CLEAN file whose checkout changes its eol class (`* text=auto`, `eol=crlf`) -> inexact for that path", async () => {
    const variants: Array<[string, string[]]> = [
      // core.autocrlf=false, core.eol unset: native eol, CRLF on win32 (QA's repro), LF elsewhere.
      ["* text=auto\n", isWin ? [".gitattributes", ".gitignore", "a.txt", "b.txt", "package.json", "packages/a/index.js"] : []],
      ["*.txt text eol=crlf\n", ["a.txt", "b.txt"]],
      ["* text=auto eol=lf\n", []], // control: an LF checkout of LF files is exact
    ];
    for (const [attributes, expected] of variants) {
      await fsp.writeFile(join(repo, ".gitattributes"), attributes);
      await git(repo, "add", ".gitattributes");
      await git(repo, "commit", "-q", "-m", `attributes ${attributes.trim()}`);
      expect(await git(repo, "status", "--porcelain")).toBe(""); // clean: the gap QA-1.5-6a left open
      const ref = await capture();
      expect(ref.tracked.size).toBe(0);
      const handle = await mat(ref);
      try {
        const conversions = handle.inexactReasons.filter((r) => r.cause === "checkout-conversion").map((r) => r.path);
        expect([attributes, conversions]).toEqual([attributes, expected]);
        expect(handle.exact).toBe(expected.length === 0);
        const bytes = await fsp.readFile(join(handle.dir, "a.txt"), "utf8");
        expect([attributes, bytes]).toEqual([attributes, expected.includes("a.txt") ? "a0\r\n" : "a0\n"]);
        expect(await fsp.readFile(join(repo, "a.txt"), "utf8")).toBe("a0\n");
      } finally {
        await handle.dispose();
      }
    }
  });

  it("QA-1.5-16: a clean `eol=crlf` file edited between capture and materialize -> inexact for that path", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "a.txt text eol=crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "eol");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const ref = await capture();
    expect(ref.tracked.size).toBe(0);
    await fsp.writeFile(join(repo, "a.txt"), "a1\n"); // the producer's edit after dispatch
    const handle = await mat(ref);
    try {
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\r\n");
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
    } finally {
      await handle.dispose();
    }
  });

  // QA-1.5-18: a clean file's live bytes come from its last checkout, so conversions no
  // attribute pathspec selects must still be caught by the full `ls-files --eol` listing.
  const expectCleanConversion = async (expected: string[]) => {
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const ref = await capture();
    expect(ref.tracked.size).toBe(0);
    const handle = await mat(ref);
    try {
      const conversions = handle.inexactReasons.filter((r) => r.cause === "checkout-conversion").map((r) => r.path);
      expect(conversions).toEqual(expected);
      expect(handle.exact).toBe(false);
    } finally {
      await handle.dispose();
    }
  };

  it("QA-1.5-18: legacy `crlf` attribute on a clean LF file -> inexact for those paths", async () => {
    await git(repo, "config", "core.eol", "crlf");
    await fsp.writeFile(join(repo, ".gitattributes"), "*.txt crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "legacy crlf");
    await expectCleanConversion(["a.txt", "b.txt"]);
  });

  it("QA-1.5-18: working-tree-encoding added after checkout -> inexact for that path", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "a.txt working-tree-encoding=UTF-16LE-BOM\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "encoding");
    expect(await fsp.readFile(join(repo, "a.txt"), "utf8")).toBe("a0\n");
    await expectCleanConversion(["a.txt"]);
  });

  it("QA-1.5-18: a file last checked out under core.autocrlf=true, now false -> inexact for that path", async () => {
    await fsp.rm(join(repo, "a.txt"));
    await git(repo, "-c", "core.autocrlf=true", "checkout", "--", "a.txt");
    expect(await fsp.readFile(join(repo, "a.txt"), "utf8")).toBe("a0\r\n");
    await new Promise((r) => setTimeout(r, 1100)); // not racily clean
    await git(repo, "-c", "core.autocrlf=true", "update-index", "--refresh"); // stat now matches; config says false
    await expectCleanConversion(["a.txt"]);
  });

  it("#88: a successful re-diff never clears a real conversion (QA-1.5-18 file, no concurrent edit, stays flagged)", async () => {
    await fsp.rm(join(repo, "a.txt"));
    await git(repo, "-c", "core.autocrlf=true", "checkout", "--", "a.txt");
    await new Promise((r) => setTimeout(r, 1100)); // not racily clean
    await git(repo, "-c", "core.autocrlf=true", "update-index", "--refresh");
    const ref = await capture();
    let diffs = 0;
    const counting: CaptureDeps["argv"] = async (cmd, args, o) => {
      if (args.includes("diff") && args.includes("--no-ext-diff")) diffs++;
      return argv(cmd, args, o);
    };
    const handle = await mat(ref, { argv: counting });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
      expect(diffs).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-18: GIT_LITERAL_PATHSPECS=1 in the environment does not disable the eol check", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "eol");
    const saved = process.env.GIT_LITERAL_PATHSPECS;
    process.env.GIT_LITERAL_PATHSPECS = "1";
    try {
      await expectCleanConversion(["a.txt", "b.txt"]);
    } finally {
      if (saved === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
      else process.env.GIT_LITERAL_PATHSPECS = saved;
    }
  });

  it("QA-1.5-13: an eol comparison that cannot run makes the reference approximate, not failed", async () => {
    const failing: CaptureDeps["argv"] = async (file, args, opts) =>
      args.includes("--eol") ? { code: 128, stdout: "", stderr: "fatal: simulated", timedOut: false } : argv(file, args, opts);
    const handle = await mat(await capture(), { argv: failing });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toEqual([{ cause: "checkout-conversion", path: "" }]);
    } finally {
      await handle.dispose();
    }
  });

  // #88: another writer appends LF lines to a clean CRLF file after the step-7 drift diff and before
  // the live `ls-files --eol` listing. The file is then in neither set and its live `w/` (mixed)
  // differs from the reference's (crlf) with no checkout conversion behind it.
  type RediffFault = "none" | "code128" | "throw";
  const racingEol = async (file = "a.txt", opts: { link?: boolean } = {}) => {
    if (opts.link) {
      await fsp.mkdir(join(repo, "node_modules", "@s"));
      await fsp.symlink(join(repo, "packages", "a"), join(repo, "node_modules", "@s", "a"), linkType);
    }
    await fsp.writeFile(join(repo, file), "a0\r\n");
    await git(repo, "add", file);
    await git(repo, "commit", "-q", "-m", "crlf");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    const ref = await capture();
    expect(ref.tracked.size).toBe(0);
    const realRepo = await fsp.realpath(repo);
    const state = { appended: false, diffs: 0 };
    const wrap = (fault: RediffFault = "none", onRediff?: () => void): CaptureDeps["argv"] => async (cmd, args, o) => {
      if (args.includes("--eol") && !state.appended && o?.cwd !== undefined && (await fsp.realpath(o.cwd)) === realRepo) {
        state.appended = true;
        await fsp.appendFile(join(repo, file), "x\n");
      }
      if (args.includes("diff") && args.includes("--no-ext-diff") && ++state.diffs === 2) {
        onRediff?.();
        if (fault === "code128") return { code: 128, stdout: "", stderr: "fatal: simulated", timedOut: false };
        if (fault === "throw") throw new Error("simulated seam failure");
      }
      return argv(cmd, args, o);
    };
    return { ref, state, wrap };
  };

  it("#88: a clean file edited by another writer during verification is re-diffed, not flagged as a checkout conversion", async () => {
    const { ref, state, wrap } = await racingEol();
    const handle = await mat(ref, { argv: wrap() });
    try {
      expect(handle.inexactReasons).toEqual([]);
      expect(handle.exact).toBe(true);
      expect(state.appended).toBe(true);
      expect(state.diffs).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it("#88: a failing re-diff keeps the checkout-conversion flag (fail safe)", async () => {
    const { ref, state, wrap } = await racingEol();
    const handle = await mat(ref, { argv: wrap("code128") });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
      expect(state.appended).toBe(true);
      expect(state.diffs).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it("#88: a seam error during the re-diff keeps the checkout-conversion flag and is logged", async () => {
    const { ref, state, wrap } = await racingEol();
    const handle = await mat(ref, { argv: wrap("throw") });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
      expect(state.diffs).toBe(2);
      expect(warnings).toContain("reference eol re-diff failed: flags kept");
    } finally {
      await handle.dispose();
    }
  });

  it("#88: a throw from the re-diff's private-index read keeps the flag and is logged", async () => {
    const { ref, state, wrap } = await racingEol();
    const failing: ReferenceDeps["fs"] = {
      ...nodeReferenceFs,
      readFile: (path, options) => {
        if (state.appended && String(path).endsWith("index")) throw new Error("simulated index read failure");
        return nodeReferenceFs.readFile(path, options);
      },
    };
    const handle = await mat(ref, { argv: wrap(), fs: failing });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
      expect(warnings).toContain("reference eol re-diff failed: flags kept");
    } finally {
      await handle.dispose();
    }
  });

  it("#88: a caller abort during the re-diff -> ok:false aborted", async () => {
    const { ref, wrap } = await racingEol();
    const controller = new AbortController();
    const result = await materialize(ref, undefined, controller.signal, deps({ argv: wrap("none", () => controller.abort()) }));
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("#88: a race on a workspace-linked file is still workspace-link-drift (check d runs on re-diffed paths)", async () => {
    const { ref, wrap } = await racingEol("packages/a/index.js", { link: true });
    const handle = await mat(ref, { argv: wrap() });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "workspace-link-drift", path: "packages/a" });
    } finally {
      await handle.dispose();
    }
  });

  it("#88: a race on a manifest is still dependency-drift (check c runs on re-diffed paths)", async () => {
    const { ref, wrap } = await racingEol("package.json");
    const handle = await mat(ref, { argv: wrap() });
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "dependency-drift", path: "package.json" });
    } finally {
      await handle.dispose();
    }
  });

  it("#88: without a live-vs-reference eol difference materialize takes exactly one drift diff", async () => {
    let diffs = 0;
    const counting: CaptureDeps["argv"] = async (cmd, args, o) => {
      if (args.includes("diff") && args.includes("--no-ext-diff")) diffs++;
      return argv(cmd, args, o);
    };
    const handle = await mat(await capture(), { argv: counting });
    try {
      expect(handle.exact).toBe(true);
      expect(diffs).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-21: a truncated `ls-files --eol -z` listing (p12 maxBuffer cut, exit 0) is never exact", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await git(repo, "add", ".gitattributes");
    await git(repo, "commit", "-q", "-m", "eol");
    // Untruncated, a.txt and b.txt are reported (the QA-1.5-18 test above); a cut before a.txt hid both.
    const variants: Array<[string, (stdout: string) => { stdout: string; note: boolean }]> = [
      // p12's runArgv: stdout cut at a record boundary (still ends in NUL), code kept, note in stderr.
      ["note", (s) => ({ stdout: s.slice(0, s.lastIndexOf("\0", s.indexOf("\ta.txt")) + 1), note: true })],
      // A -z listing cut mid-record without any note: it does not end in NUL.
      ["no trailing NUL", (s) => ({ stdout: s.slice(0, s.indexOf("\ta.txt") - 5), note: false })],
    ];
    for (const [name, cut] of variants) {
      const truncating: CaptureDeps["argv"] = async (file, args, opts) => {
        const result = await argv(file, args, opts);
        if (!args.includes("--eol") || result.code !== 0) return result;
        expect(result.stdout).toContain("\ta.txt\0");
        const { stdout, note } = cut(result.stdout);
        const stderr = note ? `${result.stderr}\n[stdout truncated at ${stdout.length} chars]` : result.stderr;
        return { ...result, code: 0, stdout, stderr };
      };
      const handle = await mat(await capture(), { argv: truncating });
      try {
        expect([name, handle.exact]).toEqual([name, false]);
        expect([name, handle.inexactReasons]).toEqual([name, [{ cause: "checkout-conversion", path: "" }]]);
      } finally {
        await handle.dispose();
      }
    }
  });

  it("QA-1.5-23: a repository file named like the truncation note does not disable capture or materialize", async () => {
    const name = "[stdout truncated at 1 chars].txt";
    await fsp.writeFile(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    await fsp.writeFile(join(repo, name), "x0\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "note-named file");
    // Dirty with LF content: `stash create` warns on stderr, quoting the file name.
    await fsp.writeFile(join(repo, name), "x1\n");
    const ref = await capture();
    expect(ref).toBeDefined();
    // Dirtied again after capture: step 7's `diff --name-only` prints the same warning.
    await fsp.writeFile(join(repo, name), "x2\n");
    const handle = await mat(ref);
    try {
      expect(handle.inexactReasons.some((r) => r.path === name)).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-6b: assume-unchanged / skip-worktree entries -> inexact index-flags", async () => {
    await git(repo, "update-index", "--assume-unchanged", "b.txt");
    await git(repo, "update-index", "--skip-worktree", "packages/a/index.js");
    await fsp.writeFile(join(repo, "b.txt"), "b-local\n");
    await fsp.writeFile(join(repo, "packages", "a", "index.js"), "module.exports = 'local';\n");
    const ref = await capture();
    expect(ref.captureReasons).toEqual([{ cause: "index-flags", path: "b.txt" }]);
    const handle = await mat(ref);
    try {
      expect(await fsp.readFile(join(handle.dir, "b.txt"), "utf8")).toBe("b0\n"); // the gap the reason reports
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "index-flags", path: "b.txt" });
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-8: neither the repository's nor a committed `.omr-no-hooks` post-checkout hook runs during materialize", async () => {
    const marker = join(base, "hook-ran.txt");
    const hook = (tag: string) => `#!/bin/sh\necho ${tag} >> "$OMR_HOOK_MARKER"\n`;
    await fsp.mkdir(join(repo, ".omr-no-hooks"));
    await fsp.writeFile(join(repo, ".omr-no-hooks", "post-checkout"), hook("committed"), { mode: 0o755 });
    await git(repo, "add", ".omr-no-hooks/post-checkout");
    await git(repo, "update-index", "--chmod=+x", ".omr-no-hooks/post-checkout");
    await git(repo, "commit", "-q", "-m", "hook");
    await fsp.mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await fsp.writeFile(join(repo, ".git", "hooks", "post-checkout"), hook("repo"), { mode: 0o755 });
    const withMarker: CaptureDeps["argv"] = (file, args, opts) =>
      argv(file, args, { ...opts, env: { ...opts?.env, OMR_HOOK_MARKER: marker } });
    const addControl = async (wt: string, ...config: string[]) => {
      const result = await withMarker("git", [...config, "worktree", "add", "-q", "--detach", wt, "HEAD"], { cwd: repo, timeoutMs: 30_000 });
      expect(result.code).toBe(0);
      await git(repo, "worktree", "remove", "--force", wt);
    };
    // Controls: hooks do run here; the repository's hook, and the committed one under the former D9 path.
    await addControl(join(base, "control repo"));
    const formerD9 = join(base, "control d9");
    await addControl(formerD9, "-c", `core.hooksPath=${join(formerD9, ".omr-no-hooks")}`);
    expect((await fsp.readFile(marker, "utf8")).split(/\s+/).filter(Boolean)).toEqual(["repo", "committed"]);
    await fsp.rm(marker);

    let hooksPath = "";
    const recording: CaptureDeps["argv"] = (file, args, opts) => {
      const config = args.find((arg) => arg.startsWith("core.hooksPath="));
      if (config) hooksPath = config.slice("core.hooksPath=".length);
      return withMarker(file, args, opts);
    };
    const handle = await mat(await capture(), { argv: recording });
    try {
      expect(await exists(join(handle.dir, ".omr-no-hooks", "post-checkout"))).toBe(true);
      expect(await exists(marker)).toBe(false);
      expect(hooksPath.toLowerCase().startsWith(handle.dir.toLowerCase())).toBe(false);
      expect(join(hooksPath, "..").toLowerCase()).toBe(tmp.toLowerCase());
      expect(await exists(hooksPath)).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("commit-missing -> ok:false", async () => {
    const ref = await capture();
    const result = await materialize({ ...ref, commit: "0".repeat(40) }, undefined, new AbortController().signal, deps());
    expect(result).toMatchObject({ ok: false, reason: "commit-missing" });
  });

  it("unsafe dir name -> refused before anything is created", async () => {
    const ref = await capture();
    const result = await materialize(ref, undefined, new AbortController().signal, deps({ randomSuffix: () => "NOT-HEX" }));
    expect(result).toMatchObject({ ok: false, reason: "unsafe-path" });
  });

  it("unsafe untracked relPath -> inexact, nothing written outside", async () => {
    const ref = await capture();
    const evil: DispatchReference = { ...ref, untracked: new Map([["../evil.txt", "0".repeat(64)]]) };
    const handle = await mat(evil);
    try {
      expect(handle.inexactReasons).toEqual([{ cause: "untracked-unsafe-path", path: "../evil.txt" }]);
      expect(await exists(join(tmp, "evil.txt"))).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("abort mid-materialize -> ok:false aborted, no partial state", async () => {
    const ref = await capture();
    const controller = new AbortController();
    const aborting: CaptureDeps["argv"] = async (file, args, opts) => {
      const result = await argv(file, args, opts);
      if (args.includes("worktree") && args.includes("add")) controller.abort();
      return result;
    };
    const result = await materialize(ref, undefined, controller.signal, deps({ argv: aborting }));
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirsIn(tmp)).toEqual([]);
    expect(await worktreeCount(repo)).toBe(1);
  });

  it("QA-1.5-12: the reference is locked with the omr reason; a user's `git worktree remove [--force]` refuses it", async () => {
    const handle = await mat(await capture());
    const reason = referenceLockReason(process.pid);
    try {
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(`locked ${reason}\n`);
      // Sandbox guard, checked BEFORE any `git worktree remove` runs: every junction leads into
      // this test's temp sandbox, to a dir holding only the sentinel, never into real data.
      expect(handle.links).toHaveLength(2);
      for (const link of handle.links) {
        const target = await fsp.realpath(link);
        expect(isStrictlyInside(target, base)).toBe(true);
        expect(await fsp.readdir(target)).toEqual(["sentinel.txt"]);
      }
      for (const force of [[], ["--force"]]) {
        const user = await argv("git", ["worktree", "remove", ...force, handle.dir], { cwd: repo, timeoutMs: 30_000, env: { LC_ALL: "C" } });
        expect(user.code).not.toBe(0);
        expect(user.stderr).toContain(`cannot remove a locked working tree, lock reason: ${reason}`);
      }
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\n");
      for (const link of handle.links) expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await worktreeCount(repo)).toBe(2);
    } finally {
      await handle.dispose();
    }
    expect(await exists(handle.dir)).toBe(false);
    expect(await worktreeCount(repo)).toBe(1); // dispose unlocked its own reason once the dir was gone
    expect(warnings).toEqual([]);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-12: dispose lifts only its own lock reason; someone else's lock keeps the admin entry", async () => {
    const handle = await mat(await capture());
    await git(repo, "worktree", "unlock", handle.dir);
    await git(repo, "worktree", "lock", "--reason", "a user's lock", handle.dir);
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false); // the links went first, then fs.rm
    expect(warnings).toContain("reference worktree admin entry left registered: locked");
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain("locked a user's lock");
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    // Test cleanup: the dir is already gone, so remove only drops the admin entry.
    await git(repo, "worktree", "unlock", handle.dir);
    await git(repo, "worktree", "remove", "--force", handle.dir);
  });

  it("QA-1.5-12: a git without `worktree add --reason` (< 2.33) falls back to an unlocked add, with a warning", async () => {
    const rejected: string[][] = [];
    const oldGit: CaptureDeps["argv"] = async (file, args, opts) => {
      if (args.includes("add") && args.includes("--reason")) {
        rejected.push([...args]);
        return { code: 129, stdout: "", stderr: "error: unknown option `reason'\nusage: git worktree add [<options>] <path> [<commit-ish>]\n", timedOut: false };
      }
      return argv(file, args, opts);
    };
    const handle = await mat(await capture(), { argv: oldGit });
    try {
      expect(rejected).toHaveLength(1);
      expect(warnings.some((w) => w.includes("--reason"))).toBe(true);
      const list = await git(repo, "worktree", "list", "--porcelain");
      expect(list).toContain("omr-ref-");
      expect(list).not.toContain("locked");
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\n");
    } finally {
      await handle.dispose();
    }
    expect(await exists(handle.dir)).toBe(false);
  });

  it("QA-1.5-5: an abort mid-checkout (slow smudge filter) leaves no locked admin entry", async () => {
    await fsp.writeFile(join(repo, ".gitattributes"), "slow.txt filter=slow\n");
    await fsp.writeFile(join(repo, "slow.txt"), "slow\n");
    await git(repo, "add", ".gitattributes", "slow.txt");
    await git(repo, "commit", "-q", "-m", "slow");
    const ref = await capture();
    // Short: the MSYS `sleep` escapes `taskkill /T` and holds git's stderr until it exits.
    await git(repo, "config", "filter.slow.smudge", "sleep 3; cat");
    const admin = join(repo, ".git", "worktrees");
    const controller = new AbortController();
    let lockSeen = false;
    let lockText = "";
    const aborting: CaptureDeps["argv"] = async (file, args, opts) => {
      if (!(args.includes("worktree") && args.includes("add"))) return argv(file, args, opts);
      const running = argv(file, args, opts);
      // Mid-checkout: the entry is locked and the checkout (`reset --hard`) holds the worktree's index lock.
      lockSeen = await waitFor(async () => {
        if (!(await exists(admin))) return false;
        for (const name of await fsp.readdir(admin)) {
          if (!(await exists(join(admin, name, "index.lock")))) continue;
          lockText = (await fsp.readFile(join(admin, name, "locked"), "utf8").catch(() => "")).trim();
          if (lockText) return true;
        }
        return false;
      }, 15_000);
      controller.abort(); // tree-kills `git worktree add` in the middle of its checkout
      return running;
    };
    const result = await materialize(ref, undefined, controller.signal, deps({ argv: aborting }));
    expect(lockSeen).toBe(true);
    // QA-1.5-12: with --lock --reason, git writes our reason from the start, never "initializing".
    expect(lockText).toBe(referenceLockReason(process.pid));
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("omr-ref-");
    expect(await worktreeCount(repo)).toBe(1);
    expect(await refDirsIn(tmp)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("gcStaleReferences", { timeout: 60_000 }, () => {
  it("removes dead-owner worktrees and orphans; keeps live owners, user worktrees and look-alikes", async () => {
    const DEAD = 111111;
    const LIVE = 222222;
    const dead = join(tmp, `omr-ref-${DEAD}-0123456789abcdef`);
    const live = join(tmp, `omr-ref-${LIVE}-0123456789abcdef`);
    const lookalike = join(tmp, "omr-refX");
    const userWt = join(base, "user worktree");
    const orphan = join(tmp, `omr-ref-${DEAD}-fedcba9876543210`);
    for (const wt of [dead, live, lookalike, userWt]) await git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    await fsp.symlink(join(repo, "node_modules"), join(dead, "node_modules"), linkType);
    await fsp.mkdir(orphan);
    await fsp.writeFile(join(orphan, "junk.txt"), "junk");
    await fsp.symlink(join(repo, "packages", "a", "node_modules"), join(orphan, "node_modules"), linkType);
    const plainLookalike = join(tmp, "omr-refX-plain");
    await fsp.mkdir(plainLookalike);

    // QA-1.5-4: an alive owner whose heartbeat stopped an hour ago (PID reuse) is stale;
    // our own PID alone no longer makes a fresh, not-in-use dir stale.
    const staleLive = join(tmp, `omr-ref-${LIVE}-00000000000000aa`);
    const ownFresh = join(tmp, `omr-ref-${process.pid}-00000000000000bb`);
    for (const wt of [staleLive, ownFresh]) await git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(staleLive, old, old);

    const report = await gcStaleReferences(repo, deps({ isAlive: (pid) => pid === LIVE || pid === process.pid }));
    const lower = (dirs: readonly string[]) => dirs.map((d) => d.toLowerCase()).sort();
    expect(lower(report.removed)).toEqual(lower([dead, orphan, staleLive]));
    expect(lower(report.kept)).toEqual(lower([live, ownFresh]));
    expect(report.failed).toEqual([]);
    for (const gone of [dead, orphan, staleLive]) expect(await exists(gone)).toBe(false);
    for (const kept of [live, ownFresh, lookalike, userWt, plainLookalike]) expect(await exists(kept)).toBe(true);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    const list = await git(repo, "worktree", "list", "--porcelain");
    expect(list).toContain("omr-refX");
    expect(list).toContain("user worktree");

    // Test cleanup of the kept worktrees (not the module under test).
    for (const wt of [live, ownFresh, lookalike, userWt]) await git(repo, "worktree", "remove", "--force", wt);
    await fsp.rm(plainLookalike, { recursive: true, maxRetries: 10, retryDelay: 200 });
  });

  it("QA-1.5-5: GC lifts only an 'initializing' lock, and only for a dead owner", async () => {
    const DEAD = 111111;
    const LIVE = 222222;
    const deadInit = join(tmp, `omr-ref-${DEAD}-00000000000000c1`);
    const liveInit = join(tmp, `omr-ref-${LIVE}-00000000000000c2`);
    const deadOther = join(tmp, `omr-ref-${DEAD}-00000000000000c3`);
    for (const wt of [deadInit, liveInit, deadOther]) await git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    await git(repo, "worktree", "lock", "--reason", "initializing", deadInit);
    await git(repo, "worktree", "lock", "--reason", "initializing", liveInit); // an add may still be running
    await git(repo, "worktree", "lock", "--reason", "on a usb stick", deadOther); // someone else's lock

    const report = await gcStaleReferences(repo, deps({ isAlive: (pid) => pid === LIVE }));
    const lower = (dirs: readonly string[]) => dirs.map((d) => d.toLowerCase()).sort();
    expect(lower(report.removed)).toEqual(lower([deadInit]));
    expect(lower(report.kept)).toEqual(lower([liveInit, deadOther]));
    expect(report.failed).toEqual([]);
    expect(await exists(deadInit)).toBe(false);
    for (const kept of [liveInit, deadOther]) expect(await exists(kept)).toBe(true);
    const list = await git(repo, "worktree", "list", "--porcelain");
    expect(list).not.toContain("00000000000000c1");
    expect(list).toContain("on a usb stick");

    // Test cleanup of the kept worktrees (not the module under test).
    for (const wt of [liveInit, deadOther]) {
      await git(repo, "worktree", "unlock", wt);
      await git(repo, "worktree", "remove", "--force", wt);
    }
  });

  it("QA-1.5-12: GC lifts the omr lock only for a dead owner, a stale heartbeat or its own pid's reason", async () => {
    const DEAD = 111111;
    const LIVE = 222222;
    const deadOwn = join(tmp, `omr-ref-${DEAD}-00000000000000d1`);
    const liveOwn = join(tmp, `omr-ref-${LIVE}-00000000000000d2`);
    const liveStale = join(tmp, `omr-ref-${LIVE}-00000000000000d3`);
    const otherPid = join(tmp, `omr-ref-${DEAD}-00000000000000d4`);
    const lockedAdd = (wt: string, pid: number) =>
      git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", referenceLockReason(pid), wt, "HEAD");
    await lockedAdd(deadOwn, DEAD);
    await lockedAdd(liveOwn, LIVE);
    await lockedAdd(liveStale, LIVE);
    await lockedAdd(otherPid, LIVE); // an omr reason naming another pid is not this entry's own
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(liveStale, old, old); // heartbeat stopped an hour ago: PID reuse

    const report = await gcStaleReferences(repo, deps({ isAlive: (pid) => pid === LIVE }));
    const lower = (dirs: readonly string[]) => dirs.map((d) => d.toLowerCase()).sort();
    expect(lower(report.removed)).toEqual(lower([deadOwn, liveStale]));
    expect(lower(report.kept)).toEqual(lower([liveOwn, otherPid]));
    expect(report.failed).toEqual([]);
    for (const gone of [deadOwn, liveStale]) expect(await exists(gone)).toBe(false);
    for (const kept of [liveOwn, otherPid]) expect(await exists(kept)).toBe(true);
    const list = await git(repo, "worktree", "list", "--porcelain");
    expect(list).not.toContain("00000000000000d1");
    expect(list).not.toContain("00000000000000d3");

    // Test cleanup of the kept, junction-free worktrees (not the module under test).
    for (const wt of [liveOwn, otherPid]) {
      await git(repo, "worktree", "unlock", wt);
      await git(repo, "worktree", "remove", "--force", wt);
    }
  });

  it("QA-1.5-15: GC collects an omr-locked entry whose dir is missing even when its pid is alive (reused)", async () => {
    const LIVE = 222222;
    const gone = join(tmp, `omr-ref-${LIVE}-00000000000000e1`);
    await git(repo, "worktree", "add", "-q", "--detach", "--lock", "--reason", referenceLockReason(LIVE), gone, "HEAD");
    await fsp.rm(gone, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // junction-free test worktree
    const report = await gcStaleReferences(repo, deps({ isAlive: () => true, now: () => Date.now() + 30 * 24 * 60 * 60 * 1000 }));
    expect(report.removed.map((d) => d.toLowerCase())).toEqual([gone.toLowerCase()]);
    expect(report.failed).toEqual([]);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("00000000000000e1");
  });
  it("QA-1.5-4: a second copy of the module (two install paths) keeps the first copy's live reference", async () => {
    const handle = await mat(await capture());
    try {
      vi.resetModules();
      const second = await import("../../src/verify/reference");
      expect(second.gcStaleReferences).not.toBe(gcStaleReferences);
      const report = await second.gcStaleReferences(repo, deps());
      expect(report.kept.map((d) => d.toLowerCase())).toContain(handle.dir.toLowerCase());
      expect(report.removed).toEqual([]);
      // Even with the clock 10 h ahead: the dir is in use in this process.
      const later = await second.gcStaleReferences(repo, deps({ now: () => Date.now() + 10 * 60 * 60 * 1000 }));
      expect(later.removed).toEqual([]);
      expect(await exists(handle.dir)).toBe(true);
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\n");
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-4: the heartbeat keeps a live reference's mtime fresh, and dispose stops it", async () => {
    const handle = await mat(await capture(), { heartbeatMs: 50 });
    try {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fsp.utimes(handle.dir, old, old);
      const fresh = await waitFor(async () => Date.now() - (await fsp.stat(handle.dir)).mtimeMs < 60_000, 5_000);
      expect(fresh).toBe(true);
    } finally {
      await handle.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(warnings).toEqual([]);
  });
});

/**
 * E2E-2: the win32 8.3 spelling of an existing path (cmd's `%~sI`, spawned with an argv), or
 * undefined when the volume has 8.3 name generation disabled (the spelling comes back unchanged).
 */
function shortPathOf(path: string): string | undefined {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (r.status !== 0) throw new Error(`cmd.exe %~sI failed for ${path}: ${r.stderr}`);
  const short = r.stdout.trim();
  return short.toLowerCase() === path.toLowerCase() ? undefined : short;
}

// E2E-2 (phase 3.1): os.tmpdir() and the plugin directory are 8.3 short paths on many Windows
// hosts (C:\Users\ABCDEF~1\AppData\Local\Temp). Real git, a real node_modules junction.
describe("8.3 short paths (E2E-2)", { timeout: 60_000 }, () => {
  it("captures from an 8.3 cwd, links a junctioned node_modules under realpath(tmpdir) and maps both root spellings", async (ctx) => {
    if (!isWin) return ctx.skip("8.3 short names exist on win32 only");
    // ASCII-only long names, so cmd's output code page cannot garble the short spelling.
    const longRoot = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr-e2e2-long-directory-"));
    const longRepo = join(longRoot, "repository-long-name");
    const longTmp = join(longRoot, "temporary-long-name");
    const store = join(longRoot, "dependency-store", "node_modules");
    const junction = join(longRepo, "node_modules");
    try {
      await fsp.mkdir(longRepo);
      await fsp.mkdir(longTmp);
      const shortRepo = shortPathOf(longRepo);
      const shortTmp = shortPathOf(longTmp);
      if (shortRepo === undefined || shortTmp === undefined) {
        console.warn(`[E2E-2] SKIPPED: 8.3 short names are disabled on the volume of ${longRoot}`);
        return ctx.skip("8.3 short names are disabled on this volume");
      }
      expect(shortRepo).toMatch(/~\d/);
      await git(longRepo, "init", "-q");
      for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
        await git(longRepo, "config", k, v);
      }
      await fsp.mkdir(join(longRepo, "src"));
      await fsp.writeFile(join(longRepo, "src", "a.test.js"), "a0\n");
      await fsp.writeFile(join(longRepo, ".gitignore"), "node_modules/\n");
      await git(longRepo, "add", "-A");
      await git(longRepo, "commit", "-q", "-m", "init");
      // node_modules is a junction into a store outside the repository, as in the e2e fixtures.
      await fsp.mkdir(join(store, "vitest"), { recursive: true });
      await fsp.writeFile(join(store, "vitest", "package.json"), '{"name":"vitest","version":"1.0.0","bin":{"vitest":"vitest.mjs"}}\n');
      await fsp.writeFile(join(store, "vitest", "vitest.mjs"), "\n");
      await fsp.symlink(store, junction, "junction");

      const ref = await captureReference(shortRepo, new AbortController().signal, captureDeps({ tmpdir: shortTmp }));
      if (!ref) throw new Error("capture from the 8.3 cwd returned undefined");
      const realTmp = await fsp.realpath(shortTmp);
      expect(realTmp.toLowerCase()).toBe(longTmp.toLowerCase());
      const realStore = await fsp.realpath(store);

      // The root as git spells it, and the 8.3 spelling a caller may hold (the plugin directory).
      for (const root of [ref.root, shortRepo]) {
        const m = await mat({ ...ref, root }, { tmpdir: shortTmp });
        try {
          expect(dirname(m.dir)).toBe(realTmp); // created directly under realpath(tmpdir) (section 4 step 2)
          expect(m.exact).toBe(true);
          expect(m.unreproduced).toEqual([]);
          expect(m.links).toEqual([join(m.dir, "node_modules")]);
          expect(await fsp.realpath(join(m.dir, "node_modules"))).toBe(realStore);
          expect(JSON.parse(await fsp.readFile(join(m.dir, "node_modules", "vitest", "package.json"), "utf8"))).toMatchObject({ name: "vitest" });
          // The planner's canonical (realpath'd) paths map whichever spelling the root has.
          expect(m.toRefPath(longRepo)).toBe(m.dir);
          expect(m.toRefPath(join(longRepo, "src", "a.test.js"))).toBe(join(m.dir, "src", "a.test.js"));
          expect(m.toRefPath(join(root, "src", "a.test.js"))).toBe(join(m.dir, "src", "a.test.js"));
          expect(m.toRefPath(join(longRoot, "elsewhere.test.js"))).toBeUndefined();
        } finally {
          await m.dispose();
        }
      }
      // Disposal never went through the junction (R1), and nothing is left behind.
      expect(await fsp.readFile(join(store, "vitest", "package.json"), "utf8")).toContain('"vitest"');
      expect(await worktreeCount(longRepo)).toBe(1);
      expect(await refDirsIn(longTmp)).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      if ((await fsp.lstat(junction).catch(() => undefined))?.isSymbolicLink()) await fsp.unlink(junction);
      await fsp.rm(longRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

// Pure R3 guards (QA-1.5-9b), checked with explicit platforms so they run on every host.
describe("path guards (R3)", () => {
  const NAME = "omr-ref-1234-0123456789abcdef";
  const SHORT = "C:\\Users\\MARQUI~1\\AppData\\Local\\Temp";
  const LONG = "C:\\Users\\Marquinho\\AppData\\Local\\Temp";

  it("isStrictlyInside: case, separators, dot segments, prefix siblings, drives, UNC, roots, 8.3", () => {
    const win: Array<[string, string, boolean]> = [
      ["C:\\a\\b", "C:\\a", true],
      ["C:\\A\\B", "c:\\a", true], // case-insensitive on win32
      ["C:\\a", "C:\\a", false], // equal is not inside
      ["C:\\a\\", "C:\\a", false], // a trailing separator does not make it a child
      ["C:\\a\\b\\", "C:\\a\\", true],
      ["C:\\a\\..\\b", "C:\\a", false], // `..` escaping the parent
      ["C:\\a\\b\\..\\c", "C:\\a", true], // `..` staying inside
      ["C:\\a\\.\\b", "C:\\a", true],
      ["C:\\a2\\x", "C:\\a", false], // prefix sibling
      ["C:\\Temp2\\" + NAME, "C:\\Temp", false],
      ["D:\\a\\b", "C:\\a", false], // other drive
      ["C:/a/b", "C:\\a", true], // `/`-separated input
      ["\\\\srv\\share\\a\\b", "\\\\srv\\share\\a", true], // UNC
      ["\\\\srv\\share2\\a", "\\\\srv\\share\\a", false],
      ["C:\\x", "C:\\", true],
      ["C:\\", "C:\\", false],
      ["a\\b", "C:\\a", false], // relative child
      ["C:\\a\\b", "a", false], // relative parent
      [`${SHORT}\\x`, LONG, false], // lexical: an 8.3 form never matches its long form...
      [`${SHORT}\\x`, SHORT.toLowerCase(), true], // ...so callers pass both (tmpRootsFor)
    ];
    for (const [child, parent, expected] of win) expect([child, parent, isStrictlyInside(child, parent, "win32")]).toEqual([child, parent, expected]);
    const posix: Array<[string, string, boolean]> = [
      ["/tmp/a", "/tmp", true],
      ["/TMP/a", "/tmp", false], // case-sensitive on POSIX
      ["/tmp2/a", "/tmp", false],
      ["/tmp/../etc", "/tmp", false],
      ["/tmp/a/", "/tmp", true],
      ["/tmp", "/tmp/", false],
      ["/a", "/", true],
      ["/", "/", false],
      ["tmp/a", "/tmp", false],
    ];
    for (const [child, parent, expected] of posix) expect([child, parent, isStrictlyInside(child, parent, "linux")]).toEqual([child, parent, expected]);
  });

  it("assertSafeRefDir accepts only a well-named direct child of a tmp root", () => {
    const ok: Array<[string, string[]]> = [
      [`${LONG}\\${NAME}`, [SHORT, LONG]],
      [`${SHORT}\\${NAME}`, [SHORT, LONG]], // 8.3 form, matched by the 8.3 root
      [`${LONG.toLowerCase()}\\${NAME}`, [LONG]], // case
      [`${LONG}\\${NAME}\\`, [LONG]], // trailing separator
      [`${LONG}\\${NAME}`, [`${LONG}\\`]], // root with a trailing separator
      [`C:/Users/Marquinho/AppData/Local/Temp/${NAME}`, [LONG]], // `/`-separated
      [`\\\\srv\\share\\tmp\\${NAME}`, ["\\\\srv\\share\\tmp"]], // UNC tmp root
    ];
    for (const [dir, roots] of ok) expect(() => assertSafeRefDir(dir, roots, "win32")).not.toThrow();
    const refused: Array<[string, string[]]> = [
      [`${LONG}\\${NAME}`, [SHORT]], // long form against an 8.3-only root list
      [`${LONG}\\x\\..\\${NAME}`, [LONG]], // `..` segment
      [`${LONG}\\.\\${NAME}`, [LONG]], // `.` segment
      [`${LONG}\\sub\\${NAME}`, [LONG]], // nested
      [LONG, [LONG]], // the tmp root itself
      [`C:\\${NAME}`, ["C:\\"]], // a filesystem root is never a tmp root
      [`\\\\srv\\share\\${NAME}`, ["\\\\srv\\share"]], // nor is a UNC share root
      [`C:\\Temp2\\${NAME}`, ["C:\\Temp"]], // prefix sibling
      [NAME, [LONG]], // relative
      ["", [LONG]],
      [`${LONG}\\${NAME}`, ["Temp"]], // a relative tmp root is ignored
      [`${LONG}\\omr-ref-0-0123456789abcdef`, [LONG]], // pid 0
      [`${LONG}\\omr-ref-1234-0123456789ABCDEF`, [LONG]], // uppercase hex
      [`${LONG}\\omr-ref-1234-0123456789abcde`, [LONG]], // 15 hex
      [`${LONG}\\${NAME}.x`, [LONG]],
      [`${LONG}\\omr-refX`, [LONG]],
    ];
    for (const [dir, roots] of refused) {
      expect(() => assertSafeRefDir(dir, roots, "win32"), JSON.stringify([dir, roots])).toThrow(UnsafeReferencePathError);
    }
    expect(() => assertSafeRefDir(`/tmp/${NAME}`, ["/tmp"], "linux")).not.toThrow();
    expect(() => assertSafeRefDir(`/private/var/T/${NAME}`, ["/var/T", "/private/var/T"], "linux")).not.toThrow();
    expect(() => assertSafeRefDir(`/TMP/${NAME}`, ["/tmp"], "linux")).toThrow(UnsafeReferencePathError); // case-sensitive
    expect(() => assertSafeRefDir(`/${NAME}`, ["/"], "linux")).toThrow(UnsafeReferencePathError);
    expect(() => assertSafeRefDir(`/tmp/../tmp/${NAME}`, ["/tmp"], "linux")).toThrow(UnsafeReferencePathError);
  });
});
