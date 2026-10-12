/**
 * src/verify/perimeter.ts
 *
 * Cross-repo P1.8 (docs/design/cross-repo.md, invariants I4, I8, I13): the verification perimeter P of a role dispatch. P is W's
 * repository (the dispatch's verification root), plus the working-set worktrees of the orchestrator session other than W, plus
 * the admitted repositories W links to (package links in W's top-level `node_modules` whose real path is outside W and is not a
 * package store). P is fixed when the dispatch starts (I13): the store snapshots each extra root next to the change baseline
 * (dispatch.ts beginDispatch), and the wiring snapshots it again at the gate (wiring.ts observeChange).
 *
 * Inert by default (I9): only a routed role dispatch whose grant has a location (cross-repo admission bound it), or whose
 * orchestrator session's working set holds a root other than W, or (I13, QA round 2) with `routing.repoParents` set, can have a
 * perimeter; every other dispatch plans none, so nothing else is snapshotted and no reason changes.
 *
 * Link targets (QA round 1, I11, I12), all without running git:
 * - a link whose real path is neither below a `routing.repoParents` entry nor inside a working-set worktree is not in P, but is
 *   kept as an "unadmitted" root named by its basename (I8, I12; QA round 2), never dropped;
 * - otherwise its repository's top level is found by walking up to the nearest `.git` entry (F3), and links are de-duplicated
 *   by top level, so several links into one monorepo are one root and one snapshot;
 * - a top level is admitted when it lies 1..`routing.repoDepth` segments below a parent and no `routing.repoExclude` glob
 *   matches it or a directory between the parent and it, or when it is a working-set worktree (F4). A top level that is not
 *   admitted, or a link target that is not in a git repository, is kept as an "unadmitted" root: never snapshotted, and named in
 *   I8 as not observed;
 * - P holds at most PERIMETER_MAX snapshotted roots, W included; the roots beyond are kept as "unobserved" roots, never dropped
 *   (F2), so the gate refuses a dispatch that ran unattributable writers.
 */
import { type Dirent, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import { permissionMatches } from "../router/read-only";
import { routedRoleOf } from "../routing/wire/dispatch";
import { workingSetOf } from "../routing/wire/working-set";
import type { DispatchPerimeter, PerimeterSeed } from "./dispatch";
import { depthBelow, gitTopOf, perimeterKey } from "./git-top";
import { isStoreLikeLink } from "./reference";

/** P holds at most this many snapshotted roots, W included. */
export const PERIMETER_MAX = 16;

/** What link admission needs: `routing.repoParents`, `routing.repoDepth` and `routing.repoExclude`. */
export interface PerimeterAdmission {
  readonly parents: readonly string[];
  readonly depth: number;
  /** `routing.repoExclude`: absolute globs (the max policy's matcher, `permissionMatches`). Absent: none. */
  readonly exclude?: readonly string[];
}

/** A comparison key (moved to `git-top.ts` with `gitTopOf`; re-exported for existing importers). */
export { perimeterKey };

function insideOrEqual(child: string, parent: string): boolean {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function canonical(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The package entries of `<w>/node_modules`: the top level, and one level under `@scope`. Dot-entries are tool state. */
function packageEntries(w: string): string[] {
  const modules = path.join(w, "node_modules");
  const entries: string[] = [];
  for (const name of readNames(modules)) {
    if (name.startsWith(".")) continue;
    const full = path.join(modules, name);
    if (!name.startsWith("@")) {
      entries.push(full);
      continue;
    }
    for (const sub of readNames(full)) if (!sub.startsWith(".")) entries.push(path.join(full, sub));
  }
  return entries;
}

/**
 * QA-1 #3: a link's text naming a UNC share or a device path (`\\server\share`, `\\?\…`, `//server/share`). Such a target is
 * never resolved (no `realpath` on it, so no network access from the gate or the store): the link is skipped, as unreadable.
 */
export function isUncLinkText(text: string): boolean {
  return /^[\\/]{2}/.test(text);
}

/** The link primitives `linkedTargets` uses; injectable for tests (QA-1 #3). */
export interface LinkIO {
  readonly lstat: (p: string) => { isSymbolicLink(): boolean };
  readonly readlink: (p: string) => string;
  readonly realpath: (p: string) => string;
}

const defaultLinkIO: LinkIO = {
  lstat: (p) => lstatSync(p),
  readlink: (p) => readlinkSync(p),
  realpath: (p) => realpathSync.native(p),
};

/** The real paths of W's package links (symlinks, junctions) that point outside W and are not store-like, de-duplicated. */
export function linkedTargets(w: string, io: LinkIO = defaultLinkIO): string[] {
  const targets = new Map<string, string>();
  for (const entry of packageEntries(w)) {
    let real: string;
    try {
      if (!io.lstat(entry).isSymbolicLink()) continue;
      // QA-1 #3: the link text first; a UNC or device target is never realpath'ed (not admitted, as an unreadable link).
      if (isUncLinkText(io.readlink(entry))) continue;
      real = io.realpath(entry);
    } catch {
      continue; // Unreadable or dangling: it loads nothing.
    }
    if (insideOrEqual(real, w) || insideOrEqual(w, real) || isStoreLikeLink(real, process.platform)) continue;
    if (!targets.has(perimeterKey(real))) targets.set(perimeterKey(real), real);
  }
  return [...targets.values()];
}

/** Cross-repo P3a: the link primitives `crossLinkAliases` uses; injectable for tests. */
export interface AliasIO extends LinkIO {
  /** The JS (not native) realpath: on win32 it keeps a junction's stored target text, the spelling vite uses (spike C4). */
  readonly jsRealpath: (p: string) => string;
}

const defaultAliasIO: AliasIO = { ...defaultLinkIO, jsRealpath: (p) => realpathSync(p) };

/** `packageEntries`, bounded: at most `max` entries (top level and `@scope/*`), in directory order. */
function boundedPackageEntries(dir: string, max: number): string[] {
  const modules = path.join(dir, "node_modules");
  const entries: string[] = [];
  for (const name of readNames(modules)) {
    if (entries.length >= max) break;
    if (name.startsWith(".")) continue;
    const full = path.join(modules, name);
    if (!name.startsWith("@")) {
      entries.push(full);
      continue;
    }
    for (const sub of readNames(full)) {
      if (entries.length >= max) break;
      if (!sub.startsWith(".")) entries.push(path.join(full, sub));
    }
  }
  return entries;
}

/**
 * Cross-repo P3a (SD-P3a-2 amended by the spike): W's top as a consumer's package links spell it. For each link in
 * `<consumer>/node_modules` (top level and `@scope/*`) whose native real path lies inside W, the JS `fs.realpathSync` of the link
 * (it keeps a junction's stored target text, the id vite gives the module), walked up to W's top when the link targets a
 * directory below it. Never a `node_modules` spelling. Bounded (CONSUMER_READ_MAX entries, CONSUMER_SCAN_MAX links) and
 * fail-soft: an unreadable link is skipped, any other error gives what was found so far (the zero guard is the backstop).
 */
export function crossLinkAliases(consumer: string, w: string, io: AliasIO = defaultAliasIO): string[] {
  const aliases: string[] = [];
  let realW: string;
  try {
    realW = io.realpath(w);
  } catch {
    return aliases;
  }
  let links = 0;
  for (const entry of boundedPackageEntries(consumer, CONSUMER_READ_MAX)) {
    try {
      if (!io.lstat(entry).isSymbolicLink()) continue;
      if (++links > CONSUMER_SCAN_MAX) break;
      if (isUncLinkText(io.readlink(entry))) continue;
      const real = io.realpath(entry);
      if (!insideOrEqual(real, realW)) continue;
      const rel = path.relative(realW, real);
      const up = rel === "" ? [] : rel.split(/[\\/]+/).filter(segment => segment !== "").map(() => "..");
      const alias = path.resolve(io.jsRealpath(entry), ...up);
      if (alias.split(/[\\/]+/).includes("node_modules")) continue;
      if (!aliases.includes(alias)) aliases.push(alias);
    } catch {
      continue; // Unreadable or dangling: it spells nothing.
    }
  }
  return aliases;
}

/** Cross-repo P2b.3: one working-set worktree whose `node_modules` links into W. */
export interface PerimeterConsumer {
  readonly root: string;
  readonly name?: string;
  /** The link, relative to `<root>/node_modules` (for example `lib` or `@scope/lib`), "/" separated. */
  readonly entry: string;
}

/** Cross-repo P2b.3: the bound on `node_modules` LINK entries checked by `discoverConsumers`, per root (QA-1 #2, M2: plain entries are free). */
export const CONSUMER_SCAN_MAX = 2000;

/** Cross-repo M2: the hard bound on all `node_modules` entries (links or not) read per root; past it the root is incomplete. */
export const CONSUMER_READ_MAX = 20000;

/** Cross-repo QA-1 #2: the bound on W's package names looked up directly (W's own, plus its workspace packages'). */
export const CONSUMER_NAMES_MAX = 64;

/** Cross-repo QA-1 #2: the bound on the workspace `package.json` files read to learn W's package names. */
const WORKSPACE_MANIFESTS_MAX = 256;

/** A `package.json` larger than this is not read for names. */
const MANIFEST_BYTES_MAX = 1024 * 1024;

/** A package name usable as a `node_modules` path: `name` or `@scope/name`, no dot-leading segment, no separators besides one "/". */
const PACKAGE_NAME = /^(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*$/i;

/** One working-set root handed to `discoverConsumers`. */
export interface ConsumerRoot {
  readonly root: string;
  readonly name?: string;
}

/** Cross-repo QA-1 #2/#13: what `discoverConsumers` found, and the roots it could not finish (budget or deadline). */
export interface ConsumerDiscovery {
  readonly consumers: PerimeterConsumer[];
  readonly incomplete: ConsumerRoot[];
}

async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path.join(dir, "package.json"), "utf8");
    if (text.length > MANIFEST_BYTES_MAX) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function workspacePatterns(manifest: Record<string, unknown>): string[] {
  const field = manifest.workspaces;
  const packages = typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as { packages?: unknown }).packages
    : field;
  return Array.isArray(packages) ? packages.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The directories of one `workspaces` pattern, inside W only: literal segments, and a wildcard (`*`, `**`) in the last segment
 * only, matched one level deep. Negations, absolute paths, `..` and inner wildcards give none. At most `limit` directories.
 */
async function workspaceDirs(w: string, pattern: string, limit: number): Promise<string[]> {
  if (pattern.startsWith("!") || path.isAbsolute(pattern) || /^[\\/]/.test(pattern)) return [];
  const segments = pattern.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return [];
  const last = segments[segments.length - 1] ?? "";
  const head = segments.slice(0, -1);
  if (head.some((segment) => segment.includes("*"))) return [];
  if (!last.includes("*")) return [path.join(w, ...segments)];
  const escaped = last.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(`^${escaped.join("[^/\\\\]*")}$`, process.platform === "win32" ? "i" : "");
  const base = path.join(w, ...head);
  let children: string[];
  try {
    children = await readdir(base);
  } catch {
    return [];
  }
  return children
    .filter((child) => !child.startsWith(".") && child !== "node_modules" && match.test(child))
    .slice(0, limit)
    .map((child) => path.join(base, child));
}

/**
 * Cross-repo QA-1 #2: W's package names, looked up directly in each root's `node_modules`: the `name` of `<W>/package.json`
 * and, when W is a workspace root, the `name` of each workspace package its `workspaces` lists. Bounded (CONSUMER_NAMES_MAX
 * names, WORKSPACE_MANIFESTS_MAX manifests); `stop` ends the reading early (the deadline).
 */
async function packageNamesOf(w: string, stop: () => boolean): Promise<string[]> {
  const names = new Set<string>();
  const take = (manifest: Record<string, unknown> | undefined): void => {
    const name = manifest?.name;
    if (typeof name === "string" && PACKAGE_NAME.test(name) && names.size < CONSUMER_NAMES_MAX) names.add(name);
  };
  const manifest = await readManifest(w);
  if (manifest === undefined) return [];
  take(manifest);
  let read = 0;
  for (const pattern of workspacePatterns(manifest)) {
    if (stop() || names.size >= CONSUMER_NAMES_MAX || read >= WORKSPACE_MANIFESTS_MAX) break;
    for (const dir of await workspaceDirs(w, pattern, WORKSPACE_MANIFESTS_MAX - read)) {
      if (stop() || names.size >= CONSUMER_NAMES_MAX || read >= WORKSPACE_MANIFESTS_MAX) break;
      read += 1;
      take(await readManifest(dir));
    }
  }
  return [...names];
}

/**
 * Cross-repo P2b.3 (docs/design/cross-repo.md §6, consumer discovery): the roots among `roots` whose `node_modules` hold a
 * link whose real path is inside W or W itself. Only the given roots are read; async fs, no git; never throws. Per root
 * (QA-1 #2): first a direct lookup of each of W's package names (`<root>/node_modules/<name>`, scoped names included; one
 * lookup per name, outside the budget), then a scan of the entries `packageEntries` reads, spending at most `opts.maxEntries`
 * (default CONSUMER_SCAN_MAX) on link entries and reading at most `opts.maxRead` (default CONSUMER_READ_MAX) entries per root
 * (QA-2 M2). A root whose scan stops on either bound without finding a consumer is incomplete; so is
 * every root not finished when `opts.signal` aborts (QA-1 #13, the gate deadline). A link whose text names a UNC or device
 * path is never resolved (QA-1 #3). One entry per consumer (the first link found); both lists follow the order of `roots`.
 */
export async function discoverConsumers(
  w: string,
  roots: readonly ConsumerRoot[],
  opts?: { maxEntries?: number; maxRead?: number; signal?: AbortSignal },
): Promise<ConsumerDiscovery> {
  const maxEntries = Math.max(0, Math.floor(opts?.maxEntries ?? CONSUMER_SCAN_MAX));
  const readMax = Math.max(0, Math.floor(opts?.maxRead ?? CONSUMER_READ_MAX));
  const signal = opts?.signal;
  const stopped = (): boolean => signal?.aborted === true;
  // Per root, by index: a consumer's entry, "incomplete", "none"; unset while the root is not finished.
  // W (or a root around it) is never scanned, so never incomplete either: settled before any fs call, by text.
  const outcomes: (string | { readonly incomplete: true } | null | undefined)[] = roots.map(({ root }) =>
    (insideOrEqual(root, w) || insideOrEqual(w, root) ? null : undefined));
  const assemble = (): ConsumerDiscovery => {
    const consumers: PerimeterConsumer[] = [];
    const incomplete: ConsumerRoot[] = [];
    roots.forEach(({ root, name }, index) => {
      const outcome = outcomes[index];
      const named = name !== undefined ? { name } : {};
      if (typeof outcome === "string") consumers.push({ root, ...named, entry: outcome });
      else if (outcome !== null) incomplete.push({ root, ...named });
    });
    return { consumers, incomplete };
  };
  const work = async (): Promise<void> => {
    // Link targets are real paths: W is matched as given and as its real path (a junction or 8.3 spelling of W).
    const wReal = await realpath(w).catch(() => w);
    const inW = (dir: string): boolean => insideOrEqual(dir, w) || insideOrEqual(dir, wReal);
    const linksIntoW = async (full: string): Promise<boolean> => {
      try {
        if (!(await lstat(full)).isSymbolicLink()) return false;
        if (isUncLinkText(await readlink(full))) return false; // QA-1 #3: never resolved.
        const real = await realpath(full);
        return inW(real) && !isStoreLikeLink(real, process.platform);
      } catch {
        return false; // Unreadable or dangling: it loads nothing.
      }
    };
    const entries = async (dir: string): Promise<Dirent[]> => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    const wNames = await packageNamesOf(w, stopped);
    for (const [index, { root }] of roots.entries()) {
      if (outcomes[index] === null) continue;
      if (inW(root) || insideOrEqual(w, root) || insideOrEqual(wReal, root)) {
        outcomes[index] = null;
        continue;
      }
      if (stopped()) return;
      const modules = path.join(root, "node_modules");
      let found: string | undefined;
      // (a) The direct lookup: one per name, outside the budget.
      for (const name of wNames) {
        if (stopped()) return;
        if (await linksIntoW(path.join(modules, ...name.split("/")))) {
          found = name;
          break;
        }
      }
      // (b) The bounded scan, its budget per root.
      // Only link entries spend `budget` (M2); every entry read counts toward the hard `readMax` cap.
      let budget = maxEntries;
      let read = 0;
      let exhausted = false;
      const check = async (full: string, entry: string, dirent: Dirent): Promise<void> => {
        if (found !== undefined || exhausted) return;
        read += 1;
        if (read > readMax) {
          exhausted = true;
          return;
        }
        // A plain directory or file is no link: free. A type the fs did not report is checked by lstat, like a link.
        if (!dirent.isSymbolicLink() && (dirent.isDirectory() || dirent.isFile())) return;
        if (budget <= 0) {
          exhausted = true;
          return;
        }
        budget -= 1;
        if (await linksIntoW(full)) found = entry;
      };
      if (found === undefined) {
        for (const top of await entries(modules)) {
          if (stopped()) return;
          if (found !== undefined || exhausted) break;
          if (top.name.startsWith(".")) continue;
          if (!top.name.startsWith("@")) {
            await check(path.join(modules, top.name), top.name, top);
            continue;
          }
          read += 1;
          if (read > readMax) {
            exhausted = true;
            break;
          }
          for (const sub of await entries(path.join(modules, top.name))) {
            if (stopped()) return;
            if (found !== undefined || exhausted) break;
            if (sub.name.startsWith(".")) continue;
            await check(path.join(modules, top.name, sub.name), `${top.name}/${sub.name}`, sub);
          }
        }
      }
      // (c) Stopped on the budget without a consumer: incomplete.
      outcomes[index] = found !== undefined ? found : exhausted ? { incomplete: true } : null;
    }
  };
  if (signal === undefined) {
    await work().catch(() => undefined);
    return assemble();
  }
  if (signal.aborted) return assemble();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work().catch(() => undefined), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  return assemble();
}

/** QA-1 F11: the git common directory of the repository whose top level is `top`, read without git; undefined when unknown. */
function commonDirOf(top: string | undefined): string | undefined {
  if (top === undefined) return undefined;
  const dotGit = path.join(top, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return perimeterKey(canonical(dotGit));
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8").slice(0, 4096))?.[1];
    if (named === undefined) return undefined;
    const gitDir = path.resolve(top, named);
    let common = gitDir;
    try {
      common = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // No `commondir`: a submodule's (or a relocated) git directory is its own common directory.
    }
    return perimeterKey(canonical(common));
  } catch {
    return undefined;
  }
}

/**
 * The perimeter beyond W of the dispatch `dispatchID` (a native `task` dispatch, `task:<orchestrator>:<callID>`) verified at
 * `cwd`, or undefined when it has none (I9): not a routed role dispatch, or neither a grant location nor another working-set
 * root, or no extra root at all. W is the grant location's worktree, else `cwd`. `admission` is read for W's package links only.
 */
export function planPerimeter(dispatchID: string, cwd: string, admission: () => PerimeterAdmission): DispatchPerimeter | undefined {
  if (!dispatchID.startsWith("task:")) return undefined;
  const rest = dispatchID.slice("task:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const orchestrator = rest.slice(0, separator);
  const routed = routedRoleOf(rest.slice(separator + 1));
  if (routed === undefined || routed.parentSessionID !== orchestrator) return undefined;
  const location = routed.grant?.location;
  const w = location?.worktree ?? cwd;
  const workingSet = workingSetOf(orchestrator);
  const others = workingSet.filter((entry) => !insideOrEqual(w, entry.worktree) && !insideOrEqual(entry.worktree, w));
  // I13 (S1/S2): with cross-repo configured (`routing.repoParents`), W's admitted link targets are in P even when the dispatch has
  // no location and no working set. Without parents, such a dispatch has none (I9).
  const config = admission();
  if (location === undefined && others.length === 0 && config.parents.length === 0) return undefined;

  // QA-1 F11: W's git common directory, to tell another worktree of W's own repository from another repository.
  const wCommon = commonDirOf(gitTopOf(w));
  const sameRepository = (top: string): boolean => wCommon !== undefined && commonDirOf(top) === wCommon;

  const seeds: PerimeterSeed[] = [];
  const seen = new Set<string>([perimeterKey(w)]);
  let observed = 0;
  // QA-1 F2: past the cap a root is kept, unobserved (the gate refuses it with writers), never dropped.
  const add = (seed: PerimeterSeed): void => {
    const key = perimeterKey(seed.at);
    if (seen.has(key)) return;
    seen.add(key);
    if (seed.fixed !== undefined) {
      seeds.push(seed);
      return;
    }
    observed += 1;
    if (observed <= PERIMETER_MAX - 1) {
      seeds.push(seed);
      return;
    }
    seeds.push({
      at: seed.at,
      ...(seed.name !== undefined ? { name: seed.name } : {}),
      ...(seed.sameRepository === true ? { sameRepository: true } : {}),
      ...(seed.origin !== undefined ? { origin: seed.origin } : {}),
      fixed: "unobserved",
    });
  };
  for (const entry of others) {
    add({
      at: entry.worktree,
      name: entry.name,
      origin: "working-set",
      ...(sameRepository(entry.worktree) ? { sameRepository: true } : {}),
    });
  }

  const depth = Math.max(1, Math.floor(config.depth));
  const exclude = config.exclude ?? [];
  // Both spellings of each parent: as configured, and canonical (link targets are real paths).
  const parents = [...new Map(config.parents.flatMap((parent) => [parent, canonical(parent)]).map((p) => [perimeterKey(p), p])).values()];
  const excluded = (parent: string, top: string): boolean => {
    if (exclude.length === 0) return false;
    const segments = path.relative(parent, top).split(/[\\/]/).filter((segment) => segment !== "");
    for (let level = 1; level <= segments.length; level++) {
      const dir = path.join(parent, ...segments.slice(0, level));
      if (exclude.some((glob) => permissionMatches(dir, glob))) return true;
    }
    return false;
  };
  const parentOf = (dir: string): string | undefined => parents.find((parent) => depthBelow(dir, parent) >= 1);
  const worktreeOf = (dir: string) => workingSet.find((entry) => insideOrEqual(dir, entry.worktree));
  // QA-1 F4 (I11, I12): admission by top level, before any git call; the snapshot's top level is checked again at the gate.
  const admitTop = (top: string): boolean =>
    workingSet.some((entry) => perimeterKey(entry.worktree) === perimeterKey(top))
    || parents.some((parent) => {
      const below = depthBelow(top, parent);
      return below >= 1 && below <= depth && !excluded(parent, top);
    });

  for (const real of linkedTargets(w)) {
    // Admission by text first: a link outside every parent and every working-set worktree is not in P, but it is not dropped
    // either (I8, I12): kept as an unadmitted root named by its basename, without running git or touching the filesystem.
    const parent = parentOf(real);
    const worktree = worktreeOf(real);
    if (parent === undefined && worktree === undefined) {
      add({ at: real, name: path.basename(real), fixed: "unadmitted", origin: "link" });
      continue;
    }
    // QA-1 F3: the repository's top level, without git; the walk stops at the parent (or above the worktree).
    const top = gitTopOf(real, worktree !== undefined ? path.dirname(worktree.worktree) : parent);
    if (top === undefined) {
      add({ at: real, name: path.basename(real), fixed: "unadmitted", origin: "link" }); // Not in a git repository: nothing to observe.
      continue;
    }
    if (insideOrEqual(top, w) || insideOrEqual(w, top)) continue; // W's own repository: W's snapshot covers it.
    const covering = seeds.findIndex((seed) => seed.fixed === undefined && insideOrEqual(top, seed.at));
    if (covering >= 0) {
      // A root already in P covers it: one seed. QA-1 #9a: a working-set root covering it is marked as a link target too, so it
      // is pinned at dispatch; it keeps its working-set semantics (consumer discovery, I13). Its admission still accepts any
      // top level at, above or inside it at the gate (as without one), and admits its own links for the pin as a link's are.
      const seed = seeds[covering];
      if (seed !== undefined && seed.origin === "working-set" && seed.linked !== true) {
        const at = seed.at;
        seeds[covering] = {
          ...seed,
          linked: true,
          admit: (dir: string): boolean => insideOrEqual(dir, at) || insideOrEqual(at, dir) || admitTop(dir),
        };
      }
      continue;
    }
    if (!admitTop(top)) {
      add({ at: top, name: path.basename(top), fixed: "unadmitted", origin: "link" });
      continue;
    }
    add({ at: top, admit: admitTop, origin: "link", ...(sameRepository(top) ? { sameRepository: true } : {}) });
  }
  if (seeds.length === 0) return undefined;
  return { ...(location !== undefined ? { name: location.name } : {}), roots: seeds };
}
