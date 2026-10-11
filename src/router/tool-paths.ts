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
  /**
   * A `router_git_*` call whose paths are relative to the repository top level, resolved against `cwd`
   * because the caller gave no `gitRoot`: the work root may be below the top level, so they may be wrong.
   */
  gitRootAssumed?: true;
}

/** Optional context for `toolTargets`. */
export interface ToolTargetsOptions {
  /** Absolute repository top level: the base of `router_git_*` paths (git-tools.ts takes them relative to it). */
  gitRoot?: string;
}

/** The tools that mutate the workspace; mirrors `WRITE_TOOLS` in src/verify/dispatch.ts (pinned by a test). */
export const WRITE_CLASS: ReadonlySet<string> = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);

/** The apply_patch header lines that name a file; verbatim from the dispatch.ts change-set parser. */
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/**
 * Path argument keys: the ones `extractChangedFile` (src/verify/dispatch.ts) reads plus the host's `file_path`.
 * Every non-empty string among them is a target (the host may honour any of them, so first-wins is unsafe).
 */
const PATH_KEYS = ["filePath", "path", "file", "file_path"] as const;

/** The apply_patch argument keys the v2 host reads, in order; the first string wins (even when empty). */
const PATCH_KEYS = ["patchText", "patch_text", "patch", "input"] as const;

/** The header prefixes of the v2 host's patch format (`patchPaths` in src/compat/v2-hooks.ts). */
const HOST_PATCH_HEADERS = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The paths named by an apply_patch call's headers (Add, Update, Delete, Move to), trimmed, in order of appearance. */
export function applyPatchHeaderPaths(args: unknown): string[] {
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const patch = typeof a.patchText === "string" ? a.patchText : typeof a.patch === "string" ? a.patch : "";
  return [...patch.matchAll(PATCH_HEADER)].map(m => m[1].trim());
}

/**
 * The paths of a patch as the v2 host parses it (same semantics as `patchPaths` in src/compat/v2-hooks.ts, which this
 * module may not import): header lines may have leading blanks. Undefined when a header names no path or no header is
 * found, i.e. the patch is unreadable and its targets unknown.
 */
function hostPatchPaths(a: Record<string, unknown>): string[] | undefined {
  const text = PATCH_KEYS.map(key => a[key]).find(value => typeof value === "string");
  if (typeof text !== "string") return undefined;
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();
    const header = HOST_PATCH_HEADERS.find(prefix => line.startsWith(prefix));
    if (header === undefined) continue;
    const path = line.slice(header.length).trim();
    if (path === "") return undefined;
    paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
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

/** Every non-empty string among the path keys of `a`. */
function pathArgs(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = nonEmpty(a[key]);
    if (value !== undefined) out.push(value);
  }
  return out;
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
  let segments = pattern.split(/[\\/]/);
  if (!isAbsolute(pattern)) {
    // Normalise lexically first: `src/../../w1/**` and `./../w1/**` leave the root, `src/../x/*` does not.
    const normal: string[] = [];
    for (const segment of segments) {
      if (segment === "" || segment === ".") continue;
      if (segment !== "..") normal.push(segment);
      else if (normal.length > 0 && normal[normal.length - 1] !== "..") normal.pop();
      else normal.push("..");
    }
    if (normal[0] !== "..") return undefined;
    segments = normal;
  }
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
  if (tool === "patch" || tool === "apply_patch") {
    // An unreadable patch has unknown targets: a write of nothing the caller can name.
    return { access: "write", paths: resolved(hostPatchPaths(a) ?? [], cwd), roots: [] };
  }
  const raw = pathArgs(a);
  if (tool === "multiedit" && Array.isArray(a.edits)) {
    for (const edit of a.edits) raw.push(...pathArgs(record(edit)));
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

/** A `router_git_*` result: paths are relative to the repository top level, so resolved against `gitRoot`. */
function gitTargets(
  result: ToolTargets,
  a: Record<string, unknown>,
  cwd: string,
  opts: ToolTargetsOptions | undefined,
): ToolTargets {
  const gitRoot = nonEmpty(opts?.gitRoot);
  const base = gitRoot !== undefined && isAbsolute(gitRoot) ? gitRoot : undefined;
  const dir = nonEmpty(a.path);
  // Without a path the tools list the work root (git-tools.ts scopes the pathspec to it), so that is the root.
  const out: ToolTargets = result.access === "read"
    ? { ...result, paths: dir === undefined ? [] : resolved([dir], base ?? cwd) }
    : { ...result, roots: resolved([dir ?? cwd], dir === undefined ? cwd : base ?? cwd) };
  return base === undefined ? { ...out, gitRootAssumed: true } : out;
}

function classify(tool: string, a: Record<string, unknown>, cwd: string, opts?: ToolTargetsOptions): ToolTargets {
  switch (tool) {
    case "read":
      return { access: "read", paths: resolved(pathArgs(a), cwd), roots: [] };
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
      return gitTargets({ access: "read", paths: [], roots: [] }, a, cwd, opts);
    }
    case "router_git_diff":
      return gitDiffReadsWorkingTree(a) ? gitTargets({ access: "search", paths: [], roots: [] }, a, cwd, opts) : none();
    case "router_git_status":
    case "router_git_ls_files":
      return gitTargets({ access: "search", paths: [], roots: [] }, a, cwd, opts);
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

/**
 * What the tool call `tool(args)` touches, with `cwd` (absolute) as the base for relative paths. `router_git_*` paths
 * are relative to the repository top level and resolve against `opts.gitRoot`; without it they fall back to `cwd` and
 * the result carries `gitRootAssumed: true`. Never throws.
 */
export function toolTargets(tool: string, args: unknown, cwd: string, opts?: ToolTargetsOptions): ToolTargets {
  const name = typeof tool === "string" ? tool.toLowerCase() : "";
  try {
    return classify(name, record(args), typeof cwd === "string" ? cwd : "", opts);
  } catch {
    // Unreachable for string inputs; a write-class tool stays a write so a lease is not skipped.
    return WRITE_CLASS.has(name) ? { access: "write", paths: [], roots: [] } : none();
  }
}
