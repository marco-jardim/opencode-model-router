// Impure, bounded Git fingerprint adapter. Never interpolates paths into a shell.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { constants as osConstants, setPriority } from "node:os";
import { join, resolve } from "node:path";
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
  let child: ChildProcess;
  try {
    child = spawn(nice ? "nice" : "git", nice ? ["-n", "10", "--", "git", ...args] : [...args], {
      cwd: opts.cwd, windowsHide: true, detached: !isWin, stdio: ["ignore", "pipe", "ignore"],
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
  /** The git process seam (tests). Default execGit. */
  git?: SnapshotGit;
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
  const git = (args: string[]) => run(["--no-pager", ...args], {
    cwd: gitCwd, signal, timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, maxBuffer: SNAPSHOT_GIT_MAX_BUFFER, lowPriority,
  });
  try {
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    // ls-files otherwise scopes untracked contents to a subdirectory cwd,
    // missing same-path edits in sibling packages that tests may import.
    gitCwd = root;
    // One process, so HEAD and its branch describe the same checkout.
    const [headLine, refLine] = (await git(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"])).split(/\r?\n/);
    const head = (headLine ?? "").trim();
    const branch = parseBranchLine(refLine);
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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
    hash.update(await git(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]));
    hash.update(await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
    // A submodule's dirty marker does not describe its content. Refuse rather
    // than cache a fingerprint that would excuse unmeasured changes there.
    if (/^160000 /m.test(await git(["ls-files", "--stage"]))) return undefined;
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]))
      .split("\0").filter(Boolean).sort();
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
    return { cwd: await realpath(cwd), root: await realpath(root), head, branch, fingerprint: hash.digest("hex"), dirty: files.length > 0, files, digests };
  } catch {
    // Not a Git checkout, unreadable file, timeout or concurrent deletion: no baseline.
    return undefined;
  }
}
