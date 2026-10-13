/**
 * src/verify/git-top.ts
 *
 * The git top level of a directory, found without running git (cross-repo QA-1 F3), shared by the verification perimeter
 * (perimeter.ts) and the per-check placement resolver (routing/roles/check-placement.ts).
 */
import { lstatSync } from "node:fs";
import * as path from "node:path";
import { isSlash, trimEndWhile } from "../util/linear-trim";

/** A comparison key: absolute, "/" separators, no trailing separator, case-folded on win32. */
export function perimeterKey(at: string): string {
  const normalized = trimEndWhile(path.resolve(at).replace(/\\/g, "/"), isSlash); // linear: no `/\/+$/` (polynomial on a run of "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** How many segments `child` lies below `parent`: 0 when equal, -1 when not inside. */
export function depthBelow(child: string, parent: string): number {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  if (c === p) return 0;
  return c.startsWith(`${p}/`) ? c.slice(p.length + 1).split("/").length : -1;
}

/**
 * QA-1 F3: the git top level of `dir` found without git: the nearest directory at or above it holding a `.git` entry (a
 * directory, or a worktree's or submodule's `.git` file), strictly below `ceiling` when given. Undefined when there is none.
 */
export function gitTopOf(dir: string, ceiling?: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (ceiling !== undefined && !(depthBelow(current, ceiling) >= 1)) return undefined;
    try {
      lstatSync(path.join(current, ".git"));
      return current;
    } catch {
      // No `.git` here: keep walking up.
    }
    const up = path.dirname(current);
    if (up === current) return undefined;
    current = up;
  }
}
