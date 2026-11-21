/**
 * Security: a delegated agent never writes repository git metadata (`.git` and everything below it: config, hooks, a linked
 * worktree's pointer and admin directory). Role agents are refused by their authority check (compat/v2-hooks.ts
 * `roleAuthorityDecision`, `editsGitMetadata`); this is the same rule for every other delegated session — tier agents, plugin
 * agents (#81), producer sessions — on OpenCode v1 and v2, enforced in the shared `tool.execute.before` (index.ts). Hook-based:
 * the published permission maps are unchanged. The file tools only: a shell command is not covered.
 *
 * A write-class call ({@link WRITE_CLASS}) is refused when any file it names ({@link writeTargetTexts}):
 * - has a segment naming `.git` as written ({@link namesGitMetadata}: case-insensitive, trailing dots and spaces, NTFS `:stream`);
 * - has no canonical form ({@link canonicalAuthorityPath}: padding whitespace, wildcard, NUL, UNC/device path outside the session
 *   directory's own UNC root, drive-relative or drive-less rooted path, dangling or looping link, `..` in a missing tail, an
 *   unresolvable entry) — fail closed;
 * - resolves (links and junctions followed, case and 8.3 short names as on disk) to a path with a `.git` segment, or into the git
 *   directory or common directory of the session directory's repository (also when it is not named `.git`: a bare repository's
 *   linked worktree, `--separate-git-dir`), the checkout's own files excepted when such a directory holds the checkout.
 * Each file is resolved in two readings, and refused when either hits: as written (links resolved before any `..` after them, as
 * the kernel does on POSIX) and as the host resolves it (`path.resolve`: `..` collapsed as text first). A patch whose targets
 * cannot be read is refused too (fail closed). Never throws.
 */
import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { gitPointers, nearestRepository } from "./git-tools";
import { WRITE_CLASS, writeTargetTexts } from "./tool-paths";
import { canonicalAuthorityPath, insideWorkRoot } from "../routing/roles/work-root";
import { displaySafe, namesGitMetadata } from "../routing/roles/read-set";

/** The git directories of the session directory's repository, and its checkout (both canonical). */
export interface SessionGitDirectories {
  /** The git directory and the common directory. */
  readonly directories: readonly string[];
  /** The checkout (repository top) holding the session directory; undefined outside a repository. */
  readonly checkout: string | undefined;
}

/** Seams of {@link gitMetadataWriteRefusal} (tests). */
export interface GitMetadataGuardDeps {
  /** Default `process.platform`: path syntax, NTFS stream suffixes and 8.3 names on win32. */
  readonly platform?: NodeJS.Platform;
  /** `realpathSync.native` and `lstatSync` (the filesystem the paths are resolved on). */
  readonly realpath?: (path: string) => string;
  readonly lstat?: (path: string) => unknown;
  /** The git directories and checkout of the repository holding `directory`. Default: its `.git` pointers. */
  readonly gitDirectories?: (directory: string) => SessionGitDirectories;
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

const NO_GIT_DIRECTORIES: SessionGitDirectories = Object.freeze({ directories: [], checkout: undefined });

/**
 * The canonical git directory and common directory of the repository whose checkout holds `directory`, and that checkout, read
 * from its `.git` pointers without running git ({@link gitPointers}: bounded, never followed onto a network or device path). No
 * directories when there is no repository or a pointer is refused or unreadable: the `.git` segment checks still apply.
 */
function sessionGitDirectories(directory: string): SessionGitDirectories {
  try {
    const checkout = nearestRepository(directory);
    if (checkout === undefined) return NO_GIT_DIRECTORIES;
    const pointers = gitPointers(checkout);
    if (pointers === undefined) return NO_GIT_DIRECTORIES;
    const directories: string[] = [];
    for (const dir of new Set([pointers.gitdir, pointers.common])) {
      try {
        directories.push(realpathSync.native(dir));
      } catch {
        // a git directory that does not resolve holds nothing to write
      }
    }
    return { directories, checkout: realpathSync.native(checkout) };
  } catch {
    return NO_GIT_DIRECTORIES;
  }
}

/**
 * `target` (canonical) lies in one of the session repository's git directories. A git directory that holds the checkout itself
 * (a bare repository with its worktree inside it, or a malformed pointer naming the checkout) exempts only the checkout's own
 * files; a git directory inside the checkout exempts nothing.
 */
function insideGitDirectory(target: string, git: SessionGitDirectories): boolean {
  const top = git.checkout;
  return git.directories.some((dir) => {
    if (!insideWorkRoot(target, dir)) return false;
    return !(top !== undefined && insideWorkRoot(top, dir) && insideWorkRoot(target, top));
  });
}

/**
 * The refusal of the write-class call `tool(args)` of a delegated session whose relative paths resolve against `base` (the
 * session's directory), or undefined when it writes no git metadata (and for every other tool). The caller decides whether the
 * session is delegated.
 */
export function gitMetadataWriteRefusal(tool: string, args: unknown, base: string, deps: GitMetadataGuardDeps = {}): string | undefined {
  if (typeof tool !== "string" || !WRITE_CLASS.has(tool.toLowerCase())) return undefined;
  const texts = writeTargetTexts(tool, args);
  if (texts === undefined) return GIT_METADATA_PATCH_UNREADABLE;
  const platform = deps.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const fs = {
    realpath: deps.realpath ?? ((p: string) => realpathSync.native(p)),
    lstat: deps.lstat ?? ((p: string) => lstatSync(p)),
  };
  // 8.3 names expanded on disk; a project on a share (`base` a UNC path) may resolve its own paths, never another UNC or device one.
  const canonical = (path: string): string | undefined => {
    try {
      return canonicalAuthorityPath(path, base, { platform, shortNames: "resolve", uncRoot: base, ...fs });
    } catch {
      return undefined;
    }
  };
  let git: SessionGitDirectories | undefined;
  const gitDirectories = (): SessionGitDirectories => {
    if (git === undefined) {
      try {
        git = (deps.gitDirectories ?? sessionGitDirectories)(base);
      } catch {
        git = NO_GIT_DIRECTORIES; // the `.git` segment checks still apply
      }
    }
    return git;
  };
  for (const text of texts) {
    if (namesGitMetadata(text)) return gitMetadataWriteRefusalText(text);
    const written = platform === "win32" ? withoutStreams(text) : text;
    // The kernel's reading (links before `..`) and the host's (`path.resolve`, `..` collapsed as text first): either may write.
    let hostReading: string;
    try {
      hostReading = api.resolve(base, written);
    } catch {
      return unresolvedText(text);
    }
    for (const reading of new Set([written, hostReading])) {
      const target = canonical(reading);
      if (target === undefined) return unresolvedText(text);
      if (namesGitMetadata(target) || insideGitDirectory(target, gitDirectories())) return gitMetadataWriteRefusalText(text);
    }
  }
  return undefined;
}
