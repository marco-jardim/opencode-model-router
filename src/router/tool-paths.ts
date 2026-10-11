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
   * A `router_git_*` call whose paths are relative to the repository top level but the caller gave no absolute
   * `gitRoot`: `access` stays as classified while `paths` and `roots` are empty, so the call has no concrete target
   * and the caller treats it as an unknown target.
   */
  gitRootRequired?: true;
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

/** The path arguments the v2 host reads from a `patch` / `apply_patch` call besides its headers. */
const HOST_PATCH_PATH_KEYS = ["filePath", "path", "file_path"] as const;

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

/** win32 spellings `path.resolve` would rewrite wrongly: the device prefixes `\\?\`, `\\.\`, `\??\`. */
const WIN_DEVICE = /^(?:[\\/]{2}[.?]|[\\/]\?\?)[\\/]/;
/** A win32 path rooted without a drive (`\x`): its drive is the process's, not the session's. */
const WIN_ROOTED_NO_DRIVE = /^[\\/](?![\\/])/;

/**
 * `p` resolved against `base`; undefined when it would stay relative (no absolute base, relative `p`). On win32 a
 * device-prefixed path (`\\?\C:\x`, `\??\C:\x`) and a path rooted without a drive (`\x`) are returned unchanged:
 * `path.resolve` would turn them into `C:\??\C:\x` and `<baseDrive>:\x`, defeating the lease registry, whose `keyOf`
 * understands the first and fails closed on the second.
 */
function absolute(p: string, base: string): string | undefined {
  if (process.platform === "win32" && (WIN_DEVICE.test(p) || WIN_ROOTED_NO_DRIVE.test(p))) return p;
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

/** The directory spelling of the glob-free `fixed` segments; undefined when there is none to anchor at. */
function joinPrefix(fixed: readonly string[], first: string | undefined): string | undefined {
  if (fixed.length === 0) return first === "" ? "/" : undefined;
  const joined = fixed.join("/");
  if (joined === "") return "/";
  return /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
}

/**
 * The static prefix of a relative pattern that leaves the search root (`..` first once lexically normalised), or
 * undefined. A wildcard segment may match nothing (`**`) or one directory (`*`), so a `..` after it may cancel it or
 * climb one level further: with `dropWildcards` the wildcards that precede the last `..` are dropped before the `..`
 * are resolved (the widest reading), without it they count as one ordinary segment each. The first wildcard that is
 * left ends the prefix.
 */
function relativePrefix(raw: readonly string[], dropWildcards: boolean): string | undefined {
  const lastUp = raw.lastIndexOf("..");
  const normal: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const segment = raw[index] ?? "";
    if (segment === "..") {
      if (normal.length > 0 && normal[normal.length - 1] !== "..") normal.pop();
      else normal.push("..");
    } else if (dropWildcards && index < lastUp && GLOB_CHARS.test(segment)) {
      continue;
    } else {
      normal.push(segment);
    }
  }
  if (normal[0] !== "..") return undefined;
  const cut = normal.findIndex(segment => GLOB_CHARS.test(segment));
  const fixed = cut < 0 ? normal.slice(0, -1) : normal.slice(0, cut); // no wildcard: the pattern names one entry
  return joinPrefix(fixed, "..");
}

/**
 * The directories a glob pattern is anchored at when it leaves the search root: the leading glob-free segments of an
 * absolute pattern or of a relative one that starts with `..` once normalised. A relative pattern with a wildcard
 * ahead of a `..` (`**` + `/../../w1/**`) has two readings, wildcard dropped and wildcard as one segment; both
 * prefixes are returned. Empty when the pattern stays inside the search root.
 */
function globPrefixes(pattern: string): string[] {
  const segments = pattern.split(/[\\/]/);
  if (!isAbsolute(pattern)) {
    const raw = segments.filter(segment => segment !== "" && segment !== ".");
    return dedupe([relativePrefix(raw, true), relativePrefix(raw, false)].filter((p): p is string => p !== undefined));
  }
  const fixed: string[] = [];
  let sawGlob = false;
  for (const segment of segments) {
    if (GLOB_CHARS.test(segment)) { sawGlob = true; break; }
    fixed.push(segment);
  }
  if (!sawGlob) fixed.pop(); // no wildcard: the pattern names one entry, search its directory
  const prefix = joinPrefix(fixed, segments[0]);
  return prefix === undefined ? [] : [prefix];
}

function none(): ToolTargets {
  return { access: "none", paths: [], roots: [] };
}

function writeTargets(tool: string, a: Record<string, unknown>, cwd: string): ToolTargets {
  if (tool === "patch" || tool === "apply_patch") {
    // An unreadable patch has unknown targets: a write of nothing the caller can name. The host also honours the
    // path arguments `filePath`, `path` and `file_path` of a patch call (`toolCallPaths` in src/compat/v2-hooks.ts).
    const keyed = HOST_PATCH_PATH_KEYS.map(key => nonEmpty(a[key]));
    return { access: "write", paths: resolved([...(hostPatchPaths(a) ?? []), ...keyed], cwd), roots: [] };
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

/**
 * A `router_git_*` result: paths are relative to the repository top level, so resolved against `gitRoot`; without an
 * absolute `gitRoot` there is no concrete target (`paths` and `roots` stay empty, `gitRootRequired` is set). A
 * path-less call covers the top level.
 */
function gitTargets(result: ToolTargets, a: Record<string, unknown>, opts: ToolTargetsOptions | undefined): ToolTargets {
  const gitRoot = nonEmpty(opts?.gitRoot);
  if (gitRoot === undefined || !isAbsolute(gitRoot)) return { ...result, paths: [], roots: [], gitRootRequired: true };
  const dir = nonEmpty(a.path);
  return result.access === "read"
    ? { ...result, paths: dir === undefined ? [] : resolved([dir], gitRoot) }
    : { ...result, roots: resolved([dir ?? gitRoot], gitRoot) };
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
      const prefixes = pattern === undefined ? [] : globPrefixes(pattern);
      if (prefixes.length > 0) {
        const base = roots[0] ?? cwd;
        roots.push(...resolved(prefixes, base));
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
      return gitTargets({ access: "read", paths: [], roots: [] }, a, opts);
    }
    case "router_git_diff":
      return gitDiffReadsWorkingTree(a) ? gitTargets({ access: "search", paths: [], roots: [] }, a, opts) : none();
    case "router_git_status":
    case "router_git_ls_files":
      return gitTargets({ access: "search", paths: [], roots: [] }, a, opts);
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
 * are relative to the repository top level and resolve against `opts.gitRoot` (a path-less search covers the top
 * level); without an absolute one the result has no `paths` or `roots` and carries `gitRootRequired: true`. A
 * device-prefixed (`\\?\`, `\\.\`, `\??\`) or drive-less rooted (`\x`) path is returned unchanged on win32 (the
 * registry's `keyOf` decides). Never throws.
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
