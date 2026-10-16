/**
 * src/verify/perimeter.ts
 *
 * Cross-repo P1.8 (docs/design/cross-repo.md, invariants I4, I8, I13): the verification perimeter P of a role dispatch. P is W's
 * repository (the dispatch's verification root), plus the working-set worktrees of the orchestrator session other than W, plus
 * the admitted repositories W links to (package links in W's top-level `node_modules` whose real path is outside W and is not a
 * package store). P is fixed when the dispatch starts (I13): the store snapshots each extra root next to the change baseline
 * (dispatch.ts beginDispatch), and the wiring snapshots it again at the gate (wiring.ts observeChange).
 *
 * Inert by default (I9): only a routed role dispatch whose grant has a location (cross-repo admission bound it), or whose
 * orchestrator session's working set holds a root other than W, or (I13, QA round 2) with `routing.repoParents` set, can have a
 * perimeter; every other dispatch plans none, so nothing else is snapshotted and no reason changes.
 *
 * Link targets (QA round 1, I11, I12), all without running git:
 * - a link whose real path is neither below a `routing.repoParents` entry nor inside a working-set worktree is not in P, but is
 *   kept as an "unadmitted" root named by its basename (I8, I12; QA round 2), never dropped;
 * - otherwise its repository's top level is found by walking up to the nearest `.git` entry (F3), and links are de-duplicated
 *   by top level, so several links into one monorepo are one root and one snapshot;
 * - a top level is admitted when it lies 1..`routing.repoDepth` segments below a parent and no `routing.repoExclude` glob
 *   matches it or a directory between the parent and it, or when it is a working-set worktree (F4). A top level that is not
 *   admitted, or a link target that is not in a git repository, is kept as an "unadmitted" root: never snapshotted, and named in
 *   I8 as not observed;
 * - P holds at most PERIMETER_MAX snapshotted roots, W included; the roots beyond are kept as "unobserved" roots, never dropped
 *   (F2), so the gate refuses a dispatch that ran unattributable writers.
 *
 * Declared dependency edges (cross-repo P3c, docs/design/cross-repo-phase3-plan.md SD-P3c-1, SD-P3c-3): `dependencyTargets`
 * is the union of W's package links and its declared edges (edges.ts), each edge admitted by its text first
 * (`resolveEdgeTarget`) with the same admission as a link (`admissionContext`). `planPerimeter` adds them to P as seed origin
 * "edge" (a working-set root an edge covers gets `edged`; a link and an edge into one repository stay one "link" seed);
 * edge-only seeds are never pinned (SD-P3c-2, F3) and not frozen for S11 yet (P3c.4). Consumer discovery (§6, P3c.5,
 * SD-P3c-4, SD-P3c-5) reads the same edges in reverse: a working-set root whose declared edge resolves, as text, inside W's top
 * is a consumer `{root, name?, via}` (a `node_modules` consumer keeps `{root, name?, entry}`, F6).
 *
 * P3c QA round 1: a spec past EDGE_SPEC_MAX characters, or a target past EDGE_WALK_MAX segments below its parent, is unadmitted
 * with no filesystem call (M1); an unadmitted edge's name is `displaySafe` and capped, and `displayEdgeText` is how a router
 * line shows any other edge text (M5); `planPerimeter` returns how the forward bounds cut W's edges, for its caller to log (m4).
 */
import { type Dirent, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, opendir, readFile, readdir, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import { permissionMatches } from "../router/read-only";
import type { RepoLocation } from "../routing/roles/admission";
import { displaySafe } from "../routing/roles/read-set";
import { routedRoleOf } from "../routing/wire/dispatch";
import { workingSetOf } from "../routing/wire/working-set";
import type { DispatchPerimeter, PerimeterSeed } from "./dispatch";
import {
  type DeclaredEdge,
  type EdgeIO,
  type EdgeLimits,
  type EdgeVia,
  EDGE_LIMITS,
  EDGE_SPEC_MAX,
  EDGE_WORKSPACE_ENTRIES_MAX,
  EDGE_WORKSPACE_PATTERNS_MAX,
  SITE_PACKAGES_ENTRIES_MAX,
  declaredEdges,
  defaultEdgeIO,
  isUncSpec,
  prepareWorkspaceSegment,
  workspacePatterns,
} from "./edges";
import { depthBelow, gitTopOf, perimeterKey } from "./git-top";
import { isStoreLikeLink } from "./reference";

/** P holds at most this many snapshotted roots, W included. */
export const PERIMETER_MAX = 16;

/** Cross-repo P3c (SD-P3c-4): at most this many unadmitted declared-edge targets are named; the others are counted only. */
export const EDGE_UNADMITTED_NAMES_MAX = 8;

/**
 * Cross-repo P3c QA-1 M1: a declared edge's spec longer than EDGE_SPEC_MAX characters is never walked: its target is
 * unadmitted, named from its text, with no filesystem call. Defined in edges.ts (QA-2 F-2: `declaredEdges` keys such a spec
 * apart), re-exported here.
 */
export { EDGE_SPEC_MAX };

/**
 * Cross-repo P3c QA-1 M1: `resolveEdgeTarget` walks at most this many segments up from a target looking for its nearest
 * existing ancestor; a target deeper than that below its parent (or its worktree) is unadmitted, with no filesystem call.
 */
export const EDGE_WALK_MAX = 32;

/** Cross-repo P3c QA-1 M5: an unadmitted edge seed's name (the last segment of its text) is at most this many characters. */
export const EDGE_NAME_MAX = 64;

/** Cross-repo P3c QA-1 M5: `displayEdgeText` shows at most this many characters of an edge target's text. */
export const EDGE_TEXT_DISPLAY_MAX = 256;

/**
 * `displaySafe(text)` in at most `max` characters, the ellipsis included: past it, the longest prefix of `text` (whole code
 * points, at most `max` of them, so a 1 MiB text is never quoted whole) whose `displaySafe` form fits with a trailing "…".
 */
function cappedDisplay(text: string, max: number): string {
  if (text.length <= max) {
    const safe = displaySafe(text);
    if (safe.length <= max) return safe;
  }
  const points = Array.from(text.slice(0, max));
  // A surrogate pair the slice cut leaves a lone high surrogate last: drop it.
  const last = points[points.length - 1];
  if (last !== undefined && /^[\uD800-\uDBFF]$/.test(last)) points.pop();
  while (points.length > 0) {
    const safe = displaySafe(points.join(""));
    if (safe.length + 1 <= max) return `${safe}…`;
    // Quoting expands the text (up to 16 characters per code point): shrink in proportion, by one code point at least.
    points.length = Math.max(0, Math.min(points.length - 1, Math.floor((points.length * (max - 1)) / safe.length)));
  }
  return "…";
}

/**
 * Cross-repo P3c QA-1 M5: an edge target's text (a declared spec, a path resolved from one, an unadmitted top level) as a router
 * line may show it: `displaySafe` (no control, format or bidi character, no `[` `]`), at most EDGE_TEXT_DISPLAY_MAX characters.
 * The text itself stays a path (a seed's `at`, a comparison key); only its display goes through here.
 */
export function displayEdgeText(text: string): string {
  return cappedDisplay(text, EDGE_TEXT_DISPLAY_MAX);
}

/** What link admission needs: `routing.repoParents`, `routing.repoDepth` and `routing.repoExclude`. */
export interface PerimeterAdmission {
  readonly parents: readonly string[];
  readonly depth: number;
  /** `routing.repoExclude`: absolute globs (the max policy's matcher, `permissionMatches`). Absent: none. */
  readonly exclude?: readonly string[];
}

/** A comparison key (moved to `git-top.ts` with `gitTopOf`; re-exported for existing importers). */
export { perimeterKey };

function insideOrEqual(child: string, parent: string): boolean {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function canonical(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The package entries of `<w>/node_modules`: the top level, and one level under `@scope`. Dot-entries are tool state. */
function packageEntries(w: string): string[] {
  const modules = path.join(w, "node_modules");
  const entries: string[] = [];
  for (const name of readNames(modules)) {
    if (name.startsWith(".")) continue;
    const full = path.join(modules, name);
    if (!name.startsWith("@")) {
      entries.push(full);
      continue;
    }
    for (const sub of readNames(full)) if (!sub.startsWith(".")) entries.push(path.join(full, sub));
  }
  return entries;
}

/**
 * QA-1 #3: a link's text naming a UNC share or a device path (`\\server\share`, `\\?\…`, `//server/share`). Such a target is
 * never resolved (no `realpath` on it, so no network access from the gate or the store): the link is skipped, as unreadable.
 */
export function isUncLinkText(text: string): boolean {
  return /^[\\/]{2}/.test(text);
}

/** The link primitives `linkedTargets` uses; injectable for tests (QA-1 #3). */
export interface LinkIO {
  readonly lstat: (p: string) => { isSymbolicLink(): boolean };
  readonly readlink: (p: string) => string;
  readonly realpath: (p: string) => string;
}

const defaultLinkIO: LinkIO = {
  lstat: (p) => lstatSync(p),
  readlink: (p) => readlinkSync(p),
  realpath: (p) => realpathSync.native(p),
};

/** The real paths of W's package links (symlinks, junctions) that point outside W and are not store-like, de-duplicated. */
export function linkedTargets(w: string, io: LinkIO = defaultLinkIO): string[] {
  const targets = new Map<string, string>();
  for (const entry of packageEntries(w)) {
    let real: string;
    try {
      if (!io.lstat(entry).isSymbolicLink()) continue;
      // QA-1 #3: the link text first; a UNC or device target is never realpath'ed (not admitted, as an unreadable link).
      if (isUncLinkText(io.readlink(entry))) continue;
      real = io.realpath(entry);
    } catch {
      continue; // Unreadable or dangling: it loads nothing.
    }
    if (insideOrEqual(real, w) || insideOrEqual(w, real) || isStoreLikeLink(real, process.platform)) continue;
    if (!targets.has(perimeterKey(real))) targets.set(perimeterKey(real), real);
  }
  return [...targets.values()];
}

/** Cross-repo P3c (SD-P3c-3): the primitives `resolveEdgeTarget` uses once a target passed the text gates; injectable for tests. */
export interface EdgeTargetIO {
  /** The canonical path of an existing `p` (follows links and junctions); throws when absent. */
  readonly realpath: (p: string) => string;
  /** The git top level of `dir`, strictly below `ceiling` when given (`gitTopOf`, no git run). */
  readonly gitTop: (dir: string, ceiling?: string) => string | undefined;
}

/** Cross-repo P3c: every primitive `dependencyTargets` uses (`linkedTargets`, `declaredEdges`, `resolveEdgeTarget`). */
export interface DependencyIO extends LinkIO, EdgeIO, EdgeTargetIO {}

const defaultDependencyIO: DependencyIO = { ...defaultLinkIO, ...defaultEdgeIO, gitTop: (dir, ceiling) => gitTopOf(dir, ceiling) };

/** What `resolveEdgeTarget` needs beyond link admission. */
export interface EdgeContext extends AdmissionContext {
  /** The root whose files declare the edges (W): an edge's spec resolves against `path.dirname(path.join(root, edge.from))`. */
  readonly root: string;
  /** Whether a top level is another worktree of W's repository (the same git common directory, QA-1 F11). */
  readonly sameRepository: (top: string) => boolean;
}

/**
 * Where one declared edge leads (SD-P3c-3):
 * - `admitted`: the repository top level `top`, admitted as a link's would be (`admitTop`);
 * - `unadmitted`: not in P, named (I8, I12): `at` is the target as text (the spec itself for a UNC or device spec) or, past the
 *   filesystem gates, its top level; `name` is the last segment of that text, never the canonical path;
 * - `skipped`: not a perimeter root at all: a `node_modules` segment (links cover them), W's own repository (at, inside or above
 *   W's top, or another worktree of it), or a Python path line outside every parent (dropped silently).
 */
export type EdgeResolution =
  | { readonly status: "admitted"; readonly top: string }
  | { readonly status: "unadmitted"; readonly at: string; readonly name: string }
  | { readonly status: "skipped"; readonly reason: "nodeModules" | "insideW" | "sameRepository" | "pythonOutside" };

/** The last non-empty segment of a path as text, either separator (a UNC spec is never resolved, even on posix). */
function textName(at: string): string {
  const segments = at.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? at;
}

/**
 * QA-1 M5: an unadmitted edge seed's name, shown in the scope note and the S11 caveat: the last segment of its text, `displaySafe`
 * and at most EDGE_NAME_MAX characters (repository text never reaches a router line raw).
 */
function edgeName(at: string): string {
  return cappedDisplay(textName(at), EDGE_NAME_MAX);
}

function hasNodeModulesSegment(at: string): boolean {
  return at.split(/[\\/]/).some((segment) => segment.toLowerCase() === "node_modules");
}

/**
 * Cross-repo P3c.2b (SD-P3c-3, I11): admit one declared edge of `ctx.root` by its text first. The spec is repository text: it
 * is resolved against the declaring file's directory as text, and gated as text before any filesystem call: a UNC or device
 * spec, or a target outside every parent (either spelling) and every working-set worktree, is unadmitted; a `node_modules`
 * segment or a target at, inside or above `wTop` (W's top level) is skipped. Only then is the nearest existing ancestor of the
 * target below the parent (or inside the worktree) realpath'ed (an unbuilt `dist/` resolves to its repository); its canonical
 * path must still be below a parent or inside a working-set worktree (a junction leading out is unadmitted); then its top level
 * (`gitTop`, the walk stopping at the parent) must be admitted by `admitTop`, as a link target's is.
 */
export function resolveEdgeTarget(
  edge: DeclaredEdge,
  ctx: EdgeContext,
  wTop: string,
  io: EdgeTargetIO = defaultDependencyIO,
): EdgeResolution {
  const python = edge.kind === "python";
  // A UNC share or a device path: never resolved (QA-1 #3), so no network access.
  if (edge.unc === true || isUncSpec(edge.spec)) {
    return python ? { status: "skipped", reason: "pythonOutside" } : { status: "unadmitted", at: edge.spec, name: edgeName(edge.spec) };
  }
  const target = path.resolve(path.dirname(path.join(ctx.root, edge.from)), edge.spec);
  const unadmittedText: EdgeResolution = { status: "unadmitted", at: target, name: edgeName(target) };
  // QA-1 M1: an overlong spec is never walked (each step of the walk below is a filesystem call plus passes over the text).
  if (edge.spec.length > EDGE_SPEC_MAX) return unadmittedText;
  if (isUncSpec(target)) return python ? { status: "skipped", reason: "pythonOutside" } : unadmittedText;
  if (hasNodeModulesSegment(target)) return { status: "skipped", reason: "nodeModules" };
  if (insideOrEqual(target, wTop) || insideOrEqual(wTop, target)) return { status: "skipped", reason: "insideW" };
  const parent = ctx.parentOf(target);
  const worktree = ctx.worktreeOf(target);
  if (parent === undefined && worktree === undefined) return python ? { status: "skipped", reason: "pythonOutside" } : unadmittedText;
  // QA-1 M1: the walk below takes one step per segment between the target and its parent (or its worktree, included); past
  // EDGE_WALK_MAX steps the target is unadmitted, before any filesystem call.
  const steps = Math.max(
    parent !== undefined ? depthBelow(target, parent) : 0,
    worktree !== undefined ? depthBelow(target, worktree.worktree) + 1 : 0,
  );
  if (steps > EDGE_WALK_MAX) return unadmittedText;

  // The nearest existing ancestor, never at or above the parent (nor above the worktree).
  const within = (dir: string): boolean =>
    (parent !== undefined && depthBelow(dir, parent) >= 1) || (worktree !== undefined && insideOrEqual(dir, worktree.worktree));
  let real: string | undefined;
  for (let dir = target; real === undefined && within(dir); dir = path.dirname(dir)) {
    try {
      real = io.realpath(dir);
    } catch {
      if (path.dirname(dir) === dir) break; // Missing: try its parent directory.
    }
  }
  if (real === undefined) return unadmittedText; // Nothing exists there: nothing to observe.
  // The canonical path stays below a parent or inside a working-set worktree: a junction leading out is not admitted.
  const realParent = ctx.parentOf(real);
  const realWorktree = ctx.worktreeOf(real);
  if (realParent === undefined && realWorktree === undefined) return unadmittedText;
  if (insideOrEqual(real, wTop) || insideOrEqual(wTop, real)) return { status: "skipped", reason: "insideW" };

  const top = io.gitTop(real, realWorktree !== undefined ? path.dirname(realWorktree.worktree) : realParent);
  if (top === undefined) return unadmittedText; // Not in a git repository: nothing to observe.
  if (insideOrEqual(top, wTop) || insideOrEqual(wTop, top)) return { status: "skipped", reason: "insideW" };
  // QA-1 m7: admission first, as for a link: an unadmitted top level never has its `.git` read (`sameRepository`).
  if (!ctx.admitTop(top)) return { status: "unadmitted", at: top, name: edgeName(top) };
  if (ctx.sameRepository(top)) return { status: "skipped", reason: "sameRepository" };
  return { status: "admitted", top };
}

/**
 * One target W depends on: a package link's real path (`linkedTargets`, admitted by the caller as before), an admitted edge's
 * repository top level, or an unadmitted edge target (named, never snapshotted).
 */
export type DependencyTarget =
  | { readonly origin: "link"; readonly at: string }
  | { readonly origin: "edge"; readonly at: string; readonly via: EdgeVia; readonly from: string }
  | { readonly origin: "edge"; readonly at: string; readonly via: EdgeVia; readonly from: string; readonly name: string; readonly fixed: "unadmitted" };

/** The result of `dependencyTargets`. */
export interface DependencyTargets {
  /**
   * Link targets first (`linkedTargets`, unchanged), then edge targets: each once (by top level, or by text when unadmitted),
   * none repeating a link target.
   */
  readonly targets: DependencyTarget[];
  /** Unadmitted edge targets past EDGE_UNADMITTED_NAMES_MAX: counted, not named (SD-P3c-4). */
  readonly unadmittedMore: number;
  /** A `declaredEdges` bound cut the reading (SD-P3c-4). */
  readonly incomplete: boolean;
}

/**
 * Cross-repo P3c.2b (SD-P3c-1): the targets W depends on, the union of its package links and its declared edges (`declaredEdges`,
 * admitted by text first, `resolveEdgeTarget`). `ctx.sameRepository` defaults to "shares W's git common directory".
 * `planPerimeter` reads W's links and edges through it (P3c.3).
 */
export function dependencyTargets(
  w: string,
  ctx: AdmissionContext & { readonly sameRepository?: (top: string) => boolean },
  io: DependencyIO = defaultDependencyIO,
): DependencyTargets {
  const targets: DependencyTarget[] = linkedTargets(w, io).map((at) => ({ origin: "link", at }));
  const declared = declaredEdges(w, io);
  if (declared.edges.length === 0) return { targets, unadmittedMore: 0, incomplete: declared.incomplete };
  const wTop = io.gitTop(w) ?? w;
  let sameRepository = ctx.sameRepository;
  if (sameRepository === undefined) {
    const wCommon = commonDirOf(wTop);
    sameRepository = (top: string): boolean => wCommon !== undefined && commonDirOf(top) === wCommon;
  }
  const edgeContext: EdgeContext = { ...ctx, root: w, sameRepository };
  // An edge whose top level is already a link target is that link (SD-P3c-2: links first, one target). QA-2 F-2: by kind, so an
  // unadmitted spelling of a path (an overlong spec, say) never shadows an admitted top level at that path: the admitted target
  // takes the unadmitted one's place (its name, or its count). An unadmitted spelling of an admitted path adds nothing.
  const seen = new Map<string, "admitted" | "named" | "counted">(targets.map((target) => [perimeterKey(target.at), "admitted"]));
  let named = 0;
  let unadmittedMore = 0;
  for (const edge of declared.edges) {
    const resolved = resolveEdgeTarget(edge, edgeContext, wTop, io);
    if (resolved.status === "skipped") continue;
    const at = resolved.status === "admitted" ? resolved.top : resolved.at;
    const key = perimeterKey(at);
    const before = seen.get(key);
    if (before === "admitted" || (before !== undefined && resolved.status !== "admitted")) continue;
    if (resolved.status === "admitted") {
      const admitted: DependencyTarget = { origin: "edge", at, via: edge.via, from: edge.from };
      const index = before === "named"
        ? targets.findIndex((target) => "fixed" in target && perimeterKey(target.at) === key)
        : -1;
      if (index >= 0) {
        named -= 1;
        targets[index] = admitted;
      } else {
        if (before === "counted") unadmittedMore -= 1;
        targets.push(admitted);
      }
      seen.set(key, "admitted");
    } else if (named < EDGE_UNADMITTED_NAMES_MAX) {
      named += 1;
      targets.push({ origin: "edge", at, via: edge.via, from: edge.from, name: resolved.name, fixed: "unadmitted" });
      seen.set(key, "named");
    } else {
      unadmittedMore += 1;
      seen.set(key, "counted");
    }
  }
  return { targets, unadmittedMore, incomplete: declared.incomplete };
}

/** Cross-repo P3a: the link primitives `crossLinkAliases` uses; injectable for tests. */
export interface AliasIO extends LinkIO {
  /** The JS (not native) realpath: on win32 it keeps a junction's stored target text, the spelling vite uses (spike C4). */
  readonly jsRealpath: (p: string) => string;
}

const defaultAliasIO: AliasIO = { ...defaultLinkIO, jsRealpath: (p) => realpathSync(p) };

/** Cross-repo QA-1 M2: the bounds of one `crossLinkAliases` call, each a total over the whole call. */
export interface AliasBounds {
  /** `node_modules` directories read: the consumer's, its ancestors' up to its git top, then W's. */
  readonly dirs: number;
  /** Directory entries looked at, in those directories, their `@scope` directories and pnpm's `.pnpm` store. */
  readonly entries: number;
  /** pnpm `.pnpm/<entry>` directories looked at. */
  readonly pnpm: number;
}

/** Cross-repo QA-1 M2: the default `crossLinkAliases` bounds. */
export const ALIAS_BOUNDS: AliasBounds = { dirs: 64, entries: 4000, pnpm: 256 };

/**
 * QA-1 M2: the `node_modules` directories whose links can spell W for a consumer, de-duplicated, in order: the consumer's own;
 * each ancestor's up to and including the consumer's git top (hoisted links, a check `cwd=` set to a workspace sub-package),
 * none when it has no git top or is a UNC path; then W's own (its workspace links into W, reached through a consumer link).
 */
function aliasModuleDirs(consumer: string, w: string): string[] {
  const dirs = [path.resolve(consumer)];
  const top = isUncLinkText(consumer) ? undefined : gitTopOf(consumer);
  if (top !== undefined && insideOrEqual(dirs[0]!, top)) {
    for (let at = dirs[0]!; perimeterKey(at) !== perimeterKey(top); ) {
      const up = path.dirname(at);
      if (up === at) break;
      dirs.push(up);
      at = up;
    }
  }
  dirs.push(path.resolve(w));
  const seen = new Set<string>();
  const modules: string[] = [];
  for (const dir of dirs) {
    if (seen.has(perimeterKey(dir))) continue;
    seen.add(perimeterKey(dir));
    modules.push(path.join(dir, "node_modules"));
  }
  return modules;
}

/**
 * Cross-repo P3a (SD-P3a-2 amended by the spike; QA-1 M2): W's top as a consumer's package links spell it. The links read: the
 * top level and `@scope/*` of `<consumer>/node_modules`, of each ancestor's `node_modules` up to the consumer's git top, and of
 * `<W>/node_modules`; then pnpm's `.pnpm/<entry>/node_modules/<name>` (and `@scope/*`) under each of them. For each link whose native
 * real path lies inside W, the JS `fs.realpathSync` of the link (it keeps a junction's stored target text, the id vite gives the
 * module), walked up to W's top when the link targets a directory below it. Never a spelling holding the substring
 * `node_modules` (vitest skips those ids, case-sensitively); case-only variants are kept. A UNC link target is never resolved.
 * Bounded (`bounds`: directories, entries and `.pnpm` entries read; CONSUMER_SCAN_MAX links) and fail-soft: an unreadable link
 * or directory is skipped (the zero guard is the backstop).
 */
export function crossLinkAliases(consumer: string, w: string, io: AliasIO = defaultAliasIO, bounds: AliasBounds = ALIAS_BOUNDS): string[] {
  const aliases: string[] = [];
  let realW: string;
  try {
    realW = io.realpath(w);
  } catch {
    return aliases;
  }
  let entries = 0;
  let links = 0;
  let pnpm = 0;
  const spent = (): boolean => links > CONSUMER_SCAN_MAX || entries >= bounds.entries;
  /** The names in `dir`, at most `cap` and what the entry budget has left; each name taken costs one entry. */
  const namesOf = (dir: string, cap = Number.POSITIVE_INFINITY): string[] => {
    const room = Math.min(cap, bounds.entries - entries);
    if (room <= 0 || spent()) return [];
    const names = readNames(dir).slice(0, room);
    entries += names.length;
    return names;
  };
  const consider = (entry: string): void => {
    try {
      if (!io.lstat(entry).isSymbolicLink()) return;
      if (++links > CONSUMER_SCAN_MAX) return;
      if (isUncLinkText(io.readlink(entry))) return;
      const real = io.realpath(entry);
      if (!insideOrEqual(real, realW)) return;
      const rel = path.relative(realW, real);
      const up = rel === "" ? [] : rel.split(/[\\/]+/).filter(segment => segment !== "").map(() => "..");
      const alias = path.resolve(io.jsRealpath(entry), ...up);
      // vitest drops every module id holding the substring "node_modules" (case-sensitive), so such a spelling matches nothing.
      if (alias.includes("node_modules")) return;
      if (!aliases.includes(alias)) aliases.push(alias);
    } catch {
      // Unreadable or dangling: it spells nothing.
    }
  };
  /** The package entries of one `node_modules` directory: the top level, and one level under `@scope`. Dot-entries are tool state. */
  const scanPackages = (modules: string): void => {
    for (const name of namesOf(modules)) {
      if (spent()) return;
      if (name.startsWith(".")) continue;
      const full = path.join(modules, name);
      if (!name.startsWith("@")) {
        consider(full);
        continue;
      }
      for (const sub of namesOf(full)) {
        if (spent()) return;
        if (!sub.startsWith(".")) consider(path.join(full, sub));
      }
    }
  };
  const dirs = aliasModuleDirs(consumer, w).slice(0, Math.max(0, bounds.dirs));
  for (const modules of dirs) scanPackages(modules);
  // pnpm: `<modules>/.pnpm/<entry>/node_modules/<name>`, after every top level (the likelier spellings first).
  for (const modules of dirs) {
    const store = path.join(modules, ".pnpm");
    const names = namesOf(store, bounds.pnpm - pnpm);
    pnpm += names.length;
    for (const name of names) if (!name.startsWith(".")) scanPackages(path.join(store, name, "node_modules"));
  }
  return aliases;
}

/**
 * Cross-repo P2b.3: one working-set worktree whose `node_modules` links into W (`entry`); cross-repo P3c.5 (SD-P3c-5, F6): or
 * one whose declared dependency edge leads into W (`via`). Exactly one of `entry` and `via` is set: a `node_modules` consumer
 * keeps its shape `{root, name?, entry}`, an edge consumer is `{root, name?, via}`.
 */
export interface PerimeterConsumer {
  readonly root: string;
  readonly name?: string;
  /** The link, relative to `<root>/node_modules` (for example `lib` or `@scope/lib`), "/" separated. */
  readonly entry?: string;
  /**
   * P3c.5: the edge, as the declaring file relative to `root` ("/" separated) and its fixed `EDGE_VIAS` label, for example
   * `package.json dependencies (file:)`. Never the raw spec.
   */
  readonly via?: string;
}

/** Cross-repo P2b.3: the bound on `node_modules` LINK entries checked by `discoverConsumers`, per root (QA-1 #2, M2: plain entries are free). */
export const CONSUMER_SCAN_MAX = 2000;

/** Cross-repo M2: the hard bound on all `node_modules` entries (links or not) read per root; past it the root is incomplete. */
export const CONSUMER_READ_MAX = 20000;

/** Cross-repo QA-1 #2: the bound on W's package names looked up directly (W's own, plus its workspace packages'). */
export const CONSUMER_NAMES_MAX = 64;

/** Cross-repo QA-1 #2: the bound on the workspace `package.json` files read to learn W's package names. */
const WORKSPACE_MANIFESTS_MAX = 256;

/**
 * Cross-repo P3c.5 (SD-P3c-4): the bounds of a working-set root's declared edges read in reverse for consumer discovery: at
 * most WORKSPACE_MANIFESTS_MAX workspace packages (a package.json and a tsconfig.json each, plus the root's own files).
 */
const CONSUMER_EDGE_LIMITS: EdgeLimits = Object.freeze({
  ...EDGE_LIMITS,
  workspaces: WORKSPACE_MANIFESTS_MAX,
  files: Math.max(EDGE_LIMITS.files, 2 * WORKSPACE_MANIFESTS_MAX + 16),
});

/**
 * Cross-repo P3c.5 (SD-P3c-5): how an edge consumer names its edge in the caveat: the fixed `EDGE_VIAS` label, plus the declaring
 * file (relative to the consumer root, "/" separated) when the label does not already start with it. Never the raw spec.
 */
function consumerVia(edge: DeclaredEdge): string {
  return edge.via === edge.from || edge.via.startsWith(`${edge.from} `) ? edge.via : `${edge.via} in ${edge.from}`;
}

/** A `package.json` larger than this is not read for names. */
const MANIFEST_BYTES_MAX = 1024 * 1024;

/** A package name usable as a `node_modules` path: `name` or `@scope/name`, no dot-leading segment, no separators besides one "/". */
const PACKAGE_NAME = /^(?:@[a-z0-9_~-][a-z0-9._~-]*\/)?[a-z0-9_~-][a-z0-9._~-]*$/i;

/** One working-set root handed to `discoverConsumers`. */
export interface ConsumerRoot {
  readonly root: string;
  readonly name?: string;
}

/** Cross-repo QA-1 #2/#13: what `discoverConsumers` found, and the roots it could not finish (budget or deadline). */
export interface ConsumerDiscovery {
  readonly consumers: PerimeterConsumer[];
  readonly incomplete: ConsumerRoot[];
}

async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path.join(dir, "package.json"), "utf8");
    if (text.length > MANIFEST_BYTES_MAX) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** QA-2 F-1: the names in `dir`, in directory order, at most `max + 1` of them (so a caller sees a cut); rejects when unreadable. */
async function boundedListing(dir: string, max: number): Promise<string[]> {
  const handle = await opendir(dir);
  try {
    const names: string[] = [];
    for (let entry = await handle.read(); entry !== null && names.length <= max; entry = await handle.read()) names.push(entry.name);
    return names;
  } finally {
    await handle.close();
  }
}

/**
 * The directories of one `workspaces` pattern (`workspaceDirs` rules), whether the listing was cut at `entries` names, and how
 * many names it read: the async twin of edges.ts `matchWorkspace`. QA-2 F-1: the segment is prepared once, before the listing
 * (one no entry name can match lists nothing), and the listing reads at most `entries + 1` names, so one synchronous filter
 * never runs over an uncapped listing.
 */
export async function workspaceListing(
  w: string,
  pattern: string,
  limit: number,
  entries: number,
): Promise<{ dirs: string[]; cut: boolean; listed: number }> {
  if (pattern.startsWith("!") || path.isAbsolute(pattern) || /^[\\/]/.test(pattern)) return { dirs: [], cut: false, listed: 0 };
  const segments = pattern.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return { dirs: [], cut: false, listed: 0 };
  const last = segments[segments.length - 1] ?? "";
  const head = segments.slice(0, -1);
  if (head.some((segment) => segment.includes("*"))) return { dirs: [], cut: false, listed: 0 };
  if (!last.includes("*")) return { dirs: [path.join(w, ...segments)], cut: false, listed: 0 };
  const matches = prepareWorkspaceSegment(last);
  if (matches === undefined) return { dirs: [], cut: false, listed: 0 };
  const base = path.join(w, ...head);
  let children: string[];
  try {
    children = await boundedListing(base, entries);
  } catch {
    return { dirs: [], cut: false, listed: 0 };
  }
  // QA-1 C1: the linear matcher of edges.ts, never a regular expression built from the pattern; code-unit order, as edges.ts.
  const dirs = children
    .slice(0, entries)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .filter((child) => !child.startsWith(".") && child !== "node_modules" && matches(child))
    .slice(0, limit)
    .map((child) => path.join(base, child));
  return { dirs, cut: children.length > entries, listed: Math.min(children.length, entries + 1) };
}

/**
 * The directories of one `workspaces` pattern, inside W only: literal segments, and a wildcard (`*`, `**`) in the last segment
 * only, matched one level deep. Negations, absolute paths, `..` and inner wildcards give none. At most `limit` directories, from
 * a listing of at most `entries` names (QA-2 F-1). Exported for the agreement test with its synchronous twin, edges.ts
 * `workspaceDirsSync` (P3c.1).
 */
export async function workspaceDirs(
  w: string,
  pattern: string,
  limit: number,
  entries: number = SITE_PACKAGES_ENTRIES_MAX,
): Promise<string[]> {
  return (await workspaceListing(w, pattern, limit, entries)).dirs;
}

/**
 * Cross-repo QA-1 #2: W's package names, looked up directly in each root's `node_modules`: the `name` of `<W>/package.json`
 * and, when W is a workspace root, the `name` of each workspace package its `workspaces` lists. Bounded (CONSUMER_NAMES_MAX
 * names, WORKSPACE_MANIFESTS_MAX manifests); `stop` ends the reading early (the deadline).
 */
async function packageNamesOf(w: string, stop: () => boolean, onCut: () => void = () => undefined): Promise<string[]> {
  const names = new Set<string>();
  const take = (manifest: Record<string, unknown> | undefined): void => {
    const name = manifest?.name;
    if (typeof name === "string" && PACKAGE_NAME.test(name) && names.size < CONSUMER_NAMES_MAX) names.add(name);
  };
  const manifest = await readManifest(w);
  if (manifest === undefined) return [];
  take(manifest);
  let read = 0;
  let listed = 0;
  // QA-1 M2: at most EDGE_WORKSPACE_PATTERNS_MAX patterns (each wildcard one is a directory listing), as edges.ts reads them;
  // QA-2 F-1: their listings read at most EDGE_WORKSPACE_ENTRIES_MAX names in total, each at most SITE_PACKAGES_ENTRIES_MAX, as
  // edges.ts. Fail-closed, as edges.ts marks its result incomplete: each of those cuts calls `onCut` (W's names may be short).
  const patterns = workspacePatterns(manifest);
  if (patterns.length > EDGE_WORKSPACE_PATTERNS_MAX) onCut();
  for (const pattern of patterns.slice(0, EDGE_WORKSPACE_PATTERNS_MAX)) {
    if (stop() || names.size >= CONSUMER_NAMES_MAX || read >= WORKSPACE_MANIFESTS_MAX) break;
    const budget = Math.max(0, Math.min(SITE_PACKAGES_ENTRIES_MAX, EDGE_WORKSPACE_ENTRIES_MAX - listed));
    if (budget === 0 && pattern.includes("*")) {
      onCut(); // A wildcard needs a listing, and the total is spent.
      continue;
    }
    const listing = await workspaceListing(w, pattern, WORKSPACE_MANIFESTS_MAX - read, budget);
    listed += listing.listed;
    if (listing.cut) onCut();
    for (const dir of listing.dirs) {
      if (stop() || names.size >= CONSUMER_NAMES_MAX || read >= WORKSPACE_MANIFESTS_MAX) break;
      read += 1;
      take(await readManifest(dir));
    }
  }
  return [...names];
}

/**
 * Cross-repo P2b.3 (docs/design/cross-repo.md §6, consumer discovery): the roots among `roots` whose `node_modules` hold a
 * link whose real path is inside W or W itself. Only the given roots are read; async fs, no git; never throws. Per root
 * (QA-1 #2): first a direct lookup of each of W's package names (`<root>/node_modules/<name>`, scoped names included; one
 * lookup per name, outside the budget), then a scan of the entries `packageEntries` reads, spending at most `opts.maxEntries`
 * (default CONSUMER_SCAN_MAX) on link entries and reading at most `opts.maxRead` (default CONSUMER_READ_MAX) entries per root
 * (QA-2 M2). A root whose scan stops on either bound without finding a consumer is incomplete; so is
 * every root not finished when `opts.signal` aborts (QA-1 #13, the gate deadline). A link whose text names a UNC or device
 * path is never resolved (QA-1 #3). One entry per consumer (the first link found); both lists follow the order of `roots`.
 *
 * Cross-repo P3c.5 (SD-P3c-3..5): then, for a root with no `node_modules` link into W, (c) its declared dependency edges
 * (`declaredEdges`, read in reverse with CONSUMER_EDGE_LIMITS: at most WORKSPACE_MANIFESTS_MAX workspace packages, EDGES_MAX
 * edges): an edge whose spec, resolved as text against its declaring file's directory, lies inside W's top (W as given or
 * canonical, its git top level) and not under a `node_modules` segment makes the root a consumer `{root, name?, via}` (F6: a
 * `node_modules` consumer keeps `{root, name?, entry}`). Edge text is never resolved on the filesystem (I11): an edge spelling
 * W only through a junction is not seen, unless the junction is a spelling of W's parent given in `opts.parents` (QA-1 m5: W's
 * top is matched under every spelling of its parent). A root inside W's top (W's own repository) reads no edges. A root with no consumer
 * whose edge reading a bound cut is incomplete, as one whose scan stopped on its budget.
 */
export async function discoverConsumers(
  w: string,
  roots: readonly ConsumerRoot[],
  opts?: {
    maxEntries?: number;
    maxRead?: number;
    signal?: AbortSignal;
    edgeIO?: EdgeIO;
    edgeLimits?: EdgeLimits;
    /** QA-1 m5: the admission's parents in both spellings (`AdmissionData.parents`); edges are matched against W's top under each. */
    parents?: readonly string[];
  },
): Promise<ConsumerDiscovery> {
  const maxEntries = Math.max(0, Math.floor(opts?.maxEntries ?? CONSUMER_SCAN_MAX));
  const readMax = Math.max(0, Math.floor(opts?.maxRead ?? CONSUMER_READ_MAX));
  const edgeIO = opts?.edgeIO ?? defaultEdgeIO;
  const edgeLimits = opts?.edgeLimits ?? CONSUMER_EDGE_LIMITS;
  const signal = opts?.signal;
  const stopped = (): boolean => signal?.aborted === true;
  // Per root, by index: a consumer's entry (a link) or via (an edge), "incomplete", "none"; unset while the root is not finished.
  // W (or a root around it) is never scanned, so never incomplete either: settled before any fs call, by text.
  const outcomes: (string | { readonly via: string } | { readonly incomplete: true } | null | undefined)[] = roots.map(({ root }) =>
    (insideOrEqual(root, w) || insideOrEqual(w, root) ? null : undefined));
  const assemble = (): ConsumerDiscovery => {
    const consumers: PerimeterConsumer[] = [];
    const incomplete: ConsumerRoot[] = [];
    roots.forEach(({ root, name }, index) => {
      const outcome = outcomes[index];
      const named = name !== undefined ? { name } : {};
      if (typeof outcome === "string") consumers.push({ root, ...named, entry: outcome });
      else if (outcome !== null && outcome !== undefined && "via" in outcome) consumers.push({ root, ...named, via: outcome.via });
      else if (outcome !== null) incomplete.push({ root, ...named });
    });
    return { consumers, incomplete };
  };
  const work = async (): Promise<void> => {
    // Link targets are real paths: W is matched as given and as its real path (a junction or 8.3 spelling of W).
    const wReal = await realpath(w).catch(() => w);
    const inW = (dir: string): boolean => insideOrEqual(dir, w) || insideOrEqual(dir, wReal);
    // P3c.5: W's top level (W may be a folder of its repository), as found and canonical; edges are matched against them by text.
    const wTop = gitTopOf(w) ?? w;
    const wTopReal = await realpath(wTop).catch(() => wTop);
    // QA-1 m5: W's top as every spelling of its parent spells it (`opts.parents`, the admission's parents as configured and
    // canonical): an edge written through a junction-spelled parent still lies inside W's top, by text. Spellings of one parent
    // are those with one canonical path.
    const rewritten: string[] = [];
    const parentSpellings = opts?.parents ?? [];
    if (parentSpellings.length > 0) {
      const groups = new Map<string, string[]>();
      for (const spelling of parentSpellings) {
        const key = perimeterKey(await realpath(spelling).catch(() => spelling));
        groups.set(key, [...(groups.get(key) ?? []), spelling]);
      }
      for (const group of groups.values()) {
        for (const from of group) {
          for (const top of [wTop, wTopReal]) {
            if (depthBelow(top, from) < 1) continue;
            const below = path.relative(from, top);
            for (const to of group) if (to !== from) rewritten.push(path.join(to, below));
          }
        }
      }
    }
    const wSpellings = [...new Map([w, wReal, wTop, wTopReal, ...rewritten].map((at) => [perimeterKey(at), at])).values()];
    const inWTop = (dir: string): boolean => insideOrEqual(dir, wTop) || insideOrEqual(dir, wTopReal);
    /** By text only (I11): the edge's target, resolved against its declaring file's directory, lies inside W's top. */
    const edgeIntoW = (root: string, edge: DeclaredEdge): boolean => {
      if (edge.unc === true || isUncSpec(edge.spec)) return false;
      const target = path.resolve(path.dirname(path.join(root, edge.from)), edge.spec);
      if (isUncSpec(target)) return false;
      return wSpellings.some((at) => insideOrEqual(target, at) && !hasNodeModulesSegment(path.relative(at, target)));
    };
    const linksIntoW = async (full: string): Promise<boolean> => {
      try {
        if (!(await lstat(full)).isSymbolicLink()) return false;
        if (isUncLinkText(await readlink(full))) return false; // QA-1 #3: never resolved.
        const real = await realpath(full);
        return inW(real) && !isStoreLikeLink(real, process.platform);
      } catch {
        return false; // Unreadable or dangling: it loads nothing.
      }
    };
    const entries = async (dir: string): Promise<Dirent[]> => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    // QA-2 F-1 (fail-closed): a bound cut W's workspace listing, so its names may be short; a root with no consumer is incomplete.
    let namesCut = false;
    const wNames = await packageNamesOf(w, stopped, () => {
      namesCut = true;
    });
    for (const [index, { root }] of roots.entries()) {
      if (outcomes[index] === null) continue;
      if (inW(root) || insideOrEqual(w, root) || insideOrEqual(wReal, root)) {
        outcomes[index] = null;
        continue;
      }
      if (stopped()) return;
      const modules = path.join(root, "node_modules");
      let found: string | undefined;
      // (a) The direct lookup: one per name, outside the budget.
      for (const name of wNames) {
        if (stopped()) return;
        if (await linksIntoW(path.join(modules, ...name.split("/")))) {
          found = name;
          break;
        }
      }
      // (b) The bounded scan, its budget per root.
      // Only link entries spend `budget` (M2); every entry read counts toward the hard `readMax` cap.
      let budget = maxEntries;
      let read = 0;
      let exhausted = false;
      const check = async (full: string, entry: string, dirent: Dirent): Promise<void> => {
        if (found !== undefined || exhausted) return;
        read += 1;
        if (read > readMax) {
          exhausted = true;
          return;
        }
        // A plain directory or file is no link: free. A type the fs did not report is checked by lstat, like a link.
        if (!dirent.isSymbolicLink() && (dirent.isDirectory() || dirent.isFile())) return;
        if (budget <= 0) {
          exhausted = true;
          return;
        }
        budget -= 1;
        if (await linksIntoW(full)) found = entry;
      };
      if (found === undefined) {
        for (const top of await entries(modules)) {
          if (stopped()) return;
          if (found !== undefined || exhausted) break;
          if (top.name.startsWith(".")) continue;
          if (!top.name.startsWith("@")) {
            await check(path.join(modules, top.name), top.name, top);
            continue;
          }
          read += 1;
          if (read > readMax) {
            exhausted = true;
            break;
          }
          for (const sub of await entries(path.join(modules, top.name))) {
            if (stopped()) return;
            if (found !== undefined || exhausted) break;
            if (sub.name.startsWith(".")) continue;
            await check(path.join(modules, top.name, sub.name), `${top.name}/${sub.name}`, sub);
          }
        }
      }
      // (c) P3c.5: no link into W: the root's declared dependency edges, by text (never W's own repository).
      let via: string | undefined;
      let edgesCut = false;
      if (found === undefined && !inWTop(root) && !insideOrEqual(wTop, root)) {
        if (stopped()) return;
        const declared = declaredEdges(root, edgeIO, edgeLimits);
        const edge = declared.edges.find((candidate) => edgeIntoW(root, candidate));
        if (edge !== undefined) via = consumerVia(edge);
        else edgesCut = declared.incomplete;
      }
      // Stopped on a budget or a bound without a consumer: incomplete.
      outcomes[index] = found !== undefined ? found : via !== undefined ? { via } : exhausted || edgesCut || namesCut ? { incomplete: true } : null;
    }
  };
  if (signal === undefined) {
    await work().catch(() => undefined);
    return assemble();
  }
  if (signal.aborted) return assemble();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work().catch(() => undefined), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
  return assemble();
}

/** QA-1 F11: the git common directory of the repository whose top level is `top`, read without git; undefined when unknown. */
function commonDirOf(top: string | undefined): string | undefined {
  if (top === undefined) return undefined;
  const dotGit = path.join(top, ".git");
  try {
    if (lstatSync(dotGit).isDirectory()) return perimeterKey(canonical(dotGit));
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8").slice(0, 4096))?.[1];
    if (named === undefined) return undefined;
    const gitDir = path.resolve(top, named);
    let common = gitDir;
    try {
      common = path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // No `commondir`: a submodule's (or a relocated) git directory is its own common directory.
    }
    return perimeterKey(canonical(common));
  } catch {
    return undefined;
  }
}

/** Link admission (QA-1 F4, I11, I12): `routing.repoParents`, `routing.repoDepth`, `routing.repoExclude` and the working set. */
export interface AdmissionContext {
  /** Both spellings of each parent: as configured, and canonical (link targets are real paths), one per comparison key. */
  readonly parents: readonly string[];
  /** The first parent `dir` lies at least one segment below, if any (admission by text, without touching `dir`). */
  readonly parentOf: (dir: string) => string | undefined;
  /** The working-set entry whose worktree holds `dir` (or is `dir`), if any. */
  readonly worktreeOf: (dir: string) => AdmissionWorktree | undefined;
  /**
   * Whether the top level `top` is admitted: it is a working-set worktree, or it lies 1..`routing.repoDepth` segments below a
   * parent and no `routing.repoExclude` glob matches it or a directory between that parent and it.
   */
  readonly admitTop: (top: string) => boolean;
}

/** A working-set entry as admission reads it: its worktree (and its name). A `RepoLocation` is one. */
export interface AdmissionWorktree {
  readonly worktree: string;
  readonly name?: string;
}

/**
 * Cross-repo P3c.4 (SD-P3c-9): what an `AdmissionContext` is built from, as data: the parents in both spellings (as configured,
 * and canonical, one per comparison key), `routing.repoDepth`, `routing.repoExclude` and the working set. A deferred perimeter
 * freezes it at dispatch, so that `router_verify` admits W's dependency targets as the dispatch did, reading no configuration.
 */
export interface AdmissionData {
  readonly parents: readonly string[];
  readonly depth: number;
  readonly exclude?: readonly string[];
  readonly workingSet: readonly AdmissionWorktree[];
}

/** P3c.4: the admission data of `config` and `workingSet`. Reads the filesystem only to canonicalise each parent. */
export function admissionData(config: PerimeterAdmission, workingSet: readonly AdmissionWorktree[]): AdmissionData {
  // Both spellings of each parent: as configured, and canonical (link targets are real paths).
  const parents = [...new Map(config.parents.flatMap((parent) => [parent, canonical(parent)]).map((p) => [perimeterKey(p), p])).values()];
  return {
    parents,
    depth: config.depth,
    ...(config.exclude !== undefined ? { exclude: [...config.exclude] } : {}),
    workingSet: workingSet.map((entry) => ({ worktree: entry.worktree, ...(entry.name !== undefined ? { name: entry.name } : {}) })),
  };
}

/**
 * Cross-repo P3c.2a: the link admission of `planPerimeter`, factored out so that other admissions (the workspace edges, P3c.2b)
 * read the same parents, depth, excludes and working set. Reads the filesystem only to canonicalise each parent.
 */
export function admissionContext(config: PerimeterAdmission, workingSet: readonly AdmissionWorktree[]): AdmissionContext {
  return admissionFromData(admissionData(config, workingSet));
}

/**
 * Cross-repo P3c.4 (SD-P3c-9): the admission of frozen `data` (its parents already in both spellings). No filesystem call: the
 * admission `router_verify` reads W's dependency targets with is the dispatch's.
 */
export function admissionFromData(data: AdmissionData): AdmissionContext {
  const depth = Math.max(1, Math.floor(data.depth));
  const exclude = data.exclude ?? [];
  const parents = data.parents;
  const workingSet = data.workingSet;
  const excluded = (parent: string, top: string): boolean => {
    if (exclude.length === 0) return false;
    const segments = path.relative(parent, top).split(/[\\/]/).filter((segment) => segment !== "");
    for (let level = 1; level <= segments.length; level++) {
      const dir = path.join(parent, ...segments.slice(0, level));
      if (exclude.some((glob) => permissionMatches(dir, glob))) return true;
    }
    return false;
  };
  const parentOf = (dir: string): string | undefined => parents.find((parent) => depthBelow(dir, parent) >= 1);
  const worktreeOf = (dir: string): AdmissionWorktree | undefined => workingSet.find((entry) => insideOrEqual(dir, entry.worktree));
  // QA-1 F4 (I11, I12): admission by top level, before any git call; the snapshot's top level is checked again at the gate.
  const admitTop = (top: string): boolean =>
    workingSet.some((entry) => perimeterKey(entry.worktree) === perimeterKey(top))
    || parents.some((parent) => {
      const below = depthBelow(top, parent);
      return below >= 1 && below <= depth && !excluded(parent, top);
    });
  return { parents, parentOf, worktreeOf, admitTop };
}

/**
 * Cross-repo P3c QA-1 m4: what `planPerimeter` returns: P, plus how W's declared edges were cut on the way forward, for the
 * caller to log once per dispatch ("past a forward bound: logged", SD-P3c-4; perimeter.ts has no logger of its own).
 */
export interface PlannedPerimeter extends DispatchPerimeter {
  /** A `declaredEdges` bound cut the reading of W's declared edges. */
  readonly edgesIncomplete?: true;
  /** Unadmitted edge targets past EDGE_UNADMITTED_NAMES_MAX: counted, not named. Absent when 0. */
  readonly unadmittedMore?: number;
}

/** A-5.1-12: a plan-task verification id, `plan:<orchestratorSessionID>:<planId>/<taskId>#<n>`; group 1 is the orchestrator. */
export const PLAN_TASK_PERIMETER_ID = /^plan:([^:/]+):[^/]+\/.+#[1-9][0-9]*$/;

/**
 * The perimeter beyond W of the dispatch `dispatchID` (a native `task` dispatch, `task:<orchestrator>:<callID>`) verified at
 * `cwd`, or undefined when it has none (I9): not a routed role dispatch, or neither a grant location nor another working-set
 * root, or no extra root at all. W is the grant location's worktree, else `cwd`. `admission` is read for W's package links and
 * declared dependency edges only (P3c.3); `io` (tests) is what `dependencyTargets` reads them with.
 */
export function planPerimeter(
  dispatchID: string,
  cwd: string,
  admission: () => PerimeterAdmission,
  io: DependencyIO = defaultDependencyIO,
): PlannedPerimeter | undefined {
  // A-5.1-12 (Phase 5.1, additive): a plan-task attempt `plan:<orchestrator>:<planId>/<taskId>#<n>` is planned too, with W its
  // slot (`cwd`, no grant location), the orchestrator's working set and W's link targets.
  const planTask = PLAN_TASK_PERIMETER_ID.exec(dispatchID);
  if (!dispatchID.startsWith("task:") && planTask === null) return undefined;
  const rest = dispatchID.slice("task:".length);
  const separator = rest.indexOf(":");
  if (planTask === null && separator <= 0) return undefined;
  const orchestrator = planTask?.[1] ?? rest.slice(0, separator);
  const routed = planTask === null ? routedRoleOf(rest.slice(separator + 1)) : undefined;
  if (planTask === null && (routed === undefined || routed.parentSessionID !== orchestrator)) return undefined;
  const location = routed?.grant?.location;
  const w = location?.worktree ?? cwd;
  const workingSet = workingSetOf(orchestrator);
  const others = workingSet.filter((entry) => !insideOrEqual(w, entry.worktree) && !insideOrEqual(entry.worktree, w));
  // I13 (S1/S2): with cross-repo configured (`routing.repoParents`), W's admitted link targets are in P even when the dispatch has
  // no location and no working set. Without parents, such a dispatch has none (I9).
  const config = admission();
  if (location === undefined && others.length === 0 && config.parents.length === 0) return undefined;

  // QA-1 F11: W's git common directory, to tell another worktree of W's own repository from another repository.
  const wCommon = commonDirOf(gitTopOf(w));
  const sameRepository = (top: string): boolean => wCommon !== undefined && commonDirOf(top) === wCommon;

  const seeds: PerimeterSeed[] = [];
  const seen = new Set<string>([perimeterKey(w)]);
  let observed = 0;
  // QA-1 F2: past the cap a root is kept, unobserved (the gate refuses it with writers), never dropped.
  const add = (seed: PerimeterSeed): void => {
    const key = perimeterKey(seed.at);
    if (seen.has(key)) return;
    seen.add(key);
    if (seed.fixed !== undefined) {
      seeds.push(seed);
      return;
    }
    observed += 1;
    if (observed <= PERIMETER_MAX - 1) {
      seeds.push(seed);
      return;
    }
    seeds.push({
      at: seed.at,
      ...(seed.name !== undefined ? { name: seed.name } : {}),
      ...(seed.sameRepository === true ? { sameRepository: true } : {}),
      ...(seed.origin !== undefined ? { origin: seed.origin } : {}),
      fixed: "unobserved",
    });
  };
  for (const entry of others) {
    add({
      at: entry.worktree,
      name: entry.name,
      origin: "working-set",
      ...(sameRepository(entry.worktree) ? { sameRepository: true } : {}),
    });
  }

  // P3c.2a: link admission (parents in both spellings, depth, excludes, working set), factored into `admissionContext`.
  // P3c.4 (SD-P3c-9): its data is returned with P, frozen with a deferred perimeter for router_verify.
  const frozenAdmission = admissionData(config, workingSet);
  const linkAdmission = admissionFromData(frozenAdmission);
  const { parentOf, worktreeOf, admitTop } = linkAdmission;
  // P3c.3 (SD-P3c-1): W's package links first (`linkedTargets`, unchanged), then its declared edges, read once.
  const dependencies = dependencyTargets(w, { ...linkAdmission, sameRepository }, io);

  for (const dependency of dependencies.targets) {
    if (dependency.origin !== "link") continue;
    const real = dependency.at;
    // Admission by text first: a link outside every parent and every working-set worktree is not in P, but it is not dropped
    // either (I8, I12): kept as an unadmitted root named by its basename, without running git or touching the filesystem.
    const parent = parentOf(real);
    const worktree = worktreeOf(real);
    if (parent === undefined && worktree === undefined) {
      add({ at: real, name: path.basename(real), fixed: "unadmitted", origin: "link" });
      continue;
    }
    // QA-1 F3: the repository's top level, without git; the walk stops at the parent (or above the worktree).
    const top = gitTopOf(real, worktree !== undefined ? path.dirname(worktree.worktree) : parent);
    if (top === undefined) {
      add({ at: real, name: path.basename(real), fixed: "unadmitted", origin: "link" }); // Not in a git repository: nothing to observe.
      continue;
    }
    if (insideOrEqual(top, w) || insideOrEqual(w, top)) continue; // W's own repository: W's snapshot covers it.
    const covering = seeds.findIndex((seed) => seed.fixed === undefined && insideOrEqual(top, seed.at));
    if (covering >= 0) {
      // A root already in P covers it: one seed. QA-1 #9a: a working-set root covering it is marked as a link target too, so it
      // is pinned at dispatch; it keeps its working-set semantics (consumer discovery, I13). Its admission still accepts any
      // top level at, above or inside it at the gate (as without one), and admits its own links for the pin as a link's are.
      const seed = seeds[covering];
      if (seed !== undefined && seed.origin === "working-set" && seed.linked !== true) {
        const at = seed.at;
        seeds[covering] = {
          ...seed,
          linked: true,
          admit: (dir: string): boolean => insideOrEqual(dir, at) || insideOrEqual(at, dir) || admitTop(dir),
        };
      }
      continue;
    }
    if (!admitTop(top)) {
      add({ at: top, name: path.basename(top), fixed: "unadmitted", origin: "link" });
      continue;
    }
    add({ at: top, admit: admitTop, origin: "link", ...(sameRepository(top) ? { sameRepository: true } : {}) });
  }

  // P3c.3 (SD-P3c-2): W's declared dependency edges outside `node_modules`, after the links, so that a link and an edge into one
  // repository are one "link" seed (pinned as before). An admitted edge is a seed of origin "edge", observed like a link target
  // (I4, I8), counted toward PERIMETER_MAX and frozen for S11 (P3c.4), but never pinned (F3). An unadmitted one is
  // named (`name (not admitted)`, at most EDGE_UNADMITTED_NAMES_MAX, `dependencyTargets`), never snapshotted (I11, I12).
  for (const dependency of dependencies.targets) {
    if (dependency.origin !== "edge") continue;
    if ("fixed" in dependency) {
      add({ at: dependency.at, name: dependency.name, fixed: "unadmitted", origin: "edge" });
      continue;
    }
    const top = dependency.at;
    const covering = seeds.findIndex((seed) => seed.fixed === undefined && insideOrEqual(top, seed.at));
    if (covering >= 0) {
      // A root already in P covers it: one seed. A working-set root keeps its semantics and is marked `edged`; unlike a `linked`
      // one it is not pinned (F3). A link seed, or a working-set root already `linked`, stays as it is.
      const seed = seeds[covering];
      if (seed !== undefined && seed.origin === "working-set" && seed.linked !== true && seed.edged !== true) {
        seeds[covering] = { ...seed, edged: true };
      }
      continue;
    }
    add({ at: top, admit: admitTop, origin: "edge" });
  }
  if (seeds.length === 0) return undefined;
  return {
    ...(location !== undefined ? { name: location.name } : {}),
    roots: seeds,
    admission: frozenAdmission,
    // QA-1 m4: the forward bounds' outcome, for the caller to log once per dispatch (this module has no logger).
    ...(dependencies.incomplete ? { edgesIncomplete: true as const } : {}),
    ...(dependencies.unadmittedMore > 0 ? { unadmittedMore: dependencies.unadmittedMore } : {}),
  };
}
