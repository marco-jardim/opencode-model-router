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
 * orchestrator session's working set holds a root other than W, can have a perimeter; every other dispatch plans none, so nothing
 * else is snapshotted and no reason changes. A link target is snapshotted only when its real path is admitted by text first
 * (below a `routing.repoParents` entry, or inside a working-set worktree; I11, I12); its git top level is checked again at the gate.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { routedRoleOf } from "../routing/wire/dispatch";
import { workingSetOf } from "../routing/wire/working-set";
import type { DispatchPerimeter, PerimeterSeed } from "./dispatch";
import { isStoreLikeLink } from "./reference";

/** P holds at most this many roots, W included. */
export const PERIMETER_MAX = 16;

/** What link admission needs: `routing.repoParents` and `routing.repoDepth`. */
export interface PerimeterAdmission {
  readonly parents: readonly string[];
  readonly depth: number;
}

/** A comparison key: absolute, "/" separators, no trailing separator, case-folded on win32. */
export function perimeterKey(at: string): string {
  const normalized = path.resolve(at).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function insideOrEqual(child: string, parent: string): boolean {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** How many segments `child` lies below `parent`: 0 when equal, -1 when not inside. */
function depthBelow(child: string, parent: string): number {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  if (c === p) return 0;
  return c.startsWith(`${p}/`) ? c.slice(p.length + 1).split("/").length : -1;
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
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

/** The real paths of W's package links (symlinks, junctions) that point outside W, are not store-like and pass `admitted`. */
function linkedTargets(w: string, admitted: (real: string) => boolean): string[] {
  const targets = new Map<string, string>();
  for (const entry of packageEntries(w)) {
    let real: string;
    try {
      if (!lstatSync(entry).isSymbolicLink()) continue;
      real = realpathSync.native(entry);
    } catch {
      continue; // Unreadable or dangling: it loads nothing.
    }
    if (insideOrEqual(real, w) || insideOrEqual(w, real) || isStoreLikeLink(real, process.platform) || !admitted(real)) continue;
    if (!targets.has(perimeterKey(real))) targets.set(perimeterKey(real), real);
  }
  return [...targets.values()];
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
  if (location === undefined && others.length === 0) return undefined;

  const seeds: PerimeterSeed[] = [];
  const seen = new Set<string>([perimeterKey(w)]);
  const add = (seed: PerimeterSeed): void => {
    const key = perimeterKey(seed.at);
    if (seen.has(key) || seeds.length >= PERIMETER_MAX - 1) return;
    seen.add(key);
    seeds.push(seed);
  };
  for (const entry of others) add({ at: entry.worktree, name: entry.name });

  const config = admission();
  const belowParent = (dir: string, maxDepth: number): boolean => config.parents.some((parent) => {
    const depth = depthBelow(dir, parent);
    return depth >= 1 && depth <= maxDepth;
  });
  const inWorkingSet = (dir: string): boolean => workingSet.some((entry) => insideOrEqual(dir, entry.worktree));
  // Admission by text before any git call (I11, I12); the snapshot's top level is admitted again at the gate (`admit`).
  const admitRoot = (root: string): boolean =>
    belowParent(root, Math.max(1, config.depth)) || workingSet.some((entry) => perimeterKey(entry.worktree) === perimeterKey(root));
  for (const real of linkedTargets(w, (dir) => belowParent(dir, Number.POSITIVE_INFINITY) || inWorkingSet(dir))) {
    if (seeds.some((seed) => insideOrEqual(real, seed.at))) continue;
    add({ at: real, admit: admitRoot });
  }
  if (seeds.length === 0) return undefined;
  return { ...(location !== undefined ? { name: location.name } : {}), roots: seeds };
}
