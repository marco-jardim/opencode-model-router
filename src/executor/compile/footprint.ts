// src/executor/compile/footprint.ts
// Footprint extraction (task 2.3.3, memo 2.3.1 §4 in docs/qa/critical-path-execution/phase-2.3.md).
// Turns a task body (plus its closed `Writes:`/`Reads:` lines and the phase ownership rows) into a `Footprint`.
// Pure except `loadRepoView`, which runs four read-only git commands. The input types are declared here
// structurally; this module does not import `parse.ts` (D9).

import { posix, win32 } from "node:path";
import type { Footprint, TaskKind } from "../types.js";

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/**
 * The tracked files of the repository and the roots it is checked out at.
 * `files` and `dirs` hold repo-relative '/'-separated paths in the case git reports them; the repository root is
 * the empty path and is not a member of `dirs`. `byBasename` is keyed by `touchKey(basename, caseInsensitive)`.
 */
export interface RepoView {
  toplevel: string;
  worktrees: readonly string[];
  files: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
  byBasename: ReadonlyMap<string, readonly string[]>;
  caseInsensitive: boolean;
}

/**
 * `path` is repo-relative and '/'-separated; it is "" only for the repository root (a directory). `dir` is true for a
 * directory and for a glob reduced to its static prefix.
 */
export type PathOutcome =
  | { ok: true; path: string; via: "worktree" | "relative" | "basename" | "suffix" | "new"; dir: boolean }
  | {
      ok: false;
      reason: "url" | "outside" | "other-drive" | "unc" | "device" | "escape" | "ambiguous" | "not-found";
      raw: string;
    };

/** What `extractFootprint` needs of a parsed task (structural: no dependency on parse.ts, D9). */
export interface FootprintInput {
  id: string;
  kind: TaskKind;
  body: string;
  manual: boolean;
  route: { fields: { needs?: readonly string[]; class?: string } | null } | null;
  writesLine: { line: number; text: string; none: boolean } | null;
  readsLine: { line: number; text: string; none: boolean } | null;
}

export interface OwnershipInput { path: string; owners: string[]; line: number }

/**
 * `evidence[].line` and `ignored[].line` are plan lines for paths that come from a `Writes:`/`Reads:` line and
 * 1-based lines of `body` for every other path. `ignored[].reason` is a `PathOutcome` reason, `"repo-root"` (a read of
 * the whole repository was dropped, info), `"dir-write-unbounded"` (a directory write matches no tracked file or more
 * than `MAX_DIR_EXPANSION`; the footprint is then `unknown`, i.e. writes ⊤, D4/O2) or `"write-unresolved"` (a write
 * path that cannot be represented; also ⊤). A write path that does not exist is kept as a new write, never ignored
 * (QA-2.3-1). `foreignRoots` lists the leading
 * roots dropped by suffix matches.
 */
export interface TaskFootprint {
  footprint: Footprint;
  editing: boolean;
  lowConfidence: boolean;
  /** True when the writes are the phase's whole ownership set assumed for lack of evidence (confidence `inferred`). */
  ownershipAssumed: boolean;
  evidence: Array<{ path: string; access: "write" | "read"; source: Footprint["sources"][number]; line: number; rule: string }>;
  /** `write` is true for a candidate found in a write context (`Writes:` line or after a write verb). */
  ignored: Array<{ raw: string; reason: string; line: number; write?: boolean }>;
  foreignRoots: string[];
}

/** ⊤ marker used by edges/validate: the write set of an editing task whose footprint confidence is `unknown`. */
export const UNKNOWN_WRITES: unique symbol = Symbol("footprint.UNKNOWN_WRITES");

/** O2: a directory write expands to at most this many tracked files; otherwise the task writes ⊤. */
export const MAX_DIR_EXPANSION = 50;

/** The read-only git runner `loadRepoView` needs (the `git` member of the compiler's dependencies). */
export interface RepoGit {
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------

/** The key two paths collide on: lower case when the file system is case-insensitive. */
export function touchKey(p: string, ci: boolean): string {
  return ci ? p.toLowerCase() : p;
}

/** True when `a` and `b` are equal or one is a '/'-prefix of the other ("" is the repository root, a prefix of all). */
export function overlaps(a: string, b: string, ci: boolean): boolean {
  const ka = touchKey(a, ci);
  const kb = touchKey(b, ci);
  if (ka === kb || ka === "" || kb === "") return true;
  return ka.startsWith(`${kb}/`) || kb.startsWith(`${ka}/`);
}

// ---------------------------------------------------------------------------------------------------------------
// RepoView
// ---------------------------------------------------------------------------------------------------------------

interface RepoIndex {
  fileKeys: Map<string, string>;
  dirKeys: Map<string, string>;
  /** Directory key -> number of tracked files below it and the first `MAX_DIR_EXPANSION + 1` of them. */
  under: Map<string, { count: number; files: string[] }>;
}

const indexCache = new WeakMap<RepoView, RepoIndex>();

function buildIndex(repo: RepoView): RepoIndex {
  const ci = repo.caseInsensitive;
  const fileKeys = new Map<string, string>();
  const dirKeys = new Map<string, string>();
  const under = new Map<string, { count: number; files: string[] }>();
  const note = (key: string, file: string): void => {
    let e = under.get(key);
    if (e === undefined) { e = { count: 0, files: [] }; under.set(key, e); }
    e.count += 1;
    if (e.files.length <= MAX_DIR_EXPANSION) e.files.push(file);
  };
  for (const f of repo.files) {
    fileKeys.set(touchKey(f, ci), f);
    note("", f);
    let cut = f.lastIndexOf("/");
    while (cut > 0) {
      const dir = f.slice(0, cut);
      const k = touchKey(dir, ci);
      note(k, f);
      cut = dir.lastIndexOf("/");
    }
  }
  for (const d of repo.dirs) dirKeys.set(touchKey(d, ci), d);
  return { fileKeys, dirKeys, under };
}

function indexOf(repo: RepoView): RepoIndex {
  let idx = indexCache.get(repo);
  if (idx === undefined) { idx = buildIndex(repo); indexCache.set(repo, idx); }
  return idx;
}

/** Build a `RepoView` from plain data: `dirs` and `byBasename` are derived from `files` (git paths, '/'-separated). */
export function repoViewFrom(
  i: { toplevel: string; worktrees: string[]; files: string[]; caseInsensitive: boolean },
): RepoView {
  const ci = i.caseInsensitive;
  const files = new Set<string>();
  const dirs = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const raw of i.files) {
    const f = raw.replace(/\\/g, "/");
    if (f === "" || files.has(f)) continue;
    files.add(f);
    const slash = f.lastIndexOf("/");
    const base = f.slice(slash + 1);
    const key = touchKey(base, ci);
    const list = byBasename.get(key);
    if (list === undefined) byBasename.set(key, [f]);
    else list.push(f);
    let cut = slash;
    while (cut > 0) {
      const dir = f.slice(0, cut);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      cut = dir.lastIndexOf("/");
    }
  }
  const view: RepoView = { toplevel: i.toplevel, worktrees: [...i.worktrees], files, dirs, byBasename, caseInsensitive: ci };
  indexCache.set(view, buildIndex(view));
  return view;
}

/**
 * Read the repository facts with `rev-parse --show-toplevel`, `worktree list --porcelain`, `ls-files -z` and
 * `config core.ignorecase`. The first and third must succeed; `worktree list` failing leaves the toplevel as the only
 * root, and a missing `core.ignorecase` means case-sensitive.
 */
export async function loadRepoView(git: RepoGit, cwd: string): Promise<RepoView> {
  const top = await git.run(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0 || top.stdout.trim() === "") {
    throw new Error(`git rev-parse --show-toplevel failed in ${cwd} (exit ${top.code})`);
  }
  const toplevel = top.stdout.trim();
  const wt = await git.run(["worktree", "list", "--porcelain"], toplevel);
  const worktrees: string[] = [];
  if (wt.code === 0) {
    for (const line of wt.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        const p = line.slice("worktree ".length).trim();
        if (p !== "" && p !== toplevel) worktrees.push(p);
      }
    }
  }
  const ls = await git.run(["ls-files", "-z"], toplevel);
  if (ls.code !== 0) throw new Error(`git ls-files failed in ${toplevel} (exit ${ls.code})`);
  const files = ls.stdout.split("\0").filter((f) => f !== "");
  const cfg = await git.run(["config", "core.ignorecase"], toplevel);
  const caseInsensitive = cfg.code === 0 && cfg.stdout.trim().toLowerCase() === "true";
  return repoViewFrom({ toplevel, worktrees, files, caseInsensitive });
}

// ---------------------------------------------------------------------------------------------------------------
// normalizeRepoPath
// ---------------------------------------------------------------------------------------------------------------

const URL_RE = /^(?:[a-z][a-z0-9+.-]+:\/\/|file:)/i;
/** The win32 device prefixes `\\?\`, `\\.\`, `\??\` (the same spellings tool-paths.ts rejects). */
const WIN_DEVICE = /^(?:[\\/]{2}[.?]|[\\/]\?\?)[\\/]/;
const UNC = /^[\\/]{2}/;
const ROOTED_NO_DRIVE = /^[\\/](?![\\/])/;
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const DRIVE_REL = /^[A-Za-z]:(?![\\/])/;
const GLOB_CHARS = /[*?[\]{}]/;

type Ok = Extract<PathOutcome, { ok: true }>;
type Fail = Extract<PathOutcome, { ok: false }>;
type FailReason = Fail["reason"];

interface Resolved { outcome: PathOutcome; foreignRoot: string | null }

function fail(reason: FailReason, raw: string): Resolved {
  return { outcome: { ok: false, reason, raw }, foreignRoot: null };
}

function good(path: string, via: Ok["via"], dir: boolean, foreignRoot: string | null = null): Resolved {
  return { outcome: { ok: true, path, via, dir }, foreignRoot };
}

function splitSegs(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

function badSegment(s: string): boolean {
  return s.includes(":") || s.includes("\0");
}

/** Lower-cased mirror of a created-directory set, extended incrementally (the set only grows, in insertion order). */
const createdFolded = new WeakMap<ReadonlySet<string>, { seen: number; keys: Set<string> }>();

function createdHas(created: ReadonlySet<string>, p: string, ci: boolean): boolean {
  if (created.has(p)) return true;
  if (!ci) return false;
  let e = createdFolded.get(created);
  if (e === undefined || e.seen > created.size) { e = { seen: 0, keys: new Set() }; createdFolded.set(created, e); }
  if (e.seen < created.size) {
    let i = 0;
    for (const c of created) {
      if (i >= e.seen) e.keys.add(c.toLowerCase());
      i += 1;
    }
    e.seen = created.size;
  }
  return e.keys.has(p.toLowerCase());
}

/** Canonical (git-case) spelling and kind of `rel` when it is a tracked file or a directory of one. */
function lookup(repo: RepoView, rel: string): { path: string; dir: boolean } | null {
  const idx = indexOf(repo);
  const k = touchKey(rel, repo.caseInsensitive);
  const f = idx.fileKeys.get(k);
  if (f !== undefined) return { path: f, dir: false };
  const d = idx.dirKeys.get(k);
  if (d !== undefined) return { path: d, dir: true };
  return null;
}

/** Lexical '/'-separated spelling of a relative `raw` that is not tracked; null on an escape or an unusable segment. */
function lexicalNew(raw: string): string | null {
  const stack: string[] = [];
  for (const s of raw.trim().split(/[\\/]+/)) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(s);
  }
  if (stack.length === 0 || stack.some(badSegment)) return null;
  return stack.join("/");
}

/** Rule 9: an unknown path is accepted only when `allowNew` and its parent exists or is created earlier. */
function asNew(repo: RepoView, rel: string, dirWanted: boolean, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> }, raw: string): Resolved {
  if (!o.allowNew) return fail("not-found", raw);
  const slash = rel.lastIndexOf("/");
  const parent = slash < 0 ? "" : rel.slice(0, slash);
  const parentOk = parent === "" || lookup(repo, parent)?.dir === true || createdHas(o.createdEarlier, parent, repo.caseInsensitive);
  return parentOk ? good(rel, "new", dirWanted) : fail("not-found", raw);
}

function resolveAbsolute(
  raw: string, win: boolean, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> },
): Resolved {
  const mod = win ? win32 : posix;
  const trailing = /[\\/]$/.test(raw);
  const segs = splitSegs(mod.normalize(raw));
  const ci = repo.caseInsensitive;
  const eq = (a: string, b: string, i: number): boolean =>
    a === b || ((ci || (win && i === 0)) && a.toLowerCase() === b.toLowerCase());

  // Rule 5: under the toplevel or a worktree; the longest root wins.
  let best: string[] | null = null;
  for (const root of [repo.toplevel, ...repo.worktrees]) {
    const rs = splitSegs(mod.normalize(root));
    if (rs.length === 0 || rs.length > segs.length) continue;
    if (best !== null && rs.length <= best.length) continue;
    if (rs.every((s, i) => eq(s, segs[i] ?? "", i))) best = rs;
  }
  if (best !== null) {
    const rel = segs.slice(best.length);
    if (rel.some(badSegment)) return fail("outside", raw);
    if (rel.length === 0) return good("", "worktree", true);
    const joined = rel.join("/");
    const hit = lookup(repo, joined);
    if (hit !== null) return good(hit.path, "worktree", hit.dir);
    return good(joined, "worktree", trailing);
  }

  // Rule 6: another root: the longest suffix that exists in the repository.
  for (let drop = win ? 1 : 0; drop < segs.length; drop++) {
    const rel = segs.slice(drop);
    if (rel.some(badSegment)) continue;
    const hit = lookup(repo, rel.join("/"));
    if (hit !== null) {
      const dropped = segs.slice(0, drop);
      const root = win ? dropped.join("\\") : `/${dropped.join("/")}`;
      return good(hit.path, "suffix", hit.dir, root);
    }
  }
  // Rules 6 + 9: a new file under another root (`D:\git\other-wt\test\smoke\new.test.ts`, created by the task) maps to the
  // longest suffix of at least two segments whose parent directory exists or is created earlier.
  if (o.allowNew) {
    for (let drop = win ? 1 : 0; drop + 2 <= segs.length; drop++) {
      const rel = segs.slice(drop);
      if (rel.some(badSegment)) continue;
      const parent = rel.slice(0, -1).join("/");
      if (lookup(repo, parent)?.dir === true || createdHas(o.createdEarlier, parent, ci)) {
        const dropped = segs.slice(0, drop);
        const root = win ? dropped.join("\\") : `/${dropped.join("/")}`;
        return good(rel.join("/"), "suffix", trailing, root);
      }
    }
  }
  if (win) {
    const drive = (segs[0] ?? "").toLowerCase();
    const known = [repo.toplevel, ...repo.worktrees].some((r) => splitSegs(mod.normalize(r))[0]?.toLowerCase() === drive);
    return fail(known ? "outside" : "other-drive", raw);
  }
  return fail("outside", raw);
}

function resolveRelative(
  raw: string, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> },
): Resolved {
  const trailing = /[\\/]$/.test(raw);
  const stack: string[] = [];
  for (const s of raw.split(/[\\/]+/)) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (stack.length === 0) return fail("escape", raw);
      stack.pop();
    } else stack.push(s);
  }
  if (stack.some(badSegment)) return fail("outside", raw);
  if (stack.length === 0) return good("", "relative", true);
  const rel = stack.join("/");
  const hit = lookup(repo, rel);
  if (hit !== null) return good(hit.path, "relative", hit.dir);
  return asNew(repo, rel, trailing, o, raw);
}

function resolveBare(
  raw: string, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> },
): Resolved {
  if (badSegment(raw)) return fail("outside", raw);
  const matches = repo.byBasename.get(touchKey(raw, repo.caseInsensitive));
  if (matches !== undefined && matches.length === 1) return good(matches[0] ?? raw, "basename", false);
  if (matches !== undefined && matches.length > 1) return fail("ambiguous", raw);
  const dir = lookup(repo, raw);
  if (dir !== null) return good(dir.path, "relative", dir.dir);
  return asNew(repo, raw, false, o, raw);
}

function resolveDetailed(
  raw0: string, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> },
): Resolved {
  const raw = raw0.trim();
  if (raw === "") return fail("not-found", raw0);
  if (URL_RE.test(raw)) return fail("url", raw0);                       // 1
  if (WIN_DEVICE.test(raw)) return fail("device", raw0);                // 2
  if (UNC.test(raw)) return fail("unc", raw0);                          // 3
  const winRepo = DRIVE_ABS.test(repo.toplevel) || repo.toplevel.includes("\\");
  if (ROOTED_NO_DRIVE.test(raw) && (winRepo || raw.includes("\\"))) return fail("device", raw0); // 4
  if (raw.includes("\0") || DRIVE_REL.test(raw)) return fail("outside", raw0);

  // Glob tokens reduce to their static prefix (the segments before the first wildcard) and become directories.
  const parts = raw.split(/[\\/]/);
  const cut = parts.findIndex((s) => GLOB_CHARS.test(s));
  if (cut >= 0) {
    const sep = raw.includes("\\") ? "\\" : "/";
    let prefix = parts.slice(0, cut).join(sep);
    if (cut === 1 && parts[0] === "") prefix = sep;
    const r = resolveDetailed(prefix === "" ? "." : prefix, repo, { allowNew: false, createdEarlier: o.createdEarlier });
    if (!r.outcome.ok) return { outcome: { ...r.outcome, raw: raw0 }, foreignRoot: null };
    return { outcome: { ...r.outcome, dir: true }, foreignRoot: r.foreignRoot };
  }

  const absWin = DRIVE_ABS.test(raw);
  if (absWin || (raw.startsWith("/") && !winRepo && !raw.includes("\\"))) {
    const r = resolveAbsolute(raw, absWin, repo, o);
    return r.outcome.ok ? r : { outcome: { ...r.outcome, raw: raw0 }, foreignRoot: null };
  }
  const hasSeparator = /[\\/]/.test(raw.replace(/[\\/]+$/, ""));
  const r = hasSeparator ? resolveRelative(raw, repo, o) : resolveBare(raw.replace(/[\\/]+$/, ""), repo, o);
  return r.outcome.ok ? r : { outcome: { ...r.outcome, raw: raw0 }, foreignRoot: null };
}

/**
 * Resolve a path spelling found in a plan to a repo-relative '/'-separated path, following the rules of memo §4:
 * url, device, unc and drive-less rooted spellings are rejected; an absolute path under the toplevel or a worktree maps
 * to its suffix; one under another root maps to the longest suffix that exists; a relative path resolves lexically
 * (a leading `..` that escapes is `escape`); a bare file name needs exactly one tracked match; anything unknown is
 * accepted only with `allowNew` and an existing or earlier-created parent directory. Win32 spellings always use
 * `path.win32`, so the result does not depend on the host OS.
 */
export function normalizeRepoPath(
  raw: string, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> },
): PathOutcome {
  return resolveDetailed(raw, repo, o).outcome;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------------------------------------------

interface Cand {
  raw: string;
  /** Offsets in `text` of the candidate including its backticks. */
  start: number;
  end: number;
  line: number;
  text: string;
}

const TICK_FORBIDDEN = /[\s"'<>|=,;$]/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9_-]{0,11}$/;
const SEG = "[\\w.@~+*-]";

function stripAnnotations(tok: string): string {
  return tok.replace(/#L?\d+(?:-L?\d+)?$/, "").replace(/(?<=[^\\/:]):\d+(?:[-:]\d+)*$/, "");
}

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== "");
  return parts[parts.length - 1] ?? "";
}

function fileish(p: string): boolean {
  const last = lastSegment(p);
  return EXTENSION.test(last) || last.includes("*");
}

function tickedQualifies(tok: string): boolean {
  if (URL_RE.test(tok)) return true;
  if (tok.length < 2 || TICK_FORBIDDEN.test(tok) || /^[\d.]+$/.test(tok) || tok.startsWith("-")) return false;
  if (!/[^\\/]/.test(tok)) return false;
  return /[\\/]/.test(tok) || EXTENSION.test(tok);
}

const BARE_URL = /\b[a-z][a-z0-9+.-]+:\/\/[^\s`"'<>)\]]+/gi;
const BARE_DRIVE = /(?<![\w])[A-Za-z]:[\\/][^\s"'<>|`]*/g;
const BARE_UNC = /(?<![\w\\])\\\\[^\s"'<>|`]+/g;
const BARE_POSIX = new RegExp(`(?<![\\w.@~+*\\\\/:)-])\\/(?!\\/)${SEG}+(?:\\/${SEG}+)*\\/?`, "g");
const BARE_REL = new RegExp(`(?<![\\w.@~+*\\\\/:-])${SEG}+(?:[\\\\/]${SEG}+)+[\\\\/]?`, "g");

/** The path candidates of one line: backticked tokens first, then the bare spellings outside backticks. */
function scanLine(text: string, line: number): Cand[] {
  const out: Cand[] = [];
  let blank = text;
  const blankRange = (s: number, e: number): void => {
    blank = blank.slice(0, s) + " ".repeat(e - s) + blank.slice(e);
  };
  const tick = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = tick.exec(text)) !== null) {
    const tok = stripAnnotations((m[1] ?? "").trim());
    const end = m.index + m[0].length;
    if (tickedQualifies(tok)) out.push({ raw: tok, start: m.index, end, line, text });
    blankRange(m.index, end);
  }
  const bare = (re: RegExp, accept: (tok: string) => boolean): void => {
    const source = blank;
    re.lastIndex = 0;
    let b: RegExpExecArray | null;
    while ((b = re.exec(source)) !== null) {
      const stripped = b[0].replace(/[.,;:)\]]+$/, "");
      const tok = stripped === "" ? b[0] : stripped;
      if (accept(tok)) out.push({ raw: tok, start: b.index, end: b.index + tok.length, line, text });
      blankRange(b.index, b.index + b[0].length);
    }
  };
  bare(BARE_URL, () => true);
  bare(BARE_DRIVE, () => true);
  bare(BARE_UNC, () => true);
  bare(BARE_POSIX, (tok) => splitSegs(tok).length >= 2 || fileish(tok) || tok.endsWith("/"));
  bare(BARE_REL, (tok) => fileish(tok) || /[\\/]$/.test(tok));
  return out.sort((a, b) => a.start - b.start);
}

function scanText(text: string, firstLine: number): Cand[] {
  const out: Cand[] = [];
  text.split(/\r?\n/).forEach((l, i) => { out.push(...scanLine(l, firstLine + i)); });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Write verbs
// ---------------------------------------------------------------------------------------------------------------

const WRITE_VERB =
  /\b(?:implement(?:s|ed|ing)?|creat(?:e|es|ed|ing)|add(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|updat(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|extend(?:s|ed|ing)?|writ(?:e|es|ing)|wrote|edit(?:s|ed|ing)?|fix(?:es|ed|ing)?|refactor(?:s|ed|ing)?|renam(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|rework(?:s|ed|ing)?|chang(?:e|es|ed|ing)|keys?\s+in)\b/i;
/** "wire … in `X`", "document … in `X`", "record … in `X`": the verb, up to four tokens, then `in` right before the path. */
const WRITE_VERB_IN = /\b(?:wir(?:e|es|ed|ing)|document(?:s|ed|ing)?|record(?:s|ed|ing)?)\b(?:\s+\S+){0,4}?\s+in\s*$/i;
const CREATE_VERB = /^(?:implement|creat|add)/i;
const TESTS_IN = /\btests?\s+in\s*$/i;
const NEW_MARKER = /^[\s*_]*\(new\)/i;

/** The write verb in the clause before `c` (at most 6 tokens back, or the "In `X`:" form), or null. */
function verbBefore(c: Cand): { rule: string; create: boolean } | null {
  const masked = c.text.slice(0, c.start).replace(/`[^`]*`/g, "§");
  const clause = masked.split(/(?<=[.;!?])\s+/).pop() ?? "";
  const lead = clause.replace(/^[\s>*+-]+/, "").replace(/^\d+[.)]\s+/, "").trim();
  if (/(?:^|\s)in$/i.test(lead) && /^\s*:/.test(c.text.slice(c.end))) return { rule: "verb:in", create: false };
  const tail = clause.trim().split(/\s+/).slice(-6).join(" ");
  if (TESTS_IN.test(tail)) return { rule: "verb:tests-in", create: false };
  const m = WRITE_VERB.exec(tail);
  if (m === null) {
    const w = WRITE_VERB_IN.exec(tail);
    return w === null ? null : { rule: `verb:${(/^\S+/.exec(w[0]) ?? [w[0]])[0].toLowerCase()}-in`, create: false };
  }
  return { rule: `verb:${m[0].toLowerCase()}`, create: CREATE_VERB.test(m[0]) };
}

// ---------------------------------------------------------------------------------------------------------------
// extractFootprint
// ---------------------------------------------------------------------------------------------------------------

/** Classes whose tasks do not edit unless they show write evidence (`TASK_CLASSES` minus implement/debug/mechanical/other). */
const NON_EDITING_CLASSES: ReadonlySet<string> = new Set(["search", "recon", "design", "review"]);
const NEVER_EDITING_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["manual", "preflight", "qa"]);

type Source = Footprint["sources"][number];

/** The tracked files below directory `dir`; null (⊤) when there are none or more than `MAX_DIR_EXPANSION` (O2). */
function expandDir(repo: RepoView, dir: string): string[] | null {
  const e = indexOf(repo).under.get(touchKey(dir, repo.caseInsensitive));
  if (e === undefined || e.count === 0 || e.count > MAX_DIR_EXPANSION) return null;
  return e.files;
}

/**
 * The footprint of one task. D5: a present `Writes:` line is closed (verbs, mentions and ownership rows add no writes)
 * and so is a present `Reads:` line (mentions add no reads). A path both written and read stays in `writes` only. New
 * files the task creates are added, with their parent directories, to `createdEarlier`. A directory (or glob) write
 * expands to its tracked files (O2); when it cannot, confidence is `unknown` and the task writes ⊤ (D4).
 * Cost is O(|body|) plus set lookups per task.
 */
export function extractFootprint(
  t: FootprintInput, phaseOwnership: readonly OwnershipInput[], repo: RepoView, createdEarlier: Set<string>,
): TaskFootprint {
  const ci = repo.caseInsensitive;
  const evidence: TaskFootprint["evidence"] = [];
  const ignored: TaskFootprint["ignored"] = [];
  const foreignRoots: string[] = [];
  const sources: Source[] = [];
  const writes: string[] = [];
  const writeKeys = new Set<string>();
  const reads: string[] = [];
  const readKeys = new Set<string>();
  const declared = new Set<string>();
  const mentions: Ok[] = [];
  let explicit = false;
  let owned = false;
  let unbounded = false;
  let weak = false;
  let writeIgnored = false;
  let assumed = false;

  const note = (s: Source): void => { if (!sources.includes(s)) sources.push(s); };
  const created = (p: string): void => {
    createdEarlier.add(p);
    let cut = p.lastIndexOf("/");
    while (cut > 0) {
      createdEarlier.add(p.slice(0, cut));
      cut = p.lastIndexOf("/", cut - 1);
    }
  };
  const resolve = (raw: string, line: number, allowNew: boolean, report: boolean): Ok | null => {
    const r = resolveDetailed(raw, repo, { allowNew, createdEarlier });
    if (r.outcome.ok) {
      if (r.foreignRoot !== null && !foreignRoots.includes(r.foreignRoot)) foreignRoots.push(r.foreignRoot);
      return r.outcome;
    }
    if (report) ignored.push({ raw: r.outcome.raw, reason: r.outcome.reason, line });
    return null;
  };
  /**
   * Resolve a path found in a write context (QA-2.3-1). A path that is `not-found` is kept as a new write (lexically
   * normalized, escape-checked) so a dropped candidate never leaves an `explicit` footprint short; an `ambiguous`
   * basename writes every match; a glob or path that cannot be represented makes the task write ⊤. Only truly outside
   * spellings (url, device, unc, other drive, escape, outside) are ignored: they return null and set `writeIgnored`.
   */
  const resolveWrites = (raw: string, line: number, allowNew: boolean): Ok[] | null => {
    const r = resolveDetailed(raw, repo, { allowNew, createdEarlier });
    if (r.outcome.ok) {
      if (r.foreignRoot !== null && !foreignRoots.includes(r.foreignRoot)) foreignRoots.push(r.foreignRoot);
      return [r.outcome];
    }
    const o = r.outcome;
    if (o.reason === "ambiguous") {
      const ms = repo.byBasename.get(touchKey(raw.trim().replace(/[\\/]+$/, ""), ci)) ?? [];
      if (ms.length > 1) return ms.map((path): Ok => ({ ok: true, path, via: "basename", dir: false }));
    }
    if (o.reason === "not-found") {
      if (raw.split(/[\\/]/).some((s) => GLOB_CHARS.test(s))) {
        unbounded = true;
        ignored.push({ raw, reason: "dir-write-unbounded", line });
        return [];
      }
      const lex = lexicalNew(raw);
      if (lex !== null) return [{ ok: true, path: lex, via: "new", dir: false }];
      unbounded = true;
      ignored.push({ raw, reason: "write-unresolved", line });
      return [];
    }
    writeIgnored = true;
    ignored.push({ raw: o.raw, reason: o.reason, line, write: true });
    return null;
  };
  const putWrite = (p: string, source: Source, line: number, rule: string): void => {
    const key = touchKey(p, ci);
    if (!writeKeys.has(key)) { writeKeys.add(key); writes.push(p); }
    evidence.push({ path: p, access: "write", source, line, rule });
    if (lookup(repo, p) === null) created(p);
  };
  const addWrite = (ok: Ok, raw: string, source: Source, line: number, rule: string): void => {
    note(source);
    if (ok.dir) {
      const files = expandDir(repo, ok.path);
      if (files === null) {
        unbounded = true;
        ignored.push({ raw, reason: "dir-write-unbounded", line });
        return;
      }
      for (const f of files) putWrite(f, source, line, rule);
      // QA-2.3-16: the directory itself stays a key so a file created below it later still overlaps this write.
      if (ok.path !== "") putWrite(ok.path, source, line, rule);
      return;
    }
    if (ok.via === "suffix" || ok.via === "basename") weak = true;
    putWrite(ok.path, source, line, rule);
  };
  const addRead = (ok: Ok, raw: string, source: Source, line: number, rule: string): void => {
    if (ok.path === "") {
      ignored.push({ raw, reason: "repo-root", line });
      return;
    }
    const key = touchKey(ok.path, ci);
    if (!readKeys.has(key)) { readKeys.add(key); reads.push(ok.path); }
    evidence.push({ path: ok.path, access: "read", source, line, rule });
    note(source);
  };

  // Writes: line (closed).
  if (t.writesLine !== null) {
    if (t.writesLine.none) {
      explicit = true;
      note("writes-line");
    } else {
      for (const c of scanText(t.writesLine.text, t.writesLine.line)) {
        declared.add(c.raw);
        const oks = resolveWrites(c.raw, c.line, true);
        if (oks === null) continue;
        explicit = true;
        if (oks.length === 0) note("writes-line");
        for (const ok of oks) addWrite(ok, c.raw, "writes-line", c.line, "writes-line");
      }
    }
  }
  // Reads: line (closed).
  if (t.readsLine !== null && !t.readsLine.none) {
    for (const c of scanText(t.readsLine.text, t.readsLine.line)) {
      declared.add(c.raw);
      const ok = resolve(c.raw, c.line, false, true);
      if (ok !== null) addRead(ok, c.raw, "writes-line", c.line, "reads-line");
    }
  }
  // Body mentions: write verbs (no Writes: line) and reads (no Reads: line).
  const wantOwnership = t.writesLine === null && phaseOwnership.length > 0;
  if (t.writesLine === null || t.readsLine === null) {
    t.body.split(/\r?\n/).forEach((text, i) => {
      for (const c of scanLine(text, i + 1)) {
        if (declared.has(c.raw)) continue;
        const marked = NEW_MARKER.test(c.text.slice(c.end));
        const verb = t.writesLine === null ? verbBefore(c) : null;
        if (verb !== null) {
          const oks = resolveWrites(c.raw, c.line, verb.create || marked);
          if (oks === null) continue;
          explicit = true;
          if (oks.length === 0) note("path");
          for (const ok of oks) {
            mentions.push(ok);
            addWrite(ok, c.raw, "path", c.line, verb.rule);
          }
        } else if (t.readsLine === null) {
          const ok = resolve(c.raw, c.line, marked, true);
          if (ok === null) {
            if (wantOwnership) {
              const guess = resolve(c.raw, c.line, true, false);
              if (guess !== null) mentions.push(guess);
            }
            continue;
          }
          mentions.push(ok);
          addRead(ok, c.raw, "path", c.line, "mention");
        } else if (wantOwnership) {
          const ok = resolve(c.raw, c.line, true, false);
          if (ok !== null) mentions.push(ok);
        }
      }
    });
  }
  // Ownership rows of the task's phase that the task mentions (no Writes: line).
  if (wantOwnership) {
    for (const row of phaseOwnership) {
      const rp = resolve(row.path, row.line, true, false);
      if (rp === null || rp.path === "") continue;
      if (!mentions.some((m) => overlaps(m.path, rp.path, ci))) continue;
      owned = true;
      addWrite(rp, row.path, "ownership", row.line, "ownership-row");
    }
  }

  const cls = t.route?.fields?.class;
  const needs = t.route?.fields?.needs;
  // D9: an editing task with no write evidence of its own writes what its phase owns. The ownership table declares the
  // phase's write set ("Owns (writes)"), so this is a bounded over-approximation (low confidence) instead of ⊤.
  const editsByDefault = !t.manual && !NEVER_EDITING_KINDS.has(t.kind)
    && (needs !== undefined ? needs.includes("edit") : cls === undefined || !NON_EDITING_CLASSES.has(cls));
  // QA-2.3-5: skipped when a write candidate was ignored (the task keeps ⊤), and the result is `inferred`, not
  // `ownership`, so the residue may still add to it.
  if (wantOwnership && editsByDefault && writes.length === 0 && !unbounded && !explicit && !writeIgnored) {
    for (const row of phaseOwnership) {
      const rp = resolve(row.path, row.line, true, false);
      if (rp === null || rp.path === "") continue;
      assumed = true;
      weak = true;
      addWrite(rp, row.path, "ownership", row.line, "ownership-phase");
    }
  }

  const finalReads = reads.filter((r) => !writeKeys.has(touchKey(r, ci)));
  const hasWriteEvidence = writes.length > 0 || unbounded;
  let editing: boolean;
  if (t.manual || NEVER_EDITING_KINDS.has(t.kind)) editing = false;
  else if (needs !== undefined) editing = needs.includes("edit") || hasWriteEvidence;
  else editing = cls === undefined || !NON_EDITING_CLASSES.has(cls) || hasWriteEvidence;

  let confidence: Footprint["confidence"];
  if (unbounded) confidence = "unknown";
  else if (explicit) confidence = "explicit";
  else if (owned) confidence = "ownership";
  else if (assumed) confidence = "inferred";
  else confidence = editing ? "unknown" : "inferred";
  const lowConfidence = editing && (confidence === "unknown" || confidence === "inferred" || weak);

  return {
    footprint: { writes, reads: finalReads, confidence, sources },
    editing,
    lowConfidence,
    ownershipAssumed: assumed,
    evidence,
    ignored,
    foreignRoots,
  };
}
