/**
 * Security: a delegated agent never writes repository git metadata (`.git` and everything below it: config, hooks, a linked
 * worktree's pointer and admin directory). Role agents are refused by their authority check (compat/v2-hooks.ts
 * `roleAuthorityDecision`, `editsGitMetadata`); this is the same rule for every other delegated session — tier agents, plugin
 * agents (#81), producer sessions — on OpenCode v1 and v2, enforced in the shared `tool.execute.before` (index.ts). Hook-based:
 * the published permission maps are unchanged.
 *
 * A write-class call ({@link WRITE_CLASS}) is refused when any file it names ({@link writeTargetTexts}):
 * - has a segment naming `.git` as written ({@link namesGitMetadata}: case-insensitive, trailing dots and spaces, NTFS `:stream`);
 * - has no canonical form ({@link canonicalAuthorityPath}: padding whitespace, wildcard, NUL, UNC/device path, drive-relative or
 *   drive-less rooted path, dangling or looping link, `..` in a missing tail, an unresolvable entry) — fail closed;
 * - resolves (links and junctions followed, case and 8.3 short names as on disk) to a path with a `.git` segment, or into the git
 *   directory or common directory of the session directory's repository (also when it is not named `.git`: a bare repository's
 *   linked worktree, `--separate-git-dir`).
 * A patch whose targets cannot be read is refused too (fail closed). Never throws.
 */
import { realpathSync } from "node:fs";
import { gitPointers, nearestRepository } from "./git-tools";
import { WRITE_CLASS, writeTargetTexts } from "./tool-paths";
import { canonicalAuthorityPath, insideWorkRoot } from "../routing/roles/work-root";
import { displaySafe, namesGitMetadata } from "../routing/roles/read-set";

/** Seams of {@link gitMetadataWriteRefusal} (tests). */
export interface GitMetadataGuardDeps {
  /** Default `process.platform`: on win32 an NTFS stream suffix is cut before a path is resolved. */
  readonly platform?: NodeJS.Platform;
  /** The canonical form of `path` (relative paths against `base`). Default: {@link canonicalAuthorityPath}, 8.3 names resolved. */
  readonly canonical?: (path: string, base: string) => string | undefined;
  /** The canonical git and common directories of the repository holding `directory`. Default: its `.git` pointers. */
  readonly gitDirectories?: (directory: string) => readonly string[];
}

/** The refusal of a write that targets git metadata. */
export function gitMetadataWriteRefusalText(path: string): string {
  return `[router] Refused: writing git metadata (${displaySafe(path)}) is not allowed for delegated agents.`;
}

/** The refusal of a write whose target the router cannot resolve (fail closed). */
function unresolvedText(path: string): string {
  return `[router] Refused: the router could not resolve ${displaySafe(path)} to check that it is not git metadata, which delegated `
    + "agents may not write (fail closed). Name the file by a plain path.";
}

/** The refusal of a patch whose targets cannot be read (fail closed). */
export const GIT_METADATA_PATCH_UNREADABLE = "[router] Refused: the router could not read which files this patch writes, so it "
  + "cannot check that none of them is git metadata, which delegated agents may not write (fail closed). Name each file in an "
  + "`*** Add File:`, `*** Update File:` or `*** Delete File:` header.";

/**
 * win32: `path` with each segment's NTFS stream suffix cut (`name:stream`, `name::$DATA`, `name::$INDEX_ALLOCATION` all name the
 * entry `name`), a leading drive's `X:` kept, so the entry is what gets resolved.
 */
function withoutStreams(path: string): string {
  return path.split(/([\\/])/).map((part, index) => {
    const drive = index === 0 && /^[A-Za-z]:/.test(part) ? part.slice(0, 2) : "";
    const rest = part.slice(drive.length);
    const colon = rest.indexOf(":");
    return drive + (colon === -1 ? rest : rest.slice(0, colon));
  }).join("");
}

/**
 * The canonical git directory and common directory of the repository whose checkout holds `directory`, read from its `.git`
 * pointers without running git ({@link gitPointers}: bounded, never followed onto a network or device path). Neither may contain
 * the checkout itself (a malformed pointer). Empty when there is no repository or a pointer is refused or unreadable: the `.git`
 * segment checks still apply.
 */
function sessionGitDirectories(directory: string): string[] {
  try {
    const checkout = nearestRepository(directory);
    if (checkout === undefined) return [];
    const pointers = gitPointers(checkout);
    if (pointers === undefined) return [];
    const top = realpathSync.native(checkout);
    const dirs: string[] = [];
    for (const dir of new Set([pointers.gitdir, pointers.common])) {
      let real: string;
      try {
        real = realpathSync.native(dir);
      } catch {
        continue;
      }
      if (!insideWorkRoot(top, real)) dirs.push(real);
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * The refusal of the write-class call `tool(args)` of a delegated session whose relative paths resolve against `base`, or
 * undefined when it writes no git metadata (and for every other tool). The caller decides whether the session is delegated.
 */
export function gitMetadataWriteRefusal(tool: string, args: unknown, base: string, deps: GitMetadataGuardDeps = {}): string | undefined {
  if (typeof tool !== "string" || !WRITE_CLASS.has(tool.toLowerCase())) return undefined;
  const texts = writeTargetTexts(tool, args);
  if (texts === undefined) return GIT_METADATA_PATCH_UNREADABLE;
  const platform = deps.platform ?? process.platform;
  const canonical = deps.canonical ?? ((path: string, from: string) => canonicalAuthorityPath(path, from, { shortNames: "resolve" }));
  const resolveTarget = (text: string): string | undefined => {
    try {
      return canonical(platform === "win32" ? withoutStreams(text) : text, base);
    } catch {
      return undefined;
    }
  };
  let gitDirs: readonly string[] | undefined;
  for (const text of texts) {
    if (namesGitMetadata(text)) return gitMetadataWriteRefusalText(text);
    const target = resolveTarget(text);
    if (target === undefined) return unresolvedText(text);
    if (namesGitMetadata(target)) return gitMetadataWriteRefusalText(text);
    if (gitDirs === undefined) {
      try {
        gitDirs = (deps.gitDirectories ?? sessionGitDirectories)(base);
      } catch {
        gitDirs = []; // the `.git` segment checks above still apply
      }
    }
    if (gitDirs.some((dir) => insideWorkRoot(target, dir))) return gitMetadataWriteRefusalText(text);
  }
  return undefined;
}
