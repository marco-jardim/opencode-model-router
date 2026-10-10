/**
 * The read set R of a role dispatch beyond its work root W (`docs/design/cross-repo.md` §1 "R, read set", Phase 1 step P1.5):
 * the worktrees of the orchestrator session's working set (P1.4), and every directory inside a repository whose top lies
 * 1..`routing.repoDepth` segments below a `routing.repoParents` entry and that no `routing.repoExclude` glob matches.
 *
 * Synchronous on purpose: `roleAuthorityDecision` (compat/v2-hooks.ts) is pure and synchronous, so its predicate only uses
 * `statSync` / `readFileSync`. A repository top is the nearest ancestor (below the parent, at most `repoDepth` deep) holding a
 * `.git` entry — a directory, or a file for a linked worktree or a submodule. Its branch is best effort from `HEAD`
 * (`ref: refs/heads/<x>` → `x`, anything else → null), following a `.git` file's `gitdir:`, never to a UNC or device path (no
 * filesystem call may reach a remote host). Probes are cached 5 s per directory. Without parents and without a working set there
 * is no predicate at all (I9: nothing beyond W).
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { permissionMatches } from "../../router/read-only";
import type { RepoLocation } from "./admission";
import { insideWorkRoot } from "./work-root";

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
  /** The kind of the entry at `path` (links followed); undefined when there is none. */
  entry(path: string): "file" | "directory" | undefined;
  /** A small regular file's text; undefined when missing, not a regular file, or larger than 4 KiB. */
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
      const stat = statSync(path);
      return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
    } catch {
      return undefined;
    }
  },
  readSmall: (path) => {
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size <= SMALL_FILE_MAX ? readFileSync(path, "utf8") : undefined;
    } catch {
      return undefined;
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

/** `ref: refs/heads/<x>` → `x`; a detached or unreadable `HEAD` → null. */
function branchOf(head: string | undefined): string | null {
  const line = head?.split(/\r?\n/, 1)[0]?.trim();
  const match = line === undefined ? null : /^ref:\s*refs\/heads\/(\S+)$/.exec(line);
  return match?.[1] ?? null;
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
  const headOf = (dir: string, kind: "file" | "directory"): string | undefined => {
    const dotGit = join(dir, ".git");
    if (kind === "directory") return deps.readSmall(join(dotGit, "HEAD"));
    const line = deps.readSmall(dotGit)?.split(/\r?\n/, 1)[0]?.trim();
    const gitdir = line === undefined ? undefined : /^gitdir:\s*(.+)$/.exec(line)?.[1];
    if (gitdir === undefined || remote(gitdir)) return undefined;
    const target = resolve(dir, gitdir);
    return remote(target) ? undefined : deps.readSmall(join(target, "HEAD"));
  };
  return {
    repositoryAt: (dir) => cached(keyOf("repo", dir), () => {
      if (remote(dir)) return undefined;
      const kind = deps.entry(join(dir, ".git"));
      if (kind === undefined) return undefined;
      return { repository: dir, name: basename(dir), branch: branchOf(headOf(dir, kind)) };
    }),
    canonicalParent: (parent) => cached(keyOf("parent", parent), () => (remote(parent) ? undefined : deps.realpath(parent))),
  };
}

/**
 * P1.5: the membership test of R beyond W, or undefined when R adds nothing (no parents, no working set: I9). A canonical target
 * is in R when it lies inside a working-set worktree, or below a canonical parent inside a repository whose top is its nearest
 * ancestor 1..`depth` segments below that parent, neither that top nor the target matching a `routing.repoExclude` glob (the
 * max policy's matcher: separators unified, win32 case folding).
 */
export function readSetPredicate(config: ReadSetConfig, workingSet: readonly RepoLocation[], probe: RepoProbe): InReadSet | undefined {
  if (config.parents.length === 0 && workingSet.length === 0) return undefined;
  const depth = Math.max(1, Math.floor(config.depth));
  const excluded = (dir: string, target: string): boolean =>
    config.exclude.some((glob) => permissionMatches(dir, glob) || permissionMatches(target, glob));
  return (target) => {
    if (target === "" || /[*?\0]/.test(target) || remote(target)) return undefined;
    for (const location of workingSet) {
      if (insideWorkRoot(target, location.worktree)) return { repository: location.repository, name: location.name, branch: location.branch };
    }
    for (const text of config.parents) {
      const parent = probe.canonicalParent(text);
      if (parent === undefined || !insideWorkRoot(target, parent)) continue;
      const segments = target.slice(parent.replace(/[\\/]+$/, "").length).split(/[\\/]/).filter((segment) => segment !== "");
      for (let level = Math.min(depth, segments.length); level >= 1; level--) {
        const dir = join(parent, ...segments.slice(0, level));
        const repository = probe.repositoryAt(dir);
        if (repository === undefined) continue;
        if (excluded(dir, target)) break;
        return repository;
      }
    }
    return undefined;
  };
}
