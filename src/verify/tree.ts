// Impure, bounded Git fingerprint adapter. Never interpolates paths into a shell.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import { extname, join, resolve } from "node:path";
import { scrubText } from "../guard/scrub";
import * as tools from "../router/git-tools";
import { ABSENT_DIGEST, FILE_DIGEST_PREFIX, LINK_DIGEST_PREFIX, type TreeSnapshot, type ChangedFile } from "./dispatch";

/** Each git process of a snapshot. */
export const SNAPSHOT_GIT_TIMEOUT_MS = 10_000;
/** Each git process's stdout, in bytes (execFile's maxBuffer). */
export const SNAPSHOT_GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** What one git process of a snapshot is spawned with. */
export interface SnapshotGitOptions {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
  /** QA-3.1-8: below-normal OS priority (VerifyBudget.lowPriority), like every other verification process. */
  readonly lowPriority: boolean;
  /** Cross-repo QA-1 F4 (SnapshotOptions.hardened): the environment git runs with. Absent: the process's own (unchanged). */
  readonly env?: NodeJS.ProcessEnv;
  /** Cross-repo QA-1 F4: the git executable, by absolute path. Absent: `git`, looked up as before. */
  readonly executable?: string;
}

/**
 * One git process of a snapshot: `git` with `args`, never a shell. Resolves its stdout; rejects on a
 * non-zero exit, a timeout, an abort or a spawn error.
 */
export type SnapshotGit = (args: readonly string[], opts: SnapshotGitOptions) => Promise<string>;

/** Windows: lowers a spawned child's priority class; false when it could not (the child may have exited). */
function lowerPriority(pid: number): boolean {
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false; // The run itself is unaffected, as in exec.ts.
  }
}

const isWin = process.platform === "win32";
/** exec.ts's rule: Windows tools by absolute path, never looked up in the (project) cwd. */
const TASKKILL = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill.exe";
const TASKKILL_TIMEOUT_MS = 5000;

/**
 * QA-G-6: end git and everything it spawned (fsmonitor hooks, filters such as git-lfs), the same
 * way exec.ts kills a verification tree: `taskkill /T /F` on Windows, the process group on POSIX
 * (git is spawned detached, so it leads its own group). execFile's own abort/timeout ends git only.
 * Kept here rather than imported from exec.ts: several tests mock exec.ts while calling this module.
 */
function killGitTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return; // Never started; its `error` rejects the call.
  if (isWin) {
    execFile(TASKKILL, ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (err) => {
      if (err) child.kill();
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * A git process that ran and exited non-zero (I7, P0.2). `exitCode` tells an expected exit apart from a failure without
 * parsing the message (`symbolic-ref -q HEAD` exits 1 on a detached HEAD). The message is the one execGit always used.
 */
export class GitExitError extends Error {
  constructor(readonly exitCode: number) {
    super(`git exited with code ${exitCode}`);
  }
}

/** The exit code a SnapshotGit rejection carries (a GitExitError, or a seam's error with a numeric `exitCode`); else undefined. */
export function gitExitCode(err: unknown): number | undefined {
  const code = err && typeof err === "object" && "exitCode" in err ? (err as { exitCode: unknown }).exitCode : undefined;
  return typeof code === "number" ? code : undefined;
}

/**
 * The default SnapshotGit. QA-3.1-8: `lowPriority` applies exec.ts's rule: on POSIX
 * `nice -n 10 -- git …` (inherited from birth), on Windows PRIORITY_BELOW_NORMAL set on the child
 * right after the spawn (its descendants inherit the class). QA-G-6: an abort, the timeout or a
 * stdout past `maxBuffer` rejects at once and kills git's whole tree (`killGitTree`).
 */
export const execGit: SnapshotGit = (args, opts) => new Promise<string>((ok, fail) => {
  if (opts.signal.aborted) {
    fail(new Error("git aborted before it started"));
    return;
  }
  const nice = opts.lowPriority && !isWin;
  const git = opts.executable ?? "git";
  let child: ChildProcess;
  try {
    child = spawn(nice ? "nice" : git, nice ? ["-n", "10", "--", git, ...args] : [...args], {
      cwd: opts.cwd, windowsHide: true, detached: !isWin, stdio: ["ignore", "pipe", "ignore"],
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
  } catch (e) {
    fail(e);
    return;
  }
  if (opts.lowPriority && isWin && child.pid !== undefined) lowerPriority(child.pid);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const settle = (error?: unknown, stdout?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    if (error === undefined) ok(stdout ?? "");
    else fail(error);
  };
  const stop = (why: string) => {
    if (settled) return;
    killGitTree(child);
    settle(new Error(`git ${why}`));
  };
  const onAbort = () => stop("aborted");
  const timer = setTimeout(() => stop(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
  opts.signal.addEventListener("abort", onAbort, { once: true });
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > opts.maxBuffer) stop(`stdout exceeded ${opts.maxBuffer} bytes`);
    else chunks.push(chunk);
  });
  child.on("error", (e) => settle(e));
  child.on("close", (code, signal) => {
    if (code === 0) settle(undefined, Buffer.concat(chunks).toString("utf8"));
    else settle(code === null ? new Error(`git exited with ${signal}`) : new GitExitError(code));
  });
});

/**
 * QA-2.1-2: above this many paths to digest, a snapshot's per-file digests are "unavailable".
 * QA-2.1-14: the change set then widens to every dispatch-listed path (delta), so this bounds the
 * gate's reads, not attribution.
 */
export const MAX_DIGEST_FILES = 500;
/** QA-2.1-2: above this many bytes of regular files to digest, per-file digests are "unavailable". */
export const MAX_DIGEST_BYTES = 64 * 1024 * 1024;

export interface SnapshotOptions {
  /**
   * The absolute paths to digest. Default: the snapshot's own listed (dirty or untracked) paths,
   * as at dispatch. A gate passes the dispatch snapshot's paths.
   */
  digestPaths?: readonly string[];
  /** Default MAX_DIGEST_FILES. */
  maxDigestFiles?: number;
  /** Default MAX_DIGEST_BYTES. */
  maxDigestBytes?: number;
  /**
   * QA-3.1-8: run the snapshot's git processes at below-normal priority. The wiring passes
   * VerifyBudget.lowPriority (default true). Default false.
   */
  lowPriority?: boolean;
  /**
   * Cross-repo QA-1 F4 (I11): run every git process of the snapshot hardened, as the router's other git calls in a repository
   * it does not own (git-tools.ts): `hardeningArgs()` (no fsmonitor, no hooks, no pager, no external diff, no optional locks),
   * the user's `safe.directory` values and inherited line-ending settings (`core.autocrlf` …), `gitEnvironment()` (no inherited GIT_*, no system or global config) and git by absolute
   * path outside the snapshotted tree. The perimeter's extra roots use it. Default false: the snapshot of W is unchanged.
   */
  hardened?: boolean;
  /** The git process seam (tests). Default execGit. */
  git?: SnapshotGit;
  /** Optional failure diagnostic: scrubbed, single-line, at most 200 chars. Callback errors are ignored. */
  onError?: (reason: string) => void;
  /**
   * Cross-repo P2.6 (SD11): also compute `TreeSnapshot.ignored`, a bounded digest of the repository's ignored files (nothing
   * under a `node_modules` segment), with the snapshot's own git runner (hardened when `hardened`). QA-2 #9b: "over-bounds" when
   * the index holds a skip-worktree or assume-unchanged entry (the fingerprint cannot see edits there). Default false: no extra
   * git process, no extra read, no `ignored` field.
   */
  ignoredDigest?: boolean;
  /** Default MAX_IGNORED_FILES. */
  maxIgnoredFiles?: number;
  /** Default MAX_IGNORED_BYTES. */
  maxIgnoredBytes?: number;
}

/** Cross-repo P2.6: mirrors reference.ts MAX_UNTRACKED_FILES / MAX_UNTRACKED_BYTES (not imported: tree.ts stays free of reference.ts). */
export const MAX_IGNORED_FILES = 5_000;
export const MAX_IGNORED_BYTES = 64 * 1024 * 1024;

/**
 * Cross-repo QA-2 #4: how the ignored files are listed. `--directory` reports a wholly ignored directory (an ignored
 * `node_modules` above all) as one `dir/` entry without walking it; the pathspec excludes keep any file under a `node_modules`
 * (top-level or nested) out of the listing. ignoredFilesDigest drops the `node_modules/` entries and walks the other reported
 * directories itself, bounded, never into a `node_modules`.
 */
export const IGNORED_LIST_ARGS: readonly string[] = [
  "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z",
  "--", ".", ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**",
];

/** Cross-repo QA-2 #9b: lists the index with its tags (`S` skip-worktree, lowercase assume-unchanged). */
export const INDEX_TAGS_ARGS: readonly string[] = ["ls-files", "-v", "-z"];

/**
 * Cross-repo P3a (D23, OD-P3a-2 b): bounds of the git-ignored module list a cross-link run adds to its related
 * inputs (`listIgnoredModules`). Over either bound the list is refused (`overBounds`), never truncated.
 */
export const MAX_IGNORED_MODULES = 2_000;
export const MAX_IGNORED_MODULE_PATH_BYTES = 256 * 1024;
/** Cross-repo P3a (D23): the directory entries `listIgnoredModules` reads while walking ignored directories, any kind. */
export const MAX_IGNORED_WALK_ENTRIES = 50_000;
/** Cross-repo P3a (D23): the extensions of the ignored files that can be modules a consumer loads (`dist/`). */
export const IGNORED_MODULE_EXTENSIONS: readonly string[] = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx", ".jsx", ".json"];

/**
 * Cross-repo P3a (D23, QA round 2 M-A): the tool-state directories `listIgnoredModules` never lists nor walks, at any depth
 * (a `node_modules`, so `node_modules/.vite`, is never walked either): a check of the linked repository run earlier by the gate
 * can write fresh files there, which are neither build output nor modules a consumer loads.
 */
export const IGNORED_TOOL_STATE_DIRS: readonly string[] = ["coverage", ".nyc_output", ".vitest", ".cache"];

/**
 * Cross-repo P3a (D23): what `listIgnoredModules` found: the absolute paths (sorted, deduplicated), or why there is no list.
 * The file bounds count only the kept files (after the extension, declaration and `since` filters); the walk bound counts
 * every directory entry read, a skipped nested repository's included.
 * `newestMtimeByDir` (QA round 2 M-A): per ignored directory that contributed files, the newest own mtime (lstat, ms) of
 * its listed files. The key is the directory git reports (`--directory`, e.g. `dist`), relative to the root with `/`
 * separators and no trailing slash; a file git lists on its own is keyed by its parent directory (`.` at the root).
 * `overBounds`: past MAX_IGNORED_MODULES, MAX_IGNORED_MODULE_PATH_BYTES or MAX_IGNORED_WALK_ENTRIES (never truncated).
 * `unavailable`: not a repository, a git failure, an unreadable directory or an abort (fail closed).
 */
export type IgnoredModules =
  | { readonly files: readonly string[]; readonly newestMtimeByDir: Readonly<Record<string, number>> }
  | { readonly overBounds: true }
  | { readonly unavailable: true };

export interface ListIgnoredModulesOptions {
  readonly signal: AbortSignal;
  /** VerifyBudget.lowPriority, as the snapshot's git processes. Default false. */
  readonly lowPriority?: boolean;
  /** Default MAX_IGNORED_MODULES. */
  readonly maxFiles?: number;
  /** Default MAX_IGNORED_MODULE_PATH_BYTES: the UTF-8 bytes of the returned absolute paths, summed. */
  readonly maxPathBytes?: number;
  /** Default MAX_IGNORED_WALK_ENTRIES. */
  readonly maxWalkEntries?: number;
  /**
   * Cross-repo P3a (D23 as amended 2026-10-12, QA C1): a ms epoch (the dispatch start). When set, only the files whose own
   * mtime (lstat, a link never followed) is at or after it are listed: a build output older than the dispatch is stale for
   * the change and is never a run input. Absent: no mtime filter (the hook never calls without it).
   */
  readonly since?: number;
  /** The git process seam (tests). Default execGit. */
  readonly git?: SnapshotGit;
}

/** Cross-repo P3a (QA M4): declaration files are never modules a consumer loads at run time. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

/** Cross-repo P3a (D23, QA round 2 M-A): a `node_modules` or tool-state (IGNORED_TOOL_STATE_DIRS) path segment, any case for the latter. */
function isSkippedIgnoredSegment(segment: string): boolean {
  return segment === "node_modules" || IGNORED_TOOL_STATE_DIRS.includes(segment.toLowerCase());
}

/**
 * Cross-repo P2.6: a digest of the ignored files `git ls-files` lists (IGNORED_LIST_ARGS), minus any path with a
 * `node_modules` segment: sha256 over the sorted paths with their size and content (a link: its target). "over-bounds"
 * above `maxFiles` paths or `maxBytes` bytes (sizes come from lstat before anything is read); undefined on any error
 * (a nested repository included).
 */
async function ignoredFilesDigest(
  root: string,
  list: () => Promise<string>,
  signal: AbortSignal,
  maxFiles: number,
  maxBytes: number,
): Promise<string | "over-bounds" | undefined> {
  try {
    // `--directory`: git reports a wholly ignored directory as `dir/` without walking it (so never a `node_modules` tree);
    // the other ignored directories are walked here, bounded by `maxFiles`, and never into a `node_modules`.
    const listed = (await list()).split("\0").filter(Boolean)
      .filter(path => !path.split(/[\\/]/).includes("node_modules"));
    const paths: string[] = [];
    for (const path of listed) {
      if (!/[\\/]$/.test(path)) {
        paths.push(path);
        if (paths.length > maxFiles) return "over-bounds";
        continue;
      }
      const pending = [path.replace(/[\\/]+$/, "")];
      while (pending.length > 0) {
        if (signal.aborted) return undefined;
        const dir = pending.pop() as string;
        for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          if (entry.name === ".git") return undefined; // A nested repository has no content identity here.
          const child = `${dir}/${entry.name}`;
          if (entry.isDirectory()) {
            pending.push(child);
            continue;
          }
          paths.push(child);
          if (paths.length > maxFiles) return "over-bounds";
        }
      }
    }
    paths.sort();
    const sized: [string, "file" | "link", number][] = [];
    let bytes = 0;
    for (const path of paths) {
      const stat = await lstat(resolve(root, path));
      if (stat.isSymbolicLink()) sized.push([path, "link", stat.size]);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) return "over-bounds";
        sized.push([path, "file", stat.size]);
      } else return undefined; // A directory (nested repository) has no content identity here.
    }
    const hash = createHash("sha256");
    for (const [path, kind, size] of sized) {
      if (signal.aborted) return undefined;
      hash.update(JSON.stringify([path, kind, size]));
      hash.update(kind === "link" ? await readlink(resolve(root, path)) : await readFile(resolve(root, path), { signal }));
    }
    return hash.digest("hex");
  } catch {
    return undefined; // Unlisted, vanished or unreadable: no digest, never a throw.
  }
}

/**
 * Cross-repo P3a (D23, OD-P3a-2 b, finding X6): the git-ignored JS/TS/JSON files under `root` (IGNORED_MODULE_EXTENSIONS),
 * as absolute paths under `root` as given, so a consumer that loads the linked repository's build output (`dist/`) is
 * selected by a cross-link `vitest related` run. Listed as the ignored digest lists (IGNORED_LIST_ARGS, `--directory`),
 * always hardened (`hardenedGit`: no hooks, no fsmonitor, no optional locks, so no index refresh; read-only), the reported
 * directories walked here, bounded, never into a `node_modules` nor into a directory holding a `.git` entry (a nested
 * repository or worktree, skipped entirely). Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are dropped; with `since`, so is
 * every file whose own mtime is before it (D23 as amended 2026-10-12: only the modules modified during the dispatch). The
 * tool-state directories (IGNORED_TOOL_STATE_DIRS) are neither listed nor walked, and each listed file's mtime feeds
 * `newestMtimeByDir` (QA round 2 M-A). Never throws.
 */
export async function listIgnoredModules(root: string, opts: ListIgnoredModulesOptions): Promise<IgnoredModules> {
  const run = opts.git ?? execGit;
  const maxFiles = opts.maxFiles ?? MAX_IGNORED_MODULES;
  const maxPathBytes = opts.maxPathBytes ?? MAX_IGNORED_MODULE_PATH_BYTES;
  const maxWalk = opts.maxWalkEntries ?? MAX_IGNORED_WALK_ENTRIES;
  const unavailable: IgnoredModules = { unavailable: true };
  const overBounds: IgnoredModules = { overBounds: true };
  try {
    if (opts.signal.aborted) return unavailable;
    const hardened = await hardenedGit(root);
    const listing = await run([...hardened.prefix, ...IGNORED_LIST_ARGS], {
      cwd: root, signal: opts.signal, timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER,
      lowPriority: opts.lowPriority === true, env: hardened.env, executable: hardened.executable,
    });
    const files = new Set<string>();
    const newest = new Map<string, number>();
    const since = opts.since;
    let bytes = 0;
    let walked = 0;
    /** False once a bound is passed. `dir`: the newestMtimeByDir key the file counts toward. */
    const add = async (relative: string, dir: string): Promise<boolean> => {
      if (!IGNORED_MODULE_EXTENSIONS.includes(extname(relative).toLowerCase())) return true;
      if (DECLARATION_FILE.test(relative)) return true; // QA M4: `.d.ts`, `.d.mts`, `.d.cts` are never loaded.
      const absolute = resolve(root, relative);
      if (files.has(absolute)) return true;
      // QA C1: a file not modified since the dispatch start is stale for the change (lstat: a link's own mtime).
      const mtime = (await lstat(absolute)).mtimeMs;
      if (since !== undefined && !(mtime >= since)) return true;
      files.add(absolute);
      // QA round 2 M-A: the newest listed file per ignored directory, for the hook's build-staleness check.
      if (!(mtime <= (newest.get(dir) ?? -Infinity))) newest.set(dir, mtime);
      bytes += Buffer.byteLength(absolute, "utf8");
      return files.size <= maxFiles && bytes <= maxPathBytes;
    };
    for (const path of listing.split("\0")) {
      if (path === "" || path.split(/[\\/]/).some(isSkippedIgnoredSegment)) continue;
      if (!/[\\/]$/.test(path)) {
        const slash = path.search(/[\\/][^\\/]*$/);
        if (!(await add(path, slash < 0 ? "." : path.slice(0, slash).replace(/\\/g, "/")))) return overBounds;
        continue;
      }
      // `--directory`: a wholly ignored directory (`dist/`) is reported once; walk it. Links are entries, never followed.
      const top = path.replace(/[\\/]+$/, "");
      const key = top.replace(/\\/g, "/");
      const pending = [top];
      while (pending.length > 0) {
        if (opts.signal.aborted) return unavailable;
        const dir = pending.pop() as string;
        const entries = await readdir(resolve(root, dir), { withFileTypes: true });
        walked += entries.length;
        if (walked > maxWalk) return overBounds;
        // QA M4: a directory holding a `.git` entry (a nested repository or worktree) is skipped entirely, its subtree too.
        if (entries.some(entry => entry.name === ".git")) continue;
        for (const entry of entries) {
          if (isSkippedIgnoredSegment(entry.name)) continue;
          const child = `${dir}/${entry.name}`;
          if (entry.isDirectory()) pending.push(child);
          else if (!(await add(child, key))) return overBounds;
        }
      }
    }
    if (opts.signal.aborted) return unavailable;
    const newestMtimeByDir: Record<string, number> = {};
    for (const dir of [...newest.keys()].sort()) newestMtimeByDir[dir] = newest.get(dir) as number;
    return { files: [...files].sort(), newestMtimeByDir };
  } catch {
    return unavailable; // Not a repository, git failed or timed out, a directory vanished or is unreadable: fail closed.
  }
}

/**
 * Cross-repo P3a (D23, QA round 2 M-A): a changed source's mtime in ms (stat: a link's target, whose content the build reads),
 * undefined when it does not exist (ENOENT, ENOTDIR). Any other error throws (the testsPass hook counts it as newer than
 * any build: fail closed).
 */
export async function fileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/** QA-1 F4: the argument prefix and process options of a hardened snapshot of `cwd` (SnapshotOptions.hardened). */
async function hardenedGit(cwd: string): Promise<{ prefix: string[]; env: NodeJS.ProcessEnv; executable: string }> {
  const executable = tools.gitExecutable(tools.workRootGuards(cwd));
  const trusted = await tools.inheritedSafeDirectoryArgs(executable);
  const base = [...tools.hardeningArgs(), ...trusted];
  // The inherited line-ending settings (inspectGit's allowlist): a CRLF checkout must not read as modified because the
  // environment hides the user's `core.autocrlf`.
  const inherited = await tools.inheritedConfigArgs(executable, cwd, base);
  return { prefix: [...base, ...inherited], env: tools.gitEnvironment(), executable };
}

function errorCode(err: unknown): unknown {
  return err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
}

/**
 * QA-2.1-2: one content identity per path, bounded by count and bytes (sizes are summed from lstat
 * before anything is read). Reads only files, spawns nothing, and honours `signal`. Anything it
 * cannot prove (a directory, an unreadable path, the bounds) makes the whole map "unavailable".
 */
async function digestPaths(
  paths: readonly string[],
  signal: AbortSignal,
  maxFiles: number,
  maxBytes: number,
): Promise<ReadonlyMap<string, string> | "unavailable"> {
  if (paths.length > maxFiles) return "unavailable";
  try {
    const kinds: [string, "absent" | "link" | "file"][] = [];
    let bytes = 0;
    for (const path of paths) {
      let stat;
      try {
        stat = await lstat(path);
      } catch (err) {
        const code = errorCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") return "unavailable";
        kinds.push([path, "absent"]);
        continue;
      }
      if (stat.isSymbolicLink()) {
        kinds.push([path, "link"]);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) return "unavailable";
        kinds.push([path, "file"]);
      } else {
        return "unavailable"; // A directory (nested repository) has no content identity here.
      }
    }
    const digests = new Map<string, string>();
    for (const [path, kind] of kinds) {
      if (signal.aborted) return "unavailable";
      if (kind === "absent") digests.set(path, ABSENT_DIGEST);
      else if (kind === "link") digests.set(path, LINK_DIGEST_PREFIX + await readlink(path));
      else digests.set(path, FILE_DIGEST_PREFIX + createHash("sha256").update(await readFile(path, { signal })).digest("hex"));
    }
    return digests;
  } catch {
    // Deleted or replaced between lstat and read, unreadable, or aborted: no per-file proof.
    return "unavailable";
  }
}

/**
 * I7 (P0.2): the checked-out branch from line 2 of `git rev-parse HEAD --symbolic-full-name HEAD`: the short name
 * (`feat/x` from `refs/heads/feat/x`); null on a detached HEAD (`HEAD`); another ref kept whole; undefined when the line is
 * missing or empty.
 */
function parseBranchLine(line: string | undefined): string | null | undefined {
  const ref = line?.trim();
  if (ref === undefined || ref === "") return undefined;
  if (ref === "HEAD") return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export async function snapshotTree(cwd: string, signal: AbortSignal, options: SnapshotOptions = {}): Promise<TreeSnapshot | undefined> {
  let gitCwd = cwd;
  const run = options.git ?? execGit;
  const lowPriority = options.lowPriority === true;
  let prefix: readonly string[] = ["--no-pager"];
  let hardening: Pick<SnapshotGitOptions, "env" | "executable"> = {};
  type Stage = "root" | "head" | "status" | "diff-worktree" | "diff-index" | "index" | "untracked-list" | "hash" | "index-tags" | "ignored-list";
  let stage: Stage = "root";
  const git = (label: Stage, args: string[]) => {
    stage = label;
    return run([...prefix, ...args], {
      cwd: gitCwd, signal, timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER, lowPriority, ...hardening,
    });
  };
  try {
    if (options.hardened === true) {
      const hardened = await hardenedGit(cwd);
      prefix = hardened.prefix;
      hardening = { env: hardened.env, executable: hardened.executable };
    }
    const root = (await git("root", ["rev-parse", "--show-toplevel"])).trim();
    // ls-files otherwise scopes untracked contents to a subdirectory cwd,
    // missing same-path edits in sibling packages that tests may import.
    gitCwd = root;
    // One process, so HEAD and its branch describe the same checkout.
    const [headLine, refLine] = (await git("head", ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"])).split(/\r?\n/);
    const head = (headLine ?? "").trim();
    const branch = parseBranchLine(refLine);
    const status = await git("status", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files: ChangedFile[] = [];
    const records = status.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const file: ChangedFile = { path: resolve(root, record.slice(3)), status: record.slice(0, 2) };
      // -z emits a rename/copy as `XY dest\0source\0`; keep the source.
      if (/[RC]/.test(file.status)) {
        const source = records[++i];
        if (source) file.previousPath = resolve(root, source);
      }
      files.push(file);
    }
    const hash = createHash("sha256").update(status);
    hash.update(await git("diff-worktree", ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]));
    hash.update(await git("diff-index", ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
    // A submodule's dirty marker does not describe its content. Refuse rather
    // than cache a fingerprint that would excuse unmeasured changes there.
    if (/^160000 /m.test(await git("index", ["ls-files", "--stage"]))) return undefined;
    const untracked = (await git("untracked-list", ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]))
      .split("\0").filter(Boolean).sort();
    stage = "hash";
    for (const path of untracked) {
      const absolute = resolve(root, path);
      const stat = await lstat(absolute);
      hash.update(JSON.stringify([path, stat.mode, stat.size]));
      if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
      else if (stat.isFile()) hash.update(await readFile(absolute, { signal }));
      else return undefined;
    }
    const digests = await digestPaths(
      options.digestPaths ?? files.map(f => f.path),
      signal,
      options.maxDigestFiles ?? MAX_DIGEST_FILES,
      options.maxDigestBytes ?? MAX_DIGEST_BYTES,
    );
    if (signal.aborted) return undefined;
    let ignored: string | "over-bounds" | undefined;
    if (options.ignoredDigest === true) {
      // Cross-repo QA-2 #9b: a skip-worktree (`S`) or assume-unchanged (lowercase) entry hides its edits from `status` and
      // `diff`, so the fingerprint cannot vouch for it: the digest is unusable ("over-bounds"), as reference.ts treats it for W.
      // A failed listing leaves `ignored` absent and the snapshot intact, as a failed ignored listing does.
      const hidden = await git("index-tags", [...INDEX_TAGS_ARGS]).then(
        tags => tags.split("\0").some(record => record !== "" && (record[0] === "S" || record[0] !== record[0]?.toUpperCase())),
        () => undefined,
      );
      ignored = hidden === undefined
        ? undefined
        : hidden
        ? "over-bounds"
        : await ignoredFilesDigest(
          root,
          () => git("ignored-list", [...IGNORED_LIST_ARGS]),
          signal,
          options.maxIgnoredFiles ?? MAX_IGNORED_FILES,
          options.maxIgnoredBytes ?? MAX_IGNORED_BYTES,
        );
    }
    return {
      cwd: await realpath(cwd), root: await realpath(root), head, branch, fingerprint: hash.digest("hex"), dirty: files.length > 0, files, digests,
      ...(ignored !== undefined ? { ignored } : {}),
    };
  } catch (error) {
    // Not a Git checkout, unreadable file, timeout or concurrent deletion: no baseline.
    try {
      if (options.onError !== undefined) {
        const code = errorCode(error);
        const message = error instanceof Error ? error.message : String(error);
        const reason = `${stage}: ${typeof code === "string" || typeof code === "number" ? `${code}: ` : ""}${message}`;
        options.onError(scrubText(reason).replace(/\s+/g, " ").trim().slice(0, 200) || "snapshot failed");
      }
    } catch { /* Diagnostics never turn an unavailable snapshot into a throw. */ }
    return undefined;
  }
}
