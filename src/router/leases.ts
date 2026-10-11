/**
 * src/router/leases.ts — the file lease registry (ADR 0007 D7, Phase 1.3). A child session that writes a file holds a
 * lease on it until it completes (`until-complete`) or its plan task is integrated (`until-integrated`); a second
 * writer, and a child that reads or searches the file, is refused with the holder named. Root sessions are never
 * refused a read, a search or a run, and a root write is refused only while a child holds the file.
 *
 * Ownership is per OWNER, not per session: the owner of a lease is its holder's `taskRef` when there is one, else its
 * holderID. Sessions of one plan task (the producer, a retry, its verifier or QA child) therefore never conflict with
 * one another: a re-entrant write is not counted, and a read, search or run by an actor naming the same `taskRef` is
 * exempt. Actors without a `taskRef` are their own owner. An actor whose holderID is recorded IS that holder: its owner
 * comes from the record (it may omit `taskRef`; a different `taskRef`, `tree` or `isChild` is `invalid-holder`), and it
 * is never refused a lease it holds itself.
 *
 * A lease has a SET of holders (all of one owner, first writer first): every session of the owner that writes the file
 * joins it, and the lease ends only with the last of them (the strongest scope among them decides how long it lives,
 * `until-integrated` over `until-complete`). The sessions of one taskRef must not write concurrently: two writers of
 * one owner never conflict, so 3.1 must serialise the producer and its retry.
 *
 * Two keys per file: the LOGICAL key (repository + repo-relative path) decides write conflicts, so one file edited in
 * two worktrees of one repository collides; the PHYSICAL key (the canonical, case-folded absolute path) decides read
 * conflicts, so a read of the same relative path in another worktree is not a conflict. One logical key records every
 * (physical, tree) pair its owner wrote it in, and reads and runs are checked against each of them.
 *
 * A path no key can be derived for is unkeyable. A spelling that may name any file (a device form, a drive-relative
 * path, an 8.3 name) fails CLOSED: a child's read or write of it is refused while any other owner holds any lease.
 * Other unkeyable input (empty, NUL, not a string, oversize) is an unknown target: a child write is refused while
 * another owner holds a lease in the same repository, and a read is allowed. A run directory that is unkeyable fails
 * closed for a child runner while any other owner holds a lease. A drive-less rooted win32 path (`\x`) is aliasing: it
 * is on the drive of the process, which the registry cannot know. Device forms other than `X:` and `Volume{guid}`
 * (`\\.\pipe\…`, `\\?\GLOBALROOT\…`) are unkeyable without any filesystem call.
 *
 * Handoffs for 2.1: run the authority checks before the lease checks; back `repoKeyOf` with the git pointers; treat a
 * `toolTargets` result with `gitRootRequired` (no concrete target) as an unknown target; hand git the `relOnDisk` of a
 * key, not `rel`/`physical` (folded); serialise sessions of one taskRef; drop `until-complete` holders on restart
 * (`restore(…, { dropCompleteHolders: true })`).
 *
 * Time is epoch milliseconds (`seams.now()`). A holder's `lastSeenAt` is refreshed by each acquire, read, search and
 * run it makes; an `until-complete` holder not seen for `sweepAgeMs` is swept by {@link LeaseRegistry.sweep} or on the
 * spot when it is named by a conflict.
 *
 * Pure policy over injected seams: the filesystem is reached only through {@link LeaseSeams}, every seam is
 * synchronous, and the registry contains no `await`, so a check and its insert are atomic. The registry is unwired
 * until Phase 2.1 (v2 only); `repoKeyOf` is the seam that phase backs with the repository's git pointers, and
 * {@link foldKeyPath} is the function that phase uses to spell its answers.
 *
 * Known limits: hard links; case-insensitive POSIX volumes; a `link/..` on POSIX (resolved lexically); junctions
 * created after a lease; NTFS's `$UpCase` table is only approximated by the per-unit `toUpperCase` fold; a loopback
 * UNC spelling of a local drive (`\\localhost\C$\…`, `\\127.0.0.1\C$\…`) cannot be told from a remote share and keys
 * apart from `C:\…`.
 */
import { posix, win32 } from "node:path";
import { canonicalPath } from "../verify/canonical-path";

/** When a lease ends: with the holder's session (`until-complete`) or at plan-task integration (`until-integrated`). */
export type LeaseScope = "until-complete" | "until-integrated";

/** One recorded lease holder (a session). */
export interface Holder {
  holderID: string;
  /** The session's work tree (absolute); the base of its relative paths. */
  tree: string;
  /** A child session; root sessions never hold a lease. */
  isChild: boolean;
  /** The plan task the holder works on; required for `until-integrated`. It names the OWNER of the holder's leases. */
  taskRef?: string;
  scope: LeaseScope;
  /** `seams.now()` (epoch ms) when the holderID was first recorded. */
  acquiredAt: number;
  /** `seams.now()` (epoch ms) of the holder's latest acquire, read, search or run; the sweep ages from it. */
  lastSeenAt: number;
}

/** A holder as the caller names it; `acquiredAt` and `lastSeenAt` are stamped by the registry. */
export type HolderInput = Omit<Holder, "acquiredAt" | "lastSeenAt">;

/** The session making a read, search or run (a subset of {@link HolderInput}); `taskRef` names its owner. */
export type LeaseActor = Pick<HolderInput, "holderID" | "tree" | "isChild" | "taskRef">;

/** The effects the registry needs, all synchronous (no `await` between a check and its insert). */
export interface LeaseSeams {
  /** Native realpath; throws when the path does not exist. */
  realpath(p: string): string;
  /**
   * The repository and work tree containing `dir`, or undefined outside any. The answer is folded by the registry
   * exactly like a physical key ({@link foldKeyPath}), so either spelling is accepted.
   */
  repoKeyOf(dir: string): { repo: string; tree: string } | undefined;
  /** The clock, in epoch milliseconds. */
  now(): number;
}

/** Registry options. */
export interface LeaseOptions {
  /** What a child `router_run` does while another holder edits its tree: annotate the result or refuse. */
  runMode: "annotate" | "refuse";
  /** Maximum number of leases held at once. Default 10 000. */
  cap?: number;
  /** Age since `lastSeenAt` at which an `until-complete` holder is swept. Default 6 h. */
  sweepAgeMs?: number;
  /** Path rules to apply (tests). Default `process.platform`. */
  platform?: NodeJS.Platform;
}

/** The normalised identity of one file (see {@link keyOf}). */
export interface PathKey {
  /** The canonical absolute path, `/`-separated, case-folded on win32: decides read conflicts. */
  physical: string;
  /** `r:<repo>\0<rel>` inside a repository, else `x:<physical>`: decides write conflicts. */
  logical: string;
  /** The work tree containing the file (canonical, folded), or null outside any repository. */
  tree: string | null;
  /** The repository (folded), or null outside any. */
  repo: string | null;
  /** Path relative to the tree (`""` for the tree itself), or null outside any repository. FOLDED (upper-cased on win32). */
  rel: string | null;
  /**
   * `rel` in the case the filesystem reports, `/`-separated: the spelling for a git pathspec. `physical`, `tree`,
   * `repo`, `rel` and `logical` are key spellings (folded on win32) and must not be handed to git.
   */
  relOnDisk: string | null;
  /** The absolute path as given (lexically resolved), for messages. */
  display: string;
}

/** A path no stable key can be derived for. */
export interface Unkeyable {
  unkeyable: string;
}

/** The outcome of {@link LeaseRegistry.acquireWrite}. */
export type AcquireResult =
  | { ok: true; leased: string[]; reentrant: string[]; unkeyed: string[] }
  | { ok: false; reason: "held"; holders: [Holder]; path: string; key: string }
  | { ok: false; reason: "unknown-target"; holders: Holder[] }
  | { ok: false; reason: "cap"; limit: number; held: number }
  | { ok: false; reason: "invalid-holder"; message: string };

/** The outcome of {@link LeaseRegistry.checkRead}. */
export type ReadCheck =
  | { ok: true }
  | { ok: false; reason: "underEdit"; holders: Holder[]; path: string }
  | { ok: false; reason: "invalid-holder"; message: string };

/** The outcome of {@link LeaseRegistry.checkRun}. */
export type RunCheck =
  | { ok: true }
  | { ok: true; contaminatedBy: Holder[]; fileCount: number }
  | { ok: false; reason: "run-refused"; holders: Holder[]; fileCount: number }
  | { ok: false; reason: "invalid-holder"; message: string };

/** The outcome of {@link LeaseRegistry.filterSearchResults}. */
export interface FilterResult {
  /** The entries the reader may see: the original strings, in the original order. */
  kept: string[];
  /** How many entries were left out. */
  omitted: number;
  /** The distinct holders of the omitted entries, first-seen order. */
  holders: Holder[];
  /** Present only when the reader is not a valid actor: every entry is then left out. */
  invalid?: string;
}

/** The outcome of {@link LeaseRegistry.release}. */
export interface ReleaseResult {
  released: number;
  /** Leases kept because they are `until-integrated`. */
  retained: number;
}

/** The outcome of {@link LeaseRegistry.releaseTask} and {@link LeaseRegistry.sweep}. */
export interface HoldersReleased {
  /** Leases ended. */
  released: number;
  /** The ids of the holders whose leases ended. */
  holders: string[];
}

/** One lease in a {@link LeaseSnapshot}: one line per holder and recorded (physical, tree) pair of a logical key. */
export interface SnapshotLease {
  logical: string;
  physical: string;
  tree: string | null;
  holderID: string;
  display: string;
}

/** The registry state as plain JSON. */
export interface LeaseSnapshot {
  version: 1;
  /** Epoch ms. */
  takenAt: number;
  holders: Holder[];
  leases: SnapshotLease[];
}

/** The outcome of {@link LeaseRegistry.restore}. */
export type RestoreResult =
  | { ok: true; leases: number }
  | { ok: false; reason: "invalid-snapshot"; message: string };

/** Options of {@link LeaseRegistry.restore}. */
export interface RestoreOptions {
  /** Leave out the `until-complete` holders (and their leases): their sessions did not survive the restart. */
  dropCompleteHolders?: boolean;
}

/** The lease registry. */
export interface LeaseRegistry {
  /**
   * A child session takes write leases on `path` (one path, or an array which is all-or-nothing). `null`, `[]` and any
   * other value that is not a string or an array is a write whose target is unknown. A root session is only checked:
   * nothing is recorded for it. Never throws.
   */
  acquireWrite(holder: HolderInput, path: string | readonly string[] | null): AcquireResult;
  /** A child reader is refused a file another owner leases (same physical file). Root readers are never refused. */
  checkRead(reader: LeaseActor, path: string): ReadCheck;
  /**
   * A run in `tree` while other owners edit that tree, or lease files under the run directory (nested trees,
   * submodules, files outside any repository): annotate or refuse per `runMode` (roots are only annotated).
   */
  checkRun(runner: LeaseActor, tree: string): RunCheck;
  /** Drops the entries of `paths` (relative ones against `tree`) a child reader may not see. */
  filterSearchResults(reader: LeaseActor, tree: string, paths: readonly string[]): FilterResult;
  /** Ends the `until-complete` leases of a holder (idempotent); `until-integrated` leases are kept. */
  release(holderID: string): ReleaseResult;
  /** Ends every lease of the holders working on `taskRef`, whatever their scope. */
  releaseTask(taskRef: string): HoldersReleased;
  /** Ends the leases of `until-complete` holders not seen for `sweepAgeMs`; future stamps are never swept. */
  sweep(): HoldersReleased;
  /** The state as plain JSON. */
  snapshot(): LeaseSnapshot;
  /**
   * Replaces the state with a snapshot after validating all of it (shapes and consistency; stamps in the future are
   * clamped to `now()`); a rejected snapshot leaves the state unchanged.
   */
  restore(snapshot: unknown, opts?: RestoreOptions): RestoreResult;
}

const DEFAULT_CAP = 10_000;
const DEFAULT_SWEEP_AGE_MS = 6 * 60 * 60 * 1000;
/** The longest path accepted (the NTFS extended-length limit), in UTF-16 units. */
const MAX_PATH_CHARS = 32_767;
/** The most segments a path may have. */
const MAX_PATH_SEGMENTS = 4_096;
/** A win32 8.3 short-name segment (`PROGRA~1`, `MARQUI~1.TXT`), which cannot be told from a long name when missing. */
const SHORT_NAME = /^[^.~\\/]{1,6}~\d+(\.[^.]{0,3})?$/i;
/** `\\.\`, `\\?\` and the NT object prefix `\??\`. */
const DEVICE_PREFIX = /^(?:[\\/]{2}[.?]|[\\/]\?\?)[\\/]/;
/** The reasons of unkeyable paths that may still name any file; they fail closed. */
const ALIASING_REASONS: ReadonlySet<string> = new Set([
  "device path",
  "drive-relative path",
  "rooted path without a drive",
  "8.3 short name in a missing path",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return typeof value;
  }
}

function isRoot(path: string): boolean {
  return path === "/" || /^[a-z]:\/$/i.test(path) || /^\/\/[^/]+\/[^/]+\/?$/.test(path);
}

/**
 * Each UTF-16 unit upper-cased when that stays one unit (`ß` stays, `ſ` becomes `S`): an approximation of NTFS's table.
 * A unit whose upper case is longer (`ᾳ` → `ΑΙ`) falls back to its LOWER case, so that `ᾳ` and `ᾼ` (its title case,
 * whose lower case is `ᾳ`) fold to one spelling.
 */
function upcaseUnits(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const unit = text.charAt(index);
    const upper = unit.toUpperCase();
    if (upper.length === 1) {
      out += upper;
      continue;
    }
    const lower = unit.toLowerCase();
    out += lower.length === 1 ? lower : unit;
  }
  return out;
}

/**
 * The key spelling of a path: `/` separators, case-folded on win32 (see the module limits), no trailing `/` except on
 * a root. Applied to physical keys, to the tree and repository a `repoKeyOf` answers with, and to snapshot paths; the
 * 2.1 adapter spells its answers with it.
 */
export function foldKeyPath(text: string, platform: NodeJS.Platform = process.platform): string {
  let out = text.replace(/\\/g, "/");
  if (platform === "win32") out = upcaseUnits(out);
  while (out.length > 1 && out.endsWith("/") && !isRoot(out)) out = out.slice(0, -1);
  return out;
}

/** `\\?\X:\…`, `\\.\X:\…`, `\??\X:\…` → `X:\…`; the `UNC\h\s\…` forms → `\\h\s\…`; other device forms are unkeyable. */
function unwrapDevicePath(text: string): { path: string } | Unkeyable {
  const prefix = DEVICE_PREFIX.exec(text);
  if (prefix === null) return { path: text };
  const rest = text.slice(prefix[0].length);
  const unc = /^UNC[\\/]([\s\S]*)$/i.exec(rest);
  if (unc) return { path: `\\\\${unc[1] ?? ""}` };
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(rest)) return { path: rest };
  return { unkeyable: "device path" };
}

/** The one non-drive device form that names a volume the filesystem can resolve: `\\?\Volume{guid}\…`. */
const VOLUME_DEVICE = /^(?:[\\/]{2}[.?]|[\\/]\?\?)[\\/]Volume\{[0-9a-f-]+\}(?:[\\/]|$)/i;

/**
 * {@link unwrapDevicePath}, and for a `Volume{guid}` form the DOS path the filesystem answers with, if it does. Every
 * other device form (`\\.\pipe\…`, `\\?\GLOBALROOT\…`, `\\.\PhysicalDrive0`, …) is unkeyable without any filesystem
 * call: resolving it could open a pipe or a device.
 */
function normalizeDevice(text: string, realpath: (p: string) => string): { path: string } | Unkeyable {
  const first = unwrapDevicePath(text);
  if (!("unkeyable" in first)) return first;
  if (!VOLUME_DEVICE.test(text)) return first;
  let real: unknown;
  try {
    real = realpath(text);
  } catch {
    return first;
  }
  if (typeof real !== "string") return first;
  const again = unwrapDevicePath(real);
  return "unkeyable" in again ? first : again;
}

/**
 * Why `text` is too big to key (more than 32 767 units, or with `countSegments` more than 4 096 segments), or
 * undefined. The segments are counted on the resolved path, after `..` collapse.
 */
function oversized(text: string, win: boolean, countSegments: boolean): string | undefined {
  if (text.length > MAX_PATH_CHARS) return "path too long";
  if (!countSegments) return undefined;
  let segments = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 47 || (win && code === 92)) {
      segments++;
      if (segments > MAX_PATH_SEGMENTS) return "too many path segments";
    }
  }
  return undefined;
}

/** The canonical spelling of `abs` (an absolute, cleaned path) and the segments of it that do not exist. */
function canonicalize(
  abs: string,
  api: typeof posix,
  realpath: (p: string) => string,
): { canonical: string; tail: string[] } {
  const reached: string[] = [];
  const probe = (p: string): string => {
    const real = realpath(p);
    reached.push(p);
    return real;
  };
  let canonical: string;
  if ((api === win32) === (process.platform === "win32")) {
    canonical = canonicalPath(abs, probe);
  } else {
    // canonicalPath resolves with the host's path rules; for the other platform's rules, the same walk with theirs.
    canonical = abs;
    let head = abs;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = probe(head);
        canonical = missing.length === 0 ? real : api.join(real, ...missing.reverse());
        break;
      } catch {
        const parent = api.dirname(head);
        if (parent === head) break;
        missing.push(api.basename(head));
        head = parent;
      }
    }
  }
  const head = reached[0];
  const rest = head === undefined ? abs.slice(api.parse(abs).root.length) : abs.slice(head.length);
  return { canonical, tail: rest.split(api.sep).filter((segment) => segment !== "") };
}

function keyOfIn(
  raw: unknown,
  base: string,
  seams: LeaseSeams,
  platform: NodeJS.Platform,
  asDirectory: boolean,
): PathKey | Unkeyable {
  // 1. unkeyable inputs
  if (typeof raw !== "string") return { unkeyable: "not a string" };
  if (raw.trim() === "") return { unkeyable: "empty path" };
  if (raw.includes("\0")) return { unkeyable: "NUL in path" };
  const win = platform === "win32";
  const api = win ? win32 : posix;
  let text = raw;
  let root = typeof base === "string" ? base : "";
  const tooBig = oversized(text, win, false) ?? oversized(root, win, false);
  if (tooBig !== undefined) return { unkeyable: tooBig };
  // 2. win32: unwrap device forms; refuse unresolvable device forms and drive-relative paths
  if (win) {
    const unwrapped = normalizeDevice(text, (p) => seams.realpath(p));
    if ("unkeyable" in unwrapped) return unwrapped;
    text = unwrapped.path;
    if (/^[A-Za-z]:(?![\\/])/.test(text)) return { unkeyable: "drive-relative path" };
    // `\x` is on the drive of the process, which is not necessarily the one of the base.
    if (/^[\\/](?![\\/])/.test(text)) return { unkeyable: "rooted path without a drive" };
    const unwrappedBase = normalizeDevice(root, (p) => seams.realpath(p));
    if ("unkeyable" in unwrappedBase) return unwrappedBase;
    root = unwrappedBase.path;
  }
  if (!api.isAbsolute(text) && !api.isAbsolute(root)) return { unkeyable: "relative path without an absolute base" };
  // 3. lexical resolution
  const display = api.resolve(root, text);
  const collapsed = oversized(display, win, true);
  if (collapsed !== undefined) return { unkeyable: collapsed };
  // 4. win32: per segment, strip a stream suffix, then trailing dots and spaces
  const volume = api.parse(display).root;
  let absolute = display;
  if (win) {
    const cleaned: string[] = [];
    for (const segment of display.slice(volume.length).split(api.sep)) {
      if (segment === "") continue;
      const colon = segment.indexOf(":");
      const name = (colon >= 0 ? segment.slice(0, colon) : segment).replace(/[. ]+$/, "");
      if (name === "") return { unkeyable: "empty path segment" };
      cleaned.push(name);
    }
    absolute = volume + cleaned.join(api.sep);
  }
  // 5. canonical form of the nearest existing ancestor
  const { canonical: found, tail } = canonicalize(absolute, api, (p) => seams.realpath(p));
  let canonical = found;
  if (win) {
    const unwrapped = unwrapDevicePath(canonical);
    if ("unkeyable" in unwrapped) return unwrapped;
    canonical = unwrapped.path;
    // 6. an 8.3-looking name in the part that does not exist cannot be expanded
    if (tail.some((segment) => SHORT_NAME.test(segment))) return { unkeyable: "8.3 short name in a missing path" };
  }
  // 7. physical key
  const physical = foldKeyPath(canonical, platform);
  // 8. repository identity, folded exactly like the physical key
  let id: { repo: string; tree: string } | undefined;
  try {
    const answer: unknown = seams.repoKeyOf(asDirectory ? canonical : api.dirname(canonical));
    if (isRecord(answer) && typeof answer.repo === "string" && typeof answer.tree === "string") {
      id = { repo: foldKeyPath(answer.repo, platform), tree: foldKeyPath(answer.tree, platform) };
    }
  } catch {
    id = undefined;
  }
  if (id !== undefined) {
    const prefix = id.tree.endsWith("/") ? id.tree : `${id.tree}/`;
    let rel: string | undefined;
    if (physical === id.tree || `${physical}/` === prefix) rel = "";
    else if (physical.startsWith(prefix)) rel = physical.slice(prefix.length);
    if (rel !== undefined) {
      // Folding keeps the length of every unit, so the tail of the unfolded path is the on-disk spelling of `rel`.
      const disk = foldKeyPath(canonical, "linux");
      const relOnDisk = rel === "" ? "" : disk.slice(disk.length - rel.length);
      return { physical, logical: `r:${id.repo}\0${rel}`, tree: id.tree, repo: id.repo, rel, relOnDisk, display };
    }
  }
  return { physical, logical: `x:${physical}`, tree: null, repo: null, rel: null, relOnDisk: null, display };
}

/**
 * The key of one file: every spelling of it (case, separators, `..`, `\\?\`, `\\.\X:\`, `\??\`, trailing dots or
 * spaces, NTFS streams, junctions, symlinks and 8.3 names of existing segments) maps to the same key. `raw` is
 * resolved against `base`; a path no stable key exists for (empty, NUL, over 32 767 characters or 4 096 segments,
 * an unresolvable device or drive-relative form, 8.3 name in the missing part) gives `{ unkeyable: reason }`. Known
 * limits: see the module doc.
 */
export function keyOf(
  raw: unknown,
  base: string,
  seams: LeaseSeams,
  platform: NodeJS.Platform = process.platform,
): PathKey | Unkeyable {
  return keyOfIn(raw, base, seams, platform, false);
}

/** The run note a contaminated `router_run` result carries (holder ids joined with `, `). */
export function formatRunNote(holders: readonly (Holder | string)[], n: number): string {
  const ids = holders.map((holder) => (typeof holder === "string" ? holder : holder.holderID));
  return `[router] ran while ${ids.join(", ")} edits ${n} file(s); result may be contaminated`;
}

/** One (physical, tree) spelling a logical key was written in. */
interface Pair {
  physical: string;
  tree: string | null;
}

interface LeaseEntry {
  /** The sessions holding the lease, first writer first. All of them have one owner; the lease ends with the last. */
  holders: Set<string>;
  /** The owner of every holder (`t:<taskRef>` or `h:<holderID>`). */
  owner: string;
  display: string;
  /** The repository of an `r:` key, else null. */
  repo: string | null;
  /** Keyed by {@link pairKey}. */
  pairs: Map<string, Pair>;
}

interface HolderRecord {
  holder: Holder;
  /** `t:<taskRef>` or `h:<holderID>`. */
  owner: string;
  keys: Set<string>;
}

interface State {
  leases: Map<string, LeaseEntry>;
  holders: Map<string, HolderRecord>;
  /** repository → holderID → number of logical keys held in it. */
  repoHolders: Map<string, Map<string, number>>;
  tasks: Map<string, Set<string>>;
  /** owner → number of recorded holders. */
  owners: Map<string, number>;
  /** tree (folded; "" for no tree) → the logical keys with a pair in it. Bounds a run check to its tree. */
  byTree: Map<string, Set<string>>;
  /** Every directory (folded) that is an ancestor-or-self of a leased physical path → the logical keys below it. */
  byDir: Map<string, Set<string>>;
}

function emptyState(): State {
  return {
    leases: new Map(),
    holders: new Map(),
    repoHolders: new Map(),
    tasks: new Map(),
    owners: new Map(),
    byTree: new Map(),
    byDir: new Map(),
  };
}

/**
 * The directories a folded physical path lies under, itself included (`/a/b` → `/`, `/a`, `/a/b`; `C:/a` → `C:/`,
 * `C:/a`); a root is listed with and without its trailing `/`. These are the keys of {@link State.byDir}.
 */
function dirPrefixes(physical: string): string[] {
  const out = new Set<string>([physical]);
  for (let index = physical.indexOf("/"); index >= 0; index = physical.indexOf("/", index + 1)) {
    const withSlash = physical.slice(0, index + 1);
    if (isRoot(withSlash)) {
      out.add(withSlash);
      if (withSlash.length > 1) out.add(withSlash.slice(0, -1));
    } else if (index > 0) {
      out.add(physical.slice(0, index));
    }
  }
  return [...out];
}

function addToIndex(index: Map<string, Set<string>>, key: string, logical: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(logical);
  index.set(key, set);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, logical: string): void {
  const set = index.get(key);
  if (set === undefined) return;
  set.delete(logical);
  if (set.size === 0) index.delete(key);
}

/** Records a (physical, tree) pair of a lease in the run-check indexes. */
function indexPair(state: State, logical: string, pair: Pair): void {
  for (const dir of dirPrefixes(pair.physical)) addToIndex(state.byDir, dir, logical);
  if (pair.tree !== null) addToIndex(state.byTree, pair.tree, logical);
}

function unindexLease(state: State, logical: string, entry: LeaseEntry): void {
  for (const pair of entry.pairs.values()) {
    for (const dir of dirPrefixes(pair.physical)) removeFromIndex(state.byDir, dir, logical);
    if (pair.tree !== null) removeFromIndex(state.byTree, pair.tree, logical);
  }
}

function ownerOf(holderID: string, taskRef: string | undefined): string {
  return taskRef !== undefined ? `t:${taskRef}` : `h:${holderID}`;
}

function pairKey(pair: Pair): string {
  return `${pair.tree ?? ""}\0${pair.physical}`;
}

function recordHolder(state: State, holder: Holder): HolderRecord {
  const record: HolderRecord = { holder, owner: ownerOf(holder.holderID, holder.taskRef), keys: new Set() };
  state.holders.set(holder.holderID, record);
  state.owners.set(record.owner, (state.owners.get(record.owner) ?? 0) + 1);
  if (holder.taskRef !== undefined) {
    const ids = state.tasks.get(holder.taskRef) ?? new Set<string>();
    ids.add(holder.holderID);
    state.tasks.set(holder.taskRef, ids);
  }
  return record;
}

/** Adds a new lease, held by `record`. */
function link(state: State, record: HolderRecord, logical: string, entry: LeaseEntry): void {
  state.leases.set(logical, entry);
  for (const pair of entry.pairs.values()) indexPair(state, logical, pair);
  join(state, record, logical, entry);
}

/** Adds `record` to the holders of an existing lease (its owner is the lease's). */
function join(state: State, record: HolderRecord, logical: string, entry: LeaseEntry): void {
  const holderID = record.holder.holderID;
  if (entry.holders.has(holderID)) return;
  entry.holders.add(holderID);
  record.keys.add(logical);
  if (entry.repo === null) return;
  const counts = state.repoHolders.get(entry.repo) ?? new Map<string, number>();
  counts.set(holderID, (counts.get(holderID) ?? 0) + 1);
  state.repoHolders.set(entry.repo, counts);
}

/**
 * Ends the part of every lease one holder has and forgets the holder; a lease ends only with its last holder (the
 * strongest scope among them decides how long it lives). Returns how many leases ended.
 */
function dropHolder(state: State, holderID: string): number {
  const record = state.holders.get(holderID);
  if (record === undefined) return 0;
  let ended = 0;
  for (const logical of record.keys) {
    const entry = state.leases.get(logical);
    if (entry === undefined) continue;
    entry.holders.delete(holderID);
    if (entry.holders.size === 0) {
      state.leases.delete(logical);
      unindexLease(state, logical, entry);
      ended++;
    }
    if (entry.repo === null) continue;
    const counts = state.repoHolders.get(entry.repo);
    if (counts === undefined) continue;
    const left = (counts.get(holderID) ?? 0) - 1;
    if (left > 0) counts.set(holderID, left);
    else counts.delete(holderID);
    if (counts.size === 0) state.repoHolders.delete(entry.repo);
  }
  state.holders.delete(holderID);
  const owners = (state.owners.get(record.owner) ?? 0) - 1;
  if (owners > 0) state.owners.set(record.owner, owners);
  else state.owners.delete(record.owner);
  const { taskRef } = record.holder;
  if (taskRef !== undefined) {
    const ids = state.tasks.get(taskRef);
    if (ids !== undefined) {
      ids.delete(holderID);
      if (ids.size === 0) state.tasks.delete(taskRef);
    }
  }
  return ended;
}

/** The actor as the caller names it, or why it is invalid. */
function parseActor(value: unknown, platform: NodeJS.Platform): LeaseActor | string {
  if (!isRecord(value)) return "holder must be an object";
  const { holderID, tree, isChild, taskRef } = value;
  if (typeof holderID !== "string" || holderID.trim() === "") return "holderID must be a non-empty string";
  if (typeof tree !== "string" || tree === "") return "tree must be a non-empty string";
  if (!(platform === "win32" ? win32 : posix).isAbsolute(tree)) return "tree must be an absolute path";
  if (typeof isChild !== "boolean") return "isChild must be a boolean";
  if (taskRef !== undefined && (typeof taskRef !== "string" || taskRef.trim() === "")) {
    return "taskRef must be a non-empty string";
  }
  return taskRef === undefined ? { holderID, tree, isChild } : { holderID, tree, isChild, taskRef };
}

/** The holder as the caller names it, or why it is invalid. */
function parseHolderInput(value: unknown, platform: NodeJS.Platform): HolderInput | string {
  const actor = parseActor(value, platform);
  if (typeof actor === "string") return actor;
  const scope = isRecord(value) ? value.scope : undefined;
  if (scope !== "until-complete" && scope !== "until-integrated") return "scope must be until-complete or until-integrated";
  if (scope === "until-integrated" && actor.taskRef === undefined) return "an until-integrated lease requires a taskRef";
  return { ...actor, scope };
}

/** The paths of a write as a list: a string is one path; an array (read once, so a hostile one cannot change) is its items. */
function readPaths(path: unknown): readonly unknown[] {
  try {
    if (Array.isArray(path)) return Array.from(path as readonly unknown[]);
    return typeof path === "string" ? [path] : [];
  } catch {
    return [];
  }
}

/** A {@link LeaseActor} with the owner its leases belong to. */
type BoundActor = LeaseActor & { owner: string };

function sameHolder(a: HolderInput, b: HolderInput): boolean {
  return a.tree === b.tree && a.scope === b.scope && a.taskRef === b.taskRef && a.isChild === b.isChild;
}

function copyHolder(holder: Holder): Holder {
  return { ...holder };
}

/** The seams with a per-call cache, so a batch of paths shares the canonicalisation of its directories. */
function memoize(seams: LeaseSeams): LeaseSeams {
  const real = new Map<string, { value: string } | { error: unknown }>();
  const repos = new Map<string, { repo: string; tree: string } | undefined>();
  return {
    realpath(p: string): string {
      const hit = real.get(p);
      if (hit !== undefined) {
        if ("error" in hit) throw hit.error;
        return hit.value;
      }
      try {
        const value = seams.realpath(p);
        real.set(p, { value });
        return value;
      } catch (error) {
        real.set(p, { error });
        throw error;
      }
    },
    repoKeyOf(dir: string): { repo: string; tree: string } | undefined {
      if (repos.has(dir)) return repos.get(dir);
      const id = seams.repoKeyOf(dir);
      repos.set(dir, id);
      return id;
    },
    now: () => seams.now(),
  };
}

/** Whether `physical` is `dir` or lies under it (both folded keys). */
function isUnder(physical: string, dir: string): boolean {
  return physical === dir || physical.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/**
 * A lease registry over `seams`. Throws a TypeError only for an invalid `runMode` or `cap`; every other input, however
 * malformed, gets a result.
 * Indexes: `leases` by logical key, `holders` by id, `repoHolders` by repository, `tasks` by taskRef, `owners` by owner.
 * A write check is O(1) in the registry (plus the O(depth) realpath calls of the key derivation); a run check reads
 * the leases of the run tree (`byTree`) and of the directories under the run directory (`byDir`, every ancestor of a
 * leased physical path), not all of them; only an unkeyable run directory of a child scans all leases (at most `cap`).
 * Every public method that takes caller input answers a hostile input (throwing getter, revoked Proxy) with
 * `invalid-holder` / an unknown target instead of throwing.
 */
export function createLeaseRegistry(seams: LeaseSeams, opts: LeaseOptions): LeaseRegistry {
  if (!isRecord(opts) || (opts.runMode !== "annotate" && opts.runMode !== "refuse")) {
    throw new TypeError('runMode must be "annotate" or "refuse"');
  }
  const runMode = opts.runMode;
  const cap = opts.cap ?? DEFAULT_CAP;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1) {
    throw new TypeError("cap must be a positive integer");
  }
  const sweepAgeMs =
    typeof opts.sweepAgeMs === "number" && Number.isFinite(opts.sweepAgeMs) && opts.sweepAgeMs > 0
      ? opts.sweepAgeMs
      : DEFAULT_SWEEP_AGE_MS;
  const platform = opts.platform ?? process.platform;
  let state = emptyState();

  const isStale = (record: HolderRecord, now: number): boolean => {
    if (record.holder.scope !== "until-complete") return false;
    const age = now - record.holder.lastSeenAt;
    return age >= 0 && age >= sweepAgeMs;
  };

  /** The record of a holder, swept on the spot (and then undefined) when it is a stale `until-complete` holder. */
  const liveRecord = (holderID: string): HolderRecord | undefined => {
    const record = state.holders.get(holderID);
    if (record === undefined) return undefined;
    if (isStale(record, seams.now())) {
      dropHolder(state, holderID);
      return undefined;
    }
    return record;
  };

  /** The first live holder of a lease, sweeping its stale holders on the spot; undefined when none is left. */
  const liveHolderOf = (entry: LeaseEntry): HolderRecord | undefined => {
    for (const id of [...entry.holders]) {
      const record = liveRecord(id);
      if (record !== undefined) return record;
    }
    return undefined;
  };

  /** Marks a recorded holder as alive. */
  const touch = (holderID: string): void => {
    const record = state.holders.get(holderID);
    if (record !== undefined) record.holder.lastSeenAt = seams.now();
  };

  /**
   * The actor of a read, search or run with its owner. An actor whose holderID is recorded IS that holder: its owner
   * comes from the record (a missing `taskRef` is inherited), and a `taskRef`, `isChild` or `tree` that differs from
   * the record is an invalid holder. Any other actor is its own owner, or the owner its `taskRef` names.
   */
  const bindActor = (value: unknown): BoundActor | string => {
    const parsed = parseActor(value, platform);
    if (typeof parsed === "string") return parsed;
    const record = state.holders.get(parsed.holderID);
    if (record === undefined) return { ...parsed, owner: ownerOf(parsed.holderID, parsed.taskRef) };
    const recorded = record.holder;
    if (parsed.isChild !== recorded.isChild || parsed.tree !== recorded.tree) {
      return `holder ${parsed.holderID} is recorded with a different tree or isChild`;
    }
    if (parsed.taskRef !== undefined && parsed.taskRef !== recorded.taskRef) {
      return `holder ${parsed.holderID} is recorded with a different taskRef`;
    }
    return recorded.taskRef === undefined
      ? { holderID: parsed.holderID, tree: recorded.tree, isChild: recorded.isChild, owner: record.owner }
      : { holderID: parsed.holderID, tree: recorded.tree, isChild: recorded.isChild, taskRef: recorded.taskRef, owner: record.owner };
  };

  /** The live holders of any owner but `selfOwner` that hold at least one lease. */
  const holdersOtherThan = (selfOwner: string): Holder[] => {
    const now = seams.now();
    const holders: Holder[] = [];
    const stale: string[] = [];
    for (const [id, record] of state.holders) {
      if (record.owner === selfOwner || record.keys.size === 0) continue;
      if (isStale(record, now)) stale.push(id);
      else holders.push(copyHolder(record.holder));
    }
    for (const id of stale) dropHolder(state, id);
    return holders;
  };

  /** The live holders of any owner but `selfOwner` that lease files of `repo`. */
  const holdersInRepo = (repo: string, selfOwner: string): Holder[] => {
    const holders: Holder[] = [];
    for (const id of [...(state.repoHolders.get(repo)?.keys() ?? [])]) {
      const record = liveRecord(id);
      if (record !== undefined && record.owner !== selfOwner) holders.push(copyHolder(record.holder));
    }
    return holders;
  };

  /** The repository of a session's work directory, or null when it lies outside any. */
  const repoOfDirectory = (dir: string, base: string, sm: LeaseSeams): string | null => {
    const key = keyOfIn(dir, base, sm, platform, true);
    return "unkeyable" in key ? null : key.repo;
  };

  /** The holders that make `reader` refuse `raw`, with the file's display path. */
  const readConflict = (
    reader: BoundActor,
    raw: unknown,
    base: string,
    sm: LeaseSeams,
  ): { holders: Holder[]; path: string } | undefined => {
    if (!reader.isChild) return undefined;
    const key = keyOfIn(raw, base, sm, platform, false);
    if ("unkeyable" in key) {
      if (!ALIASING_REASONS.has(key.unkeyable)) return undefined;
      const holders = holdersOtherThan(reader.owner);
      return holders.length === 0 ? undefined : { holders, path: typeof raw === "string" ? raw : describeValue(raw) };
    }
    const lease = state.leases.get(key.logical);
    if (lease === undefined || lease.owner === reader.owner || lease.holders.has(reader.holderID)) return undefined;
    if (![...lease.pairs.values()].some((pair) => pair.physical === key.physical)) return undefined;
    const record = liveHolderOf(lease);
    if (record === undefined) return undefined;
    return { holders: [copyHolder(record.holder)], path: key.display };
  };

  const sweep = (): HoldersReleased => {
    const now = seams.now();
    const stale: string[] = [];
    for (const [id, record] of state.holders) {
      if (isStale(record, now)) stale.push(id);
    }
    let released = 0;
    for (const id of stale) released += dropHolder(state, id);
    return { released, holders: stale };
  };

  const acquireWrite = (holderInput: HolderInput, path: string | readonly string[] | null): AcquireResult => {
    const parsed = parseHolderInput(holderInput, platform);
    if (typeof parsed === "string") return { ok: false, reason: "invalid-holder", message: parsed };
    const holder = parsed;
    const known = state.holders.get(holder.holderID);
    if (known !== undefined && !sameHolder(known.holder, holder)) {
      return {
        ok: false,
        reason: "invalid-holder",
        message: `holder ${holder.holderID} is already recorded with a different tree, scope, taskRef or isChild`,
      };
    }
    touch(holder.holderID);
    const owner = ownerOf(holder.holderID, holder.taskRef);

    const raws = readPaths(path);
    const unknownTarget = raws.length === 0;
    const keys = new Map<string, PathKey>();
    const extras = new Map<string, Pair[]>();
    const unkeyed: string[] = [];
    let aliasing = false;
    for (const raw of raws) {
      const key = keyOfIn(raw, holder.tree, seams, platform, false);
      if ("unkeyable" in key) {
        unkeyed.push(typeof raw === "string" ? raw : describeValue(raw));
        if (ALIASING_REASONS.has(key.unkeyable)) aliasing = true;
      } else {
        const first = keys.get(key.logical);
        if (first === undefined) {
          keys.set(key.logical, key);
        } else if (first.physical !== key.physical || first.tree !== key.tree) {
          // The same repo-relative file in another worktree: one more (physical, tree) pair of the same lease.
          const more = extras.get(key.logical) ?? [];
          more.push({ physical: key.physical, tree: key.tree });
          extras.set(key.logical, more);
        }
      }
    }
    const pairsOf = (key: PathKey): Pair[] => [{ physical: key.physical, tree: key.tree }, ...(extras.get(key.logical) ?? [])];

    if (!holder.isChild) {
      for (const [logical, key] of keys) {
        const lease = state.leases.get(logical);
        if (lease === undefined) continue;
        const record = liveHolderOf(lease);
        if (record !== undefined) {
          return { ok: false, reason: "held", holders: [copyHolder(record.holder)], path: key.display, key: logical };
        }
      }
      return { ok: true, leased: [], reentrant: [], unkeyed };
    }

    let swept = false;
    search: for (;;) {
      const fresh: PathKey[] = [];
      const reentrant: string[] = [];
      const joined: { logical: string; entry: LeaseEntry; pairs: Pair[] }[] = [];
      for (const [logical, key] of keys) {
        const lease = state.leases.get(logical);
        if (lease === undefined) {
          fresh.push(key);
          continue;
        }
        const before = state.holders.size;
        const record = liveHolderOf(lease);
        if (state.holders.size !== before) continue search; // a stale holder was swept: look again
        if (record === undefined) {
          fresh.push(key);
        } else if (record.owner === owner) {
          reentrant.push(key.display);
          joined.push({ logical, entry: lease, pairs: pairsOf(key) });
        } else {
          return { ok: false, reason: "held", holders: [copyHolder(record.holder)], path: key.display, key: logical };
        }
      }
      if (aliasing) {
        const holders = holdersOtherThan(owner);
        if (holders.length > 0) return { ok: false, reason: "unknown-target", holders };
      } else if (unknownTarget || unkeyed.length > 0) {
        const repo = repoOfDirectory(holder.tree, holder.tree, seams);
        if (repo !== null) {
          const holders = holdersInRepo(repo, owner);
          if (holders.length > 0) return { ok: false, reason: "unknown-target", holders };
        }
      }
      if (state.leases.size + fresh.length > cap) {
        if (!swept) {
          swept = true;
          sweep();
          continue;
        }
        return { ok: false, reason: "cap", limit: cap, held: state.leases.size };
      }
      const stamp = seams.now();
      let record = state.holders.get(holder.holderID);
      if (record === undefined && (fresh.length > 0 || joined.length > 0)) {
        record = recordHolder(state, { ...holder, acquiredAt: stamp, lastSeenAt: stamp });
      }
      if (record !== undefined) {
        record.holder.lastSeenAt = stamp;
        for (const key of fresh) {
          link(state, record, key.logical, {
            holders: new Set(),
            owner,
            display: key.display,
            repo: key.repo,
            pairs: new Map(pairsOf(key).map((pair): [string, Pair] => [pairKey(pair), pair])),
          });
        }
        for (const { logical, entry, pairs } of joined) {
          join(state, record, logical, entry);
          for (const pair of pairs) {
            if (entry.pairs.has(pairKey(pair))) continue;
            entry.pairs.set(pairKey(pair), pair);
            indexPair(state, logical, pair);
          }
        }
      }
      for (const key of keys.values()) {
        const entry = state.leases.get(key.logical);
        if (entry === undefined || entry.owner !== owner) continue;
        for (const id of entry.holders) {
          const sibling = state.holders.get(id);
          if (sibling !== undefined) sibling.holder.lastSeenAt = stamp;
        }
      }
      return { ok: true, leased: fresh.map((key) => key.display), reentrant, unkeyed };
    }
  };

  const checkRead = (readerInput: LeaseActor, path: string): ReadCheck => {
    const reader = bindActor(readerInput);
    if (typeof reader === "string") return { ok: false, reason: "invalid-holder", message: reader };
    touch(reader.holderID);
    const conflict = readConflict(reader, path, reader.tree, seams);
    return conflict === undefined
      ? { ok: true }
      : { ok: false, reason: "underEdit", holders: conflict.holders, path: conflict.path };
  };

  const checkRun = (runnerInput: LeaseActor, tree: string): RunCheck => {
    const runner = bindActor(runnerInput);
    if (typeof runner === "string") return { ok: false, reason: "invalid-holder", message: runner };
    touch(runner.holderID);
    const key = keyOfIn(tree, runner.tree, seams, platform, true);
    const unkeyed = "unkeyable" in key;
    // A run directory no key exists for may be any directory: a root run is only annotated, a child run fails closed.
    if (unkeyed && !runner.isChild) return { ok: true };
    const now = seams.now();
    const holders = new Map<string, Holder>();
    const stale = new Set<string>();
    let fileCount = 0;
    // Candidates come from the indexes (the run tree, the directories under the run directory), not from every lease.
    const candidates = new Set<string>();
    if (unkeyed) {
      for (const logical of state.leases.keys()) candidates.add(logical);
    } else {
      for (const logical of key.tree === null ? [] : state.byTree.get(key.tree) ?? []) candidates.add(logical);
      const dir = key.physical;
      const variants = dir.endsWith("/") ? [dir, dir.slice(0, -1)] : [dir, `${dir}/`];
      for (const variant of variants) {
        for (const logical of state.byDir.get(variant) ?? []) candidates.add(logical);
      }
    }
    for (const logical of candidates) {
      const entry = state.leases.get(logical);
      if (entry === undefined || entry.owner === runner.owner || entry.holders.has(runner.holderID)) continue;
      if (!unkeyed) {
        let hit = false;
        for (const pair of entry.pairs.values()) {
          if ((key.tree !== null && pair.tree === key.tree) || isUnder(pair.physical, key.physical)) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
      }
      let first: HolderRecord | undefined;
      for (const id of entry.holders) {
        const record = state.holders.get(id);
        if (record === undefined) continue;
        if (isStale(record, now)) stale.add(id);
        else if (first === undefined) first = record;
      }
      if (first === undefined) continue;
      fileCount++;
      if (!holders.has(first.holder.holderID)) holders.set(first.holder.holderID, copyHolder(first.holder));
    }
    for (const id of stale) dropHolder(state, id);
    if (holders.size === 0) return { ok: true };
    if (!runner.isChild || runMode === "annotate") return { ok: true, contaminatedBy: [...holders.values()], fileCount };
    return { ok: false, reason: "run-refused", holders: [...holders.values()], fileCount };
  };

  const filterSearchResults = (readerInput: LeaseActor, tree: string, paths: readonly string[]): FilterResult => {
    const list: readonly string[] = Array.isArray(paths) ? paths : [];
    const reader = bindActor(readerInput);
    if (typeof reader === "string") return { kept: [], omitted: list.length, holders: [], invalid: reader };
    touch(reader.holderID);
    const foreign = state.holders.size > (state.owners.get(reader.owner) ?? 0);
    if (!reader.isChild || !foreign) return { kept: [...list], omitted: 0, holders: [] };
    // Relative entries are the reader's: against the search tree, or against the reader's own tree when there is none.
    const base = typeof tree === "string" && (platform === "win32" ? win32 : posix).isAbsolute(tree) ? tree : reader.tree;
    const sm = memoize(seams);
    const kept: string[] = [];
    const holders = new Map<string, Holder>();
    let omitted = 0;
    for (const entry of list) {
      const conflict = readConflict(reader, entry, base, sm);
      if (conflict === undefined) {
        kept.push(entry);
        continue;
      }
      omitted++;
      for (const holder of conflict.holders) {
        if (!holders.has(holder.holderID)) holders.set(holder.holderID, holder);
      }
    }
    return { kept, omitted, holders: [...holders.values()] };
  };

  const release = (holderID: string): ReleaseResult => {
    const record = state.holders.get(holderID);
    if (record === undefined) return { released: 0, retained: 0 };
    if (record.holder.scope === "until-integrated") return { released: 0, retained: record.keys.size };
    return { released: dropHolder(state, holderID), retained: 0 };
  };

  const releaseTask = (taskRef: string): HoldersReleased => {
    const ids = [...(state.tasks.get(taskRef) ?? [])];
    let released = 0;
    for (const id of ids) released += dropHolder(state, id);
    return { released, holders: ids };
  };

  const snapshot = (): LeaseSnapshot => {
    const leases: SnapshotLease[] = [];
    for (const [logical, entry] of state.leases) {
      for (const holderID of entry.holders) {
        for (const pair of entry.pairs.values()) {
          leases.push({ logical, physical: pair.physical, tree: pair.tree, holderID, display: entry.display });
        }
      }
    }
    return {
      version: 1,
      takenAt: seams.now(),
      holders: [...state.holders.values()].map((record) => copyHolder(record.holder)),
      leases,
    };
  };

  const restore = (input: unknown, restoreOpts?: RestoreOptions): RestoreResult => {
    const bad = (message: string): RestoreResult => ({ ok: false, reason: "invalid-snapshot", message });
    if (!isRecord(input)) return bad("snapshot must be an object");
    if (input.version !== 1) return bad("unsupported snapshot version");
    if (typeof input.takenAt !== "number" || !Number.isFinite(input.takenAt)) return bad("takenAt must be a finite number");
    const { holders, leases } = input;
    if (!Array.isArray(holders) || !Array.isArray(leases)) return bad("holders and leases must be arrays");
    const dropComplete = restoreOpts?.dropCompleteHolders === true;
    const api = platform === "win32" ? win32 : posix;
    const now = seams.now();
    const next = emptyState();
    /** Every holder of the snapshot, and whether it is kept. */
    const listed = new Map<string, boolean>();
    /** holderID → owner, for every holder of the snapshot. */
    const owners = new Map<string, string>();
    /** logical key → the owner its lines name; the holders of one lease share an owner. */
    const leaseOwners = new Map<string, string>();
    const lines = new Set<string>();
    for (const value of holders) {
      const parsed = parseHolderInput(value, platform);
      if (typeof parsed === "string") return bad(`invalid holder: ${parsed}`);
      if (!parsed.isChild) return bad(`holder ${parsed.holderID} is not a child session`);
      const stamps: Record<string, unknown> = isRecord(value) ? value : {};
      const acquiredAt = stamps.acquiredAt;
      if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) {
        return bad(`holder ${parsed.holderID} has no valid acquiredAt`);
      }
      const seen = stamps.lastSeenAt === undefined ? acquiredAt : stamps.lastSeenAt;
      if (typeof seen !== "number" || !Number.isFinite(seen)) return bad(`holder ${parsed.holderID} has an invalid lastSeenAt`);
      if (listed.has(parsed.holderID)) return bad(`duplicate holder ${parsed.holderID}`);
      const keep = !(dropComplete && parsed.scope === "until-complete");
      listed.set(parsed.holderID, keep);
      owners.set(parsed.holderID, ownerOf(parsed.holderID, parsed.taskRef));
      if (keep) {
        recordHolder(next, { ...parsed, acquiredAt: Math.min(acquiredAt, now), lastSeenAt: Math.min(seen, now) });
      }
    }
    for (const value of leases) {
      if (!isRecord(value)) return bad("a lease must be an object");
      const { logical, physical, tree, holderID, display } = value;
      if (typeof logical !== "string" || logical === "") return bad("a lease has no logical key");
      if (typeof physical !== "string" || typeof display !== "string") return bad(`lease ${logical} has no physical or display path`);
      if (tree !== null && typeof tree !== "string") return bad(`lease ${logical} has an invalid tree`);
      if (typeof holderID !== "string") return bad(`lease ${logical} has no holderID`);
      const keep = listed.get(holderID);
      if (keep === undefined) return bad(`lease ${logical} names an unknown holder ${holderID}`);
      if (physical !== foldKeyPath(physical, platform)) return bad(`lease ${logical} has a physical path that is not normalised`);
      let repo: string | null = null;
      if (logical.startsWith("x:")) {
        if (tree !== null) return bad(`lease ${logical} is outside any repository but has a tree`);
        if (logical !== `x:${physical}`) return bad(`lease ${logical} does not match its physical path`);
        if (!api.isAbsolute(physical)) return bad(`lease ${logical} has a physical path that is not absolute`);
      } else if (logical.startsWith("r:")) {
        if (typeof tree !== "string") return bad(`lease ${logical} is in a repository but has no tree`);
        if (tree !== foldKeyPath(tree, platform) || !api.isAbsolute(tree)) return bad(`lease ${logical} has a tree that is not normalised`);
        const prefix = tree.endsWith("/") ? tree : `${tree}/`;
        const rel = physical === tree ? "" : physical.startsWith(prefix) ? physical.slice(prefix.length) : undefined;
        if (rel === undefined) return bad(`lease ${logical} lies outside its tree`);
        const sep = logical.indexOf("\0");
        if (sep < 0 || logical.slice(sep + 1) !== rel) return bad(`lease ${logical} does not match its physical path`);
        repo = logical.slice(2, sep);
        if (repo !== foldKeyPath(repo, platform)) return bad(`lease ${logical} has a repository that is not normalised`);
      } else {
        return bad(`lease ${logical} has an unknown key space`);
      }
      const pair: Pair = { physical, tree };
      // Duplicates are found in any order of the lines and whether or not the holder is kept.
      const line = JSON.stringify([logical, holderID, tree, physical]);
      if (lines.has(line)) return bad(`duplicate lease ${logical}`);
      lines.add(line);
      const owner = owners.get(holderID) ?? "";
      const seenOwner = leaseOwners.get(logical);
      if (seenOwner !== undefined && seenOwner !== owner) return bad(`duplicate lease ${logical}: held by holders of different owners`);
      leaseOwners.set(logical, owner);
      if (!keep) continue;
      const record = next.holders.get(holderID);
      if (record === undefined) return bad(`lease ${logical} names an unknown holder ${holderID}`);
      const existing = next.leases.get(logical);
      if (existing === undefined) {
        link(next, record, logical, { holders: new Set(), owner, display, repo, pairs: new Map([[pairKey(pair), pair]]) });
        continue;
      }
      join(next, record, logical, existing);
      if (!existing.pairs.has(pairKey(pair))) {
        existing.pairs.set(pairKey(pair), pair);
        indexPair(next, logical, pair);
      }
    }
    if (next.leases.size > cap) return bad(`${next.leases.size} leases exceed the cap of ${cap}`);
    state = next;
    return { ok: true, leases: next.leases.size };
  };

  /** Never lets a throwing getter or revoked Proxy in the caller's input escape: `fallback` answers instead. */
  const safe = <Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
    fallback: (message: string) => Result,
  ): ((...args: Args) => Result) => {
    return (...args: Args): Result => {
      try {
        return fn(...args);
      } catch (error) {
        return fallback(`the input could not be read: ${describeValue(error)}`);
      }
    };
  };

  return {
    acquireWrite: safe(acquireWrite, (message): AcquireResult => ({ ok: false, reason: "invalid-holder", message })),
    checkRead: safe(checkRead, (message): ReadCheck => ({ ok: false, reason: "invalid-holder", message })),
    checkRun: safe(checkRun, (message): RunCheck => ({ ok: false, reason: "invalid-holder", message })),
    filterSearchResults: safe(
      filterSearchResults,
      (message): FilterResult => ({ kept: [], omitted: 0, holders: [], invalid: message }),
    ),
    release: safe(release, (): ReleaseResult => ({ released: 0, retained: 0 })),
    releaseTask: safe(releaseTask, (): HoldersReleased => ({ released: 0, holders: [] })),
    sweep,
    snapshot,
    restore: safe(restore, (message): RestoreResult => ({ ok: false, reason: "invalid-snapshot", message })),
  };
}
