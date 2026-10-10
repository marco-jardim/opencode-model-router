/**
 * Admission of work roots across repositories (`docs/design/cross-repo.md` §3 "Admission" and "Names", §5 refusal wording;
 * Phase 1 step P1.2). Decides which directories are admissible work roots and resolves `root=` / `repo=` / `branch=`
 * declarations (declare, then check).
 *
 * A directory is admitted when
 * 1. it lies 1..`repoDepth` segments below a `routing.repoParents` entry (text first, then the canonical form, never the parent
 *    itself), no `routing.repoExclude` glob matches it, and hardened git prints it for `rev-parse --show-toplevel`; or
 * 2. its TEXT equals a worktree that a known repository (the session repository, the working set, the named repository) lists in
 *    `git worktree list --porcelain`, and the repository still lists it after `realpath`.
 *
 * Text is compared before any filesystem call on a path outside the parents: git never runs in a directory that the text did
 * not place below a parent and that no known repository lists. Network and device paths (`\\host`, `//host`, `\\?\`, `\\.\`),
 * 8.3 short-name segments, `..` segments and relative paths are refused before any call at all.
 *
 * All I/O goes through {@link AdmissionDeps}; git results are cached for 5 s per normalised path. Nothing calls this module yet.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { permissionMatches } from "../../router/read-only";
import { gitWorktreeList, normalizeRootText } from "../wire/dispatch";

/** One entry of `git worktree list --porcelain`, as git prints it. */
export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  /** Short branch name (`refs/heads/` stripped); null when detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly prunable: boolean;
}

export interface RepoLocation {
  /** Canonical path of the main worktree (the first porcelain entry). */
  readonly repository: string;
  /** Basename of the main worktree's path: the repository's name. */
  readonly name: string;
  /** Canonical path of the matched worktree: the work root. */
  readonly worktree: string;
  /** The matched worktree's branch; null = detached. */
  readonly branch: string | null;
  readonly head: string | null;
  /** Non-prunable entries, in git's order (the main worktree first). */
  readonly worktrees: readonly WorktreeEntry[];
}

export type Admission = { readonly ok: true; readonly location: RepoLocation } | { readonly ok: false; readonly reason: string };

export interface AdmissionConfig {
  /** `routing.repoParents`: literal, absolute, canonical long-form directories. */
  readonly parents: readonly string[];
  /** `routing.repoDepth`: repositories are admitted 1..depth segments below a parent. */
  readonly depth: number;
  /** `routing.repoExclude`: absolute globs matched against the canonical path of a candidate. */
  readonly exclude: readonly string[];
}

export interface AdmissionDeps {
  /** `git worktree list --porcelain` in `cwd` (hardened); rejects on failure. */
  listWorktrees(cwd: string): Promise<string>;
  /** Hardened `git rev-parse --show-toplevel` in `cwd`; undefined on failure. */
  showToplevel(cwd: string): Promise<string | undefined>;
  /** `realpathSync.native`; throws when the path does not resolve. */
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  /** Names of the directories (not links) in `path`; [] on error. */
  readdir(path: string): string[];
  platform: NodeJS.Platform;
  now(): number;
}

export interface Declaration { readonly repo?: string; readonly branch?: string; readonly root?: string }
export interface DeclarationContext { readonly sessionRepository: string; readonly known?: readonly string[] }

export interface AdmissionService {
  /** Rule 1 (below a parent), then rule 2 (a worktree that a repository in `known` lists). */
  admit(root: string, known?: readonly string[]): Promise<Admission>;
  /** Resolve `root=` / `repo=` / `branch=`; every declaration must agree. */
  resolve(decl: Declaration, ctx: DeclarationContext): Promise<Admission>;
}

/** How long a `show-toplevel` or worktree-list result is reused, per normalised path. */
export const ADMISSION_CACHE_MS = 5_000;
const CACHE_MAX = 256;

/**
 * The entries of `git worktree list --porcelain`: blocks separated by blank lines, the first block the main worktree. Unlike
 * `parseWorktreeList` (dispatch.ts) prunable entries are kept, flagged; `locked` and unknown lines are ignored.
 */
export function parseWorktreeEntries(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; prunable: boolean } | undefined;
  const flush = (): void => {
    if (current !== undefined) out.push({ ...current });
    current = undefined;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      flush();
      const path = line.slice("worktree ".length);
      if (path !== "") current = { path, head: null, branch: null, detached: false, bare: false, prunable: false };
    } else if (current === undefined) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      const head = line.slice("HEAD ".length).trim();
      current.head = head === "" ? null : head;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();
  return out;
}

/**
 * Hardened `git rev-parse --show-toplevel` in `cwd`, as `gitWorktreeList` (dispatch.ts) spawns git: the absolute executable
 * selected outside `workRootGuards(cwd)`, `hardeningArgs()`, the user's `safe.directory` values, `gitEnvironment()`, no shell,
 * bounded to 5 s and 64 KiB. `GIT_CEILING_DIRECTORIES` stops discovery at `cwd`'s parent, so a directory inside a repository
 * never reports that repository. Undefined on any failure.
 */
export async function gitShowToplevel(cwd: string): Promise<string | undefined> {
  try {
    const { gitEnvironment, gitExecutable, hardeningArgs, inheritedSafeDirectoryArgs, spawnBounded, workRootGuards } = await import("../../router/git-tools");
    const started = performance.now();
    const executable = gitExecutable(workRootGuards(cwd));
    const trusted = await inheritedSafeDirectoryArgs(executable, 5_000);
    const above = dirname(cwd);
    const result = await spawnBounded(executable, [...hardeningArgs(), ...trusted, "rev-parse", "--show-toplevel"], cwd, {
      env: gitEnvironment(above === cwd ? {} : { GIT_CEILING_DIRECTORIES: above }),
      timeoutMs: Math.max(1, 5_000 - (performance.now() - started)),
      maxBytes: 64 * 1024,
    });
    if (result.code !== 0 || result.truncated) return undefined;
    const top = result.output.toString("utf8").trim();
    return top === "" ? undefined : top;
  } catch {
    return undefined;
  }
}

export function defaultAdmissionDeps(): AdmissionDeps {
  return {
    listWorktrees: gitWorktreeList,
    showToplevel: gitShowToplevel,
    realpath: (path) => realpathSync.native(path),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    readdir: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    platform: process.platform,
    now: () => Date.now(),
  };
}

/**
 * Why `path` can never be a work root, judged on its text alone (no filesystem call), or undefined: empty, a control
 * character, a network or device path, not absolute (win32: no drive letter), a colon after the drive (a stream or device
 * name), a `..` segment, or an 8.3 short-name segment.
 */
export function rootTextProblem(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const text = path.trim();
  if (text === "") return "is empty";
  if (/[\u0000-\u001f]/.test(text)) return "contains a control character";
  if (/^[\\/]{2}/.test(text)) return "is a network or device path (\\\\host, //host, \\\\?\\ or \\\\.\\); name a local directory";
  const win = platform === "win32";
  if (win) {
    if (!/^[A-Za-z]:[\\/]/.test(text)) return "is not an absolute path with a drive letter";
    if (text.slice(2).includes(":")) return "contains a colon after the drive letter (a stream or device name)";
  } else if (!text.startsWith("/")) {
    return "is not an absolute path";
  }
  const segments = text.split(win ? /[\\/]/ : /\//);
  if (segments.some((segment) => segment === "..")) return "contains a .. segment";
  if (segments.some((segment) => /~\d/.test(segment))) return "contains an 8.3 short-name component; use the long form of the path";
  return undefined;
}

function repoNameProblem(name: string): string | undefined {
  if (name === "") return "is empty";
  if (/[\u0000-\u001f]/.test(name)) return "contains a control character";
  if (/[\\/:]/.test(name) || name === "." || name === "..") return "is not a bare repository name (no separator, drive or . / ..)";
  if (/[*?[\]{}]/.test(name)) return "contains a wildcard";
  if (/~\d/.test(name)) return "contains an 8.3 short-name component; use the long name";
  return undefined;
}

interface CacheEntry<T> { readonly at: number; readonly value: Promise<T> }

export function createAdmission(cfg: AdmissionConfig, deps: AdmissionDeps = defaultAdmissionDeps()): AdmissionService {
  const platform = deps.platform;
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  const paths = win ? win32 : posix;
  const depth = Number.isInteger(cfg.depth) && cfg.depth >= 1 ? cfg.depth : 1;
  const text = (path: string): string => normalizeRootText(path, platform);
  // Parents are sanitised by the config layer; one that is unsafe as text is ignored here as well.
  const parents = cfg.parents.map((parent) => parent.trim()).filter((parent) => rootTextProblem(parent, platform) === undefined);
  const parentList = parents.length === 0 ? "none configured" : parents.join(", ");
  const range = depth === 1 ? "1 level" : `1 to ${String(depth)} levels`;
  const refuse = (reason: string): Admission => ({ ok: false, reason });
  const sameName = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const short = (sha: string | null): string => (sha === null ? "unknown" : sha.slice(0, 7));

  const canonical = (path: string): string | null => {
    try {
      const resolved = deps.realpath(path);
      return typeof resolved === "string" && resolved !== "" ? resolved : null;
    } catch {
      return null;
    }
  };
  /** A git-listed path for messages: its canonical form, or git's text with native separators. */
  const display = (path: string): string => canonical(path) ?? (win ? path.replace(/\//g, "\\") : path);
  const describeEntry = (entry: WorktreeEntry): string =>
    entry.bare ? "bare" : entry.branch !== null ? entry.branch : `detached at ${short(entry.head)}`;
  const listing = (entries: readonly WorktreeEntry[]): string => entries.map((entry) => `${display(entry.path)} → ${describeEntry(entry)}`).join("; ");
  const joinAnd = (items: readonly string[]): string =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
  /** `git`'s path or a canonical one equals `real` (canonical): text first, `realpath` only when the text differs. */
  const samePath = (listed: string, real: string): boolean => {
    if (text(listed) === text(real)) return true;
    const resolved = canonical(listed);
    return resolved !== null && text(resolved) === text(real);
  };
  /** Segments `child` lies below `parent` (both normalised text); 0 = the same; undefined = not below. */
  const levelsBelow = (child: string, parent: string): number | undefined => {
    if (child === parent) return 0;
    const prefix = parent.endsWith(sep) ? parent : parent + sep;
    if (!child.startsWith(prefix)) return undefined;
    const rest = child.slice(prefix.length);
    return rest === "" ? 0 : rest.split(sep).length;
  };
  const excludedBy = (path: string): string | undefined => {
    const input = win ? path.toLowerCase() : path;
    return cfg.exclude.find((pattern) => pattern.trim() !== "" && permissionMatches(input, win ? pattern.toLowerCase() : pattern));
  };
  const unique = (items: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
      const key = text(item);
      if (item.trim() === "" || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  // ── 5 s caches keyed by normalised path ──────────────────────────────────────────────────────────────────────────────
  const toplevels = new Map<string, CacheEntry<string | undefined>>();
  const lists = new Map<string, CacheEntry<string>>();
  const cached = <T>(cache: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    const now = deps.now();
    const hit = cache.get(key);
    if (hit !== undefined && now >= hit.at && now - hit.at < ADMISSION_CACHE_MS) return hit.value;
    let value: Promise<T>;
    try {
      value = load();
    } catch (error) {
      value = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    cache.delete(key);
    cache.set(key, { at: now, value });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    // A failure is not reused.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  };
  const toplevel = (cwd: string): Promise<string | undefined> =>
    cached(toplevels, text(cwd), async () => {
      try {
        return await deps.showToplevel(cwd);
      } catch {
        return undefined;
      }
    });
  const worktrees = async (cwd: string): Promise<WorktreeEntry[]> =>
    parseWorktreeEntries(await cached(lists, text(cwd), () => deps.listWorktrees(cwd)));

  /** Whether hardened git prints `real` (canonical) as the top level of the repository in `real`. */
  const isToplevel = async (real: string): Promise<boolean> => {
    const top = (await toplevel(real))?.trim();
    return top !== undefined && top !== "" && samePath(top, real);
  };

  /** The location of the canonical work root `real`, from the worktree list run in `listFrom`. */
  const locate = async (shown: string, real: string, listFrom: string): Promise<Admission> => {
    let entries: WorktreeEntry[];
    try {
      entries = await worktrees(listFrom);
    } catch {
      return refuse(`root=${shown}: git worktree list failed in ${listFrom}: no work root.`);
    }
    const main = entries[0];
    const repository = main === undefined ? null : canonical(main.path);
    if (main === undefined || repository === null) return refuse(`root=${shown}: the main worktree of its repository does not resolve: no work root.`);
    const live = entries.filter((entry) => !entry.prunable);
    const matched = live.find((entry) => text(entry.path) === text(real)) ?? live.find((entry) => samePath(entry.path, real));
    if (matched === undefined) return refuse(`root=${shown} is not listed by git worktree list of ${repository}: no work root.`);
    return {
      ok: true,
      location: { repository, name: paths.basename(repository), worktree: real, branch: matched.branch, head: matched.head, worktrees: live },
    };
  };

  /** Rule 1 for `shown`, already placed 1..depth below `parent` by its text. */
  const belowParent = async (shown: string, parent: string): Promise<Admission> => {
    const textExcluded = excludedBy(shown);
    if (textExcluded !== undefined) return refuse(`root=${shown} is excluded by routing.repoExclude (${textExcluded}): no work root.`);
    const realParent = canonical(parent);
    if (realParent === null) return refuse(`root=${shown}: the routing.repoParents entry ${parent} does not resolve: no work root.`);
    if (!deps.isDirectory(shown)) return refuse(`root=${shown} is not a directory: no work root.`);
    const real = canonical(shown);
    if (real === null) return refuse(`root=${shown} does not resolve: no work root.`);
    const levels = levelsBelow(text(real), text(realParent));
    if (levels === undefined || levels === 0) return refuse(`root=${shown} leads outside ${parent} through a link (it resolves to ${real}): no work root.`);
    const excluded = excludedBy(real);
    if (excluded !== undefined) return refuse(`root=${shown} is excluded by routing.repoExclude (${excluded}): no work root.`);
    if (!(await isToplevel(real))) return refuse(`root=${shown} is not the top level of a git repository: no work root.`);
    return locate(shown, real, real);
  };

  /** Rule 1: undefined when the text lies below no parent. */
  const ruleOne = async (shown: string): Promise<Admission | undefined> => {
    const rootText = text(shown);
    let first: Admission | undefined;
    for (const parent of parents) {
      const levels = levelsBelow(rootText, text(parent));
      if (levels === undefined) continue;
      let result: Admission;
      if (levels === 0) result = refuse(`root=${shown} is itself a parent in routing.repoParents; repositories are admitted ${range} below a parent: no work root.`);
      else if (levels > depth) result = refuse(`root=${shown} is ${String(levels)} levels below ${parent}; repositories are admitted ${range} below a parent (routing.repoDepth).`);
      else result = await belowParent(shown, parent);
      if (result.ok) return result;
      first ??= result;
    }
    return first;
  };

  /** Rule 2: undefined when no repository in `known` lists `shown` as text. */
  const ruleTwo = async (shown: string, known: readonly string[]): Promise<Admission | undefined> => {
    const rootText = text(shown);
    for (const repo of unique(known)) {
      if (rootTextProblem(repo, platform) !== undefined) continue;
      let entries: WorktreeEntry[];
      try {
        entries = await worktrees(repo);
      } catch {
        continue;
      }
      const hit = entries.find((entry) => !entry.prunable && !entry.bare && text(entry.path) === rootText);
      if (hit === undefined) continue;
      // Only now, on a text match: the filesystem, then git.
      const main = entries[0];
      const repository = main === undefined ? null : canonical(main.path);
      if (repository === null) return refuse(`root=${shown}: the main worktree of the repository that lists it does not resolve: no work root.`);
      const real = canonical(shown);
      if (real === null) return refuse(`root=${shown} is a worktree of ${repository} but does not resolve: no work root.`);
      let again: WorktreeEntry[];
      try {
        again = await worktrees(repository);
      } catch {
        return refuse(`root=${shown}: git worktree list failed in ${repository}: no work root.`);
      }
      if (!again.some((entry) => !entry.prunable && !entry.bare && samePath(entry.path, real))) {
        return refuse(`root=${shown} is no longer a worktree of ${repository}: no work root.`);
      }
      if (!(await isToplevel(real))) return refuse(`root=${shown} is not the top level of a git repository: no work root.`);
      return locate(shown, real, repository);
    }
    return undefined;
  };

  const admit = async (root: string, known: readonly string[] = []): Promise<Admission> => {
    const shown = root.trim();
    const problem = rootTextProblem(shown, platform);
    if (problem !== undefined) return refuse(`root=${shown} ${problem}: no work root.`);
    const one = await ruleOne(shown);
    if (one?.ok === true) return one;
    const two = await ruleTwo(shown, known);
    if (two !== undefined) return two;
    if (one !== undefined) return one;
    const hint = parents[0] === undefined ? "" : ` Clone it or add a worktree below ${parents[0]}.`;
    return refuse(`root=${shown} is not below routing.repoParents (${parentList}) and is not a worktree of a repository in this session: no work root.${hint}`);
  };

  /** `repo=X`: `<parent>\X`, then `<parent>\*\X` while the depth allows (one listing per level); admitted by rule 1, named X. */
  const lookup = async (name: string): Promise<{ found: RepoLocation[]; refused: string[]; searched: string[] }> => {
    const found: RepoLocation[] = [];
    const refused: string[] = [];
    const searched: string[] = [];
    const seen = new Set<string>();
    for (const parent of parents) {
      let frontier = [parent];
      for (let level = 1; level <= depth; level++) {
        searched.push(paths.join(parent, ...Array.from({ length: level - 1 }, () => "*"), name));
        for (const dir of frontier) {
          const candidate = paths.join(dir, name);
          if (!deps.isDirectory(candidate)) continue;
          const result = await ruleOne(candidate);
          if (result === undefined) continue;
          if (!result.ok) {
            refused.push(result.reason);
            continue;
          }
          if (!sameName(result.location.name, name)) continue;
          const key = text(result.location.repository);
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(result.location);
        }
        if (level === depth) break;
        frontier = frontier.flatMap((dir) => deps.readdir(dir).map((child) => paths.join(dir, child)));
      }
    }
    return { found, refused, searched };
  };

  /** The worktree of a repository (`worktrees`, git's order) for `branch`, or the only one. */
  const pick = async (label: string, view: { readonly repository: string; readonly name: string; readonly worktrees: readonly WorktreeEntry[] }, branch: string | undefined, known: readonly string[]): Promise<Admission> => {
    const usable = view.worktrees.filter((entry) => !entry.bare && !entry.prunable);
    const knownHere = unique([...known, view.repository]);
    if (branch !== undefined) {
      const on = usable.find((entry) => entry.branch === branch);
      if (on === undefined) {
        return refuse(`${label} branch=${branch}: no worktree of ${view.name} is on ${branch} (${listing(usable)}): no work root. Add a worktree on ${branch}, or name one with root="<path>".`);
      }
      return admit(on.path, knownHere);
    }
    if (usable.length === 0) return refuse(`${label}: ${view.name} has no worktree: no work root.`);
    if (usable.length > 1) {
      return refuse(`${label} has ${String(usable.length)} worktrees: ${listing(usable)}: no work root. Add branch=<name>, or name one with root="<path>".`);
    }
    return admit(usable[0]?.path ?? view.repository, knownHere);
  };

  const branchMismatch = (shown: string, location: RepoLocation, branch: string): string => {
    const state = location.branch !== null ? `on ${location.branch} (HEAD ${short(location.head)})` : `detached at ${short(location.head)}`;
    const on = location.worktrees.find((entry) => !entry.bare && entry.branch === branch);
    const hint = on !== undefined
      ? ` The worktree on ${branch} is ${display(on.path)} — use repo=${location.name} branch=${branch}.`
      : ` No worktree of ${location.name} is on ${branch} (${listing(location.worktrees.filter((entry) => !entry.bare))}).`;
    return `root=${shown} declares branch=${branch}, but that worktree is ${state}: no work root.${hint}`;
  };

  const resolve = async (decl: Declaration, ctx: DeclarationContext): Promise<Admission> => {
    const root = decl.root?.trim() || undefined;
    const repo = decl.repo?.trim() || undefined;
    const rawBranch = decl.branch?.trim() || undefined;
    const branch = rawBranch?.startsWith("refs/heads/") === true ? rawBranch.slice("refs/heads/".length) : rawBranch;
    if (root === undefined && repo === undefined && branch === undefined) return refuse("no root=, repo= or branch= was declared: no work root.");
    if (root !== undefined) {
      const problem = rootTextProblem(root, platform);
      if (problem !== undefined) return refuse(`root=${root} ${problem}: no work root.`);
    }
    if (repo !== undefined) {
      const problem = repoNameProblem(repo);
      if (problem !== undefined) return refuse(`repo=${repo} ${problem}: no work root.`);
    }
    if (branch !== undefined && (branch === "" || /[\u0000-\u001f]/.test(branch))) return refuse(`branch=${rawBranch ?? ""} is not a branch name: no work root.`);
    const known = unique([ctx.sessionRepository, ...(ctx.known ?? [])]);

    if (root !== undefined) {
      // The named repository joins the known ones, so a worktree of it outside the parents is admitted (rule 2).
      const named = repo === undefined ? [] : (await lookup(repo)).found;
      const admitted = await admit(root, unique([...known, ...named.map((location) => location.repository)]));
      if (!admitted.ok) return admitted;
      const location = admitted.location;
      if (repo !== undefined && !sameName(location.name, repo)) {
        const hint = named.length === 1
          ? ` The repository ${repo} is ${named[0]?.repository ?? ""} — use repo=${repo}${branch === undefined ? "" : ` branch=${branch}`}.`
          : ` Use repo=${location.name}, or name a worktree of ${repo} with root="<path>".`;
        return refuse(`root=${root} declares repo=${repo}, but that worktree belongs to repo=${location.name} (${location.repository}): no work root.${hint}`);
      }
      if (branch !== undefined && location.branch !== branch) return refuse(branchMismatch(root, location, branch));
      return admitted;
    }

    if (repo !== undefined) {
      const { found, refused, searched } = await lookup(repo);
      if (found.length === 0) {
        const notes = refused.length === 0 ? "" : ` ${refused.join(" ")}`;
        return refuse(`repo=${repo} matches no repository below routing.repoParents (searched ${searched.length === 0 ? "nothing: none configured" : searched.join(", ")}): no work root.${notes}`);
      }
      if (found.length > 1) {
        return refuse(`repo=${repo} matches ${String(found.length)} repositories: ${joinAnd(found.map((location) => location.repository))}: no work root. Name one with root="<path>".`);
      }
      const [location] = found;
      if (location === undefined) return refuse(`repo=${repo}: no work root.`);
      return pick(`repo=${repo}`, location, branch, known);
    }

    // branch= alone: the session repository's worktree on that branch.
    let entries: WorktreeEntry[];
    try {
      entries = await worktrees(ctx.sessionRepository);
    } catch {
      return refuse(`branch=${branch ?? ""}: git worktree list failed in the session repository ${ctx.sessionRepository}: no work root.`);
    }
    const main = entries[0];
    const repository = main === undefined ? null : canonical(main.path);
    if (repository === null) return refuse(`branch=${branch ?? ""}: the session repository ${ctx.sessionRepository} does not resolve: no work root.`);
    const view = { repository, name: paths.basename(repository), worktrees: entries.filter((entry) => !entry.prunable) };
    return pick(`repo=${view.name}`, view, branch, known);
  };

  return { admit, resolve };
}
