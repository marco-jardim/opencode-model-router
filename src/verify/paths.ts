// src/verify/paths.ts
// Pure path helpers for scoping verification to a producer subagent's working
// directory. Path math only (no fs/exec/network I/O), so this stays inside the
// verifier's purity contract while letting deterministic checks and the grader
// resolve relative paths against an effective base dir instead of the router's
// own cwd.

import { isAbsolute, join } from "node:path";

/**
 * Resolve the effective base directory for a delegation's verification.
 *  - no cwd            -> the router's own directory (byte-identical default)
 *  - absolute cwd      -> that cwd
 *  - relative cwd      -> joined onto the router directory
 */
export function resolveBaseDir(cwd: string | undefined, routerDir: string): string {
  if (!cwd) return routerDir;
  if (isAbsolute(cwd)) return cwd;
  return join(routerDir, cwd);
}

/**
 * Resolve a (possibly relative) path against a base directory. Absolute paths
 * are returned unchanged so downstream fs seams that special-case absolute
 * paths bypass their own (router-scoped) join.
 */
export function resolveAgainst(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}
