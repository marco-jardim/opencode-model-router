import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build marker for the liveness probe of the dogfood checkpoints (plan §0.11):
 * the package version plus the git commit the running code was loaded from.
 *
 * There is no build step (package.json has no build script) and the host loads
 * the plugin straight from a checkout, so the commit is read from `.git` at
 * module load time. Everything here is best-effort: any failure yields
 * `"unknown"` and nothing ever throws, because a missing marker must never stop
 * the plugin from loading.
 */
export interface BuildInfo {
  /** `version` of the plugin's package.json, or `"unknown"`. */
  readonly version: string;
  /** Full commit sha (40 or 64 hex digits), or `"unknown"`. */
  readonly sha: string;
}

export const UNKNOWN = "unknown";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Plugin root: this file lives in `<root>/src/router/`. */
function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Text of a file, or `undefined` when it cannot be read. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    // Absent or unreadable is the normal case for most of the paths probed here.
    return undefined;
  }
}

/** The sha a `packed-refs` file records for `ref`, if any. */
function packedRef(packedRefs: string, ref: string): string | undefined {
  for (const line of packedRefs.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space > 0 && line.slice(space + 1).trim() === ref) {
      const sha = line.slice(0, space);
      if (SHA_PATTERN.test(sha)) return sha.toLowerCase();
    }
  }
  return undefined;
}

/**
 * Directory that holds `HEAD`: `<root>/.git` itself, or — when `.git` is a file
 * (a linked worktree or a submodule) — the `gitdir:` it points at.
 */
function resolveGitDir(root: string): string | undefined {
  const dotGit = join(root, ".git");
  const pointer = readText(dotGit);
  if (pointer === undefined) {
    // A directory cannot be read as text; its HEAD file is the evidence.
    return readText(join(dotGit, "HEAD")) !== undefined ? dotGit : undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match?.[1]) return undefined;
  return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
}

/**
 * Commit sha of the checkout at `root`, read from `.git`: `HEAD`, then the ref
 * file it names (in the worktree's own git dir, then in the common dir that its
 * `commondir` file points at), then `packed-refs`. A detached `HEAD` holds the
 * sha itself. Returns `"unknown"` for anything else, and never throws.
 *
 * Not read: the `reftable` ref format (`git init --ref-format=reftable`), which
 * keeps `HEAD` as the stub `ref: refs/heads/.invalid` and the real refs in binary
 * tables under `.git/reftable/`. Such a checkout reports `"unknown"` (QA-1.1-20).
 */
export function readGitSha(root: string): string {
  try {
    const gitDir = resolveGitDir(root);
    if (gitDir === undefined) return UNKNOWN;
    const head = readText(join(gitDir, "HEAD"))?.trim();
    if (head === undefined || head === "") return UNKNOWN;
    if (SHA_PATTERN.test(head)) return head.toLowerCase();
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (ref === undefined) return UNKNOWN;

    const commonText = readText(join(gitDir, "commondir"))?.trim();
    const dirs = [gitDir];
    if (commonText) dirs.push(isAbsolute(commonText) ? commonText : resolve(gitDir, commonText));
    for (const dir of dirs) {
      const loose = readText(join(dir, ref))?.trim();
      if (loose !== undefined && SHA_PATTERN.test(loose)) return loose.toLowerCase();
    }
    for (const dir of dirs) {
      const packed = readText(join(dir, "packed-refs"));
      const sha = packed === undefined ? undefined : packedRef(packed, ref);
      if (sha !== undefined) return sha;
    }
    return UNKNOWN;
  } catch {
    // Unreachable in practice (every read above is guarded); the contract is
    // that this function never throws, so a surprise degrades to "unknown".
    return UNKNOWN;
  }
}

/** `version` of the package.json at `root`, or `"unknown"`. Never throws. */
export function readPackageVersion(root: string): string {
  try {
    const text = readText(join(root, "package.json"));
    if (text === undefined) return UNKNOWN;
    const version: unknown = (JSON.parse(text) as { version?: unknown } | null)?.version;
    return typeof version === "string" && version !== "" ? version : UNKNOWN;
  } catch {
    // Malformed package.json: the marker degrades, the plugin still loads.
    return UNKNOWN;
  }
}

/** Build info of the checkout at `root`. */
export function readBuildInfo(root: string): BuildInfo {
  return Object.freeze({ version: readPackageVersion(root), sha: readGitSha(root) });
}

/**
 * Build info of the plugin checkout found by `root()`. If even locating it throws
 * (`import.meta.url` is not a `file:` URL when the module is bundled or loaded
 * remotely, QA-1.1-20), there is no checkout to read: both parts are `"unknown"`.
 */
export function loadBuildInfo(root: () => string = pluginRoot): BuildInfo {
  try {
    return readBuildInfo(root());
  } catch {
    return Object.freeze({ version: UNKNOWN, sha: UNKNOWN });
  }
}

/** The running plugin's build info, read once when this module loads. */
export const buildInfo: BuildInfo = loadBuildInfo();

/**
 * The marker line `/router` prints: `router: engine=<mode> build=<version>+<sha7>`.
 * `<sha7>` is the first seven digits of the commit, or `unknown`.
 */
export function formatRouterLine(engine: string, info: BuildInfo = buildInfo): string {
  const sha = info.sha === UNKNOWN ? UNKNOWN : info.sha.slice(0, 7);
  return `router: engine=${engine} build=${info.version}+${sha}`;
}
