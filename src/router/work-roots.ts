/**
 * DF-1-1: whether a location (the host's `ctx.directory`) lies inside one of the configured `routing.workRoots` entries.
 * An entry is an absolute path or an absolute glob with the semantics of the `external_directory` rule the role agents get
 * for it (`workRootPattern` in role-agents.ts) as the host matches it (`permissionMatches`, QA-DF1-25): `*` matches any run of
 * characters and crosses separators, `?` one character, every other character (`[`, `]`, `{`, `}` included) is literal. As
 * in `workRootPattern`, the static directory before the first glob character (`workRootGlobIndex`) is resolved to its
 * canonical form and the glob tail is kept verbatim; the location is canonical too (`realpathSync.native`; a path that does
 * not resolve is used as written). The location is inside an entry when it or one of its ancestors matches it. Separators
 * are normalized; on win32 the match ignores case. Unset or empty `workRoots`: every location counts as inside (nothing
 * changes for a user without them).
 */
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { permissionMatches } from "./read-only";
import { workRootGlobIndex } from "./roles-config";

type Realpath = (path: string) => string;
const nativeRealpath: Realpath = (path) => realpathSync.native(path);

function normalize(path: string, platform: NodeJS.Platform): string {
  const forward = path.replace(/\\/g, "/");
  const trimmed = /^[A-Za-z]:\/$|^\/$/.test(forward) ? forward : forward.replace(/\/+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function canonical(path: string, realpath: Realpath): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

/** The entry with its static directory in canonical form and its glob tail verbatim (as `workRootPattern` builds it). */
function canonicalEntry(entry: string, realpath: Realpath): string {
  const globAt = workRootGlobIndex(entry);
  if (globAt === -1) return canonical(entry, realpath);
  const prefix = entry.slice(0, globAt);
  const cut = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  const directory = entry.slice(0, cut + 1);
  const tail = entry.slice(cut + 1);
  const resolved = canonical(directory, realpath);
  return /[\\/]$/.test(resolved) ? resolved + tail : `${resolved}/${tail}`;
}

/** True only when `workRoots` is non-empty and no entry contains `directory`. */
export function locationOutsideWorkRoots(
  directory: string,
  workRoots: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
  realpath: Realpath = nativeRealpath,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const entries = (workRoots ?? []).filter((entry) => typeof entry === "string" && entry.trim() !== "" && paths.isAbsolute(entry));
  if (entries.length === 0) return false;
  const location = normalize(canonical(paths.resolve(directory), realpath), platform);
  const candidates: string[] = [];
  for (let at = location; ; ) {
    candidates.push(at);
    const cut = at.lastIndexOf("/");
    if (cut <= 0) break;
    const parent = at.slice(0, cut);
    // `D:/x` → `D:/`, the drive root, not `D:`.
    at = /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
    if (candidates.includes(at)) break;
  }
  for (const entry of entries) {
    const pattern = normalize(canonicalEntry(entry, realpath), platform);
    if (candidates.some((candidate) => entryMatches(candidate, pattern, platform))) return false;
  }
  return true;
}

/**
 * The host's match of an `external_directory` pattern (`permissionMatches`) for `platform`. Both sides are normalized first
 * (`normalize`: lower case on win32), so the host matcher's own case folding, which follows the running process, only
 * matters for a posix `platform` under a win32 process (tests): there a case-only difference must not match.
 */
function entryMatches(candidate: string, pattern: string, platform: NodeJS.Platform): boolean {
  if (!permissionMatches(candidate, pattern)) return false;
  if (platform === "win32" || process.platform !== "win32") return true;
  // The same translation as `permissionMatches`, without its win32 case folding.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(candidate);
}
