/**
 * Phase 3.1.4: task expansion (the launch prompt of one plan task attempt).
 *
 * Design memo: docs/qa/critical-path-execution/phase-3.1.md M36 and §8 "expand.ts (3.1.4)".
 * Pure except `loadExpansionEnv`, which reads the worktree list and `core.longpaths` through the `GitRunner` seam.
 */
import * as path from "node:path";
import {
  ABSOLUTE_PATH_PATTERN,
  ExecutorError,
  FINDINGS_FORMAT,
  formatLaunchPrompt,
  type GitRunner,
  type LedgerV1,
  type SlotLease,
  type TaskId,
  type TaskNode,
} from "./types";

/** What the expansion needs from git (M36): the repository's worktree paths and whether `core.longpaths` is on. */
export interface ExpansionEnv {
  worktrees: readonly string[];
  longPaths: boolean;
}

/**
 * Prefix sets of one expansion (M36). `mappable` prefixes are rewritten to `slot`; any other absolute path under an
 * `inRepo` prefix is unmappable and fails. Both are sorted longest first.
 */
export interface PathMap {
  mappable: readonly string[];
  inRepo: readonly string[];
  slot: string;
  longPaths: boolean;
}

/** Input of `expandTask`: one attempt `attempt` of `taskId`, with its durable nonce, its slot and the git environment. */
export interface ExpandInput {
  ledger: Readonly<LedgerV1>;
  taskId: TaskId;
  attempt: number;
  nonce: string;
  slot: SlotLease;
  env: ExpansionEnv;
}

/** The expansion: the full launch prompt, the re-serialized route line and the slot-relative check inputs. */
export interface ExpandedTask {
  prompt: string;
  routeLine: string;
  acceptance: string | null;
  verify: string | null;
  workRoot: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Absolute path prefixes (M36 "Prefixes" and "Matching")
// ---------------------------------------------------------------------------------------------------------------

/** Windows `MAX_PATH`: a longer path needs `core.longpaths` in the slot (M36). */
export const MAX_PATH_CHARS = 260;

const DRIVE_OR_UNC = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

/** A drive or UNC path: matched through `path.win32` and case-insensitively on every OS. */
function isWindowsPath(p: string): boolean {
  return DRIVE_OR_UNC.test(p);
}

/** Characters that end a path token in prose (none of them can be part of a Windows file name segment). */
const PATH_TERMINATORS = new Set([..." \t\r\n\f\v\"'`<>|*?:;,()[]{}"]);
/** Characters that end a token only when followed by a terminator or the end of the text (sentence punctuation). */
const TRAILING_PUNCTUATION = new Set([".", ","]);

function isSeparator(c: string | undefined): boolean {
  return c === "\\" || c === "/";
}

function isTerminator(c: string | undefined): boolean {
  return c === undefined || PATH_TERMINATORS.has(c);
}

/** True iff a prefix ending at `end` (exclusive) ends at a segment boundary of `text`. */
function atSegmentBoundary(text: string, end: number): boolean {
  const c = text[end];
  if (c === undefined || isSeparator(c) || isTerminator(c)) return true;
  return TRAILING_PUNCTUATION.has(c) && isTerminator(text[end + 1]);
}

/** True iff a path may start at `start`: not inside a word or another path. */
function atPathStart(text: string, start: number): boolean {
  if (start === 0) return true;
  const c = text[start - 1];
  return c !== undefined && !/[A-Za-z0-9._~$%\\/-]/.test(c);
}

/** The end (exclusive) of the path token that starts at `start`, without trailing sentence punctuation. */
function tokenEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && !isTerminator(text[end])) end++;
  while (end > start && TRAILING_PUNCTUATION.has(text[end - 1] ?? "")) end--;
  return end;
}

/**
 * The canonical form of a prefix: drive/UNC through `path.win32.normalize` (backslashes), POSIX through
 * `path.posix.normalize`; no trailing separator except at a root. Null for a relative or empty path.
 */
export function normalizePrefix(p: string): string | null {
  const s = p.trim();
  if (s === "" || !ABSOLUTE_PATH_PATTERN.test(s)) return null;
  if (isWindowsPath(s)) {
    const n = path.win32.normalize(s);
    const root = path.win32.parse(n).root;
    return n.length > root.length ? n.replace(/[\\/]+$/, "") : n;
  }
  const n = path.posix.normalize(s);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** Normalized, de-duplicated (case-insensitively for drive/UNC), longest first, ties in code-unit order. */
function prefixList(paths: Iterable<string>): string[] {
  const out = new Map<string, string>();
  for (const p of paths) {
    const n = normalizePrefix(p);
    if (n === null) continue;
    const key = isWindowsPath(n) ? n.toLowerCase() : n;
    if (!out.has(key)) out.set(key, n);
  }
  return [...out.values()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function foldWin(c: string): string {
  return c === "/" ? "\\" : c.toLowerCase();
}

/** True iff `prefix` (normalized) occurs in `text` at `start`, segment-bounded at its end. */
function prefixAt(text: string, start: number, prefix: string): boolean {
  if (start + prefix.length > text.length) return false;
  if (isWindowsPath(prefix)) {
    for (let k = 0; k < prefix.length; k++) {
      if (foldWin(text[start + k] ?? "") !== foldWin(prefix[k] ?? "")) return false;
    }
  } else if (text.startsWith(prefix, start) === false) {
    return false;
  }
  // A root prefix (`C:\`, `/`) already ends at a separator.
  return isSeparator(prefix[prefix.length - 1]) || atSegmentBoundary(text, start + prefix.length);
}

/** Throws the one error this module raises (M36): the expansion of this attempt cannot be launched. */
function fail(message: string, detail: Record<string, string | number | boolean | null> = {}): never {
  throw new ExecutorError("E_LAUNCH_TASK", message, detail);
}

/** The longest prefix of `prefixes` (already longest first) at `start`, or null. */
function matchPrefix(text: string, start: number, prefixes: readonly string[]): string | null {
  for (const p of prefixes) if (prefixAt(text, start, p)) return p;
  return null;
}

/**
 * Rewrites every absolute path under a `mappable` prefix to the same path under `map.slot` (M36). The prefix matches
 * at a segment boundary only, through `path.win32` and case-insensitively for drive/UNC paths on every OS,
 * case-sensitively for POSIX paths; the rest of the path is kept byte for byte. Any other path under an `inRepo`
 * prefix is unmappable. A rewritten drive/UNC path longer than `MAX_PATH_CHARS` needs `map.longPaths`.
 * Throws ExecutorError E_LAUNCH_TASK on an unmappable or too long path.
 */
export function rewriteAbsolutePaths(text: string, map: PathMap): string {
  const mappable = prefixList(map.mappable);
  const inRepo = prefixList([...map.inRepo, ...map.mappable]);
  const winSlot = isWindowsPath(map.slot);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const candidate = (isSeparator(c) || /[A-Za-z]/.test(c)) && atPathStart(text, i);
    const hit = candidate ? matchPrefix(text, i, mappable) : null;
    if (hit !== null) {
      const end = Math.max(tokenEnd(text, i), i + hit.length);
      const sep = isSeparator(hit[hit.length - 1]) ? text[i + hit.length - 1] ?? "" : "";
      const rewritten = `${map.slot}${sep}${text.slice(i + hit.length, end)}`;
      if (winSlot && !map.longPaths && rewritten.length > MAX_PATH_CHARS) {
        fail(`path longer than ${MAX_PATH_CHARS} characters in the slot and core.longpaths is off`, {
          path: rewritten, length: rewritten.length,
        });
      }
      out += rewritten;
      i = end;
      continue;
    }
    if (candidate && matchPrefix(text, i, inRepo) !== null) {
      fail("absolute path in the repository cannot be mapped into the slot", { path: text.slice(i, tokenEnd(text, i)) });
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Git environment (the only I/O of this module, through the GitRunner seam)
// ---------------------------------------------------------------------------------------------------------------

function gitFailure(args: readonly string[], cwd: string, detail: string): never {
  throw new ExecutorError("E_GIT", `git ${args.join(" ")} failed`, { cwd, detail });
}

/**
 * Reads `git worktree list --porcelain` in `toplevel` (every listed path, in git's order, drive/UNC paths in
 * `path.win32` form) and `core.longpaths` as the slot sees it. A missing `core.longpaths` is false.
 * Throws ExecutorError E_GIT when git fails or exits non-zero (exit 1 of `git config --get` means "unset").
 */
export async function loadExpansionEnv(
  git: GitRunner,
  i: { toplevel: string; slotPath: string; timeoutMs: number },
): Promise<ExpansionEnv> {
  const listArgs = ["worktree", "list", "--porcelain"] as const;
  const list = await git.run(listArgs, { cwd: i.toplevel, timeoutMs: i.timeoutMs });
  if (list.code !== 0) gitFailure(listArgs, i.toplevel, list.stderr.trim() || `exit ${String(list.code)}`);
  const worktrees: string[] = [];
  for (const raw of list.stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length);
    const n = normalizePrefix(p);
    if (n !== null) worktrees.push(n);
  }
  const configArgs = ["config", "--bool", "--get", "core.longpaths"] as const;
  const config = await git.run(configArgs, { cwd: i.slotPath, timeoutMs: i.timeoutMs });
  if (config.code !== 0 && config.code !== 1) {
    gitFailure(configArgs, i.slotPath, config.stderr.trim() || `exit ${String(config.code)}`);
  }
  return { worktrees, longPaths: config.code === 0 && config.stdout.trim() === "true" };
}

// ---------------------------------------------------------------------------------------------------------------
// Route line (M36 "Route line"): re-serialized from whitelisted tokens, never concatenated from plan text
// ---------------------------------------------------------------------------------------------------------------

/** `root="D:\my dir"`: the reference grammar's only way to carry whitespace in a value (extracted before tokenising). */
const QUOTED_ROOT_RE = /\broot\s*=\s*"([^"]*)"/i;
/** `needs=shell, edit`: whitespace after a needs comma is not a separator (as in the reference grammar). */
const NEEDS_LIST_RE = /(\bneeds=[a-z_]*)((?:\s*,\s*[a-z_]+(?![a-z_]|\s*=))+)/gi;

// ---------------------------------------------------------------------------------------------------------------
// Task block (M36 "taskBlock order")
// ---------------------------------------------------------------------------------------------------------------

/** The three plan rules of 3.1.4, verbatim (M36 item 7). */
export const MUST_NOT_DO_RULES: readonly string[] = [
  "no AI attribution in code, comments or docs",
  "never run git",
  "write only the `Writes:` paths",
];

/** The qa instruction (M36 item 8): one json fenced block matching `FINDINGS_FORMAT`, the last block of the answer. */
export const FINDINGS_INSTRUCTION =
  "End your final answer with exactly one ```json fenced block whose content matches this JSON schema:\n" +
  JSON.stringify(FINDINGS_FORMAT);

void formatLaunchPrompt;
export type { LedgerV1, TaskId, TaskNode };
