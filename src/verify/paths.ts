// src/verify/paths.ts
// Pure path helpers for scoping verification to a producer subagent's working
// directory. Path math only (no fs/exec/network I/O), so this stays inside the
// verifier's purity contract while letting deterministic checks and the grader
// resolve relative paths against an effective base dir instead of the router's
// own cwd.

import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Lexical containment only: no filesystem or symlink resolution. */
export function isWithinDir(path: string, dir: string): boolean {
  const key = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  const delta = relative(key(dir), key(path));
  // Only a leading `..` SEGMENT leaves the dir: a child named `..cache` stays inside.
  return delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

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

/** Where one dispatch is verified ({@link verificationScope}). */
export interface VerificationScope {
  /** The directory the change capture, the change set and the (deferred) checks use; undefined = the router's own. */
  readonly cwd: string | undefined;
  /** The gate's `Delegation.cwd`: the requested directory, which the gate refuses when it lies outside `workRoot`. */
  readonly requested: string | undefined;
  /** The role dispatch's validated work root (the gate's `Delegation.workRoot`); absent for every other dispatch. */
  readonly workRoot?: string;
  /** `requested` lies outside `workRoot`: the gate refuses it, so nothing may run there (no deferral, `cwd` = the work root). */
  readonly outside: boolean;
}

/**
 * #84 P3.3 DF2-F1: where a dispatch is verified. No work root (a tier dispatch, a role dispatch without a validated root): the
 * explicit `cwd` exactly as before (I1). A role dispatch's work root: the explicit `cwd` resolved against the work root, else
 * the work root itself; a `cwd` outside it is `outside` (refused by the gate) and every process then stays in the work root.
 * `canonical` spells one directory one way (8.3 names, links) for the containment test; the gate uses the same function.
 */
export function verificationScope(
  explicit: string | undefined,
  workRoot: string | null | undefined,
  canonical: (path: string) => string = (path) => path,
): VerificationScope {
  if (typeof workRoot !== "string" || workRoot === "") return { cwd: explicit, requested: explicit, outside: false };
  const requested = resolveBaseDir(explicit?.trim() ? explicit : undefined, workRoot);
  const outside = !isWithinDir(canonical(requested), canonical(workRoot));
  return { cwd: outside ? workRoot : requested, requested, workRoot, outside };
}

/**
 * Resolve a (possibly relative) path against a base directory. Absolute paths
 * are returned unchanged so downstream fs seams that special-case absolute
 * paths bypass their own (router-scoped) join.
 */
export function resolveAgainst(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}
