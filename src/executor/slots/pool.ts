// Slot pool (phase 2.4.3), see docs/qa/critical-path-execution/phase-2.4.md sections 3 and 4.
// Layout: <slotsDir>\slot-<n>, <slotsDir>\integration, <slotsDir>\ci. Markers: <markersDir>\<planId>\<slot>.json (DV1).
// All I/O goes through the seams (GitOps, FileSystem, Clock, Provisioner); no node:fs here.
// Every destructive clean is preceded by a sweep of exactly the paths `git clean -n` lists (GitOps.cleanPreview), because
// git's recursive delete can follow a junction. Phase 3.1 commits before it calls `cleanForChecks`.

import { posix, win32 } from "node:path";
import { CLEANUP_RETRIES, CLEANUP_RETRY_BASE_MS, TRANSIENT_FS_CODES, isStrictlyInside } from "../../verify/reference";
import type { GitOps } from "../git";
import { ExecutorError, GIT_ID_PATTERN, PLAN_ID_PATTERN } from "../types";
import type { Clock, FileSystem, PlanId, SlotLease, SlotPool, SlotRecord } from "../types";
import { registerSlot, unregisterSlot } from "./env";
import type { SlotBin } from "./env";
import { DEPENDENCY_DIRS, SLOT_SWEEP_MAX_ENTRIES, needsProvision } from "./provision";
import type { Detection, Provisioner } from "./provision";

export const UNKNOWN_PLAN_GC_AGE_MS = 7 * 24 * 3_600_000;
export { SLOT_SWEEP_MAX_ENTRIES }; // one cap, defined next to the provisioner's own sweep
export const SLOT_RM_BUDGET_MS = 120_000; // per slot, confirm with M7
export const RESET_RETRY_DELAY_MS = 2_000;
export const SLOT_NAME_PATTERN = /^(?:slot-[1-9][0-9]{0,2}|integration|ci)$/;

const MARKER_MAX_BYTES = 64 * 1024;
const MAX_TASK_SLOT_NUMBER = 999;
const OWNER_PATTERN = /^[\x20-\x7e]{1,128}$/;
const MANIFEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SLOT_STATES: readonly SlotRecord["state"][] = ["creating", "provisioning", "ready", "leased", "resetting", "broken", "retired"];
const STAGE_STATES: readonly SlotRecord["state"][] = ["creating", "provisioning", "resetting"];
const DEPENDENCY_DIR_NAMES: ReadonlySet<string> = new Set(Object.values(DEPENDENCY_DIRS).flat());
const NODE_MANAGER_NAMES: readonly string[] = ["npm", "pnpm", "yarn"];
const PYTHON_MANAGER_NAMES: readonly string[] = ["pip", "poetry", "uv"];

export interface SlotPoolDeps {
  planId: PlanId; repoKey: string; toplevel: string; slotsDir: string; markersDir: string; executorHome: string;
  maxParallel: number; git: GitOps; fs: FileSystem; clock: Clock; provisioner: Provisioner;
  platform?: NodeJS.Platform; logger?: { warn(m: string): void };
  onProvision?: (slot: string, managers: readonly string[]) => void; // test and smoke hook
}

type GcDeps = Omit<SlotPoolDeps, "planId" | "maxParallel" | "provisioner" | "onProvision">;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

function pathApi(platform: NodeJS.Platform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function shapeApi(p: string): typeof win32 {
  return /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(p) ? win32 : posix;
}

function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(child: string, parent: string, platform: NodeJS.Platform): boolean {
  return comparable(child, platform) === comparable(parent, platform) || isStrictlyInside(child, parent, platform);
}

function hasDotSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function slotKindOf(slot: string): SlotRecord["kind"] {
  return slot === "integration" ? "integration" : slot === "ci" ? "ci" : "task";
}

function slotOrder(slot: string): number {
  if (slot === "integration") return 1_000_000;
  if (slot === "ci") return 1_000_001;
  const n = Number(slot.slice("slot-".length));
  return Number.isFinite(n) ? n : 2_000_000;
}

function compareSlots(a: string, b: string): number {
  return slotOrder(a) - slotOrder(b);
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** A `.produced` sidecar: a JSON array of clean exclusions (each 1-400 characters, no newline). */
function parseStringArray(text: string | null): string[] | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A torn or foreign file is treated like a missing one; the caller warns.
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.length === 0 || item.length > 400 || item.includes("\n")) return null;
    out.push(item);
  }
  return out;
}

/** A `.bins` sidecar: a JSON array of `{path, size, mtimeMs}`. */
function parseBins(text: string | null): SlotBin[] | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A torn or foreign file is treated like a missing one; the caller warns.
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: SlotBin[] = [];
  for (const item of value as unknown[]) {
    if (!isPlainRecord(item)) return null;
    const { path, size, mtimeMs } = item;
    if (typeof path !== "string" || path.length === 0 || typeof size !== "number" || typeof mtimeMs !== "number") return null;
    out.push({ path, size, mtimeMs });
  }
  return out;
}

function cloneRecord(r: SlotRecord): SlotRecord {
  return { ...r, managers: [...r.managers], manifests: { ...r.manifests } };
}

/** Guard for a marker read from disk (memo 3); the content is exactly `SlotRecord`. */
export function isSlotRecord(v: unknown): v is SlotRecord {
  if (!isPlainRecord(v)) return false;
  if (v["schema"] !== 1) return false;
  const slot = v["slot"];
  if (typeof slot !== "string" || !SLOT_NAME_PATTERN.test(slot)) return false;
  const path = v["path"];
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (v["kind"] !== slotKindOf(slot)) return false;
  const planId = v["planId"];
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) return false;
  const repoKey = v["repoKey"];
  if (typeof repoKey !== "string" || repoKey.length === 0 || repoKey.length > 512) return false;
  const state = v["state"];
  if (typeof state !== "string" || !(SLOT_STATES as readonly string[]).includes(state)) return false;
  const owner = v["owner"];
  if (owner !== null && (typeof owner !== "string" || !OWNER_PATTERN.test(owner))) return false;
  const commit = v["commit"];
  if (commit !== null && (typeof commit !== "string" || !GIT_ID_PATTERN.test(commit))) return false;
  const managers = v["managers"];
  if (!Array.isArray(managers) || managers.length > 16) return false;
  if (!managers.every((m: unknown) => typeof m === "string" && m.length > 0 && m.length <= 32)) return false;
  const manifests = v["manifests"];
  if (!isPlainRecord(manifests)) return false;
  if (!Object.values(manifests).every((h) => typeof h === "string" && MANIFEST_DIGEST_PATTERN.test(h))) return false;
  const createdAt = v["createdAt"];
  const updatedAt = v["updatedAt"];
  return typeof createdAt === "string" && createdAt.length <= 40 && typeof updatedAt === "string" && updatedAt.length <= 40;
}

export function slotLockReason(planId: PlanId, slot: string): string {
  return `omr-executor slot ${planId}/${slot}: managed by the model-router executor; remove with router_plan action=gc`;
}

export function markerPath(markersDir: string, planId: PlanId, slot: string): string {
  if (!PLAN_ID_PATTERN.test(planId)) throw new ExecutorError("E_INVALID_INPUT", "invalid plan id for a slot marker", { planId: String(planId).slice(0, 80) });
  if (!SLOT_NAME_PATTERN.test(slot)) throw new ExecutorError("E_INVALID_INPUT", "invalid slot name for a slot marker", { slot: String(slot).slice(0, 80) });
  return shapeApi(markersDir).join(markersDir, planId, `${slot}.json`);
}

/**
 * Pure guard, called immediately before every destructive operation on a slot directory: absolute, no "."/".." segment,
 * basename matches SLOT_NAME_PATTERN and equals `slot`, the parent IS `slotsDir` (comparable), and `slotsDir` is not a filesystem root.
 */
export function assertSafeSlotDir(path: string, slot: string, slotsDir: string, platform: NodeJS.Platform = process.platform): void {
  const api = pathApi(platform);
  const fail = (why: string): never => {
    throw new ExecutorError("E_INVALID_INPUT", `refusing slot dir ${JSON.stringify(path)}: ${why}`, { slot: String(slot).slice(0, 80) });
  };
  if (typeof path !== "string" || path.length === 0 || !api.isAbsolute(path)) fail("not absolute");
  if (typeof slotsDir !== "string" || slotsDir.length === 0 || !api.isAbsolute(slotsDir)) fail("slotsDir is not absolute");
  if (hasDotSegment(path) || hasDotSegment(slotsDir)) fail("dot segment");
  if (typeof slot !== "string" || !SLOT_NAME_PATTERN.test(slot)) fail("name does not match the slot pattern");
  const resolved = api.resolve(path);
  if (api.basename(resolved) !== slot) fail("name differs from the slot");
  const root = api.resolve(slotsDir);
  if (api.parse(root).root === root) fail("slotsDir is a filesystem root");
  if (comparable(api.dirname(resolved), platform) !== comparable(root, platform)) fail("parent is not slotsDir");
}

/** Default `slotsDir`: `<repo drive>:\.omr-slots\<planId>` (D18). A repository without a drive letter has no default. */
export function defaultSlotsDir(toplevel: string, planId: PlanId): string {
  if (!PLAN_ID_PATTERN.test(planId)) throw new ExecutorError("E_INVALID_INPUT", "invalid plan id", { planId: String(planId).slice(0, 80) });
  const drive = /^([A-Za-z]):[\\/]/.exec(toplevel);
  if (drive === null) {
    throw new ExecutorError("E_INVALID_INPUT", "the repository is not on a drive-letter path; set executor.slotsDir", { toplevel: String(toplevel).slice(0, 200) });
  }
  return `${drive[1]}:\\.omr-slots\\${planId}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency, retry, file helpers
// ---------------------------------------------------------------------------------------------------------------

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  /** FIFO. The call is queued synchronously, so the order of `run` calls is the order of execution. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(ms, () => resolve());
  });
}

/** The flat retry loop of verify/reference withRetry (private there): `op` must not retry on its own. */
async function withRetry<T>(clock: Clock, op: () => Promise<T>, deadline = Number.POSITIVE_INFINITY): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const code = errorCode(error);
      const delay = CLEANUP_RETRY_BASE_MS * 2 ** attempt;
      if (attempt >= CLEANUP_RETRIES || code === undefined || !TRANSIENT_FS_CODES.has(code)) throw error;
      if (clock.now() + delay >= deadline) throw error;
      await sleep(clock, delay);
    }
  }
}

interface FileCtx {
  fs: FileSystem; clock: Clock; markersDir: string; platform: NodeJS.Platform; logger?: { warn(m: string): void };
}

async function mkdirp(fs: FileSystem, p: string, platform: NodeJS.Platform): Promise<void> {
  const api = pathApi(platform);
  const missing: string[] = [];
  let cur = api.resolve(p);
  for (;;) {
    if (await fs.lstat(cur) !== null) break;
    missing.push(cur);
    const up = api.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const dir of missing.reverse()) {
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

async function removeFile(x: FileCtx, p: string): Promise<void> {
  try {
    await withRetry(x.clock, () => x.fs.rm(p, { recursive: false }));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** Sidecars beside a marker: `<slot>.produced` (the keep list) and `<slot>.bins` (the executable snapshot, QA-2.4-27). */
const SIDECAR_EXTENSIONS: readonly string[] = ["produced", "bins"];

function sidecarPath(markersDir: string, planId: PlanId, slot: string, extension: string): string {
  return markerPath(markersDir, planId, slot).replace(/\.json$/, `.${extension}`);
}

/** Temp file with fsync, rename, then fsyncDir (memo 3). */
async function writeMarkerFile(x: FileCtx, rec: SlotRecord): Promise<void> {
  const text = `${JSON.stringify(rec)}\n`;
  if (Buffer.byteLength(text, "utf8") > MARKER_MAX_BYTES) {
    throw new ExecutorError("E_SLOT_BROKEN", `the marker of ${rec.slot} would exceed ${MARKER_MAX_BYTES} bytes`, { slot: rec.slot });
  }
  await writeAtomic(x, markerPath(x.markersDir, rec.planId, rec.slot), text);
}

/** The marker's atomic write for any file in the plan's marker directory. */
async function writeAtomic(x: FileCtx, final: string, text: string): Promise<void> {
  const api = pathApi(x.platform);
  const dir = api.dirname(final);
  await mkdirp(x.fs, dir, x.platform);
  const tmp = `${final}.${x.clock.randomHex(8)}.tmp`;
  await x.fs.writeText(tmp, text, { exclusive: true, fsync: true });
  try {
    await withRetry(x.clock, () => x.fs.rename(tmp, final));
  } catch (error) {
    try {
      await removeFile(x, tmp);
    } catch (cleanup) {
      x.logger?.warn(`could not remove ${tmp}: ${messageOf(cleanup)}`);
    }
    throw error;
  }
  await x.fs.fsyncDir(dir);
}

type MarkerRead = { ok: true; rec: SlotRecord } | { ok: false; reason: string; missing: boolean };

/** Bounded to 64 KiB and checked by `isSlotRecord`. */
async function readMarkerFile(x: FileCtx, file: string): Promise<MarkerRead> {
  const st = await x.fs.lstat(file);
  if (st === null) return { ok: false, reason: "missing", missing: true };
  if (st.kind !== "file") return { ok: false, reason: `not a regular file (${st.kind})`, missing: false };
  if (st.size > MARKER_MAX_BYTES) return { ok: false, reason: `larger than ${MARKER_MAX_BYTES} bytes`, missing: false };
  let text: string;
  try {
    text = await x.fs.readText(file);
  } catch (error) {
    return { ok: false, reason: `unreadable: ${messageOf(error)}`, missing: errorCode(error) === "ENOENT" };
  }
  if (Buffer.byteLength(text, "utf8") > MARKER_MAX_BYTES) return { ok: false, reason: `larger than ${MARKER_MAX_BYTES} bytes`, missing: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${messageOf(error)}`, missing: false };
  }
  if (!isSlotRecord(value)) return { ok: false, reason: "not a slot record", missing: false };
  return { ok: true, rec: value };
}

async function writeSidecar(x: FileCtx, planId: PlanId, slot: string, extension: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MARKER_MAX_BYTES) {
    throw new ExecutorError("E_SLOT_BROKEN", `the .${extension} file of ${slot} would exceed ${MARKER_MAX_BYTES} bytes`, { slot });
  }
  await writeAtomic(x, sidecarPath(x.markersDir, planId, slot, extension), text);
}

/** The text of a sidecar, or null when it is missing, not a regular file, too large or unreadable (a warning for the last three). */
async function readSidecar(x: FileCtx, planId: PlanId, slot: string, extension: string): Promise<string | null> {
  const file = sidecarPath(x.markersDir, planId, slot, extension);
  const st = await x.fs.lstat(file);
  if (st === null) return null;
  if (st.kind !== "file" || st.size > MARKER_MAX_BYTES) {
    x.logger?.warn(`ignoring ${file}: not a regular file of at most ${MARKER_MAX_BYTES} bytes`);
    return null;
  }
  try {
    return await x.fs.readText(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") x.logger?.warn(`could not read ${file}: ${messageOf(error)}`);
    return null;
  }
}

async function removeSidecar(x: FileCtx, planId: PlanId, slot: string, extension: string): Promise<void> {
  await removeFile(x, sidecarPath(x.markersDir, planId, slot, extension));
}

async function readdirOrEmpty(fs: FileSystem, dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

interface PlanMarkers {
  records: Array<{ file: string; rec: SlotRecord }>;
  invalid: Array<{ file: string; reason: string }>;
}

/** The markers of one plan; a record whose file name or plan directory does not match its content is invalid. */
async function readPlanMarkers(x: FileCtx, planId: PlanId): Promise<PlanMarkers> {
  const api = pathApi(x.platform);
  const dir = api.join(x.markersDir, planId);
  const out: PlanMarkers = { records: [], invalid: [] };
  const st = await x.fs.lstat(dir);
  if (st === null || st.kind !== "dir") return out;
  for (const name of await readdirOrEmpty(x.fs, dir)) {
    if (!name.endsWith(".json")) continue;
    const file = api.join(dir, name);
    const read = await readMarkerFile(x, file);
    if (!read.ok) {
      if (!read.missing) out.invalid.push({ file, reason: read.reason });
      continue;
    }
    if (read.rec.planId !== planId || `${read.rec.slot}.json` !== name) {
      out.invalid.push({ file, reason: "the content does not match the file name or plan directory" });
      continue;
    }
    out.records.push({ file, rec: read.rec });
  }
  return out;
}

async function listPlanDirs(x: FileCtx): Promise<string[]> {
  return (await readdirOrEmpty(x.fs, x.markersDir)).filter((name) => PLAN_ID_PATTERN.test(name)).sort();
}

/** Deletes the marker and, once empty, the plan's marker directory. Never touches slotsDir. */
async function deleteMarker(x: FileCtx, rec: SlotRecord): Promise<void> {
  const api = pathApi(x.platform);
  const file = markerPath(x.markersDir, rec.planId, rec.slot);
  const dir = api.dirname(file);
  await removeFile(x, file);
  for (const extension of SIDECAR_EXTENSIONS) await removeSidecar(x, rec.planId, rec.slot, extension);
  await x.fs.fsyncDir(dir);
  try {
    if ((await readdirOrEmpty(x.fs, dir)).length === 0) await x.fs.rm(dir, { recursive: false });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") x.logger?.warn(`could not remove the marker directory ${dir}: ${messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Link sweep and slot removal (memo 4.5)
// ---------------------------------------------------------------------------------------------------------------

interface SweepCtx { fs: FileSystem; clock: Clock; platform: NodeJS.Platform }

/**
 * lstat walk: a symlink or junction is removed with a non-recursive `fs.rm`, never descended into; before each `readdir` the
 * `realpath` of the directory must be inside the `realpath` of the slot. `tracked` links (pre-clean mode) are left alone.
 * Two shapes: the whole slot (`starts` null; `skipDependencyDirs` then skips `node_modules` and `.venv`, which is only safe
 * when the destructive op cannot enter them), or exactly the given slot-relative `starts` (the output of `cleanPreview`),
 * each swept in full with no skipping. `removeRootGitLink` also removes a link at `<root>/.git` (retire only).
 */
async function sweepLinks(
  x: SweepCtx, root: string,
  o: { skipDependencyDirs: boolean; tracked: ReadonlySet<string> | null; starts?: readonly string[]; removeRootGitLink?: boolean },
): Promise<{ removed: string[]; truncated: boolean }> {
  const api = pathApi(x.platform);
  const realRoot = await x.fs.realpath(root);
  const removed: string[] = [];
  let seen = 0;
  const isLink = (kind: string): boolean => kind === "symlink" || kind === "junction";
  const stack: string[] = [];
  if (o.starts === undefined) stack.push("");
  else {
    for (const start of o.starts) {
      const rel = start.replace(/\/+$/, "");
      if (rel === "" || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
        throw new ExecutorError("E_SLOT_BROKEN", `unsafe clean candidate ${JSON.stringify(start)}`, { start: start.slice(0, 200) });
      }
      // Every parent of a candidate is walked by lstat: a link in the middle is removed, never followed.
      const parts = rel.split("/");
      let cur = "";
      for (let n = 0; n < parts.length; n++) {
        cur = cur === "" ? parts[n] ?? "" : `${cur}/${parts[n] ?? ""}`;
        const path = api.join(root, ...cur.split("/"));
        const st = await x.fs.lstat(path);
        if (st === null) break;
        if (isLink(st.kind)) {
          if (o.tracked === null || !o.tracked.has(cur)) {
            await withRetry(x.clock, () => x.fs.rm(path, { recursive: false }));
            removed.push(cur);
          }
          break;
        }
        if (n === parts.length - 1 && st.kind === "dir") stack.push(cur);
        if (st.kind !== "dir") break;
      }
    }
  }
  for (;;) {
    const rel = stack.pop();
    if (rel === undefined) break;
    const dir = rel === "" ? root : api.join(root, ...rel.split("/"));
    const real = await x.fs.realpath(dir);
    if (!isInsideOrEqual(real, realRoot, x.platform)) {
      throw new ExecutorError("E_SLOT_BROKEN", `${dir} resolves outside its slot`, { dir });
    }
    for (const name of await x.fs.readdir(dir)) {
      seen++;
      if (seen > SLOT_SWEEP_MAX_ENTRIES) return { removed, truncated: true };
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const child = api.join(dir, name);
      const st = await x.fs.lstat(child);
      if (st === null) continue;
      if (rel === "" && name === ".git") {
        if (o.removeRootGitLink === true && isLink(st.kind)) {
          await withRetry(x.clock, () => x.fs.rm(child, { recursive: false }));
          removed.push(childRel);
        }
        continue;
      }
      if (isLink(st.kind)) {
        if (o.tracked !== null && o.tracked.has(childRel)) continue;
        await withRetry(x.clock, () => x.fs.rm(child, { recursive: false }));
        removed.push(childRel);
      } else if (st.kind === "dir") {
        if (o.skipDependencyDirs && o.starts === undefined && DEPENDENCY_DIR_NAMES.has(name)) continue;
        stack.push(childRel);
      }
    }
  }
  return { removed, truncated: false };
}

/** The slot itself must be a real directory whose real path is its parent's real path plus its own name. */
async function assertRealSlotDir(fs: FileSystem, path: string, platform: NodeJS.Platform): Promise<void> {
  const api = pathApi(platform);
  const st = await fs.lstat(path);
  if (st === null || st.kind !== "dir") {
    throw new ExecutorError("E_SLOT_BROKEN", `${path} is not a real directory (${st === null ? "missing" : st.kind})`, { path });
  }
  const expected = api.join(await fs.realpath(api.dirname(path)), api.basename(path));
  if (comparable(await fs.realpath(path), platform) !== comparable(expected, platform)) {
    throw new ExecutorError("E_SLOT_BROKEN", `${path} resolves through a link`, { path });
  }
}

interface RetireCtx extends FileCtx { git: GitOps; toplevel: string }

/**
 * The per-slot GC pipeline (memo 4.5, DV2): marker to `retired`, pointers, guard, link sweep, `fs.rm`, ENOENT check,
 * `git worktree remove` only once the directory is gone, marker deleted. Any failure leaves the marker `retired` and throws.
 * Returns a note when the worktree entry had to be left for manual removal.
 */
async function retireSlot(x: RetireCtx, rec: SlotRecord, deadline: number, trustedParent: string): Promise<string | null> {
  const read = await readMarkerFile(x, markerPath(x.markersDir, rec.planId, rec.slot));
  if (!read.ok) throw new Error(`marker is ${read.reason}`);
  const cur = read.rec;
  if (cur.planId !== rec.planId || cur.slot !== rec.slot || comparable(cur.path, x.platform) !== comparable(rec.path, x.platform)) {
    throw new Error("marker changed while collecting");
  }
  // The parent is the folder the caller trusts for this plan, never one derived from the marker's own path.
  assertSafeSlotDir(cur.path, cur.slot, trustedParent, x.platform);
  if (isInsideOrEqual(cur.path, x.toplevel, x.platform)) throw new Error("slot is inside the repository");
  const parentStat = await x.fs.lstat(trustedParent);
  if (parentStat !== null) {
    if (parentStat.kind !== "dir" || comparable(await x.fs.realpath(trustedParent), x.platform) !== comparable(trustedParent, x.platform)) {
      throw new Error(`${trustedParent} is not the real slots directory (it resolves through a link)`);
    }
  }
  const reason = slotLockReason(cur.planId, cur.slot);
  await writeMarkerFile(x, { ...cur, state: "retired", owner: null, updatedAt: x.clock.iso() });

  let st = await x.fs.lstat(cur.path);
  let note: string | null = null;
  if (st !== null) {
    if (st.kind !== "dir") throw new Error(`not a real directory (${st.kind})`);
    // Only a folder git itself lists as locked by this executor for this slot is ever deleted.
    const entry = (await x.git.worktreeList()).find((w) => comparable(w.path, x.platform) === comparable(cur.path, x.platform));
    if (entry === undefined || entry.locked !== reason) {
      throw new Error("git does not list the folder as a worktree locked by the executor for this slot; nothing was deleted");
    }
    try {
      await x.git.verifySlotPointers(cur.path);
    } catch (error) {
      note = `git pointers were invalid (${messageOf(error)}); the worktree entry was dropped by path and lock reason`;
    }
    assertSafeSlotDir(cur.path, cur.slot, trustedParent, x.platform);
    if (st.kind !== "dir") throw new Error(`not a real directory (${st.kind})`);
    const sweep = await sweepLinks(x, cur.path, { skipDependencyDirs: false, tracked: null, removeRootGitLink: true });
    if (sweep.truncated) throw new Error(`more than ${SLOT_SWEEP_MAX_ENTRIES} entries; link sweep stopped`);
    const limit = Math.min(x.clock.now() + SLOT_RM_BUDGET_MS, deadline);
    await withRetry(x.clock, () => x.fs.rm(cur.path, { recursive: true }), limit);
    st = await x.fs.lstat(cur.path);
    if (st !== null) throw new Error("directory still present after removal");
  }
  // The folder is gone: drop the admin entry keyed by path and lock reason (a no-op when git no longer lists it).
  await x.git.worktreeRemove(cur.path, reason);
  await deleteMarker(x, cur);
  return note;
}

// ---------------------------------------------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------------------------------------------

/** Standalone, for router_plan action=gc with no plan open; SlotPool.gc delegates to it. `opts.deadline` is an absolute `clock.now()` ms. */
export async function gcSlots(
  d: GcDeps,
  isFinished: (planId: PlanId) => Promise<boolean | null>,
  opts: { deadline?: number; trustedSlotsDirs?: readonly string[] } = {},
): Promise<{ removed: string[]; reported: string[] }> {
  const platform = d.platform ?? process.platform;
  const api = pathApi(platform);
  /** A marker's path is a candidate only when its parent is one of these (d.slotsDir plus the executor's known per-plan dirs). */
  const trusted: readonly string[] = [d.slotsDir, ...(opts.trustedSlotsDirs ?? [])];
  const x: RetireCtx = {
    fs: d.fs, clock: d.clock, markersDir: d.markersDir, platform, git: d.git, toplevel: d.toplevel,
    ...(d.logger === undefined ? {} : { logger: d.logger }),
  };
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const removed: string[] = [];
  const reported: string[] = [];

  const valid: SlotRecord[] = [];
  const trustedFor = new Map<string, string>();
  for (const planId of await listPlanDirs(x)) {
    const plan = await readPlanMarkers(x, planId);
    for (const bad of plan.invalid) reported.push(`${bad.file}: ${bad.reason}`);
    const planTrusted: string[] = [...trusted];
    try {
      planTrusted.push(defaultSlotsDir(d.toplevel, planId));
    } catch {
      // no drive-letter default for this repository: only the explicitly trusted directories apply
      planTrusted.length = trusted.length;
    }
    for (const { file, rec } of plan.records) {
      if (rec.repoKey !== d.repoKey) continue;
      try {
        const parent = api.dirname(rec.path);
        const trustedParent = planTrusted.find((dir) => comparable(dir, platform) === comparable(parent, platform));
        if (trustedParent === undefined) throw new Error("parent is not a known slots directory");
        assertSafeSlotDir(rec.path, rec.slot, trustedParent, platform);
        if (isInsideOrEqual(rec.path, d.toplevel, platform)) throw new Error("slot is inside the repository");
        trustedFor.set(comparable(rec.path, platform), trustedParent);
      } catch (error) {
        reported.push(`${file}: ${messageOf(error)}`);
        continue;
      }
      valid.push(rec);
    }
  }

  const known = new Set(valid.map((rec) => comparable(rec.path, platform)));
  for (const rec of valid) {
    let finished: boolean | null;
    try {
      finished = await isFinished(rec.planId);
    } catch (error) {
      reported.push(`${rec.path}: could not tell whether plan ${rec.planId} is finished: ${messageOf(error)}`);
      continue;
    }
    if (finished === false) continue;
    if (finished === null && d.clock.now() - timeOf(rec.updatedAt) < UNKNOWN_PLAN_GC_AGE_MS) continue;
    if (d.clock.now() >= deadline) {
      reported.push(`${rec.path}: gc deadline reached`);
      continue;
    }
    try {
      const note = await retireSlot(x, rec, deadline, trustedFor.get(comparable(rec.path, platform)) ?? d.slotsDir);
      known.delete(comparable(rec.path, platform));
      removed.push(rec.path);
      if (note !== null) reported.push(`${rec.path}: ${note}`);
    } catch (error) {
      reported.push(`${rec.path}: ${messageOf(error)}`);
    }
  }

  const scan = new Map<string, string>();
  scan.set(comparable(d.slotsDir, platform), d.slotsDir);
  for (const rec of valid) {
    const dir = api.dirname(rec.path);
    scan.set(comparable(dir, platform), dir);
  }
  for (const dir of scan.values()) {
    for (const name of await readdirOrEmpty(d.fs, dir)) {
      const entry = api.join(dir, name);
      if (!known.has(comparable(entry, platform))) reported.push(`${entry}: unmarked`);
    }
  }
  return { removed, reported };
}

// ---------------------------------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------------------------------

type ClaimMode = "same" | "reset" | "create" | "recreate";

type StageRecord = SlotRecord & { state: "creating" | "provisioning" | "resetting" };

function isStage(rec: SlotRecord): rec is StageRecord {
  return rec.state === "creating" || rec.state === "provisioning" || rec.state === "resetting";
}

interface AcquireSpec {
  kind: SlotRecord["kind"];
  owner: string;
  /** Canonical commit: the base for a task slot, the toplevel HEAD for a special slot (used only to create it). */
  base: string;
}

function keepFor(managers: readonly string[], yarnBerry: boolean): string[] {
  const keep: string[] = [];
  if (managers.some((m) => NODE_MANAGER_NAMES.includes(m))) keep.push("node_modules");
  if (yarnBerry) keep.push("/.yarn", "/.pnp.*");
  if (managers.some((m) => PYTHON_MANAGER_NAMES.includes(m))) keep.push("/.venv");
  return keep;
}

export function createSlotPool(d: SlotPoolDeps): SlotPool & { open(): Promise<void>; close(): void } {
  const platform = d.platform ?? process.platform;
  const api = pathApi(platform);
  const logger = d.logger;
  const fileCtx: FileCtx = {
    fs: d.fs, clock: d.clock, markersDir: d.markersDir, platform,
    ...(logger === undefined ? {} : { logger }),
  };
  const retireCtx: RetireCtx = { ...fileCtx, git: d.git, toplevel: d.toplevel };

  const records = new Map<string, SlotRecord>();
  const corrupt = new Set<string>();
  const poolLock = new Mutex();
  const slotLocks = new Map<string, Mutex>();
  let opened = false;
  /** Set by `close()` and by a gc of this very plan: no new acquire, and in-flight provisioning is aborted. */
  let closed = false;
  const abort = new AbortController();
  /** Paths provisioning produced besides the dependency dirs (for example `*.egg-info`), per slot: kept by every clean. */
  const produced = new Map<string, string[]>();
  /** The executable snapshot of each provisioned slot (path, size, mtime), registered with the slot environment. */
  const binsOf = new Map<string, SlotBin[]>();

  const slotLock = (slot: string): Mutex => {
    let m = slotLocks.get(slot);
    if (m === undefined) {
      m = new Mutex();
      slotLocks.set(slot, m);
    }
    return m;
  };
  const slotPath = (slot: string): string => api.join(d.slotsDir, slot);

  const assertOpen = (): void => {
    if (!opened) throw new ExecutorError("E_PLAN_STATE", "the slot pool is not open", { planId: d.planId });
  };
  const assertLive = (): void => {
    assertOpen();
    if (closed) throw new ExecutorError("E_PLAN_STATE", "the slot pool is closed", { planId: d.planId });
  };
  const assertSlot = (slot: string): void => {
    if (typeof slot !== "string" || !SLOT_NAME_PATTERN.test(slot)) {
      throw new ExecutorError("E_INVALID_INPUT", "invalid slot name", { slot: String(slot).slice(0, 80) });
    }
  };
  const need = <T>(value: T | null, what: string, slot: string): T => {
    if (value === null) throw new ExecutorError("E_SLOT_BROKEN", `slot ${slot} has no ${what}`, { slot });
    return value;
  };

  // ---- records ----------------------------------------------------------------------------------------------

  /** Write-through: the marker first, then memory. `updatedAt` is stamped here. */
  async function save(rec: SlotRecord): Promise<SlotRecord> {
    const next: SlotRecord = { ...cloneRecord(rec), updatedAt: d.clock.iso() };
    await writeMarkerFile(fileCtx, next);
    records.set(next.slot, next);
    return next;
  }

  function newRecord(slot: string, owner: string, commit: string): SlotRecord {
    const now = d.clock.iso();
    return {
      schema: 1, slot, path: slotPath(slot), kind: slotKindOf(slot), planId: d.planId, repoKey: d.repoKey,
      state: "creating", owner, commit, managers: [], manifests: {}, createdAt: now, updatedAt: now,
    };
  }

  function syncEnv(rec: SlotRecord): void {
    if (rec.managers.length > 0) registerSlot({ root: rec.path, managers: rec.managers, bins: binsOf.get(rec.slot) ?? [] });
    else unregisterSlot(rec.path);
  }

  /** `broken` with owner null; the digests stay the old ones (memo 4.4). A failing marker write still breaks the in-memory slot. */
  async function markBroken(slot: string): Promise<void> {
    const cur = records.get(slot);
    if (cur === undefined) return;
    unregisterSlot(cur.path);
    const broken: SlotRecord = { ...cloneRecord(cur), state: "broken", owner: null };
    try {
      await save(broken);
    } catch (error) {
      logger?.warn(`could not write the broken marker of ${slot}: ${messageOf(error)}`);
      records.set(slot, { ...broken, updatedAt: d.clock.iso() });
    }
  }

  async function failStage(slot: string, error: unknown): Promise<ExecutorError> {
    const cur = records.get(slot);
    if (cur !== undefined && STAGE_STATES.includes(cur.state)) await markBroken(slot);
    return wrap(slot, error);
  }

  /** Installer failures stay `E_PROVISION`; git and fs failures in the slot are `E_SLOT_BROKEN` (the commit was checked up front). */
  function wrap(slot: string, error: unknown): ExecutorError {
    if (error instanceof ExecutorError) {
      if (error.code === "E_GIT") return new ExecutorError("E_SLOT_BROKEN", `slot ${slot}: ${error.message}`, { slot, cause: "E_GIT" });
      return error;
    }
    return new ExecutorError("E_SLOT_BROKEN", `slot ${slot}: ${messageOf(error)}`, { slot, code: errorCode(error) ?? null });
  }

  function leaseOf(rec: SlotRecord): SlotLease {
    return {
      slot: rec.slot, path: rec.path, planId: rec.planId,
      owner: need(rec.owner, "owner", rec.slot), commit: need(rec.commit, "commit", rec.slot),
    };
  }

  // ---- tree, detection, provisioning ------------------------------------------------------------------------

  /** The tracked paths of the index (`ls-files -z`). Phase 3.1 commits before `cleanForChecks`, so index and HEAD agree there. */
  function trackedFiles(path: string): Promise<string[]> {
    return d.git.lsFiles(path);
  }

  async function detectFor(rec: SlotRecord): Promise<Detection> {
    return d.provisioner.detect(rec.path, await trackedFiles(rec.path));
  }

  /** What a clean of this slot must keep: the dependency dirs of its managers and what provisioning produced (QA-2.4-14). */
  async function keepList(rec: SlotRecord): Promise<string[]> {
    const berry = rec.managers.includes("yarn") && await d.fs.lstat(api.join(rec.path, ".yarnrc.yml")) !== null;
    return [...keepFor(rec.managers, berry), ...(produced.get(rec.slot) ?? [])];
  }

  /**
   * Right after an install the slot was clean, so whatever `clean -x` would now delete besides the kept dirs was produced by it.
   * The list is also written beside the marker (`<slot>.produced`, QA-2.4-25), so a later process keeps the same paths.
   */
  async function recordProduced(rec: SlotRecord, managers: readonly string[]): Promise<void> {
    const berry = managers.includes("yarn") && await d.fs.lstat(api.join(rec.path, ".yarnrc.yml")) !== null;
    const listed = await d.git.cleanPreview(rec.path, keepFor(managers, berry));
    const patterns = listed.map((p) => `/${p.replace(/\/+$/, "").replace(/[\\*?[\]]/g, "\\$&")}`);
    await writeSidecar(fileCtx, rec.planId, rec.slot, "produced", `${JSON.stringify(patterns)}\n`);
    produced.set(rec.slot, patterns);
  }

  /** The executables the install left in the slot's tool directories: the only files router_run takes from the slot (QA-2.4-27). */
  async function recordBins(rec: SlotRecord, managers: readonly string[]): Promise<void> {
    const dirs: string[] = [];
    if (managers.some((m) => PYTHON_MANAGER_NAMES.includes(m))) dirs.push(api.join(rec.path, ".venv", platform === "win32" ? "Scripts" : "bin"));
    if (managers.some((m) => NODE_MANAGER_NAMES.includes(m))) dirs.push(api.join(rec.path, "node_modules", ".bin"));
    const bins: SlotBin[] = [];
    for (const dir of dirs) {
      for (const name of await readdirOrEmpty(d.fs, dir)) {
        const file = api.join(dir, name);
        const st = await d.fs.lstat(file);
        if (st !== null && (st.kind === "file" || st.kind === "symlink")) bins.push({ path: file, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    await writeSidecar(fileCtx, rec.planId, rec.slot, "bins", `${JSON.stringify(bins)}\n`);
    binsOf.set(rec.slot, bins);
  }

  /** The slot has no install (no managers, retired, recreated): forget what the previous one produced. */
  async function clearProvisioned(rec: SlotRecord): Promise<void> {
    produced.delete(rec.slot);
    binsOf.delete(rec.slot);
    for (const extension of SIDECAR_EXTENSIONS) await removeSidecar(fileCtx, rec.planId, rec.slot, extension);
  }

  async function install(rec: SlotRecord, detection: Detection, fresh: boolean): Promise<void> {
    await d.provisioner.provision(rec.path, detection, { fresh, signal: abort.signal });
    await recordProduced(rec, detection.managers);
    await recordBins(rec, detection.managers);
    d.onProvision?.(rec.slot, detection.managers);
  }

  /** `open()`: the sidecars of a slot that has managers; an unreadable or malformed one is ignored with a warning. */
  async function restoreProvisioned(rec: SlotRecord): Promise<void> {
    if (rec.managers.length === 0) {
      await clearProvisioned(rec);
      return;
    }
    const keep = parseStringArray(await readSidecar(fileCtx, rec.planId, rec.slot, "produced"));
    if (keep === null) logger?.warn(`slot ${rec.slot}: no usable .produced file; build outputs are not kept by a clean`);
    else produced.set(rec.slot, keep);
    const bins = parseBins(await readSidecar(fileCtx, rec.planId, rec.slot, "bins"));
    if (bins === null) logger?.warn(`slot ${rec.slot}: no usable .bins file; router_run falls back to PATH for this slot`);
    else binsOf.set(rec.slot, bins);
  }

  /** Re-detects and, on drift (memo 4.4), writes `provisioning` and installs. The returned record is not yet saved with the new digests. */
  async function driftProvision(rec: SlotRecord): Promise<{ rec: SlotRecord; drifted: boolean }> {
    const detection = await detectFor(rec);
    if (!needsProvision(rec, detection)) return { rec, drifted: false };
    const prov = await save({ ...rec, state: "provisioning" });
    if (detection.managers.length > 0) await install(prov, detection, true);
    else await clearProvisioned(prov);
    return { rec: { ...prov, managers: [...detection.managers], manifests: { ...detection.manifests } }, drifted: true };
  }

  async function stageProvision(rec: SlotRecord, fresh: boolean): Promise<SlotRecord> {
    const prov = rec.state === "provisioning" ? rec : await save({ ...rec, state: "provisioning" });
    const detection = await detectFor(prov);
    if (detection.managers.length > 0) await install(prov, detection, fresh);
    else await clearProvisioned(prov);
    const done = await save({
      ...prov, managers: [...detection.managers], manifests: { ...detection.manifests },
      state: prov.owner === null ? "ready" : "leased",
    });
    syncEnv(done);
    return done;
  }

  // ---- stages -----------------------------------------------------------------------------------------------

  /** Interrupted `creating` (memo 4.1): pointers fine -> go on; absent or empty -> add again; anything else -> retire and recreate. */
  async function repairCreate(rec: SlotRecord, base: string, reason: string): Promise<void> {
    const st = await d.fs.lstat(rec.path);
    if (st !== null) {
      if (st.kind !== "dir") throw new ExecutorError("E_SLOT_BROKEN", `${rec.path} is not a real directory (${st.kind})`, { slot: rec.slot });
      let pointersOk = false;
      try {
        await d.git.verifySlotPointers(rec.path);
        pointersOk = true;
      } catch (error) {
        logger?.warn(`slot ${rec.slot} is half created (${messageOf(error)}); recreating it`);
      }
      if (pointersOk) {
        // The checkout of an interrupted `worktree add` may be partial or dirty: bring it to the base commit first.
        await resetRoutine(rec);
        return;
      }
      if ((await d.fs.readdir(rec.path)).length === 0) {
        await withRetry(d.clock, () => d.fs.rm(rec.path, { recursive: true }));
      } else {
        await retireSlot(retireCtx, rec, Number.POSITIVE_INFINITY, d.slotsDir);
        records.delete(rec.slot);
        await clearProvisioned(rec);
        await save({ ...rec, state: "creating" });
      }
    }
    await d.git.worktreeRemove(rec.path, reason);
    await d.git.worktreeAdd(rec.path, base, reason);
  }

  async function stageCreate(rec: SlotRecord, firstRun: boolean): Promise<SlotRecord> {
    const base = need(rec.commit, "commit", rec.slot);
    const reason = slotLockReason(rec.planId, rec.slot);
    if (firstRun) await d.git.worktreeAdd(rec.path, base, reason);
    else await repairCreate(rec, base, reason);
    await d.git.verifySlotPointers(rec.path);
    return stageProvision(rec, !firstRun);
  }

  /** `reset` routine (memo 4.3): pointers, link sweep, checkout, clean; HEAD and status verified; one retry. */
  async function resetRoutine(rec: SlotRecord): Promise<void> {
    const commit = need(rec.commit, "commit", rec.slot);
    await d.git.verifySlotPointers(rec.path);
    const attempt = async (): Promise<void> => {
      await assertRealSlotDir(d.fs, rec.path, platform);
      const tracked = new Set(await d.git.trackedLinks(rec.path));
      const ctx = { fs: d.fs, clock: d.clock, platform };
      // The checkout can only touch tracked paths: the whole-slot sweep (dependency dirs skipped) covers it.
      const sweep = await sweepLinks(ctx, rec.path, { skipDependencyDirs: true, tracked });
      if (sweep.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${rec.slot}`, { slot: rec.slot });
      await d.git.checkoutDetach(rec.path, commit);
      // The clean is different: sweep exactly what git is about to delete, whatever its depth or name.
      const keep = await keepList(rec);
      const doomed = await sweepLinks(ctx, rec.path, { skipDependencyDirs: false, tracked, starts: await d.git.cleanPreview(rec.path, keep) });
      if (doomed.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${rec.slot}`, { slot: rec.slot });
      await d.git.cleanTracked(rec.path, keep);
      const head = await d.git.revParse(rec.path, "HEAD");
      if (head !== commit) throw new ExecutorError("E_SLOT_BROKEN", `HEAD of ${rec.slot} is ${head}, expected ${commit}`, { slot: rec.slot });
      const status = await d.git.statusPorcelain(rec.path);
      if (status.length !== 0) throw new ExecutorError("E_SLOT_BROKEN", `${rec.slot} is not clean after reset`, { slot: rec.slot, entries: status.length });
    };
    try {
      await attempt();
    } catch (first) {
      logger?.warn(`reset of ${rec.slot} failed (${messageOf(first)}); retrying`);
      await sleep(d.clock, RESET_RETRY_DELAY_MS);
      try {
        await attempt();
      } catch (second) {
        const code = errorCode(second);
        const transient = code !== undefined && TRANSIENT_FS_CODES.has(code);
        throw new ExecutorError(
          "E_SLOT_BROKEN",
          transient ? `files in ${rec.slot} are held by a running process; stop it and retry` : `reset of ${rec.slot} failed: ${messageOf(second).slice(0, 200)}`,
          { slot: rec.slot, cause: messageOf(second).slice(0, 300) },
        );
      }
    }
  }

  async function stageReset(rec: SlotRecord): Promise<SlotRecord> {
    await resetRoutine(rec);
    const drift = await driftProvision(rec);
    const done = await save({ ...drift.rec, state: drift.rec.owner === null ? "ready" : "leased" });
    syncEnv(done);
    return done;
  }

  /** Runs the stage the marker is in, from its start (also the repair of an interrupted stage, memo 4.1). */
  async function driveStage(rec: StageRecord, firstRun: boolean): Promise<SlotRecord> {
    switch (rec.state) {
      case "creating":
        return stageCreate(rec, firstRun);
      case "provisioning":
        await d.git.verifySlotPointers(rec.path);
        return stageProvision(rec, true);
      case "resetting":
        return stageReset(rec);
    }
  }

  /** The destructive reset must never run for a state that is not a stage (QA-2.4-29): the type says so, this checks it. */
  function staged(rec: SlotRecord): StageRecord {
    if (isStage(rec)) return rec;
    throw new ExecutorError("E_SLOT_BROKEN", `slot ${rec.slot} is ${rec.state}, not in a stage`, { slot: rec.slot, state: rec.state });
  }

  // ---- acquire ----------------------------------------------------------------------------------------------

  const unavailable = (): ExecutorError => {
    const live = [...records.values()].filter((r) => r.kind === "task" && r.state !== "retired");
    return new ExecutorError("E_SLOT_UNAVAILABLE", `all ${d.maxParallel} task slots are in use`, {
      maxParallel: d.maxParallel,
      leased: live.map((r) => ({ slot: r.slot, owner: r.owner, state: r.state })),
    });
  };

  async function createNewTaskSlot(owner: string, base: string): Promise<{ slot: string; mode: ClaimMode }> {
    for (let n = 1; n <= MAX_TASK_SLOT_NUMBER; n++) {
      const slot = `slot-${n}`;
      if (records.has(slot) || corrupt.has(slot)) continue;
      if (await d.fs.lstat(slotPath(slot)) !== null) continue;
      await save(newRecord(slot, owner, base));
      return { slot, mode: "create" };
    }
    throw unavailable();
  }

  /** Marker I/O only (memo 4.2, DV10); runs under the pool mutex. */
  async function claimTask(owner: string, base: string): Promise<{ slot: string; mode: ClaimMode }> {
    const tasks = [...records.values()].filter((r) => r.kind === "task");
    const mine = tasks.find((r) => r.state !== "retired" && r.owner === owner);
    if (mine !== undefined) return { slot: mine.slot, mode: "same" };
    const ready = tasks
      .filter((r) => r.state === "ready")
      .sort((a, b) => Number(b.commit === base) - Number(a.commit === base) || timeOf(a.updatedAt) - timeOf(b.updatedAt) || compareSlots(a.slot, b.slot));
    const pick = ready[0];
    if (pick !== undefined) {
      await save({ ...pick, state: "resetting", owner, commit: base });
      return { slot: pick.slot, mode: "reset" };
    }
    const live = tasks.filter((r) => r.state !== "retired");
    if (live.length < d.maxParallel) return createNewTaskSlot(owner, base);
    const broken = live
      .filter((r) => r.state === "broken")
      .sort((a, b) => timeOf(a.updatedAt) - timeOf(b.updatedAt) || compareSlots(a.slot, b.slot))[0];
    if (broken !== undefined) {
      unregisterSlot(broken.path);
      await save({ ...broken, state: "retired", owner: null });
      await clearProvisioned(broken);
      return createNewTaskSlot(owner, base);
    }
    throw unavailable();
  }

  async function claimSpecial(kind: "integration" | "ci", base: string): Promise<{ slot: string; mode: ClaimMode }> {
    const rec = records.get(kind);
    if (rec === undefined) {
      if (corrupt.has(kind)) {
        throw new ExecutorError("E_SLOT_UNAVAILABLE", `the marker of ${kind} is unreadable; run router_plan action=gc`, { slot: kind });
      }
      // A folder with no marker is somebody else's: never adopt it (the task slots check the same in createNewTaskSlot).
      if (await d.fs.lstat(slotPath(kind)) !== null) {
        throw new ExecutorError("E_SLOT_UNAVAILABLE", `${slotPath(kind)} exists without a slot marker; run router_plan action=gc or remove it`, { slot: kind });
      }
      await save(newRecord(kind, kind, base));
      return { slot: kind, mode: "create" };
    }
    if (rec.state === "broken" || rec.state === "retired") return { slot: kind, mode: "recreate" };
    if (rec.state === "ready") {
      await save({ ...rec, state: "resetting", owner: kind });
      return { slot: kind, mode: "reset" };
    }
    return { slot: kind, mode: "same" };
  }

  /** Under the slot mutex: re-reads the record and does the slow work. */
  async function work(slot: string, mode: ClaimMode, spec: AcquireSpec): Promise<SlotLease> {
    let rec = records.get(slot);
    if (rec === undefined) throw new ExecutorError("E_SLOT_BROKEN", `slot ${slot} disappeared`, { slot });
    try {
      let firstRun = mode === "create" || mode === "reset";
      if (mode === "recreate" && (rec.state === "broken" || rec.state === "retired")) {
        unregisterSlot(rec.path);
        await retireSlot(retireCtx, rec, Number.POSITIVE_INFINITY, d.slotsDir);
        records.delete(slot);
        await clearProvisioned(rec);
        rec = await save(newRecord(slot, spec.owner, spec.base));
        firstRun = true;
      } else if (rec.state === "ready") {
        // Released between the claim and this step: claim it again.
        rec = await save({ ...rec, state: "resetting", owner: spec.owner, commit: spec.base });
        firstRun = true;
      }
      if (rec.state === "leased") {
        if (rec.owner !== spec.owner) throw unavailable();
        return leaseOf(rec);
      }
      if (rec.state === "broken" || rec.state === "retired") {
        throw new ExecutorError("E_SLOT_BROKEN", `slot ${slot} is ${rec.state}`, { slot, state: rec.state });
      }
      if (spec.kind !== "task" && rec.state === "resetting" && firstRun) {
        // A special slot is leased at its current HEAD; the queue resets it afterwards.
        rec = await save({ ...rec, commit: await d.git.revParse(rec.path, "HEAD") });
      }
      return leaseOf(await driveStage(staged(rec), firstRun));
    } catch (error) {
      throw await failStage(slot, error);
    }
  }

  async function acquireSlot(
    claim: () => Promise<{ slot: string; mode: ClaimMode }>, spec: AcquireSpec,
  ): Promise<SlotLease> {
    assertLive();
    const scheduled = await poolLock.run(async () => {
      const { slot, mode } = await claim();
      // Queued on the slot mutex before the pool mutex is released, so nothing runs on this slot ahead of the claim.
      return { run: slotLock(slot).run(() => work(slot, mode, spec)) };
    });
    return scheduled.run;
  }

  // ---- reset, cleanForChecks, release -----------------------------------------------------------------------

  async function reset(slot: string, commit: string): Promise<void> {
    assertLive();
    assertSlot(slot);
    if (typeof commit !== "string" || !GIT_ID_PATTERN.test(commit)) {
      throw new ExecutorError("E_INVALID_INPUT", "commit must be a full git object id", { commit: String(commit).slice(0, 80) });
    }
    const oid = await d.git.revParse(d.toplevel, commit);
    await slotLock(slot).run(async () => {
      let rec = records.get(slot);
      if (rec === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown slot ${slot}`, { slot });
      if (rec.state !== "leased" && rec.state !== "resetting" && rec.state !== "creating" && rec.state !== "provisioning") {
        throw new ExecutorError("E_INVALID_INPUT", `slot ${slot} is ${rec.state}, not leased`, { slot, state: rec.state });
      }
      try {
        if (rec.state === "creating" || rec.state === "provisioning") rec = await driveStage(staged(rec), false);
        const resetting = await save({ ...rec, state: "resetting", commit: oid });
        await driveStage(staged(resetting), false);
      } catch (error) {
        throw await failStage(slot, error);
      }
    });
  }

  async function cleanForChecks(slot: string): Promise<void> {
    assertLive();
    assertSlot(slot);
    await slotLock(slot).run(async () => {
      const rec = records.get(slot);
      if (rec === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown slot ${slot}`, { slot });
      if (rec.state !== "leased") throw new ExecutorError("E_INVALID_INPUT", `slot ${slot} is ${rec.state}, not leased`, { slot, state: rec.state });
      try {
        await d.git.verifySlotPointers(rec.path);
        await assertRealSlotDir(d.fs, rec.path, platform);
        const tracked = new Set(await d.git.trackedLinks(rec.path));
        const ctx = { fs: d.fs, clock: d.clock, platform };
        // The restoring checkout can only touch tracked paths: a whole-slot sweep (dependency dirs skipped) covers it.
        const walk = await sweepLinks(ctx, rec.path, { skipDependencyDirs: true, tracked });
        if (walk.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${slot}`, { slot });
        // The agent's files include links anywhere; the clean removes whatever `clean -ndx -e <keep>` lists, so sweep
        // exactly that list in full (a `node_modules` below the root is deleted unless excluded with the same anchoring).
        const keep = await keepList(rec);
        const sweep = await sweepLinks(ctx, rec.path, { skipDependencyDirs: false, tracked, starts: await d.git.cleanPreview(rec.path, keep) });
        if (sweep.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${slot}`, { slot });
        await d.git.cleanForChecks(rec.path, keep);
        const drift = await driftProvision(rec);
        if (drift.drifted) syncEnv(await save({ ...drift.rec, state: "leased" }));
      } catch (error) {
        throw await failStage(slot, error);
      }
    });
  }

  async function release(slot: string): Promise<void> {
    assertOpen();
    assertSlot(slot);
    await slotLock(slot).run(async () => {
      const rec = records.get(slot);
      if (rec === undefined || rec.state !== "leased") return;
      await save({ ...rec, state: "ready", owner: null });
    });
  }

  // ---- open -------------------------------------------------------------------------------------------------

  function validateSlotsDir(): void {
    const bad = (why: string): never => {
      throw new ExecutorError("E_INVALID_INPUT", `invalid slotsDir ${JSON.stringify(d.slotsDir)}: ${why}`, { planId: d.planId });
    };
    if (typeof d.slotsDir !== "string" || d.slotsDir.length === 0) bad("empty");
    if (platform === "win32" ? !/^[A-Za-z]:[\\/]/.test(d.slotsDir) : !api.isAbsolute(d.slotsDir)) {
      bad("not an absolute drive-letter path (UNC paths are not supported)");
    }
    if (hasDotSegment(d.slotsDir)) bad("dot segment");
    const resolved = api.resolve(d.slotsDir);
    if (api.parse(resolved).root === resolved) bad("is a filesystem root");
    if (isInsideOrEqual(d.slotsDir, d.toplevel, platform) || isInsideOrEqual(d.toplevel, d.slotsDir, platform)) {
      bad("overlaps the repository");
    }
    if (!Number.isInteger(d.maxParallel) || d.maxParallel < 1) {
      throw new ExecutorError("E_INVALID_INPUT", "maxParallel must be a positive integer", { maxParallel: String(d.maxParallel) });
    }
  }

  async function open(): Promise<void> {
    if (opened) return;
    validateSlotsDir();
    await mkdirp(d.fs, d.slotsDir, platform);
    const st = await d.fs.lstat(d.slotsDir);
    if (st === null || st.kind !== "dir") {
      throw new ExecutorError("E_SLOT_UNAVAILABLE", `slotsDir ${d.slotsDir} is not a real directory`, { slotsDir: d.slotsDir });
    }
    if (comparable(await d.fs.realpath(d.slotsDir), platform) !== comparable(d.slotsDir, platform)) {
      throw new ExecutorError("E_SLOT_UNAVAILABLE", `slotsDir ${d.slotsDir} resolves through a link`, { slotsDir: d.slotsDir });
    }
    for (const other of await listPlanDirs(fileCtx)) {
      if (other === d.planId) continue;
      for (const { rec } of (await readPlanMarkers(fileCtx, other)).records) {
        if (isInsideOrEqual(rec.path, d.slotsDir, platform) || isInsideOrEqual(d.slotsDir, rec.path, platform)) {
          throw new ExecutorError("E_SLOT_UNAVAILABLE", `slotsDir ${d.slotsDir} is claimed by plan ${other} (${rec.slot})`, { planId: other, slot: rec.slot });
        }
      }
    }
    const own = await readPlanMarkers(fileCtx, d.planId);
    for (const bad of own.invalid) {
      logger?.warn(`ignoring slot marker ${bad.file}: ${bad.reason}`);
      const slot = api.basename(bad.file, ".json");
      if (SLOT_NAME_PATTERN.test(slot)) corrupt.add(slot);
    }
    for (const { file, rec } of own.records) {
      if (rec.repoKey !== d.repoKey || comparable(rec.path, platform) !== comparable(slotPath(rec.slot), platform)) {
        logger?.warn(`ignoring slot marker ${file}: it belongs to another repository or slots directory`);
        corrupt.add(rec.slot);
        continue;
      }
      records.set(rec.slot, rec);
      if (rec.state !== "retired") await restoreProvisioned(rec);
      if (rec.state === "ready" || rec.state === "leased") syncEnv(rec);
    }
    opened = true;
  }

  // ---- reads and gc -----------------------------------------------------------------------------------------

  async function list(planId?: PlanId): Promise<SlotRecord[]> {
    if (planId === undefined || planId === d.planId) {
      return [...records.values()].sort((a, b) => compareSlots(a.slot, b.slot)).map(cloneRecord);
    }
    if (!PLAN_ID_PATTERN.test(planId)) throw new ExecutorError("E_INVALID_INPUT", "invalid plan id", { planId: String(planId).slice(0, 80) });
    const found = await readPlanMarkers(fileCtx, planId);
    return found.records.map((r) => r.rec).sort((a, b) => compareSlots(a.slot, b.slot));
  }

  async function gc(isFinished: (planId: PlanId) => Promise<boolean | null>): Promise<{ removed: string[]; reported: string[] }> {
    assertOpen();
    // A gc that is about to collect this very plan closes the pool first: no new acquire, and provisioning in flight stops.
    // The answer is asked once and reused for this plan below (QA-2.4-26): `false` means gcSlots will not touch this plan's slots.
    let ownAnswer: boolean | null | undefined;
    try {
      ownAnswer = await isFinished(d.planId);
    } catch (error) {
      logger?.warn(`gc: could not tell whether plan ${d.planId} is finished: ${messageOf(error)}`);
    }
    if (ownAnswer === true) close();
    const asked = (planId: PlanId): Promise<boolean | null> =>
      planId === d.planId && ownAnswer !== undefined ? Promise.resolve(ownAnswer) : isFinished(planId);
    return poolLock.run(() => {
      // Under the mutex of every slot of this plan, so no acquire, reset or clean runs on a slot while it is deleted;
      // an unfinished plan keeps its slots, so a gc of other plans must not wait for its running work.
      const mine = ownAnswer === false ? [] : [...records.keys()].sort(compareSlots);
      const collect = async (): Promise<{ removed: string[]; reported: string[] }> => {
        const out = await gcSlots({
          repoKey: d.repoKey, toplevel: d.toplevel, slotsDir: d.slotsDir, markersDir: d.markersDir, executorHome: d.executorHome,
          git: d.git, fs: d.fs, clock: d.clock, platform, ...(logger === undefined ? {} : { logger }),
        }, asked);
        for (const rec of [...records.values()]) {
          const read = await readMarkerFile(fileCtx, markerPath(d.markersDir, rec.planId, rec.slot));
          if (read.ok) {
            records.set(rec.slot, read.rec);
            if (read.rec.state === "retired" || read.rec.state === "broken") unregisterSlot(read.rec.path);
          } else if (read.missing) {
            records.delete(rec.slot);
            unregisterSlot(rec.path);
            produced.delete(rec.slot);
            binsOf.delete(rec.slot);
          }
        }
        return out;
      };
      const nest = (n: number): Promise<{ removed: string[]; reported: string[] }> => {
        const slot = mine[n];
        return slot === undefined ? collect() : slotLock(slot).run(() => nest(n + 1));
      };
      return nest(0);
    });
  }

  /** Refuses new acquires from now on and aborts provisioning in flight; idempotent. */
  function close(): void {
    if (closed) return;
    closed = true;
    abort.abort();
  }

  return {
    open,
    close,
    async acquire(planId, owner, baseCommit) {
      if (planId !== d.planId) throw new ExecutorError("E_INVALID_INPUT", "plan id differs from the pool's plan", { planId: String(planId).slice(0, 80) });
      if (typeof baseCommit !== "string" || !GIT_ID_PATTERN.test(baseCommit)) {
        throw new ExecutorError("E_INVALID_INPUT", "baseCommit must be a full git object id", { baseCommit: String(baseCommit).slice(0, 80) });
      }
      if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
        throw new ExecutorError("E_INVALID_INPUT", "owner must be 1-128 printable characters", { length: typeof owner === "string" ? owner.length : -1 });
      }
      assertLive();
      const base = await d.git.revParse(d.toplevel, baseCommit);
      return acquireSlot(() => claimTask(owner, base), { kind: "task", owner, base });
    },
    async acquireSpecial(planId, kind) {
      if (planId !== d.planId) throw new ExecutorError("E_INVALID_INPUT", "plan id differs from the pool's plan", { planId: String(planId).slice(0, 80) });
      if (kind !== "integration" && kind !== "ci") throw new ExecutorError("E_INVALID_INPUT", "kind must be integration or ci", { kind: String(kind).slice(0, 40) });
      assertLive();
      const base = await d.git.revParse(d.toplevel, "HEAD");
      return acquireSlot(() => claimSpecial(kind, base), { kind, owner: kind, base });
    },
    reset,
    cleanForChecks,
    release,
    async get(slot) {
      const rec = records.get(slot);
      return rec === undefined ? null : cloneRecord(rec);
    },
    list,
    gc,
  };
}
