/**
 * Phase 1.3: what a host tool call touches. A pure extractor (imports only `node:path`, no
 * filesystem): the file lease registry (leases.ts) and its wiring ask `toolTargets` which files a
 * call reads or writes, which roots it searches, and where it runs.
 *
 * Paths are resolved lexically (`path.resolve`) against the session directory; canonicalization
 * (symlinks, junctions, case) is the registry's job. Never throws.
 */
import { isAbsolute, resolve } from "node:path";

export type Access = "read" | "write" | "search" | "run" | "none";

export interface ToolTargets {
  access: Access;
  /** Read/write targets: absolute, resolved lexically against cwd, deduped, first-seen order. */
  paths: string[];
  /** Search roots (search), the run cwd (run), the shell workdir (informational). */
  roots: string[];
  /** Tools whose effects cannot be extracted from the arguments. */
  uncovered?: "shell" | "execute";
}

/** The tools that mutate the workspace; mirrors `WRITE_TOOLS` in src/verify/dispatch.ts (pinned by a test). */
export const WRITE_CLASS: ReadonlySet<string> = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);

/** The apply_patch header lines that name a file; verbatim from the dispatch.ts change-set parser. */
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/** Path argument keys, in the order `extractChangedFile` (src/verify/dispatch.ts) reads them. */
const PATH_KEYS = ["filePath", "path", "file"] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The paths named by an apply_patch call's headers (Add, Update, Delete, Move to), trimmed, in order of appearance. */
export function applyPatchHeaderPaths(args: unknown): string[] {
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const patch = typeof a.patchText === "string" ? a.patchText : typeof a.patch === "string" ? a.patch : "";
  return [...patch.matchAll(PATCH_HEADER)].map(m => m[1].trim());
}

/** `p` resolved against `base`; undefined when it would stay relative (no absolute base, relative `p`). */
function absolute(p: string, base: string): string | undefined {
  if (isAbsolute(base)) return resolve(base, p);
  return isAbsolute(p) ? resolve(p) : undefined;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The first non-empty string among the path keys of `a`, if any. */
function pathArg(a: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = nonEmpty(a[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolved(values: readonly (string | undefined)[], cwd: string): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value === undefined) continue;
    const p = absolute(value, cwd);
    if (p !== undefined) out.push(p);
  }
  return dedupe(out);
}

/** `path` argument (or cwd) as search roots. */
function searchRoots(a: Record<string, unknown>, cwd: string): string[] {
  return resolved([nonEmpty(a.path) ?? cwd], cwd);
}

const GLOB_CHARS = /[*?[\]{}()!]/;

/**
 * The directory a glob pattern is anchored at when it leaves the search root: the leading
 * glob-free segments of an absolute pattern or one starting with `..`. Undefined otherwise.
 */
function globPrefix(pattern: string): string | undefined {
  const segments = pattern.split(/[\\/]/);
  if (!isAbsolute(pattern) && segments[0] !== "..") return undefined;
  const fixed: string[] = [];
  let sawGlob = false;
  for (const segment of segments) {
    if (GLOB_CHARS.test(segment)) { sawGlob = true; break; }
    fixed.push(segment);
  }
  if (!sawGlob) fixed.pop(); // no wildcard: the pattern names one entry, search its directory
  if (fixed.length === 0) return segments[0] === "" ? "/" : undefined;
  const joined = fixed.join("/");
  if (joined === "") return "/";
  return /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
}

function none(): ToolTargets {
  return { access: "none", paths: [], roots: [] };
}

function writeTargets(tool: string, a: Record<string, unknown>, cwd: string): ToolTargets {
  let raw: (string | undefined)[];
  if (tool === "patch" || tool === "apply_patch") {
    raw = applyPatchHeaderPaths(a);
  } else {
    raw = [pathArg(a)];
    if (tool === "multiedit" && Array.isArray(a.edits)) {
      for (const edit of a.edits) raw.push(pathArg(record(edit)));
    }
  }
  return { access: "write", paths: resolved(raw, cwd), roots: [] };
}

/**
 * Whether `router_git_diff` reads the working tree. The tool runs `git diff [--stat|--name-only|--cached]
 * [<ref>] -- <pathspec>` (gitArgv in git-tools.ts):
 * - no ref: the working tree against the index, a working-tree read;
 * - one ref: the working tree against that commit, a working-tree read;
 * - `--cached` (mode "cached"): the index against HEAD or the ref, no working-tree read;
 * - a range (`a..b`, `a...b`): commit against commit, no working-tree read.
 * Only the last two are `none`.
 */
function gitDiffReadsWorkingTree(a: Record<string, unknown>): boolean {
  if (a.mode === "cached") return false;
  const ref = nonEmpty(a.ref)?.trim() ?? "";
  return !ref.includes("..");
}

function classify(tool: string, a: Record<string, unknown>, cwd: string): ToolTargets {
  switch (tool) {
    case "read":
      return { access: "read", paths: resolved([pathArg(a)], cwd), roots: [] };
    case "write":
    case "edit":
    case "multiedit":
    case "patch":
    case "apply_patch":
      return writeTargets(tool, a, cwd);
    case "list":
    case "grep":
      return { access: "search", paths: [], roots: searchRoots(a, cwd) };
    case "glob": {
      const roots = searchRoots(a, cwd);
      const pattern = nonEmpty(a.pattern);
      const prefix = pattern === undefined ? undefined : globPrefix(pattern);
      if (prefix !== undefined) {
        const base = roots[0] ?? cwd;
        roots.push(...resolved([prefix], base));
      }
      return { access: "search", paths: [], roots: dedupe(roots) };
    }
    case "router_run": {
      const dir = nonEmpty(a.cwd) ?? cwd;
      return { access: "run", paths: [], roots: resolved([dir], cwd) };
    }
    case "router_git_blame": {
      // A blame at a ref reads committed content only; without one it reads the working-tree file.
      if ((nonEmpty(a.ref)?.trim() ?? "") !== "") return none();
      return { access: "read", paths: resolved([nonEmpty(a.path)], cwd), roots: [] };
    }
    case "router_git_diff":
      return gitDiffReadsWorkingTree(a) ? { access: "search", paths: [], roots: searchRoots(a, cwd) } : none();
    case "router_git_status":
    case "router_git_ls_files":
      return { access: "search", paths: [], roots: searchRoots(a, cwd) };
    case "router_git_log":
    case "router_git_show":
      return none();
    case "shell":
      return { access: "none", paths: [], roots: resolved([nonEmpty(a.workdir) ?? cwd], cwd), uncovered: "shell" };
    case "execute":
      return { access: "none", paths: [], roots: [], uncovered: "execute" };
    default:
      return none();
  }
}

/** What the tool call `tool(args)` touches, with `cwd` (absolute) as the base for relative paths. Never throws. */
export function toolTargets(tool: string, args: unknown, cwd: string): ToolTargets {
  const name = typeof tool === "string" ? tool.toLowerCase() : "";
  try {
    return classify(name, record(args), typeof cwd === "string" ? cwd : "");
  } catch {
    // Unreachable for string inputs; a write-class tool stays a write so a lease is not skipped.
    return WRITE_CLASS.has(name) ? { access: "write", paths: [], roots: [] } : none();
  }
}
