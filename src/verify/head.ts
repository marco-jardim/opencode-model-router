// Impure, cheap HEAD reader: where a working tree is checked out, and how many HEAD reflog entries it has.
// Kept apart from tree.ts on purpose: several tests mock that module with `snapshotTree` alone.
import { realpath } from "node:fs/promises";
import { execGit } from "./tree";

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
const MAX_SUBJECTS = 1000;

function runner(cwd: string, opts: HeadReadOptions | undefined): (args: readonly string[]) => Promise<string> {
  const signal = opts?.signal ?? new AbortController().signal;
  return (args) => execGit(["--no-pager", "--no-optional-locks", ...args], {
    cwd, signal, timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, lowPriority: opts?.lowPriority === true,
  });
}

/**
 * The toplevel, HEAD and branch of the checkout at `cwd` (one git process), plus its HEAD reflog count (a second one).
 * undefined when the first fails (not a repository, unborn branch, timeout, abort) or its output cannot be parsed; a failing
 * count only leaves `reflog` absent.
 */
export async function readHeadState(cwd: string, opts?: HeadReadOptions): Promise<HeadState | undefined> {
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
  } catch {
    return undefined;
  }
  try {
    const text = (await git(["rev-list", "--walk-reflogs", "--count", "HEAD"])).trim();
    if (/^\d+$/.test(text)) return { root, head, branch, reflog: Number(text) };
  } catch {
    // The count is optional.
  }
  return { root, head, branch };
}

/** The newest `count` (clamped to 1..1000) HEAD reflog subjects, newest first; [] for count <= 0 without running git; undefined on failure. */
export async function readReflogSubjects(cwd: string, count: number, opts?: HeadReadOptions): Promise<string[] | undefined> {
  if (!(count > 0)) return [];
  const n = Math.min(MAX_SUBJECTS, Math.max(1, Math.floor(count)));
  try {
    const lines = (await runner(cwd, opts)(["log", "-g", "-n", String(n), "--format=%gs", "HEAD"])).split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return undefined;
  }
}
