/**
 * src/router/leases.ts — the file lease registry (ADR 0007 D7, Phase 1.3). A child session that writes a file holds a
 * lease on it until it completes (`until-complete`) or its plan task is integrated (`until-integrated`); a second
 * writer, and a child that reads or searches the file, is refused with the holder named. Root sessions are never
 * refused a read, a search or a run, and a root write is refused only while a child holds the file.
 *
 * Two keys per file: the LOGICAL key (repository + repo-relative path) decides write conflicts, so one file edited in
 * two worktrees of one repository collides; the PHYSICAL key (the canonical, case-folded absolute path) decides read
 * conflicts, so a read of the same relative path in another worktree is not a conflict.
 *
 * Pure policy over injected seams: the filesystem is reached only through {@link LeaseSeams}, every seam is
 * synchronous, and the registry contains no `await`, so a check and its insert are atomic. The registry is unwired
 * until Phase 2.1 (v2 only); `repoKeyOf` is the seam that phase backs with the repository's git pointers.
 */
import { posix, win32 } from "node:path";
import { canonicalPath } from "../verify/dispatch";

/** When a lease ends: with the holder's session (`until-complete`) or at plan-task integration (`until-integrated`). */
export type LeaseScope = "until-complete" | "until-integrated";

/** One recorded lease holder (a session). */
export interface Holder {
  holderID: string;
  /** The session's work tree (absolute); the base of its relative paths. */
  tree: string;
  /** A child session; root sessions never hold a lease. */
  isChild: boolean;
  /** The plan task the holder works on; required for `until-integrated`. */
  taskRef?: string;
  scope: LeaseScope;
  /** `seams.now()` when the holderID was first recorded. */
  acquiredAt: number;
}

/** A holder as the caller names it; `acquiredAt` is stamped by the registry. */
export type HolderInput = Omit<Holder, "acquiredAt">;

/** The session making a read, search or run (a subset of {@link HolderInput}). */
export type LeaseActor = Pick<HolderInput, "holderID" | "tree" | "isChild">;

/** The effects the registry needs, all synchronous (no `await` between a check and its insert). */
export interface LeaseSeams {
  /** Native realpath; throws when the path does not exist. */
  realpath(p: string): string;
  /** The repository and work tree containing `dir` (both canonical: real, `/`, case-folded), or undefined outside any. */
  repoKeyOf(dir: string): { repo: string; tree: string } | undefined;
  now(): number;
}

/** Registry options. */
export interface LeaseOptions {
  /** What a child `router_run` does while another holder edits its tree: annotate the result or refuse. */
  runMode: "annotate" | "refuse";
  /** Maximum number of leases held at once. Default 10 000. */
  cap?: number;
  /** Age at which an `until-complete` holder is swept. Default 6 h. */
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
  /** The work tree containing the file (canonical), or null outside any repository. */
  tree: string | null;
  repo: string | null;
  /** Path relative to the tree (`""` for the tree itself), or null outside any repository. */
  rel: string | null;
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
  | { ok: false; reason: "underEdit"; holders: [Holder]; path: string };

/** The outcome of {@link LeaseRegistry.checkRun}. */
export type RunCheck =
  | { ok: true }
  | { ok: true; contaminatedBy: Holder[]; fileCount: number }
  | { ok: false; reason: "run-refused"; holders: Holder[]; fileCount: number };

/** The outcome of {@link LeaseRegistry.filterSearchResults}. */
export interface FilterResult {
  /** The entries the reader may see: the original strings, in the original order. */
  kept: string[];
  /** How many entries were left out. */
  omitted: number;
  /** The distinct holders of the omitted entries, first-seen order. */
  holders: Holder[];
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

/** One lease in a {@link LeaseSnapshot}. */
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
  takenAt: number;
  holders: Holder[];
  leases: SnapshotLease[];
}

/** The outcome of {@link LeaseRegistry.restore}. */
export type RestoreResult =
  | { ok: true; leases: number }
  | { ok: false; reason: "invalid-snapshot"; message: string };

/** The lease registry. */
export interface LeaseRegistry {
  /**
   * A child session takes write leases on `path` (one path, or an array which is all-or-nothing). `null` (or `[]`) is a
   * write whose target is unknown. A root session is only checked: nothing is recorded for it.
   */
  acquireWrite(holder: HolderInput, path: string | readonly string[] | null): AcquireResult;
  /** A child reader is refused a file another holder leases (same physical file). Root readers are never refused. */
  checkRead(reader: LeaseActor, path: string): ReadCheck;
  /** A run in `tree` while other holders edit that tree: annotate or refuse per `runMode` (roots are only annotated). */
  checkRun(runner: LeaseActor, tree: string): RunCheck;
  /** Drops the entries of `paths` (relative ones against `tree`) a child reader may not see. */
  filterSearchResults(reader: LeaseActor, tree: string, paths: readonly string[]): FilterResult;
  /** Ends the `until-complete` leases of a holder (idempotent); `until-integrated` leases are kept. */
  release(holderID: string): ReleaseResult;
  /** Ends every lease of the holders working on `taskRef`, whatever their scope. */
  releaseTask(taskRef: string): HoldersReleased;
  /** Ends the leases of `until-complete` holders at least `sweepAgeMs` old; future stamps are never swept. */
  sweep(): HoldersReleased;
  /** The state as plain JSON. */
  snapshot(): LeaseSnapshot;
  /** Replaces the state with a snapshot after validating all of it; a rejected snapshot leaves the state unchanged. */
  restore(snapshot: unknown): RestoreResult;
}

const DEFAULT_CAP = 10_000;
const DEFAULT_SWEEP_AGE_MS = 6 * 60 * 60 * 1000;
/** A win32 8.3 short-name segment (`PROGRA~1`, `MARQUI~1.TXT`), which cannot be told from a long name when missing. */
const SHORT_NAME = /^[^.~\\/]{1,6}~\d+(\.[^.]{0,3})?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fold(text: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? text.toLowerCase() : text;
}

/** `\\?\X:\…` → `X:\…`, `\\?\UNC\h\s\…` → `\\h\s\…`; other device forms are unkeyable (win32 only). */
function unwrapDevicePath(text: string): { path: string } | Unkeyable {
  const unc = /^[\\/]{2}\?[\\/]UNC[\\/](.*)$/i.exec(text);
  if (unc) return { path: `\\\\${unc[1] ?? ""}` };
  const drive = /^[\\/]{2}\?[\\/]([A-Za-z]:(?:[\\/].*)?)$/.exec(text);
  if (drive) return { path: drive[1] ?? "" };
  if (/^[\\/]{2}[.?][\\/]/.test(text)) return { unkeyable: "device path" };
  return { path: text };
}

function isRoot(path: string): boolean {
  return path === "/" || /^[a-z]:\/$/i.test(path) || /^\/\/[^/]+\/[^/]+\/?$/.test(path);
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
  // 2. win32: unwrap \\?\ forms; refuse other device forms and drive-relative paths
  if (win) {
    const unwrapped = unwrapDevicePath(text);
    if ("unkeyable" in unwrapped) return unwrapped;
    text = unwrapped.path;
    if (/^[A-Za-z]:(?![\\/])/.test(text)) return { unkeyable: "drive-relative path" };
    const unwrappedBase = unwrapDevicePath(root);
    if ("unkeyable" in unwrappedBase) return unwrappedBase;
    root = unwrappedBase.path;
  }
  if (!api.isAbsolute(text) && !api.isAbsolute(root)) return { unkeyable: "relative path without an absolute base" };
  // 3. lexical resolution
  const display = api.resolve(root, text);
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
  let physical = fold(canonical.replace(/\\/g, "/"), platform);
  while (physical.length > 1 && physical.endsWith("/") && !isRoot(physical)) physical = physical.slice(0, -1);
  // 8. repository identity
  let id: { repo: string; tree: string } | undefined;
  try {
    id = seams.repoKeyOf(asDirectory ? canonical : api.dirname(canonical));
  } catch {
    id = undefined;
  }
  if (id !== undefined && (typeof id.repo !== "string" || typeof id.tree !== "string")) id = undefined;
  if (id !== undefined) {
    const prefix = id.tree.endsWith("/") ? id.tree : `${id.tree}/`;
    let rel: string | undefined;
    if (physical === id.tree || `${physical}/` === prefix) rel = "";
    else if (physical.startsWith(prefix)) rel = physical.slice(prefix.length);
    if (rel !== undefined) {
      return { physical, logical: `r:${id.repo}\0${rel}`, tree: id.tree, repo: id.repo, rel, display };
    }
  }
  return { physical, logical: `x:${physical}`, tree: null, repo: null, rel: null, display };
}

/**
 * The key of one file: every spelling of it (case, separators, `..`, `\\?\`, trailing dots or spaces, NTFS streams,
 * junctions, symlinks and 8.3 names of existing segments) maps to the same key. `raw` is resolved against `base`;
 * a path no stable key exists for (empty, NUL, device or drive-relative form, 8.3 name in the missing part) gives
 * `{ unkeyable: reason }`. Known limits: hard links, Unicode case folding, case-insensitive POSIX volumes, a
 * `link/..` on POSIX (resolved lexically), junctions created after a lease.
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

interface LeaseEntry {
  holderID: string;
  physical: string;
  tree: string | null;
  display: string;
}

interface HolderRecord {
  holder: Holder;
  keys: Set<string>;
}

interface State {
  leases: Map<string, LeaseEntry>;
  holders: Map<string, HolderRecord>;
  treeHolders: Map<string, Map<string, number>>;
  tasks: Map<string, Set<string>>;
}

function emptyState(): State {
  return { leases: new Map(), holders: new Map(), treeHolders: new Map(), tasks: new Map() };
}

function recordHolder(state: State, holder: Holder): HolderRecord {
  const record: HolderRecord = { holder, keys: new Set() };
  state.holders.set(holder.holderID, record);
  if (holder.taskRef !== undefined) {
    const ids = state.tasks.get(holder.taskRef) ?? new Set<string>();
    ids.add(holder.holderID);
    state.tasks.set(holder.taskRef, ids);
  }
  return record;
}

function link(state: State, record: HolderRecord, logical: string, entry: LeaseEntry): void {
  state.leases.set(logical, entry);
  record.keys.add(logical);
  if (entry.tree === null) return;
  const counts = state.treeHolders.get(entry.tree) ?? new Map<string, number>();
  counts.set(entry.holderID, (counts.get(entry.holderID) ?? 0) + 1);
  state.treeHolders.set(entry.tree, counts);
}

/** Ends every lease of one holder and forgets it; returns how many leases ended. */
function dropHolder(state: State, holderID: string): number {
  const record = state.holders.get(holderID);
  if (record === undefined) return 0;
  let ended = 0;
  for (const logical of record.keys) {
    const entry = state.leases.get(logical);
    if (entry === undefined) continue;
    state.leases.delete(logical);
    ended++;
    if (entry.tree === null) continue;
    const counts = state.treeHolders.get(entry.tree);
    if (counts === undefined) continue;
    const left = (counts.get(holderID) ?? 0) - 1;
    if (left > 0) counts.set(holderID, left);
    else counts.delete(holderID);
    if (counts.size === 0) state.treeHolders.delete(entry.tree);
  }
  state.holders.delete(holderID);
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

/** The holder as the caller names it, or why it is invalid. */
function parseHolderInput(value: unknown): HolderInput | string {
  if (!isRecord(value)) return "holder must be an object";
  const { holderID, tree, isChild, scope, taskRef } = value;
  if (typeof holderID !== "string" || holderID.trim() === "") return "holderID must be a non-empty string";
  if (typeof tree !== "string" || tree === "") return "tree must be a non-empty string";
  if (typeof isChild !== "boolean") return "isChild must be a boolean";
  if (scope !== "until-complete" && scope !== "until-integrated") return "scope must be until-complete or until-integrated";
  if (taskRef !== undefined && (typeof taskRef !== "string" || taskRef.trim() === "")) {
    return "taskRef must be a non-empty string";
  }
  if (scope === "until-integrated" && taskRef === undefined) return "an until-integrated lease requires a taskRef";
  return taskRef === undefined ? { holderID, tree, isChild, scope } : { holderID, tree, isChild, scope, taskRef };
}

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

/**
 * A lease registry over `seams`. Throws a TypeError only for an invalid `runMode` or `cap`.
 * Indexes: `leases` by logical key, `holders` by id, `treeHolders` by tree, `tasks` by taskRef; every check is O(1)
 * in the registry (plus the O(depth) realpath calls of the key derivation).
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
    typeof opts.sweepAgeMs === "number" && Number.isFinite(opts.sweepAgeMs) && opts.sweepAgeMs >= 0
      ? opts.sweepAgeMs
      : DEFAULT_SWEEP_AGE_MS;
  const platform = opts.platform ?? process.platform;
  let state = emptyState();

  const holderOf = (holderID: string): Holder | undefined => {
    const record = state.holders.get(holderID);
    return record === undefined ? undefined : copyHolder(record.holder);
  };

  /** The holders other than `selfID` that lease files in `tree`, and how many files they hold there. */
  const othersIn = (tree: string, selfID: string): { holders: Holder[]; fileCount: number } => {
    const holders: Holder[] = [];
    let fileCount = 0;
    for (const [id, count] of state.treeHolders.get(tree) ?? []) {
      if (id === selfID) continue;
      const holder = holderOf(id);
      if (holder === undefined) continue;
      holders.push(holder);
      fileCount += count;
    }
    return { holders, fileCount };
  };

  /** The tree of a session's work directory, or null when it lies outside any repository. */
  const treeOfDirectory = (dir: string, base: string, sm: LeaseSeams): string | null => {
    const key = keyOfIn(dir, base, sm, platform, true);
    return "unkeyable" in key ? null : key.tree;
  };

  /** The holder that makes `reader` refuse `raw`, with the file's display path. */
  const readConflict = (
    reader: LeaseActor,
    raw: string,
    base: string,
    sm: LeaseSeams,
  ): { holder: Holder; path: string } | undefined => {
    if (!reader.isChild) return undefined;
    const key = keyOfIn(raw, base, sm, platform, false);
    if ("unkeyable" in key) return undefined;
    const lease = state.leases.get(key.logical);
    if (lease === undefined || lease.holderID === reader.holderID || lease.physical !== key.physical) return undefined;
    const holder = holderOf(lease.holderID);
    return holder === undefined ? undefined : { holder, path: key.display };
  };

  const sweep = (): HoldersReleased => {
    const now = seams.now();
    const stale: string[] = [];
    for (const [id, record] of state.holders) {
      const age = now - record.holder.acquiredAt;
      if (record.holder.scope === "until-complete" && age >= 0 && age >= sweepAgeMs) stale.push(id);
    }
    let released = 0;
    for (const id of stale) released += dropHolder(state, id);
    return { released, holders: stale };
  };

  const acquireWrite = (holderInput: HolderInput, path: string | readonly string[] | null): AcquireResult => {
    const parsed = parseHolderInput(holderInput);
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

    const raws: readonly unknown[] = path === null ? [] : typeof path === "string" ? [path] : path;
    const unknownTarget = raws.length === 0;
    const keys = new Map<string, PathKey>();
    const unkeyed: string[] = [];
    for (const raw of raws) {
      const key = keyOfIn(raw, holder.tree, seams, platform, false);
      if ("unkeyable" in key) unkeyed.push(typeof raw === "string" ? raw : String(raw));
      else if (!keys.has(key.logical)) keys.set(key.logical, key);
    }

    if (!holder.isChild) {
      for (const [logical, key] of keys) {
        const lease = state.leases.get(logical);
        const owner = lease === undefined ? undefined : holderOf(lease.holderID);
        if (owner !== undefined) return { ok: false, reason: "held", holders: [owner], path: key.display, key: logical };
      }
      return { ok: true, leased: [], reentrant: [], unkeyed };
    }

    let swept = false;
    for (;;) {
      const fresh: PathKey[] = [];
      const reentrant: string[] = [];
      for (const [logical, key] of keys) {
        const lease = state.leases.get(logical);
        if (lease === undefined) {
          fresh.push(key);
        } else if (lease.holderID === holder.holderID) {
          reentrant.push(key.display);
        } else {
          const owner = holderOf(lease.holderID);
          if (owner !== undefined) return { ok: false, reason: "held", holders: [owner], path: key.display, key: logical };
          fresh.push(key);
        }
      }
      if (unknownTarget || unkeyed.length > 0) {
        const tree = treeOfDirectory(holder.tree, holder.tree, seams);
        if (tree !== null) {
          const others = othersIn(tree, holder.holderID);
          if (others.holders.length > 0) return { ok: false, reason: "unknown-target", holders: others.holders };
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
      let record = state.holders.get(holder.holderID);
      if (record === undefined && fresh.length > 0) {
        record = recordHolder(state, { ...holder, acquiredAt: seams.now() });
      }
      for (const key of fresh) {
        if (record === undefined) break;
        link(state, record, key.logical, {
          holderID: holder.holderID,
          physical: key.physical,
          tree: key.tree,
          display: key.display,
        });
      }
      return { ok: true, leased: fresh.map((key) => key.display), reentrant, unkeyed };
    }
  };

  const checkRead = (reader: LeaseActor, path: string): ReadCheck => {
    const conflict = readConflict(reader, path, reader.tree, seams);
    return conflict === undefined
      ? { ok: true }
      : { ok: false, reason: "underEdit", holders: [conflict.holder], path: conflict.path };
  };

  const checkRun = (runner: LeaseActor, tree: string): RunCheck => {
    const key = keyOfIn(tree, runner.tree, seams, platform, true);
    if ("unkeyable" in key || key.tree === null) return { ok: true };
    const { holders, fileCount } = othersIn(key.tree, runner.holderID);
    if (holders.length === 0) return { ok: true };
    if (!runner.isChild || runMode === "annotate") return { ok: true, contaminatedBy: holders, fileCount };
    return { ok: false, reason: "run-refused", holders, fileCount };
  };

  const filterSearchResults = (reader: LeaseActor, tree: string, paths: readonly string[]): FilterResult => {
    const foreign =
      state.holders.size > 1 || (state.holders.size === 1 && !state.holders.has(reader.holderID));
    if (!reader.isChild || !foreign) return { kept: [...paths], omitted: 0, holders: [] };
    const sm = memoize(seams);
    const kept: string[] = [];
    const holders = new Map<string, Holder>();
    let omitted = 0;
    for (const entry of paths) {
      const conflict = readConflict(reader, entry, tree, sm);
      if (conflict === undefined) {
        kept.push(entry);
        continue;
      }
      omitted++;
      if (!holders.has(conflict.holder.holderID)) holders.set(conflict.holder.holderID, conflict.holder);
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

  const snapshot = (): LeaseSnapshot => ({
    version: 1,
    takenAt: seams.now(),
    holders: [...state.holders.values()].map((record) => copyHolder(record.holder)),
    leases: [...state.leases].map(([logical, lease]) => ({
      logical,
      physical: lease.physical,
      tree: lease.tree,
      holderID: lease.holderID,
      display: lease.display,
    })),
  });

  const restore = (input: unknown): RestoreResult => {
    const bad = (message: string): RestoreResult => ({ ok: false, reason: "invalid-snapshot", message });
    if (!isRecord(input)) return bad("snapshot must be an object");
    if (input.version !== 1) return bad("unsupported snapshot version");
    if (typeof input.takenAt !== "number" || !Number.isFinite(input.takenAt)) return bad("takenAt must be a finite number");
    const { holders, leases } = input;
    if (!Array.isArray(holders) || !Array.isArray(leases)) return bad("holders and leases must be arrays");
    const next = emptyState();
    for (const value of holders) {
      const parsed = parseHolderInput(value);
      if (typeof parsed === "string") return bad(`invalid holder: ${parsed}`);
      if (!parsed.isChild) return bad(`holder ${parsed.holderID} is not a child session`);
      const acquiredAt = isRecord(value) ? value.acquiredAt : undefined;
      if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) {
        return bad(`holder ${parsed.holderID} has no valid acquiredAt`);
      }
      if (next.holders.has(parsed.holderID)) return bad(`duplicate holder ${parsed.holderID}`);
      recordHolder(next, { ...parsed, acquiredAt });
    }
    for (const value of leases) {
      if (!isRecord(value)) return bad("a lease must be an object");
      const { logical, physical, tree, holderID, display } = value;
      if (typeof logical !== "string" || logical === "") return bad("a lease has no logical key");
      if (typeof physical !== "string" || typeof display !== "string") return bad(`lease ${logical} has no physical or display path`);
      if (tree !== null && typeof tree !== "string") return bad(`lease ${logical} has an invalid tree`);
      if (typeof holderID !== "string") return bad(`lease ${logical} has no holderID`);
      const record = next.holders.get(holderID);
      if (record === undefined) return bad(`lease ${logical} names an unknown holder ${holderID}`);
      if (next.leases.has(logical)) return bad(`duplicate lease ${logical}`);
      link(next, record, logical, { holderID, physical, tree, display });
    }
    if (next.leases.size > cap) return bad(`${next.leases.size} leases exceed the cap of ${cap}`);
    state = next;
    return { ok: true, leases: next.leases.size };
  };

  return {
    acquireWrite,
    checkRead,
    checkRun,
    filterSearchResults,
    release,
    releaseTask,
    sweep,
    snapshot,
    restore,
  };
}
