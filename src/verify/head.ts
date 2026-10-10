// Impure, cheap HEAD reader: where a working tree is checked out, and how many HEAD reflog entries it has.
// Kept apart from tree.ts on purpose: several tests mock that module with `snapshotTree` alone.
import { realpath } from "node:fs/promises";
import { execGit, gitExitCode } from "./tree";

/** What the branch-switch rule reads of a working tree (see branch.ts `treeMove`). */
export interface HeadState {
  /** realpath of the toplevel, as snapshotTree reports it. */
  readonly root: string;
  readonly head: string;
  /** The branch name without `refs/heads/`; null on a detached HEAD; any other ref kept whole. */
  readonly branch: string | null;
  /** Number of HEAD reflog entries (per worktree); absent when it could not be counted. */
  readonly reflog?: number;
}

export interface HeadReadOptions {
  readonly signal?: AbortSignal;
  /** Each git process. Default 5000. */
  readonly timeoutMs?: number;
  readonly lowPriority?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 1024 * 1024;
const MAX_WINDOW = 1000;

function runner(cwd: string, opts: HeadReadOptions | undefined): (args: readonly string[]) => Promise<string> {
  const signal = opts?.signal ?? new AbortController().signal;
  return (args) => execGit(["--no-pager", "--no-optional-locks", ...args], {
    cwd, signal, timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, lowPriority: opts?.lowPriority === true,
  });
}

/**
 * What a head read found: the state, `"none"` when git RAN and exited non-zero (not a repository, an unborn branch: there is
 * no HEAD to compare), or undefined when the answer is unknown (timeout, abort, spawn failure, unparsable output).
 */
export type HeadRead = HeadState | "none" | undefined;

/**
 * The toplevel, HEAD and branch of the checkout at `cwd` (one git process), plus its HEAD reflog count (a second one).
 * `"none"` only for a git exit code (never decided from git's localised message); every other failure is undefined. A failing
 * count, or a count of 0 (reflogs disabled: `core.logAllRefUpdates=false`), only leaves `reflog` absent.
 */
export async function readHead(cwd: string, opts?: HeadReadOptions): Promise<HeadRead> {
  const git = runner(cwd, opts);
  let root: string;
  let head: string;
  let branch: string | null;
  try {
    const lines = (await git(["rev-parse", "--show-toplevel", "HEAD", "--symbolic-full-name", "HEAD"])).split(/\r?\n/);
    const top = (lines[0] ?? "").trim();
    head = (lines[1] ?? "").trim();
    const ref = (lines[2] ?? "").trim();
    if (top === "" || !/^[0-9a-f]{40,64}$/i.test(head) || ref === "") return undefined;
    branch = ref === "HEAD" ? null : ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    root = await realpath(top);
  } catch (err) {
    return gitExitCode(err) !== undefined ? "none" : undefined;
  }
  try {
    const text = (await git(["rev-list", "--walk-reflogs", "--count", "HEAD"])).trim();
    // HEAD exists, so a reflog of 0 entries means there is none (reflogs off), not an empty one.
    if (/^\d+$/.test(text) && Number(text) > 0) return { root, head, branch, reflog: Number(text) };
  } catch {
    // The count is optional.
  }
  return { root, head, branch };
}

/** `readHead` for callers that treat "no repository / unborn" and "unknown" alike: undefined for both. */
export async function readHeadState(cwd: string, opts?: HeadReadOptions): Promise<HeadState | undefined> {
  const read = await readHead(cwd, opts);
  return read === "none" ? undefined : read;
}

/** One HEAD reflog entry: the commit HEAD pointed at after it, and its subject (`%gs`). */
export interface ReflogEntry {
  readonly commit: string;
  readonly subject: string;
}

/**
 * The HEAD reflog window since a recorded count, read in ONE git process so it is anchored: `count` new entries plus the one
 * that was newest at the earlier read, newest first. [] for count <= 0 without running git; undefined on failure, on a count
 * above 1000, or when the output cannot be parsed.
 */
export async function readReflogWindow(cwd: string, count: number, opts?: HeadReadOptions): Promise<ReflogEntry[] | undefined> {
  if (!(count > 0)) return [];
  const n = Math.floor(count);
  if (n > MAX_WINDOW) return undefined;
  try {
    const lines = (await runner(cwd, opts)(["log", "-g", "-n", String(n + 1), "--format=%H%x09%gs", "HEAD"])).split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const entries: ReflogEntry[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const commit = tab < 0 ? line : line.slice(0, tab);
      if (!/^[0-9a-f]{40,64}$/i.test(commit)) return undefined;
      entries.push({ commit, subject: tab < 0 ? "" : line.slice(tab + 1) });
    }
    return entries;
  } catch {
    return undefined;
  }
}
