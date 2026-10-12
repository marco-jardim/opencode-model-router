/**
 * DF-1-1: whether a location (the host's `ctx.directory`) lies inside one of the configured `routing.workRoots` entries.
 * An entry is an absolute path or an absolute glob (`*` within one segment, `**` across segments, `?` one character); the
 * location is inside it when the location or one of its ancestors matches. Separators are normalized; on win32 the match
 * ignores case. Unset or empty `workRoots`: every location counts as inside (nothing changes for a user without them).
 */
import { posix, win32 } from "node:path";

function normalize(path: string, platform: NodeJS.Platform): string {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? forward.toLowerCase() : forward;
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** True only when `workRoots` is non-empty and no entry contains `directory`. */
export function locationOutsideWorkRoots(
  directory: string,
  workRoots: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const entries = (workRoots ?? []).filter((entry) => typeof entry === "string" && entry.trim() !== "" && paths.isAbsolute(entry));
  if (entries.length === 0) return false;
  const location = normalize(paths.resolve(directory), platform);
  const candidates: string[] = [];
  for (let at = location; ; ) {
    candidates.push(at);
    const cut = at.lastIndexOf("/");
    if (cut <= 0) break;
    at = at.slice(0, cut);
  }
  for (const entry of entries) {
    const pattern = globToRegExp(normalize(entry, platform));
    if (candidates.some((candidate) => pattern.test(candidate))) return false;
  }
  return true;
}
