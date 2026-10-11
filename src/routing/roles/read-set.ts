/**
 * The read set R of a role dispatch beyond its work root W (`docs/design/cross-repo.md` §1 "R, read set", Phase 1 step P1.5):
 * the worktrees of the orchestrator session's working set (P1.4), and every directory inside a repository whose top lies
 * 1..`routing.repoDepth` segments below a `routing.repoParents` entry and that no `routing.repoExclude` glob matches.
 *
 * Synchronous on purpose: `roleAuthorityDecision` (compat/v2-hooks.ts) is pure and synchronous, so its predicate only uses
 * `lstatSync` / `openSync` / `fstatSync`. A repository top is the nearest ancestor (below the parent, at most `repoDepth` deep)
 * holding a `.git` with git's shape (QA-1 F3): a directory with a `HEAD` file and an `objects` directory or a `commondir` file, or
 * a file (linked worktree, submodule) whose `gitdir:` target holds a `HEAD` file. No link counts (F5): `.git` and `HEAD` are
 * checked with `lstat`, a `HEAD` is read from its opened descriptor only when `fstat` shows a regular file of at most 4 KiB, and a
 * `gitdir:` is followed only when neither its text nor its `realpath` is a UNC or device path (no filesystem call may reach a
 * remote host). Its branch is best effort from `HEAD`: `ref: refs/heads/<x>` → `x` when `x` is a git ref name ("(unknown)"
 * otherwise, F2), anything else → null (detached). Probes are cached 5 s per directory. Without parents and without a working set
 * there is no predicate at all (I9: nothing beyond W).
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { quoteGitPath } from "../../router/git-tools";
import { permissionMatches } from "../../router/read-only";
import type { RepoLocation } from "./admission";
import { insideWorkRoot } from "./work-root";

/**
 * QA-G-A2-2: a path segment that names git's metadata entry `.git` — compared case-insensitively (win32, and stricter
 * elsewhere), with the trailing dots and spaces win32 drops and an NTFS `:stream` suffix removed (`.git.`, `.GIT`,
 * `.git::$INDEX_ALLOCATION` all name `.git` there).
 */
export function gitMetadataSegment(segment: string): boolean {
  return segment.replace(/:.*$/s, "").replace(/[. ]+$/, "").toLowerCase() === ".git";
}

/** A path written fully qualified: `X:\…` / `X:/…` on win32 (never drive- or root-relative), `/…` elsewhere. */
export function fullyQualifiedPath(path: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith("/");
}

/**
 * QA-1 F1/F7: may a path reach R beyond W at all — `path` as the call names it, `target` its canonical form? Only a path written
 * fully qualified (a relative one resolves against the session directory, which may itself be a repository of R: the role would
 * read another checkout's file silently), unless `hostRelative` (the host's own Location-relative form of a path the call's
 * `execute.before` already checked as written); and never `.git` or anything below it (its config can hold a credentialed remote).
 * The decision (`roleAuthorityDecision`) and the read provenance line (index.ts) both use it.
 */
export function readSetEligible(path: string, target: string, hostRelative = false): boolean {
  if (!hostRelative && !fullyQualifiedPath(path)) return false;
  return ![path, target].some((text) => text.split(/[\\/]/).some(gitMetadataSegment));
}

/** C0/C1 controls, format characters (bidi controls, zero-width), line/paragraph separators, unassigned, and `[` `]`. */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\u2028\u2029[\]]/u;

/**
 * QA-1 F2: text from the filesystem (a repository's name, its branch, a path) as it may be echoed into a refusal or a provenance
 * line: unchanged when it holds nothing unsafe, else git's C-style quoting (`quoteGitPath`, every non-ASCII byte octal) with `[`
 * and `]` as `\133` / `\135` too, so it can neither forge a `[router: …]` line nor reorder or hide the text around it.
 */
export function displaySafe(text: string): string {
  if (!UNSAFE_DISPLAY.test(text)) return text;
  // `quoteGitPath` leaves a text with nothing it escapes unquoted (here: brackets only, no `"` or `\`): quote it, so `\133` is
  // always an escape.
  const quoted = quoteGitPath(text, true);
  return (quoted.startsWith('"') ? quoted : `"${quoted}"`).replaceAll("[", "\\133").replaceAll("]", "\\135");
}

/**
 * QA-1 F2: a branch name `git check-ref-format` accepts (`refs/heads/<x>`), restricted further to text without control, format or
 * unassigned characters: no space, `~ ^ : ? * [ \`, `..`, `@{`, `//`; no component starting with `.` or ending with `.lock`;
 * not ending with `/` or `.`; not `@`.
 */
function refName(name: string): boolean {
  if (name === "" || name === "@" || /[\s~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(name) || UNSAFE_DISPLAY.test(name)) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** Where a path of R lies: the repository (its top directory), its name, and its checked-out branch (null: detached or unknown). */
export interface ReadSetRepository {
  readonly repository: string;
  readonly name: string;
  readonly branch: string | null;
}

/** Membership in R beyond W of a CANONICAL target (`canonicalAuthorityPath`); undefined = not in R. */
export type InReadSet = (canonicalTarget: string) => ReadSetRepository | undefined;

/** The resolved `routing.repoParents` / `repoDepth` / `repoExclude`. */
export interface ReadSetConfig {
  readonly parents: readonly string[];
  readonly depth: number;
  readonly exclude: readonly string[];
}

/** How long a `.git` probe or a parent's canonical form is reused, per directory. */
export const READ_SET_CACHE_MS = 5_000;
const CACHE_MAX = 256;
/** `HEAD` and a `.git` file are a line each; anything larger is not read. */
const SMALL_FILE_MAX = 4096;

export interface RepoProbeDeps {
  /** The kind of the entry at `path` itself (`lstat`: a link is never followed, F5); undefined when there is none. */
  entry(path: string): "file" | "directory" | "link" | undefined;
  /**
   * A small regular file's text, read from its opened descriptor (`fstat`: a regular file of at most 4 KiB, F5); undefined when
   * missing, a link, not a regular file, or larger.
   */
  readSmall(path: string): string | undefined;
  /** `realpathSync.native`; undefined when the path does not resolve. */
  realpath(path: string): string | undefined;
  now(): number;
}

export interface RepoProbe {
  /** The repository whose top is `dir` (it holds `.git`), else undefined. Cached 5 s. */
  repositoryAt(dir: string): ReadSetRepository | undefined;
  /** The canonical long form of a `routing.repoParents` entry, else undefined. Cached 5 s. */
  canonicalParent(parent: string): string | undefined;
}

const remote = (path: string): boolean => /^[\\/]{2}/.test(path);

const defaultDeps: RepoProbeDeps = {
  entry: (path) => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
    } catch {
      return undefined;
    }
  },
  readSmall: (path) => {
    let fd: number | undefined;
    try {
      if (!lstatSync(path).isFile()) return undefined; // a link (junction, symlink) or anything but a regular file
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > SMALL_FILE_MAX) return undefined;
      const buffer = Buffer.alloc(stat.size);
      const read = stat.size === 0 ? 0 : readSync(fd, buffer, 0, stat.size, 0);
      return buffer.subarray(0, read).toString("utf8");
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
  },
  realpath: (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
};

/** Shown for a `ref: refs/heads/<x>` whose `x` is not a git ref name (QA-1 F2): never echoed. */
export const UNKNOWN_BRANCH = "(unknown)";

/** `ref: refs/heads/<x>` → `x` when it is a ref name, else "(unknown)"; a detached or unreadable `HEAD` → null. */
function branchOf(head: string | undefined): string | null {
  const line = head?.split(/\r?\n/, 1)[0]?.replace(/^[ \t]+|[ \t]+$/g, "");
  const match = line === undefined ? null : /^ref:[ \t]*refs\/heads\/(.+)$/.exec(line);
  if (match === null) return null;
  return refName(match[1]!) ? match[1]! : UNKNOWN_BRANCH;
}

/** The synchronous, cached filesystem probe behind {@link readSetPredicate} (one per adapter instance). */
export function createRepoProbe(overrides: Partial<RepoProbeDeps> = {}): RepoProbe {
  const deps: RepoProbeDeps = { ...defaultDeps, ...overrides };
  const cache = new Map<string, { readonly at: number; readonly value: unknown }>();
  const keyOf = (kind: string, path: string): string =>
    `${kind}\u0000${process.platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path}`;
  const cached = <T>(key: string, compute: () => T): T => {
    const hit = cache.get(key);
    if (hit !== undefined && deps.now() - hit.at < READ_SET_CACHE_MS) return hit.value as T;
    const value = compute();
    cache.delete(key);
    cache.set(key, { at: deps.now(), value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return value;
  };
  /**
   * QA-1 F3/F5: the git directory of a repository whose top is `dir`, when its `.git` has git's shape and no link on the way — the
   * `.git` directory itself (a `HEAD` file and an `objects` directory or a `commondir` file), or the `gitdir:` target of a `.git`
   * file (canonical, never UNC or a device, holding a `HEAD` file). Undefined: not a repository.
   */
  const gitDirOf = (dir: string): string | undefined => {
    const dotGit = join(dir, ".git");
    const kind = deps.entry(dotGit);
    if (kind === "directory") {
      if (deps.entry(join(dotGit, "HEAD")) !== "file") return undefined;
      return deps.entry(join(dotGit, "objects")) === "directory" || deps.entry(join(dotGit, "commondir")) === "file" ? dotGit : undefined;
    }
    if (kind !== "file") return undefined; // none, or a link (F5)
    const line = deps.readSmall(dotGit)?.split(/\r?\n/, 1)[0]?.trim();
    const gitdir = line === undefined ? undefined : /^gitdir:\s*(.+)$/.exec(line)?.[1];
    if (gitdir === undefined || remote(gitdir)) return undefined;
    const named = resolve(dir, gitdir);
    if (remote(named)) return undefined;
    const target = deps.realpath(named);
    if (target === undefined || remote(target)) return undefined;
    return deps.entry(join(target, "HEAD")) === "file" ? target : undefined;
  };
  return {
    repositoryAt: (dir) => cached(keyOf("repo", dir), () => {
      if (remote(dir)) return undefined;
      const gitDir = gitDirOf(dir);
      if (gitDir === undefined) return undefined;
      return { repository: dir, name: basename(dir), branch: branchOf(deps.readSmall(join(gitDir, "HEAD"))) };
    }),
    canonicalParent: (parent) => cached(keyOf("parent", parent), () => (remote(parent) ? undefined : deps.realpath(parent))),
  };
}

/**
 * P1.5: the membership test of R beyond W, or undefined when R adds nothing (no parents, no working set: I9). A canonical target
 * is in R when it lies inside a working-set worktree, or below a canonical parent inside a repository whose top is its nearest
 * ancestor 1..`depth` segments below that parent, and no directory between that parent and the target — the target included —
 * matches a `routing.repoExclude` glob (QA-1 F4: an excluded repository stays excluded through a repository nested in it; the
 * max policy's matcher: separators unified, win32 case folding).
 */
export function readSetPredicate(config: ReadSetConfig, workingSet: readonly RepoLocation[], probe: RepoProbe): InReadSet | undefined {
  if (config.parents.length === 0 && workingSet.length === 0) return undefined;
  const depth = Math.max(1, Math.floor(config.depth));
  const excluded = (parent: string, segments: readonly string[]): boolean => {
    if (config.exclude.length === 0) return false;
    for (let level = 1; level <= segments.length; level++) {
      const dir = join(parent, ...segments.slice(0, level));
      if (config.exclude.some((glob) => permissionMatches(dir, glob))) return true;
    }
    return false;
  };
  return (target) => {
    if (target === "" || /[*?\0]/.test(target) || remote(target)) return undefined;
    for (const location of workingSet) {
      if (insideWorkRoot(target, location.worktree)) return { repository: location.repository, name: location.name, branch: location.branch };
    }
    for (const text of config.parents) {
      const parent = probe.canonicalParent(text);
      if (parent === undefined || !insideWorkRoot(target, parent)) continue;
      const segments = target.slice(parent.replace(/[\\/]+$/, "").length).split(/[\\/]/).filter((segment) => segment !== "");
      if (excluded(parent, segments)) continue;
      for (let level = Math.min(depth, segments.length); level >= 1; level--) {
        const repository = probe.repositoryAt(join(parent, ...segments.slice(0, level)));
        if (repository !== undefined) return repository;
      }
    }
    return undefined;
  };
}
