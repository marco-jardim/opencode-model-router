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
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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

/** The real paths of W's package links (symlinks, junctions) that point outside W and are not store-like, de-duplicated. */
function linkedTargets(w: string): string[] {
  const targets = new Map<string, string>();
  for (const entry of packageEntries(w)) {
    let real: string;
    try {
      if (!lstatSync(entry).isSymbolicLink()) continue;
      real = realpathSync.native(entry);
    } catch {
      continue; // Unreadable or dangling: it loads nothing.
    }
    if (insideOrEqual(real, w) || insideOrEqual(w, real) || isStoreLikeLink(real, process.platform)) continue;
    if (!targets.has(perimeterKey(real))) targets.set(perimeterKey(real), real);
  }
  return [...targets.values()];
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
      fixed: "unobserved",
    });
  };
  for (const entry of others) {
    add({ at: entry.worktree, name: entry.name, ...(sameRepository(entry.worktree) ? { sameRepository: true } : {}) });
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
      add({ at: real, name: path.basename(real), fixed: "unadmitted" });
      continue;
    }
    // QA-1 F3: the repository's top level, without git; the walk stops at the parent (or above the worktree).
    const top = gitTopOf(real, worktree !== undefined ? path.dirname(worktree.worktree) : parent);
    if (top === undefined) {
      add({ at: real, name: path.basename(real), fixed: "unadmitted" }); // Not in a git repository: nothing to observe.
      continue;
    }
    if (insideOrEqual(top, w) || insideOrEqual(w, top)) continue; // W's own repository: W's snapshot covers it.
    if (seeds.some((seed) => seed.fixed === undefined && insideOrEqual(top, seed.at))) continue; // A working-set root covers it.
    if (!admitTop(top)) {
      add({ at: top, name: path.basename(top), fixed: "unadmitted" });
      continue;
    }
    add({ at: top, admit: admitTop, ...(sameRepository(top) ? { sameRepository: true } : {}) });
  }
  if (seeds.length === 0) return undefined;
  return { ...(location !== undefined ? { name: location.name } : {}), roots: seeds };
}
