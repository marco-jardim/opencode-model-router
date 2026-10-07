// Branch coverage for src/verify/reference.ts through its injectable seams.
//
// Every git call goes to a scripted fake ArgvSeam (no real git runs here), and the fs
// seam is node:fs/promises with per-test overrides that inject errors, aborts or
// delays. All real fs work happens inside a per-test mkdtemp dir. Links are only ever
// created to directories inside that dir, and afterEach unlinks every link before the
// recursive removal (module rules R1/R2), so no cleanup can reach real data.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import {
  captureReference,
  gcStaleReferences,
  materialize,
  MAX_CONVERSION_REASONS,
  MAX_SWEEP_ENTRIES,
  MAX_UNTRACKED_BYTES,
  MAX_UNTRACKED_FILES,
  nodeReferenceFs,
  UNTRACKED_SYMLINK,
  type DispatchReference,
  type GcReport,
  type MaterializedReference,
  type MaterializeResult,
  type ReferenceDeps,
  type ReferenceFs,
  type ReferenceStats,
} from "../../src/verify/reference";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { ArgvSeam, ExecOptions, ExecResult } from "../../src/verify/types";

const isWin = process.platform === "win32";
const linkType = isWin ? "junction" : "dir";
const HEAD = "a".repeat(40);
const STASH = "b".repeat(40);
const DEAD_PID = 999_999;
const ALIVE_PID = 111;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errno = (code: string) => Object.assign(new Error(`fake ${code}`), { code });

function fakeStats(kind: "file" | "dir" | "link", size = 1): ReferenceStats {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
    size,
    mode: 0o644,
    mtimeMs: Date.now(),
  };
}

function fsWith(over: Partial<ReferenceFs> = {}): ReferenceFs {
  return { ...nodeReferenceFs, ...over };
}

type Reply = Partial<ExecResult> | undefined;
type Override = (cmd: string, args: string[], opts: ExecOptions | undefined) => Reply | Promise<Reply>;

interface FakeGit {
  readonly argv: ArgvSeam;
  readonly calls: string[];
  /** Registered reference worktrees: dir -> lock reason (undefined = unlocked). */
  readonly registry: Map<string, string | undefined>;
}

let base: string;
let root: string;
let tmp: string;
let warnings: string[];

/** A scripted git: `override` answers first; returning undefined falls back to a clean repository. */
function fakeGit(override?: Override): FakeGit {
  const calls: string[] = [];
  const registry = new Map<string, string | undefined>();
  const fallback = async (cmd: string, args: string[]): Promise<Reply> => {
    if (args.includes("worktree") && args.includes("add")) {
      const dir = args[args.length - 2] as string;
      await fsp.writeFile(join(dir, "a.txt"), "a0\n");
      const at = args.indexOf("--reason");
      registry.set(dir, at >= 0 ? args[at + 1] : undefined);
      return {};
    }
    if (cmd === "rev-parse --show-toplevel") return { stdout: `${root}\n` };
    if (cmd === "ls-files --stage") return { stdout: "100644 1111111111111111111111111111111111111111 0\ta.txt\n" };
    if (cmd === "ls-files -v -z") return { stdout: "H a.txt\0" };
    if (cmd === "rev-parse --verify HEAD^{commit}") return { stdout: `${HEAD}\n` };
    if (cmd === "rev-parse --git-path index") return { stdout: ".git/index\n" };
    if (cmd === "rev-parse --git-common-dir") return { stdout: ".git\n" };
    if (cmd.startsWith("-c core.splitIndex=false stash create")) return { stdout: "" };
    if (cmd.startsWith("-c core.splitIndex=false diff ")) return { stdout: "" };
    if (cmd.startsWith("diff-tree ")) return { stdout: "" };
    if (cmd.startsWith("cat-file -e ")) return {};
    if (cmd === "config --get core.autocrlf") return { code: 1 };
    if (cmd.startsWith("ls-files ")) return { stdout: "" };
    if (cmd === "worktree list --porcelain") {
      let out = `worktree ${root}\nHEAD ${HEAD}\n\n`;
      for (const [dir, reason] of registry) out += `worktree ${dir}\n${reason === undefined ? "" : `locked ${reason}\n`}\n`;
      return { stdout: out };
    }
    if (cmd.startsWith("worktree unlock ")) {
      registry.set(args[2] as string, undefined);
      return {};
    }
    if (cmd.startsWith("worktree remove --force ")) {
      registry.delete(args[3] as string);
      return {};
    }
    return { code: 1, stderr: `unexpected git ${cmd}` };
  };
  const argv: ArgvSeam = async (_file, fullArgs, opts) => {
    const args = fullArgs.slice(1); // drop --no-optional-locks
    const cmd = args.join(" ");
    calls.push(cmd);
    const reply = (await override?.(cmd, args, opts)) ?? (await fallback(cmd, args));
    return { code: 0, stdout: "", stderr: "", ...reply };
  };
  return { argv, calls, registry };
}

function ref(over: Partial<DispatchReference> = {}): DispatchReference {
  return {
    root, head: HEAD, commit: HEAD, untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0, ...over,
  };
}

function matDeps(g: FakeGit, fs: ReferenceFs, over: Partial<ReferenceDeps> = {}): ReferenceDeps {
  return { argv: g.argv, fs, tmpdir: tmp, logger: { warn: (m) => void warnings.push(m) }, ...over };
}

async function run(
  g: FakeGit,
  fs: ReferenceFs = nodeReferenceFs,
  over: Partial<ReferenceDeps> = {},
  reference: DispatchReference = ref(),
  ctrl = new AbortController(),
  currentTree?: TreeSnapshot,
): Promise<MaterializeResult> {
  return materialize(reference, currentTree, ctrl.signal, matDeps(g, fs, over));
}

async function ok(result: MaterializeResult): Promise<MaterializedReference> {
  if (!result.ok) throw new Error(`materialize failed: ${result.reason} ${result.detail}`);
  return result.reference;
}

async function refDirs(): Promise<string[]> {
  return (await fsp.readdir(tmp)).filter((name) => name.startsWith("omr-ref-"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** R1 in the test cleanup: unlink every link (never following one) before any recursive removal. */
async function unlinkLinks(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const stats = await fsp.lstat(full);
    if (stats.isSymbolicLink()) await fsp.unlink(full);
    else if (stats.isDirectory()) await unlinkLinks(full);
  }
}

function tree(cwd: string): TreeSnapshot {
  return { cwd, head: HEAD, fingerprint: "", dirty: false, files: [] };
}

beforeEach(async () => {
  warnings = [];
  base = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr-refb-"));
  root = join(base, "repo");
  tmp = join(base, "tmp");
  await fsp.mkdir(join(root, ".git"), { recursive: true });
  await fsp.mkdir(tmp);
  await fsp.writeFile(join(root, ".git", "index"), "DIRC fake index");
  await fsp.writeFile(join(root, "a.txt"), "a0\n");
});

afterEach(async () => {
  await unlinkLinks(base);
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// --- captureReference ------------------------------------------------------------

describe("captureReference branches (fake git)", { timeout: 20_000 }, () => {
  const cap = (g: FakeGit, fs: ReferenceFs = nodeReferenceFs, ctrl = new AbortController()) =>
    captureReference(root, ctrl.signal, { argv: g.argv, fs, tmpdir: tmp });

  it("a clean capture resolves with commit = HEAD and leaves no scratch dir", async () => {
    const reference = await cap(fakeGit());
    expect(reference?.commit).toBe(HEAD);
    expect(await refDirs()).toEqual([]);
  });

  it("a seam stdout note after a stderr note (n-1 chars) is a truncated, failed call", async () => {
    const g = fakeGit((cmd) =>
      cmd === "rev-parse --show-toplevel"
        ? { stdout: "x".repeat(9), stderr: "git said\n[stdout truncated at 10 chars]\n[stderr truncated at 5 chars]\n" }
        : undefined);
    expect(await cap(g)).toBeUndefined();
  });

  it.each([
    ["ls-files -v -z", { code: 1 }],
    ["rev-parse --verify HEAD^{commit}", { code: 128 }],
    ["rev-parse --git-path index", { code: 1 }],
    ["ls-files --others --exclude-standard --full-name -z", { code: 1 }],
  ])("a failing `git %s` -> undefined", async (failing, reply) => {
    expect(await cap(fakeGit((cmd) => (cmd === failing ? reply : undefined)))).toBeUndefined();
    expect(await refDirs()).toEqual([]);
  });

  it("stash create output that is not a SHA -> undefined", async () => {
    const g = fakeGit((cmd) => (cmd.includes("stash create") ? { stdout: "not a sha\n" } : undefined));
    expect(await cap(g)).toBeUndefined();
  });

  const dirty = (diffTree: Reply, untracked?: Reply) =>
    fakeGit((cmd) => {
      if (cmd.includes("stash create")) return { stdout: `${STASH}\n` };
      if (cmd.startsWith("diff-tree ")) return diffTree;
      if (untracked && cmd === "ls-files --others --exclude-standard --full-name -z") return untracked;
      return undefined;
    });
  const many = (n: number) => ({ stdout: Array.from({ length: n }, (_, i) => `f${i}`).join("\0") + "\0" });

  it.each([
    ["diff-tree fails", { code: 128 }],
    ["too many dirty paths", many(MAX_UNTRACKED_FILES + 1)],
    ["an unsafe dirty path", { stdout: "/abs\0" }],
  ])("dirty tracked files: %s -> undefined", async (_name, diffTree) => {
    expect(await cap(dirty(diffTree))).toBeUndefined();
  });

  it("dirty and untracked paths are hashed in sorted order; deleted and non-file paths are skipped", async () => {
    await fsp.writeFile(join(root, "b.txt"), "b1\n");
    await fsp.mkdir(join(root, "sub"));
    await fsp.writeFile(join(root, "u1.txt"), "u1");
    await fsp.writeFile(join(root, "u2.txt"), "u2");
    await fsp.mkdir(join(base, "link-target"));
    await fsp.symlink(join(base, "link-target"), join(root, "lnk"), linkType);
    const g = fakeGit((cmd) => {
      if (cmd.includes("stash create")) return { stdout: `${STASH}\n` };
      if (cmd.startsWith("diff-tree ")) return { stdout: "b.txt\0sub\0a.txt\0gone.txt\0" };
      if (cmd === "ls-files -v -z") return { stdout: "H b.txt\0h a.txt\0" };
      if (cmd === "ls-files --others --exclude-standard --full-name -z") return { stdout: "u2.txt\0lnk\0u1.txt\0" };
      return undefined;
    });
    const reference = await cap(g);
    expect(reference?.commit).toBe(STASH);
    expect([...(reference?.tracked ?? [])]).toEqual([["a.txt", sha("a0\n")], ["b.txt", sha("b1\n")]]);
    expect(reference?.untracked.get("lnk")).toBe(UNTRACKED_SYMLINK);
    expect(reference?.untracked.get("u1.txt")).toBe(sha("u1"));
    expect(reference?.captureReasons).toEqual([{ cause: "index-flags", path: "a.txt" }]);
  });

  it("dirty bytes above MAX_UNTRACKED_BYTES -> undefined", async () => {
    const fs = fsWith({
      lstat: async (path) => (basename(path) === "a.txt" ? fakeStats("file", MAX_UNTRACKED_BYTES + 1) : nodeReferenceFs.lstat(path)),
    });
    expect(await cap(dirty({ stdout: "a.txt\0" }), fs)).toBeUndefined();
  });

  it.each([
    ["too many untracked paths", many(MAX_UNTRACKED_FILES + 1)],
    ["an unsafe untracked path", { stdout: "/abs\0" }],
    ["an untracked directory entry", { stdout: "sub\0" }],
  ])("untracked: %s -> undefined", async (_name, listing) => {
    await fsp.mkdir(join(root, "sub"));
    expect(await cap(dirty({ stdout: "" }, listing))).toBeUndefined();
  });

  it("untracked bytes above MAX_UNTRACKED_BYTES -> undefined", async () => {
    await fsp.writeFile(join(root, "u.txt"), "u");
    const fs = fsWith({
      lstat: async (path) => (basename(path) === "u.txt" ? fakeStats("file", MAX_UNTRACKED_BYTES + 1) : nodeReferenceFs.lstat(path)),
    });
    expect(await cap(fakeGit((cmd) => (cmd.endsWith("--full-name -z") ? { stdout: "u.txt\0" } : undefined)), fs)).toBeUndefined();
  });

  it("an abort during the last untracked read -> undefined", async () => {
    await fsp.writeFile(join(root, "u.txt"), "u");
    const ctrl = new AbortController();
    const fs = fsWith({
      readFile: async (path) => {
        const bytes = await nodeReferenceFs.readFile(path, {});
        if (basename(path) === "u.txt") ctrl.abort();
        return bytes;
      },
    });
    expect(await cap(fakeGit((cmd) => (cmd.endsWith("--full-name -z") ? { stdout: "u.txt\0" } : undefined)), fs, ctrl)).toBeUndefined();
  });

  it("an abort while the private index is prepared -> undefined, scratch dir removed", async () => {
    const ctrl = new AbortController();
    const fs = fsWith({
      utimes: async (path, atime, mtime) => {
        await nodeReferenceFs.utimes(path, atime, mtime);
        ctrl.abort();
      },
    });
    expect(await cap(fakeGit(), fs, ctrl)).toBeUndefined();
    expect(await refDirs()).toEqual([]);
  });

  it("a scratch dir that cannot be created -> undefined, nothing to clean up", async () => {
    const fs = fsWith({
      mkdir: async (path, opts) => {
        if (basename(path).startsWith("omr-ref-")) throw errno("EIO");
        return nodeReferenceFs.mkdir(path, opts);
      },
    });
    expect(await cap(fakeGit(), fs)).toBeUndefined();
    expect(await refDirs()).toEqual([]);
  });

  it("a scratch dir that cannot be removed is left for GC; the capture still resolves", async () => {
    const fs = fsWith({ rm: async () => { throw errno("EIO"); } });
    expect((await cap(fakeGit(), fs))?.commit).toBe(HEAD);
    expect((await refDirs()).length).toBe(1);
  });
});

// --- materialize -----------------------------------------------------------------

describe("materialize branches (fake git)", { timeout: 20_000 }, () => {
  it("tracked, untracked, eol parsing and toRefPath edge cases; dispose removes everything", async () => {
    await fsp.writeFile(join(root, "u.txt"), "u");
    await fsp.mkdir(join(root, "dirent"));
    const untracked = new Map<string, string>([
      ["u.txt", sha("u")],
      ["lnk", UNTRACKED_SYMLINK],
      ["dirent", sha("x")],
      ["gone.txt", sha("g")],
    ]);
    if (isWin) untracked.set("a:b", sha("x"));
    const tracked = new Map<string, string>([
      ["z.txt", sha("z")],
      ["/abs", "x"],
      ["a.txt", sha("a0\n")],
      ["missing.txt", "x"],
    ]);
    const liveEol = "i/lf    w/lf    attr/                 \tx.txt\0garbage-without-tab\0i/lf attr/\tno-w.txt\0w/lf\tno-i.txt\0";
    const refEol = "i/lf    w/crlf  attr/                 \tx.txt\0w/crlf\tno-i.txt\0";
    const g = fakeGit((cmd, _args, opts) =>
      cmd === "ls-files --eol -z" ? { stdout: opts?.cwd === root ? liveEol : refEol } : undefined);
    const reference = await ok(await run(g, nodeReferenceFs, {}, ref({
      untracked, tracked, captureReasons: [{ cause: "checkout-conversion", path: "x.txt" }],
    })));
    expect(reference.inexactReasons).toEqual(expect.arrayContaining([
      { cause: "checkout-conversion", path: "/abs" },
      { cause: "checkout-conversion", path: "missing.txt" },
      { cause: "checkout-conversion", path: "z.txt" },
      { cause: "untracked-symlink", path: "lnk" },
      { cause: "untracked-not-file", path: "dirent" },
      { cause: "untracked-deleted", path: "gone.txt" },
    ]));
    expect(reference.inexactReasons).not.toContainEqual({ cause: "checkout-conversion", path: "a.txt" });
    expect(reference.inexactReasons.filter((r) => r.path === "x.txt")).toHaveLength(1);
    if (isWin) expect(reference.inexactReasons).toContainEqual({ cause: "untracked-unsafe-path", path: "a:b" });
    expect(await fsp.readFile(join(reference.dir, "u.txt"), "utf8")).toBe("u");
    expect(reference.toRefPath("relative/path")).toBeUndefined();
    expect(reference.toRefPath(join(root, "a.txt"))).toBe(join(reference.dir, "a.txt"));
    await reference.dispose();
    expect(await refDirs()).toEqual([]);
    expect(g.registry.size).toBe(0);
  });

  it("currentTree outside the repository -> ok:false error", async () => {
    const result = await run(fakeGit(), nodeReferenceFs, {}, ref(), new AbortController(), tree(base));
    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("currentTree under the root's realpath only is accepted (then commit-missing)", async () => {
    const real = join(base, "real");
    await fsp.mkdir(real);
    const fs = fsWith({ realpath: async (path) => (path === root ? real : nodeReferenceFs.realpath(path)) });
    const g = fakeGit((cmd) => (cmd.startsWith("cat-file ") ? { code: 1 } : undefined));
    const result = await run(g, fs, {}, ref(), new AbortController(), tree(join(real, "sub")));
    expect(result).toMatchObject({ ok: false, reason: "commit-missing" });
  });

  it("an already-aborted signal -> ok:false aborted before anything is created", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await run(fakeGit(), nodeReferenceFs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it.each([
    ["EEXIST", "unsafe-path"],
    ["EIO", "error"],
  ])("mkdir of the reference dir failing with %s -> %s", async (code, reason) => {
    const fs = fsWith({
      mkdir: async (path, opts) => {
        if (basename(path).startsWith("omr-ref-") && !opts.recursive) throw errno(code);
        return nodeReferenceFs.mkdir(path, opts);
      },
    });
    expect(await run(fakeGit(), fs)).toMatchObject({ ok: false, reason });
    expect(await refDirs()).toEqual([]);
  });

  it("an existing hooks path -> unsafe-path; the unregistered dir is removed", async () => {
    const fs = fsWith({
      lstat: async (path) => (basename(path).startsWith("omr-nohooks-") ? fakeStats("dir") : nodeReferenceFs.lstat(path)),
    });
    const g = fakeGit();
    expect(await run(g, fs)).toMatchObject({ ok: false, reason: "unsafe-path" });
    expect(await refDirs()).toEqual([]);
    expect(g.calls).toContain("worktree list --porcelain");
  });

  it("git < 2.33 fallback refused when the first add left content in the dir", async () => {
    const g = fakeGit(async (_cmd, args) => {
      if (!args.includes("add") || !args.includes("--reason")) return undefined;
      await fsp.writeFile(join(args[args.length - 2] as string, "partial"), "x");
      return { code: 129, stderr: "error: unknown option `reason'\n" };
    });
    expect(await run(g)).toMatchObject({ ok: false, reason: "worktree-add-failed" });
    expect(await refDirs()).toEqual([]);
    expect(g.calls.filter((c) => c.includes(" worktree add "))).toHaveLength(1);
  });

  it("a timed-out worktree add -> worktree-add-failed with an empty detail", async () => {
    const g = fakeGit((_cmd, args) => (args.includes("add") ? { code: 1, timedOut: true } : undefined));
    expect(await run(g)).toEqual({ ok: false, reason: "worktree-add-failed", detail: "" });
    expect(await refDirs()).toEqual([]);
  });

  it("an abort right after the dir is created skips the add -> aborted", async () => {
    const ctrl = new AbortController();
    const fs = fsWith({
      mkdir: async (path, opts) => {
        const made = await nodeReferenceFs.mkdir(path, opts);
        if (basename(path).startsWith("omr-ref-")) ctrl.abort();
        return made;
      },
    });
    const g = fakeGit();
    expect(await run(g, fs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(g.calls.some((c) => c.includes(" worktree add "))).toBe(false);
    expect(await refDirs()).toEqual([]);
  });

  it("an abort while reading core.autocrlf -> aborted, worktree cleaned up", async () => {
    const ctrl = new AbortController();
    const g = fakeGit((cmd) => {
      if (cmd !== "config --get core.autocrlf") return undefined;
      ctrl.abort();
      return { code: 1 };
    });
    expect(await run(g, nodeReferenceFs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
    expect(g.registry.size).toBe(0);
  });

  it("an abort while comparing tracked files -> aborted", async () => {
    const ctrl = new AbortController();
    const fs = fsWith({
      readFile: async (path, opts) => {
        const bytes = await nodeReferenceFs.readFile(path, opts);
        if (path.includes("omr-ref-") && basename(path) === "a.txt") ctrl.abort();
        return bytes;
      },
    });
    const tracked = new Map([["a.txt", sha("a0\n")], ["b.txt", "x"]]);
    expect(await run(fakeGit(), fs, {}, ref({ tracked }), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("an abort after the first untracked copy -> aborted", async () => {
    await fsp.writeFile(join(root, "u1.txt"), "u1");
    await fsp.writeFile(join(root, "u2.txt"), "u2");
    const ctrl = new AbortController();
    const fs = fsWith({
      readFile: async (path) => {
        const bytes = await nodeReferenceFs.readFile(path, {});
        if (basename(path) === "u1.txt") ctrl.abort();
        return bytes;
      },
    });
    const untracked = new Map([["u2.txt", sha("u2")], ["u1.txt", sha("u1")]]);
    expect(await run(fakeGit(), fs, {}, ref({ untracked }), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("an untracked read failing under an abort -> aborted", async () => {
    await fsp.writeFile(join(root, "u.txt"), "u");
    const ctrl = new AbortController();
    const fs = fsWith({
      readFile: async (path, opts) => {
        if (basename(path) !== "u.txt") return nodeReferenceFs.readFile(path, opts);
        ctrl.abort();
        throw errno("EIO");
      },
    });
    expect(await run(fakeGit(), fs, {}, ref({ untracked: new Map([["u.txt", sha("u")]]) }), ctrl))
      .toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("an unreadable untracked file and a copy parent resolving outside the dir -> inexact, nothing written", async () => {
    await fsp.writeFile(join(root, "bad.txt"), "b");
    await fsp.mkdir(join(root, "sub"));
    await fsp.writeFile(join(root, "sub", "u.txt"), "u");
    let escaping = true; // only while materializing: the dispose sweep must see the real path
    const fs = fsWith({
      readFile: async (path, opts) => {
        if (basename(path) === "bad.txt") throw errno("EIO");
        return nodeReferenceFs.readFile(path, opts);
      },
      realpath: async (path) =>
        escaping && path.includes("omr-ref-") && basename(path) === "sub" ? root : nodeReferenceFs.realpath(path),
    });
    const untracked = new Map([["bad.txt", sha("b")], ["sub/u.txt", sha("u")]]);
    const reference = await ok(await run(fakeGit(), fs, {}, ref({ untracked })));
    escaping = false;
    expect(reference.inexactReasons).toEqual(expect.arrayContaining([
      { cause: "untracked-unreadable", path: "bad.txt" },
      { cause: "untracked-unsafe-path", path: "sub/u.txt" },
    ]));
    expect(await exists(join(reference.dir, "sub", "u.txt"))).toBe(false);
    await reference.dispose();
    expect(await refDirs()).toEqual([]);
  });

  it.each([
    ["an abort", "abort", "aborted", undefined],
    ["a failure", { code: 1, stderr: "boom\n" }, "error", "boom"],
    ["a timeout", { code: 1, timedOut: true }, "error", "ignored-file discovery failed"],
  ] as const)("ignored-file discovery: %s -> ok:false", async (_name, reply, reason, detail) => {
    const ctrl = new AbortController();
    const g = fakeGit((cmd) => {
      if (!cmd.startsWith("ls-files --others --ignored")) return undefined;
      if (reply === "abort") {
        ctrl.abort();
        return {};
      }
      return reply;
    });
    const result = await run(g, nodeReferenceFs, {}, ref(), ctrl);
    expect(result).toMatchObject({ ok: false, reason });
    if (detail !== undefined) expect(result).toMatchObject({ detail });
    expect(await refDirs()).toEqual([]);
  });

  it("node_modules candidates that cannot be linked are unreproduced; package links are classified", async () => {
    // root/a has no node_modules; root/b/node_modules dangles; root/c is absent from the worktree.
    await fsp.mkdir(join(root, "a"));
    await fsp.mkdir(join(root, "b"));
    await fsp.mkdir(join(base, "gone"));
    await fsp.symlink(join(base, "gone"), join(root, "b", "node_modules"), linkType);
    await fsp.mkdir(join(root, "c", "node_modules"), { recursive: true });
    // The linkable root node_modules holds every kind of package entry.
    const nm = join(root, "node_modules");
    await fsp.mkdir(nm);
    await fsp.writeFile(join(nm, "@scope"), "not a dir");
    await fsp.mkdir(join(base, "outside"));
    await fsp.symlink(join(base, "outside"), join(nm, "pkg-out"), linkType);
    await fsp.symlink(join(root, "c", "node_modules"), join(nm, "pkg-nm"), linkType);
    await fsp.mkdir(join(root, "packages", "w"), { recursive: true });
    await fsp.symlink(join(root, "packages", "w"), join(nm, "pkg-ws"), linkType);
    await fsp.mkdir(join(base, "gone2"));
    await fsp.symlink(join(base, "gone2"), join(nm, "pkg-dangling"), linkType);
    await fsp.rm(join(base, "gone2"), { recursive: true, maxRetries: 10, retryDelay: 200 });
    await fsp.rm(join(base, "gone"), { recursive: true, maxRetries: 10, retryDelay: 200 });
    const g = fakeGit((cmd) =>
      cmd.startsWith("ls-files --others --ignored")
        ? { stdout: "a/node_modules/\0b/node_modules/\0c/node_modules/\0node_modules/\0" }
        : undefined);
    const reference = await ok(await run(g));
    expect(reference.links).toEqual([join(reference.dir, "node_modules")]);
    expect(reference.unreproduced).toEqual(["a/node_modules/", "b/node_modules/", "c/node_modules/"]);
    expect(reference.exact).toBe(true);
    await reference.dispose();
    expect(await refDirs()).toEqual([]);
    expect(await exists(join(nm, "@scope"))).toBe(true);
    expect(await exists(join(root, "packages", "w"))).toBe(true);
  });

  it("an abort while linking node_modules -> aborted", async () => {
    const ctrl = new AbortController();
    const fs = fsWith({
      lstat: async (path) => {
        if (path === join(root, "x", "node_modules")) ctrl.abort();
        return nodeReferenceFs.lstat(path);
      },
    });
    const g = fakeGit((cmd) =>
      cmd.startsWith("ls-files --others --ignored") ? { stdout: "x/node_modules/\0y/node_modules/\0" } : undefined);
    expect(await run(g, fs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it.each([
    ["the diff fails", { code: 1, stderr: "dfail" }, undefined, "dfail"],
    ["the diff times out and the untracked listing fails", { code: 1, timedOut: true }, { code: 1, stderr: "ufail" }, "ufail"],
    ["both time out", { code: 1, timedOut: true }, { code: 1, timedOut: true }, "drift check failed"],
  ] as const)("drift checks: %s -> ok:false error", async (_name, diff, others, detail) => {
    const g = fakeGit((cmd) => {
      if (cmd.startsWith("-c core.splitIndex=false diff ")) return diff;
      if (cmd === "ls-files --others --exclude-standard -z") return others;
      return undefined;
    });
    expect(await run(g)).toEqual({ ok: false, reason: "error", detail });
    expect(await refDirs()).toEqual([]);
  });

  it("an abort during the drift checks -> aborted", async () => {
    const ctrl = new AbortController();
    const g = fakeGit((cmd) => {
      if (cmd !== "ls-files --others --exclude-standard -z") return undefined;
      ctrl.abort();
      return {};
    });
    expect(await run(g, nodeReferenceFs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("an abort during the eol comparison -> aborted", async () => {
    const ctrl = new AbortController();
    const g = fakeGit((cmd) => {
      if (cmd !== "ls-files --eol -z") return undefined;
      ctrl.abort();
      return {};
    });
    expect(await run(g, nodeReferenceFs, {}, ref(), ctrl)).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("more than MAX_CONVERSION_REASONS differing eol classes -> capped per-path reasons plus one \"\"", async () => {
    const n = MAX_CONVERSION_REASONS + 1;
    const list = (w: string) => Array.from({ length: n }, (_, i) => `i/lf w/${w} attr/\tf${i}.txt\0`).join("");
    const g = fakeGit((cmd, _args, opts) =>
      cmd === "ls-files --eol -z" ? { stdout: list(opts?.cwd === root ? "lf" : "crlf") } : undefined);
    const reference = await ok(await run(g));
    expect(reference.inexactReasons).toHaveLength(MAX_CONVERSION_REASONS + 1);
    expect(reference.inexactReasons.at(-1)).toEqual({ cause: "checkout-conversion", path: "" });
    await reference.dispose();
  });

  it("a throwing symlink -> ok:false error; the unrealised recorded link is harmless", async () => {
    await fsp.mkdir(join(root, "node_modules"));
    const fs = fsWith({ symlink: async () => { throw errno("EIO"); } });
    const g = fakeGit((cmd) => (cmd.startsWith("ls-files --others --ignored") ? { stdout: "node_modules/\0" } : undefined));
    expect(await run(g, fs)).toMatchObject({ ok: false, reason: "error" });
    expect(await refDirs()).toEqual([]);
    expect(g.registry.size).toBe(0);
  });

  it("an error thrown after an abort -> aborted", async () => {
    await fsp.mkdir(join(root, "sub"));
    await fsp.writeFile(join(root, "sub", "u.txt"), "u");
    const ctrl = new AbortController();
    const fs = fsWith({
      mkdir: async (path, opts) => {
        if (!opts.recursive) return nodeReferenceFs.mkdir(path, opts);
        ctrl.abort();
        throw errno("EIO");
      },
    });
    expect(await run(fakeGit(), fs, {}, ref({ untracked: new Map([["sub/u.txt", sha("u")]]) }), ctrl))
      .toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirs()).toEqual([]);
  });

  it("an invalid random suffix -> unsafe-path before anything is created", async () => {
    expect(await run(fakeGit(), nodeReferenceFs, { randomSuffix: () => "NOT-HEX" })).toMatchObject({ ok: false, reason: "unsafe-path" });
    expect(await refDirs()).toEqual([]);
  });
});

// --- dispose (removeReferenceDir / sweepLinks) --------------------------------------

describe("dispose branches (fake git)", { timeout: 20_000 }, () => {
  const withNodeModules = () =>
    fakeGit((cmd) => (cmd.startsWith("ls-files --others --ignored") ? { stdout: "node_modules/\0" } : undefined));

  beforeEach(async () => {
    await fsp.mkdir(join(root, "node_modules"));
    await fsp.writeFile(join(root, "node_modules", "sentinel.txt"), "keep me");
  });

  afterEach(async () => {
    expect(await fsp.readFile(join(root, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("a recorded link whose unlink fails (EIO) stops dispose; the dir is left for GC", async () => {
    const fs = fsWith({
      unlink: async (path) => {
        if (basename(path) === "node_modules") throw errno("EIO");
        return nodeReferenceFs.unlink(path);
      },
    });
    const reference = await ok(await run(withNodeModules(), fs));
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/could not be unlinked/);
    expect(await exists(reference.dir)).toBe(true);
  });

  it("a link that reports ENOENT on unlink but survives stops the sweep", async () => {
    const fs = fsWith({
      unlink: async (path) => {
        if (basename(path) === "node_modules") throw errno("ENOENT");
        return nodeReferenceFs.unlink(path);
      },
    });
    const reference = await ok(await run(withNodeModules(), fs));
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/survived unlink/);
    expect(await exists(reference.dir)).toBe(true);
  });

  it.each([
    ["EIO", errno("EIO")],
    ["a non-string code", Object.assign(new Error("five"), { code: 5 })],
  ])("an extra link whose unlink fails with %s stops the sweep", async (_name, error) => {
    await fsp.mkdir(join(base, "extra-target"));
    const fs = fsWith({
      unlink: async (path) => {
        if (basename(path) === "extra") throw error;
        return nodeReferenceFs.unlink(path);
      },
    });
    const reference = await ok(await run(fakeGit(), fs));
    await fsp.symlink(join(base, "extra-target"), join(reference.dir, "extra"), linkType);
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/extra could not be unlinked/);
    expect(await exists(join(base, "extra-target"))).toBe(true);
  });

  const withSub = async (fs: ReferenceFs) => {
    const reference = await ok(await run(fakeGit(), fs));
    await fsp.mkdir(join(reference.dir, "sub"));
    return reference;
  };
  const isSub = (path: string) => path.includes("omr-ref-") && basename(path) === "sub";

  it("a subdir that vanishes before its readdir (ENOENT) is skipped; dispose completes", async () => {
    const fs = fsWith({
      readdir: async (path) => {
        if (isSub(path)) throw errno("ENOENT");
        return nodeReferenceFs.readdir(path);
      },
    });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(await refDirs()).toEqual([]);
  });

  it("a subdir readdir throwing a non-Error stops the sweep with its text", async () => {
    const fs = fsWith({
      readdir: async (path) => {
        if (isSub(path)) throw "boom-string";
        return nodeReferenceFs.readdir(path);
      },
    });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/boom-string/);
    expect(await exists(reference.dir)).toBe(true);
  });

  it("a subdir resolving outside the dir is never walked", async () => {
    const fs = fsWith({ realpath: async (path) => (isSub(path) ? root : nodeReferenceFs.realpath(path)) });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/resolving outside the dir/);
  });

  it("a readdir entry escaping the dir stops the sweep", async () => {
    const fs = fsWith({ readdir: async (path) => (isSub(path) ? [".."] : nodeReferenceFs.readdir(path)) });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/outside the dir/);
  });

  it("entries that vanish (ENOENT, ENOTDIR) between readdir and lstat are skipped", async () => {
    const fs = fsWith({
      readdir: async (path) => (isSub(path) ? ["ghost", "ghost2"] : nodeReferenceFs.readdir(path)),
      lstat: async (path) => {
        if (basename(path) === "ghost2") throw errno("ENOTDIR");
        return nodeReferenceFs.lstat(path);
      },
    });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(await refDirs()).toEqual([]);
  });

  it("a sweep beyond MAX_SWEEP_ENTRIES stops", async () => {
    const names = Array.from({ length: MAX_SWEEP_ENTRIES + 1 }, (_, i) => `z${i}`);
    const file = fakeStats("file");
    const fs = fsWith({
      readdir: async (path) => (isSub(path) ? names : nodeReferenceFs.readdir(path)),
      lstat: async (path) => (/^z\d+$/.test(basename(path)) ? file : nodeReferenceFs.lstat(path)),
    });
    const reference = await withSub(fs);
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/sweep exceeded/);
  });

  it("a dir that turns into a link between the sweep and fs.rm is not removed", async () => {
    let target: string | undefined;
    let seen = 0;
    const fs = fsWith({
      lstat: async (path) => {
        if (path === target && ++seen === 2) return fakeStats("link");
        return nodeReferenceFs.lstat(path);
      },
    });
    const reference = await ok(await run(fakeGit(), fs));
    target = reference.dir;
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/not a real directory/);
    expect(await exists(reference.dir)).toBe(true);
  });

  it("a dir that survives fs.rm is left in place", async () => {
    const reference = await ok(await run(fakeGit(), fsWith({ rm: async () => undefined })));
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/still exists after fs.rm/);
  });

  it("a dir that reappears before the admin entry is dropped keeps the entry", async () => {
    let recreate: string | undefined;
    const g = fakeGit(async (cmd) => {
      if (cmd === "worktree list --porcelain" && recreate) await fsp.mkdir(recreate);
      return undefined;
    });
    const reference = await ok(await run(g));
    recreate = reference.dir;
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(/reappeared/);
    expect(g.registry.size).toBe(1);
    expect(g.calls.some((c) => c.startsWith("worktree remove"))).toBe(false);
  });

  it.each([
    ["worktree unlock ", /left locked/],
    ["worktree remove ", /left registered/],
  ])("a failing `git %s` keeps the admin entry, with a warning", async (prefix, warning) => {
    const g = fakeGit((cmd) => (cmd.startsWith(prefix) ? { code: 1, stderr: "nope" } : undefined));
    const reference = await ok(await run(g));
    await reference.dispose();
    expect(warnings.join("\n")).toMatch(warning);
    expect(await exists(reference.dir)).toBe(false);
  });

  it("a failing worktree list still drops the admin entry with remove --force (dir already gone)", async () => {
    const g = fakeGit((cmd) => (cmd === "worktree list --porcelain" ? { code: 1 } : undefined));
    const reference = await ok(await run(g));
    await reference.dispose();
    expect(g.calls).toContain(`worktree remove --force ${reference.dir}`);
    expect(g.calls.some((c) => c.startsWith("worktree unlock"))).toBe(false);
    expect(await refDirs()).toEqual([]);
  });
});

// --- gcStaleReferences -----------------------------------------------------------

describe("gcStaleReferences branches (fake git)", { timeout: 20_000 }, () => {
  const name = (pid: number, n: number) => `omr-ref-${pid}-${n.toString(16).padStart(16, "0")}`;
  const listing = (dirs: readonly string[]) =>
    `worktree ${root}\n\n` + dirs.map((dir) => `worktree ${dir}\n\n`).join("");
  const gc = (g: FakeGit, fs: ReferenceFs = nodeReferenceFs, over: Partial<ReferenceDeps> = {}): Promise<GcReport> =>
    gcStaleReferences(root, matDeps(g, fs, { isAlive: (pid) => pid === ALIVE_PID, ...over }));

  it("a registered candidate that is a file is never removed", async () => {
    const dir = join(tmp, name(DEAD_PID, 1));
    await fsp.writeFile(dir, "not a dir");
    const g = fakeGit((cmd) => (cmd === "worktree list --porcelain" ? { stdout: listing([dir]) } : undefined));
    const report = await gc(g);
    expect(report.failed).toEqual([dir]);
    expect(warnings.join("\n")).toMatch(/not a real directory/);
    expect(await exists(dir)).toBe(true);
  });

  it("a removal that ends after GC's deadline leaves the admin entry for the next GC", async () => {
    const dir = join(tmp, name(DEAD_PID, 2));
    await fsp.mkdir(dir);
    const g = fakeGit((cmd) => (cmd === "worktree list --porcelain" ? { stdout: listing([dir]) } : undefined));
    const fs = fsWith({
      rm: async (path, opts) => {
        await sleep(400);
        return nodeReferenceFs.rm(path, opts);
      },
    });
    const report = await gc(g, fs, { timeoutMs: 300 });
    expect(report.failed).toEqual([dir]);
    expect(warnings.join("\n")).toMatch(/GC budget spent/);
    expect(g.calls.some((c) => c.startsWith("worktree remove"))).toBe(false);
  });

  it("the budget running out among registered candidates stops GC", async () => {
    const a = join(tmp, name(ALIVE_PID, 3));
    const b = join(tmp, name(ALIVE_PID, 4));
    await fsp.mkdir(a);
    await fsp.mkdir(b);
    const g = fakeGit((cmd) => (cmd === "worktree list --porcelain" ? { stdout: listing([a, b]) } : undefined));
    const fs = fsWith({
      lstat: async (path) => {
        if (path === a) await sleep(400);
        return nodeReferenceFs.lstat(path);
      },
    });
    const report = await gc(g, fs, { timeoutMs: 300 });
    expect(report).toEqual({ removed: [], kept: [a], failed: [] });
    expect(g.calls).not.toContain("rev-parse --git-common-dir");
  });

  it("a failing `rev-parse --git-common-dir` skips the orphan pass", async () => {
    const orphan = join(tmp, name(DEAD_PID, 5));
    await fsp.mkdir(orphan);
    const g = fakeGit((cmd) => (cmd === "rev-parse --git-common-dir" ? { code: 1 } : undefined));
    expect(await gc(g)).toEqual({ removed: [], kept: [], failed: [] });
    expect(await exists(orphan)).toBe(true);
  });

  it("the budget running out among orphans stops GC", async () => {
    await fsp.mkdir(join(tmp, name(ALIVE_PID, 6)));
    await fsp.mkdir(join(tmp, name(ALIVE_PID, 7)));
    let slowed = false;
    const fs = fsWith({
      lstat: async (path) => {
        if (!slowed && basename(path).startsWith("omr-ref-")) {
          slowed = true;
          await sleep(400);
        }
        return nodeReferenceFs.lstat(path);
      },
    });
    const report = await gc(fakeGit(), fs, { timeoutMs: 300 });
    expect(report.kept).toHaveLength(1);
    expect(report.removed).toEqual([]);
  });

  it("an omr-ref name under a filesystem-root tmpdir is never a candidate", async () => {
    const fsRoot = parse(root).root;
    const touched: string[] = [];
    const fs = fsWith({
      readdir: async (path) => (path === fsRoot ? [name(DEAD_PID, 8)] : nodeReferenceFs.readdir(path)),
      lstat: async (path) => {
        if (path.startsWith(join(fsRoot, "omr-ref-"))) touched.push(path);
        return nodeReferenceFs.lstat(path);
      },
      rm: async (path) => {
        touched.push(path);
      },
    });
    expect(await gc(fakeGit(), fs, { tmpdir: fsRoot })).toEqual({ removed: [], kept: [], failed: [] });
    expect(touched).toEqual([]);
  });

  it("orphans: alive kept, foreign or malformed .git skipped, ours removed, a failed removal reported", async () => {
    const kept = join(tmp, name(ALIVE_PID, 9));
    const dotGitDir = join(tmp, name(DEAD_PID, 10));
    const junk = join(tmp, name(DEAD_PID, 11));
    const foreign = join(tmp, name(DEAD_PID, 12));
    const ours = join(tmp, name(DEAD_PID, 13));
    const failing = join(tmp, name(DEAD_PID, 14));
    for (const dir of [kept, dotGitDir, junk, foreign, ours, failing]) await fsp.mkdir(dir);
    await fsp.mkdir(join(dotGitDir, ".git"));
    await fsp.writeFile(join(junk, ".git"), "hello\n");
    await fsp.writeFile(join(foreign, ".git"), `gitdir: ${join(base, "other", ".git", "worktrees", "x")}\n`);
    await fsp.writeFile(join(ours, ".git"), `gitdir: ${join(root, ".git", "worktrees", "x")}\n`);
    const fs = fsWith({
      rm: async (path, opts) => {
        if (path === failing) throw errno("EIO");
        return nodeReferenceFs.rm(path, opts);
      },
    });
    const report = await gc(fakeGit(), fs);
    expect(report).toEqual({ removed: [ours], kept: [kept], failed: [failing] });
    for (const dir of [kept, dotGitDir, junk, foreign, failing]) expect(await exists(dir)).toBe(true);
    expect(await exists(ours)).toBe(false);
  });

  it("an lstat error other than ENOENT aborts GC with a warning, never a throw", async () => {
    const orphan = join(tmp, name(DEAD_PID, 15));
    await fsp.mkdir(orphan);
    const fs = fsWith({
      lstat: async (path) => {
        if (path === orphan) throw errno("EIO");
        return nodeReferenceFs.lstat(path);
      },
    });
    expect(await gc(fakeGit(), fs)).toEqual({ removed: [], kept: [], failed: [] });
    expect(warnings.join("\n")).toMatch(/reference GC failed/);
    expect(await exists(orphan)).toBe(true);
  });
});
