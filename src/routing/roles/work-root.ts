/**
 * The one work-root containment rule of a role dispatch (plan §2.2, P-11, P-13): a path a role session names is canonicalised
 * by {@link canonicalAuthorityPath} and must lie in the work root by {@link insideWorkRoot}. P2.3 (authority, `compat/v2-hooks.ts`,
 * which re-exports both) and P3.3 DF2-F1 (where the router verifies a role dispatch, {@link verificationScope}) use the same rule,
 * so a directory the authority layer refuses is never one the verifier runs in.
 */
import { lstatSync, realpathSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { permissionMatches } from "../../router/read-only";

/** A win32 8.3 short-name segment (`PROGRA~1`, `MARQUI~1.TXT`): refused, never expanded (S11, P-11: fail closed). */
const SHORT_NAME_SEGMENT = /(?:^|[\\/])[^\\/~]{1,8}~\d+(?:\.[^\\/.]{0,3})?(?=[\\/]|$)/;

/**
 * The canonical long form of a path a role session names (T2.3.1). The RAW path (a relative one joined to `base` as text) goes to
 * `realpath` (`realpathSync.native`: links, junctions, case and 8.3 as on disk) WITHOUT lexical normalisation first, so a link is
 * resolved before any `..` after it (QA-P23-A1: POSIX `<root>/link/../x` is where the filesystem says, not `<root>/x`). A path that
 * does not exist is peeled to its longest existing ancestor, one component at a time, and only on a real "does not exist": an
 * entry `lstat` sees but `realpath` cannot resolve is a dangling (or looping) link and refuses; a `..` left in the missing tail
 * refuses. Undefined — the caller refuses — also for an empty path, a NUL, a wildcard, and on win32 an 8.3 spelling, a UNC/device
 * path (`\\server\…`, `\\?\…`: no filesystem call may reach a remote host), a drive-relative path (`C:x`) or a rooted path without
 * a drive (`\x`); and when anything fails to resolve for another reason than "does not exist".
 */
export function canonicalAuthorityPath(
  path: string,
  base: string,
  opts: { platform?: NodeJS.Platform; realpath?: (path: string) => string; lstat?: (path: string) => unknown } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  const lstat = opts.lstat ?? ((p: string) => lstatSync(p));
  const text = path.trim();
  if (text === "" || text.includes("\0") || /[*?]/.test(text)) return undefined;
  const api = platform === "win32" ? win32 : posix;
  const unc = (value: string): boolean => /^[\\/]{2}/.test(value);
  if (platform === "win32") {
    if (SHORT_NAME_SEGMENT.test(text) || unc(text) || /^[A-Za-z]:(?![\\/])/.test(text) || /^[\\/](?![\\/])/.test(text)) return undefined;
    if (!api.isAbsolute(text) && (SHORT_NAME_SEGMENT.test(base) || unc(base))) return undefined;
  }
  if (!api.isAbsolute(text) && !api.isAbsolute(base)) return undefined;
  const sep = platform === "win32" ? "\\" : "/";
  let head = api.isAbsolute(text) ? text : `${base.replace(/[\\/]+$/, "")}${sep}${text}`;
  const tail: string[] = [];
  const missing = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  };
  for (let depth = 0; depth < 4096; depth++) {
    try {
      const real = realpath(head);
      if (tail.includes("..")) return undefined;
      return tail.length === 0 ? real : api.join(real, ...tail);
    } catch (error) {
      if (!missing(error)) return undefined;
    }
    try {
      lstat(head);
      return undefined; // the entry exists, yet does not resolve: a dangling or looping link
    } catch (error) {
      if (!missing(error)) return undefined;
    }
    const parent = api.dirname(head);
    if (parent === head) return undefined;
    const name = api.basename(head);
    if (name !== "" && name !== ".") tail.unshift(name);
    head = parent;
  }
  return undefined;
}

/**
 * `target` (canonical) is the work root or inside it, with the matcher of the max policy's `external_directory` rules
 * (`read-only.ts` `permissionMatches`: separators unified, win32 case folding) on the registration's `<root><sep>*` shape (P-11,
 * P-13). A root carrying a wildcard never contains anything.
 */
export function insideWorkRoot(target: string, root: string): boolean {
  if (root === "" || /[*?]/.test(root)) return false;
  return permissionMatches(target, root) || permissionMatches(target, join(root, "*"));
}

/**
 * #84 P3.3 DF2-F1 (QA-P33F1-1 nit 3): the cwd a dispatch's verification is asked to use — the call's own `cwd` argument when it
 * names one, else the `[acceptance]` block's `cwd:`. The dispatch-time detection and the after-hook's gate read it the same way.
 */
export function requestedVerificationCwd(argsCwd: unknown, blockCwd: string | undefined): string | undefined {
  return typeof argsCwd === "string" && argsCwd.trim() !== "" ? argsCwd : blockCwd;
}

/** Where one dispatch is verified ({@link verificationScope}). */
export interface VerificationScope {
  /** The directory the change capture, the change set, the checks and a deferral use; undefined = the router's own. */
  readonly cwd: string | undefined;
  /** The gate's `Delegation.cwd`: for a role dispatch the CHECKED canonical directory (also the checks' exec cwd). */
  readonly requested: string | undefined;
  /** The role dispatch's verification root (the gate's `Delegation.workRoot`); absent for every other dispatch. */
  readonly workRoot?: string;
  /** The requested cwd is outside `workRoot` (or cannot be resolved safely): the gate refuses it; no deferral; `cwd` = the root. */
  readonly outside: boolean;
  /** The refused cwd as written (the gate's `Delegation.refusedCwd`); only when `outside`. */
  readonly refused?: string;
}

/**
 * #84 P3.3 DF2-F1: where a dispatch is verified. No root (a tier dispatch): the explicit `cwd`, exactly as before (I1). A role
 * dispatch's verification root (its bound work root, else its canonical session directory: QA-P33F1-1-1, 1-3): no `cwd` → the root;
 * a `cwd` (relative ones joined to the root) is canonicalised and contained by P2.3's rule ({@link canonicalAuthorityPath},
 * {@link insideWorkRoot}: UNC/device/8.3 paths refused before any filesystem call, links resolved before `..`); inside → the
 * canonical directory, which the checks then run in; anything else → `outside`, and every process stays in the root.
 */
export function verificationScope(
  explicit: string | undefined,
  root: string | null | undefined,
  canonical: (path: string, base: string) => string | undefined = canonicalAuthorityPath,
): VerificationScope {
  if (typeof root !== "string" || root === "") return { cwd: explicit, requested: explicit, outside: false };
  const text = explicit?.trim() ? explicit.trim() : undefined;
  if (text === undefined) return { cwd: root, requested: root, workRoot: root, outside: false };
  const target = canonical(text, root);
  if (target !== undefined && insideWorkRoot(target, root)) return { cwd: target, requested: target, workRoot: root, outside: false };
  return { cwd: root, requested: undefined, workRoot: root, outside: true, refused: text };
}
