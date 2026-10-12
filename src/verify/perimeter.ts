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
 * (`resolveEdgeTarget`) with the same admission as a link (`admissionContext`). Not wired yet (P3c.3).
 */
import { type Dirent, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import { permissionMatches } from "../router/read-only";
import type { RepoLocation } from "../routing/roles/admission";
import { routedRoleOf } from "../routing/wire/dispatch";
import { workingSetOf } from "../routing/wire/working-set";
import type { DispatchPerimeter, PerimeterSeed } from "./dispatch";
import { type DeclaredEdge, type EdgeIO, type EdgeVia, declaredEdges, defaultEdgeIO, isUncSpec, workspacePatterns } from "./edges";
import { depthBelow, gitTopOf, perimeterKey } from "./git-top";
import { isStoreLikeLink } from "./reference";

/** P holds at most this many snapshotted roots, W included. */
export const PERIMETER_MAX = 16;

/** Cross-repo P3c (SD-P3c-4): at most this many unadmitted declared-edge targets are named; the others are counted only. */
export const EDGE_UNADMITTED_NAMES_MAX = 8;

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
    return python ? { status: "skipped", reason: "pythonOutside" } : { status: "unadmitted", at: edge.spec, name: textName(edge.spec) };
  }
  const target = path.resolve(path.dirname(path.join(ctx.root, edge.from)), edge.spec);
  const unadmittedText: EdgeResolution = { status: "unadmitted", at: target, name: textName(target) };
  if (isUncSpec(target)) return python ? { status: "skipped", reason: "pythonOutside" } : unadmittedText;
  if (hasNodeModulesSegment(target)) return { status: "skipped", reason: "nodeModules" };
  if (insideOrEqual(target, wTop) || insideOrEqual(wTop, target)) return { status: "skipped", reason: "insideW" };
  const parent = ctx.parentOf(target);
  const worktree = ctx.worktreeOf(target);
  if (parent === undefined && worktree === undefined) return python ? { status: "skipped", reason: "pythonOutside" } : unadmittedText;

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
  if (ctx.sameRepository(top)) return { status: "skipped", reason: "sameRepository" };
  if (!ctx.admitTop(top)) return { status: "unadmitted", at: top, name: path.basename(top) };
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
 * admitted by text first, `resolveEdgeTarget`). `ctx.sameRepository` defaults to "shares W's git common directory". Nothing
 * calls it yet (P3c.3 wires it into the perimeter).
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
  // An edge whose top level is already a link target is that link (SD-P3c-2: links first, one target).
  const seen = new Set<string>(targets.map((target) => perimeterKey(target.at)));
  let named = 0;
  let unadmittedMore = 0;
  for (const edge of declared.edges) {
    const resolved = resolveEdgeTarget(edge, edgeContext, wTop, io);
    if (resolved.status === "skipped") continue;
    const at = resolved.status === "admitted" ? resolved.top : resolved.at;
    if (seen.has(perimeterKey(at))) continue;
    seen.add(perimeterKey(at));
    if (resolved.status === "admitted") {
      targets.push({ origin: "edge", at, via: edge.via, from: edge.from });
    } else if (named < EDGE_UNADMITTED_NAMES_MAX) {
      named += 1;
      targets.push({ origin: "edge", at, via: edge.via, from: edge.from, name: resolved.name, fixed: "unadmitted" });
    } else {
      unadmittedMore += 1;
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

/** Cross-repo P2b.3: one working-set worktree whose `node_modules` links into W. */
export interface PerimeterConsumer {
  readonly root: string;
  readonly name?: string;
  /** The link, relative to `<root>/node_modules` (for example `lib` or `@scope/lib`), "/" separated. */
  readonly entry: string;
}

/** Cross-repo P2b.3: the bound on `node_modules` LINK entries checked by `discoverConsumers`, per root (QA-1 #2, M2: plain entries are free). */
export const CONSUMER_SCAN_MAX = 2000;

/** Cross-repo M2: the hard bound on all `node_modules` entries (links or not) read per root; past it the root is incomplete. */
export const CONSUMER_READ_MAX = 20000;

/** Cross-repo QA-1 #2: the bound on W's package names looked up directly (W's own, plus its workspace packages'). */
export const CONSUMER_NAMES_MAX = 64;

/** Cross-repo QA-1 #2: the bound on the workspace `package.json` files read to learn W's package names. */
const WORKSPACE_MANIFESTS_MAX = 256;

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

/**
 * The directories of one `workspaces` pattern, inside W only: literal segments, and a wildcard (`*`, `**`) in the last segment
 * only, matched one level deep. Negations, absolute paths, `..` and inner wildcards give none. At most `limit` directories.
 * Exported for the agreement test with its synchronous twin, edges.ts `workspaceDirsSync` (P3c.1).
 */
export async function workspaceDirs(w: string, pattern: string, limit: number): Promise<string[]> {
  if (pattern.startsWith("!") || path.isAbsolute(pattern) || /^[\\/]/.test(pattern)) return [];
  const segments = pattern.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return [];
  const last = segments[segments.length - 1] ?? "";
  const head = segments.slice(0, -1);
  if (head.some((segment) => segment.includes("*"))) return [];
  if (!last.includes("*")) return [path.join(w, ...segments)];
  const escaped = last.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(`^${escaped.join("[^/\\\\]*")}$`, process.platform === "win32" ? "i" : "");
  const base = path.join(w, ...head);
  let children: string[];
  try {
    children = await readdir(base);
  } catch {
    return [];
  }
  return children
    .filter((child) => !child.startsWith(".") && child !== "node_modules" && match.test(child))
    .slice(0, limit)
    .map((child) => path.join(base, child));
}

/**
 * Cross-repo QA-1 #2: W's package names, looked up directly in each root's `node_modules`: the `name` of `<W>/package.json`
 * and, when W is a workspace root, the `name` of each workspace package its `workspaces` lists. Bounded (CONSUMER_NAMES_MAX
 * names, WORKSPACE_MANIFESTS_MAX manifests); `stop` ends the reading early (the deadline).
 */
async function packageNamesOf(w: string, stop: () => boolean): Promise<string[]> {
  const names = new Set<string>();
  const take = (manifest: Record<string, unknown> | undefined): void => {
    const name = manifest?.name;
    if (typeof name === "string" && PACKAGE_NAME.test(name) && names.size < CONSUMER_NAMES_MAX) names.add(name);
  };
  const manifest = await readManifest(w);
  if (manifest === undefined) return [];
  take(manifest);
  let read = 0;
  for (const pattern of workspacePatterns(manifest)) {
    if (stop() || names.size >= CONSUMER_NAMES_MAX || read >= WORKSPACE_MANIFESTS_MAX) break;
    for (const dir of await workspaceDirs(w, pattern, WORKSPACE_MANIFESTS_MAX - read)) {
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
 */
export async function discoverConsumers(
  w: string,
  roots: readonly ConsumerRoot[],
  opts?: { maxEntries?: number; maxRead?: number; signal?: AbortSignal },
): Promise<ConsumerDiscovery> {
  const maxEntries = Math.max(0, Math.floor(opts?.maxEntries ?? CONSUMER_SCAN_MAX));
  const readMax = Math.max(0, Math.floor(opts?.maxRead ?? CONSUMER_READ_MAX));
  const signal = opts?.signal;
  const stopped = (): boolean => signal?.aborted === true;
  // Per root, by index: a consumer's entry, "incomplete", "none"; unset while the root is not finished.
  // W (or a root around it) is never scanned, so never incomplete either: settled before any fs call, by text.
  const outcomes: (string | { readonly incomplete: true } | null | undefined)[] = roots.map(({ root }) =>
    (insideOrEqual(root, w) || insideOrEqual(w, root) ? null : undefined));
  const assemble = (): ConsumerDiscovery => {
    const consumers: PerimeterConsumer[] = [];
    const incomplete: ConsumerRoot[] = [];
    roots.forEach(({ root, name }, index) => {
      const outcome = outcomes[index];
      const named = name !== undefined ? { name } : {};
      if (typeof outcome === "string") consumers.push({ root, ...named, entry: outcome });
      else if (outcome !== null) incomplete.push({ root, ...named });
    });
    return { consumers, incomplete };
  };
  const work = async (): Promise<void> => {
    // Link targets are real paths: W is matched as given and as its real path (a junction or 8.3 spelling of W).
    const wReal = await realpath(w).catch(() => w);
    const inW = (dir: string): boolean => insideOrEqual(dir, w) || insideOrEqual(dir, wReal);
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
    const wNames = await packageNamesOf(w, stopped);
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
      // (c) Stopped on the budget without a consumer: incomplete.
      outcomes[index] = found !== undefined ? found : exhausted ? { incomplete: true } : null;
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
  readonly worktreeOf: (dir: string) => RepoLocation | undefined;
  /**
   * Whether the top level `top` is admitted: it is a working-set worktree, or it lies 1..`routing.repoDepth` segments below a
   * parent and no `routing.repoExclude` glob matches it or a directory between that parent and it.
   */
  readonly admitTop: (top: string) => boolean;
}

/**
 * Cross-repo P3c.2a: the link admission of `planPerimeter`, factored out so that other admissions (the workspace edges, P3c.2b)
 * read the same parents, depth, excludes and working set. Reads the filesystem only to canonicalise each parent.
 */
export function admissionContext(config: PerimeterAdmission, workingSet: readonly RepoLocation[]): AdmissionContext {
  const depth = Math.max(1, Math.floor(config.depth));
  const exclude = config.exclude ?? [];
  // Both spellings of each parent: as configured, and canonical (link targets are real paths).
  const parents = [...new Map(config.parents.flatMap((parent) => [parent, canonical(parent)]).map((p) => [perimeterKey(p), p])).values()];
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
  const worktreeOf = (dir: string): RepoLocation | undefined => workingSet.find((entry) => insideOrEqual(dir, entry.worktree));
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
 * The perimeter beyond W of the dispatch `dispatchID` (a native `task` dispatch, `task:<orchestrator>:<callID>`) verified at
 * `cwd`, or undefined when it has none (I9): not a routed role dispatch, or neither a grant location nor another working-set
 * root, or no extra root at all. W is the grant location's worktree, else `cwd`. `admission` is read for W's package links only.
 */
export function planPerimeter(dispatchID: string, cwd: string, admission: () => PerimeterAdmission): DispatchPerimeter | undefined {
  if (!dispatchID.startsWith("task:")) return undefined;
  const rest = dispatchID.slice("task:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const orchestrator = rest.slice(0, separator);
  const routed = routedRoleOf(rest.slice(separator + 1));
  if (routed === undefined || routed.parentSessionID !== orchestrator) return undefined;
  const location = routed.grant?.location;
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
  const { parentOf, worktreeOf, admitTop } = admissionContext(config, workingSet);

  for (const real of linkedTargets(w)) {
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
  if (seeds.length === 0) return undefined;
  return { ...(location !== undefined ? { name: location.name } : {}), roots: seeds };
}
