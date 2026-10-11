// Slot pool (phase 2.4.3), see docs/qa/critical-path-execution/phase-2.4.md sections 3 and 4.
// Layout: <slotsDir>\slot-<n>, <slotsDir>\integration, <slotsDir>\ci. Markers: <markersDir>\<planId>\<slot>.json (DV1).
// All I/O goes through the seams (GitOps, FileSystem, Clock, Provisioner); no node:fs here.

import { posix, win32 } from "node:path";
import { CLEANUP_RETRIES, CLEANUP_RETRY_BASE_MS, TRANSIENT_FS_CODES, isStrictlyInside } from "../../verify/reference";
import type { GitOps } from "../git";
import { ExecutorError, GIT_ID_PATTERN, PLAN_ID_PATTERN } from "../types";
import type { Clock, ExecutorConfig, FileSystem, PlanId, SlotLease, SlotPool, SlotRecord } from "../types";
import { registerSlot, unregisterSlot } from "./env";
import { DEPENDENCY_DIRS, detectManagers, needsProvision } from "./provision";
import type { Detection, Provisioner } from "./provision";

export const UNKNOWN_PLAN_GC_AGE_MS = 7 * 24 * 3_600_000;
export const SLOT_SWEEP_MAX_ENTRIES = 2_000_000; // confirm with M10
export const SLOT_RM_BUDGET_MS = 120_000; // per slot, confirm with M7
export const RESET_RETRY_DELAY_MS = 2_000;
export const SLOT_NAME_PATTERN = /^(?:slot-[1-9][0-9]{0,2}|integration|ci)$/;

const MARKER_MAX_BYTES = 64 * 1024;
const MAX_TASK_SLOT_NUMBER = 999;
const OWNER_PATTERN = /^[\x20-\x7e]{1,128}$/;
const MANIFEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b426cc5da2dd8ae8";
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
  /**
   * `executor.provision` / `executor.python`, used for manager detection (the provisioner holds its own copy for the steps).
   * Default `{provision:"auto", python:"auto"}`. Not in memo 4: detection needs it and the pool had no other way to get it.
   */
  config?: Pick<ExecutorConfig, "provision" | "python">;
}

type GcDeps = Omit<SlotPoolDeps, "planId" | "maxParallel" | "provisioner" | "onProvision" | "config">;

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

/** Temp file with fsync, rename, then fsyncDir (memo 3). */
async function writeMarkerFile(x: FileCtx, rec: SlotRecord): Promise<void> {
  const api = pathApi(x.platform);
  const final = markerPath(x.markersDir, rec.planId, rec.slot);
  const dir = api.dirname(final);
  const text = `${JSON.stringify(rec)}\n`;
  if (Buffer.byteLength(text, "utf8") > MARKER_MAX_BYTES) {
    throw new ExecutorError("E_SLOT_BROKEN", `the marker of ${rec.slot} would exceed ${MARKER_MAX_BYTES} bytes`, { slot: rec.slot });
  }
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
 * `realpath` of the directory must be inside the `realpath` of the slot. `tracked` links (pre-clean mode) are left alone and
 * `skipDependencyDirs` skips `node_modules` and `.venv`.
 */
async function sweepLinks(
  x: SweepCtx, root: string, o: { skipDependencyDirs: boolean; tracked: ReadonlySet<string> | null },
): Promise<{ removed: string[]; truncated: boolean }> {
  const api = pathApi(x.platform);
  const realRoot = await x.fs.realpath(root);
  const removed: string[] = [];
  let seen = 0;
  const stack: string[] = [""];
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
      if (rel === "" && name === ".git") continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const child = api.join(dir, name);
      const st = await x.fs.lstat(child);
      if (st === null) continue;
      if (st.kind === "symlink" || st.kind === "junction") {
        if (o.tracked !== null && o.tracked.has(childRel)) continue;
        await withRetry(x.clock, () => x.fs.rm(child, { recursive: false }));
        removed.push(childRel);
      } else if (st.kind === "dir") {
        if (o.skipDependencyDirs && DEPENDENCY_DIR_NAMES.has(name)) continue;
        stack.push(childRel);
      }
    }
  }
  return { removed, truncated: false };
}

interface RetireCtx extends FileCtx { git: GitOps; toplevel: string }

/**
 * The per-slot GC pipeline (memo 4.5, DV2): marker to `retired`, pointers, guard, link sweep, `fs.rm`, ENOENT check,
 * `git worktree remove` only once the directory is gone, marker deleted. Any failure leaves the marker `retired` and throws.
 * Returns a note when the worktree entry had to be left for manual removal.
 */
async function retireSlot(x: RetireCtx, rec: SlotRecord, deadline: number): Promise<string | null> {
  const api = pathApi(x.platform);
  const file = markerPath(x.markersDir, rec.planId, rec.slot);
  const read = await readMarkerFile(x, file);
  if (!read.ok) throw new Error(`marker is ${read.reason}`);
  const cur = read.rec;
  if (cur.planId !== rec.planId || cur.slot !== rec.slot || comparable(cur.path, x.platform) !== comparable(rec.path, x.platform)) {
    throw new Error("marker changed while collecting");
  }
  const parent = api.dirname(cur.path);
  assertSafeSlotDir(cur.path, cur.slot, parent, x.platform);
  if (isInsideOrEqual(cur.path, x.toplevel, x.platform)) throw new Error("slot is inside the repository");
  await writeMarkerFile(x, { ...cur, state: "retired", owner: null, updatedAt: x.clock.iso() });

  let st = await x.fs.lstat(cur.path);
  let note: string | null = null;
  let pointersOk = true;
  if (st !== null) {
    try {
      await x.git.verifySlotPointers(cur.path);
    } catch (error) {
      pointersOk = false;
      note = `git pointers invalid (${messageOf(error)}); the worktree entry was left for manual removal`;
    }
    assertSafeSlotDir(cur.path, cur.slot, parent, x.platform);
    if (st.kind !== "dir") throw new Error(`not a real directory (${st.kind})`);
    const sweep = await sweepLinks(x, cur.path, { skipDependencyDirs: false, tracked: null });
    if (sweep.truncated) throw new Error(`more than ${SLOT_SWEEP_MAX_ENTRIES} entries; link sweep stopped`);
    const limit = Math.min(x.clock.now() + SLOT_RM_BUDGET_MS, deadline);
    await withRetry(x.clock, () => x.fs.rm(cur.path, { recursive: true }), limit);
    st = await x.fs.lstat(cur.path);
    if (st !== null) throw new Error("directory still present after removal (held by a running process?)");
  }
  if (pointersOk) await x.git.worktreeRemove(cur.path, slotLockReason(cur.planId, cur.slot));
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
  opts: { deadline?: number } = {},
): Promise<{ removed: string[]; reported: string[] }> {
  const platform = d.platform ?? process.platform;
  const api = pathApi(platform);
  const x: RetireCtx = {
    fs: d.fs, clock: d.clock, markersDir: d.markersDir, platform, git: d.git, toplevel: d.toplevel,
    ...(d.logger === undefined ? {} : { logger: d.logger }),
  };
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const removed: string[] = [];
  const reported: string[] = [];

  const valid: SlotRecord[] = [];
  for (const planId of await listPlanDirs(x)) {
    const plan = await readPlanMarkers(x, planId);
    for (const bad of plan.invalid) reported.push(`${bad.file}: ${bad.reason}`);
    for (const { file, rec } of plan.records) {
      if (rec.repoKey !== d.repoKey) continue;
      try {
        assertSafeSlotDir(rec.path, rec.slot, api.dirname(rec.path), platform);
        if (isInsideOrEqual(rec.path, d.toplevel, platform)) throw new Error("slot is inside the repository");
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
      const note = await retireSlot(x, rec, deadline);
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

export function createSlotPool(d: SlotPoolDeps): SlotPool & { open(): Promise<void> } {
  const platform = d.platform ?? process.platform;
  const api = pathApi(platform);
  const config = d.config ?? { provision: "auto" as const, python: "auto" as const };
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
    if (rec.managers.length > 0) registerSlot({ root: rec.path, managers: rec.managers });
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

  /** The tracked paths of HEAD: `diff --name-only <empty tree> HEAD` (GitOps has no ls-files). */
  async function trackedFiles(path: string): Promise<string[]> {
    const head = await d.git.revParse(path, "HEAD");
    return d.git.diffNames(path, head.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1, head);
  }

  async function detectFor(rec: SlotRecord): Promise<Detection> {
    return detectManagers(rec.path, await trackedFiles(rec.path), d.fs, config);
  }

  async function install(rec: SlotRecord, detection: Detection, fresh: boolean): Promise<void> {
    await d.provisioner.provision(rec.path, detection, { fresh });
    d.onProvision?.(rec.slot, detection.managers);
  }

  /** Re-detects and, on drift (memo 4.4), writes `provisioning` and installs. The returned record is not yet saved with the new digests. */
  async function driftProvision(rec: SlotRecord): Promise<{ rec: SlotRecord; drifted: boolean }> {
    const detection = await detectFor(rec);
    if (!needsProvision(rec, detection)) return { rec, drifted: false };
    const prov = await save({ ...rec, state: "provisioning" });
    if (detection.managers.length > 0) await install(prov, detection, true);
    return { rec: { ...prov, managers: [...detection.managers], manifests: { ...detection.manifests } }, drifted: true };
  }

  async function stageProvision(rec: SlotRecord, fresh: boolean): Promise<SlotRecord> {
    const prov = rec.state === "provisioning" ? rec : await save({ ...rec, state: "provisioning" });
    const detection = await detectFor(prov);
    if (detection.managers.length > 0) await install(prov, detection, fresh);
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
      try {
        await d.git.verifySlotPointers(rec.path);
        return;
      } catch (error) {
        logger?.warn(`slot ${rec.slot} is half created (${messageOf(error)}); recreating it`);
      }
      if ((await d.fs.readdir(rec.path)).length === 0) {
        await withRetry(d.clock, () => d.fs.rm(rec.path, { recursive: true }));
      } else {
        await retireSlot(retireCtx, rec, Number.POSITIVE_INFINITY);
        records.delete(rec.slot);
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
      const tracked = new Set(await trackedFiles(rec.path));
      const sweep = await sweepLinks({ fs: d.fs, clock: d.clock, platform }, rec.path, { skipDependencyDirs: true, tracked });
      if (sweep.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${rec.slot}`, { slot: rec.slot });
      await d.git.checkoutDetach(rec.path, commit);
      await d.git.cleanTracked(rec.path);
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
        throw new ExecutorError(
          "E_SLOT_BROKEN", `files in ${rec.slot} are held by a running process; stop it and retry`,
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
  async function driveStage(rec: SlotRecord, firstRun: boolean): Promise<SlotRecord> {
    switch (rec.state) {
      case "creating":
        return stageCreate(rec, firstRun);
      case "provisioning":
        await d.git.verifySlotPointers(rec.path);
        return stageProvision(rec, true);
      case "resetting":
        return stageReset(rec);
      default:
        throw new ExecutorError("E_SLOT_BROKEN", `slot ${rec.slot} is ${rec.state}`, { slot: rec.slot, state: rec.state });
    }
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
        await retireSlot(retireCtx, rec, Number.POSITIVE_INFINITY);
        records.delete(slot);
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
      return leaseOf(await driveStage(rec, firstRun));
    } catch (error) {
      throw await failStage(slot, error);
    }
  }

  async function acquireSlot(
    claim: () => Promise<{ slot: string; mode: ClaimMode }>, spec: AcquireSpec,
  ): Promise<SlotLease> {
    assertOpen();
    const scheduled = await poolLock.run(async () => {
      const { slot, mode } = await claim();
      // Queued on the slot mutex before the pool mutex is released, so nothing runs on this slot ahead of the claim.
      return { run: slotLock(slot).run(() => work(slot, mode, spec)) };
    });
    return scheduled.run;
  }

  // ---- reset, cleanForChecks, release -----------------------------------------------------------------------

  async function reset(slot: string, commit: string): Promise<void> {
    assertOpen();
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
        if (rec.state === "creating" || rec.state === "provisioning") rec = await driveStage(rec, false);
        const resetting = await save({ ...rec, state: "resetting", commit: oid });
        await driveStage(resetting, false);
      } catch (error) {
        throw await failStage(slot, error);
      }
    });
  }

  async function cleanForChecks(slot: string): Promise<void> {
    assertOpen();
    assertSlot(slot);
    await slotLock(slot).run(async () => {
      const rec = records.get(slot);
      if (rec === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown slot ${slot}`, { slot });
      if (rec.state !== "leased") throw new ExecutorError("E_INVALID_INPUT", `slot ${slot} is ${rec.state}, not leased`, { slot, state: rec.state });
      try {
        await d.git.verifySlotPointers(rec.path);
        const tracked = new Set(await trackedFiles(rec.path));
        const sweep = await sweepLinks({ fs: d.fs, clock: d.clock, platform }, rec.path, { skipDependencyDirs: true, tracked });
        if (sweep.truncated) throw new ExecutorError("E_SLOT_BROKEN", `more than ${SLOT_SWEEP_MAX_ENTRIES} entries in ${slot}`, { slot });
        const berry = rec.managers.includes("yarn") && await d.fs.lstat(api.join(rec.path, ".yarnrc.yml")) !== null;
        await d.git.cleanForChecks(rec.path, keepFor(rec.managers, berry));
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
    return poolLock.run(async () => {
      const out = await gcSlots({
        repoKey: d.repoKey, toplevel: d.toplevel, slotsDir: d.slotsDir, markersDir: d.markersDir, executorHome: d.executorHome,
        git: d.git, fs: d.fs, clock: d.clock, platform, ...(logger === undefined ? {} : { logger }),
      }, isFinished);
      for (const rec of [...records.values()]) {
        const read = await readMarkerFile(fileCtx, markerPath(d.markersDir, rec.planId, rec.slot));
        if (read.ok) {
          records.set(rec.slot, read.rec);
        } else if (read.missing) {
          records.delete(rec.slot);
          unregisterSlot(rec.path);
        }
      }
      return out;
    });
  }

  return {
    open,
    async acquire(planId, owner, baseCommit) {
      if (planId !== d.planId) throw new ExecutorError("E_INVALID_INPUT", "plan id differs from the pool's plan", { planId: String(planId).slice(0, 80) });
      if (typeof baseCommit !== "string" || !GIT_ID_PATTERN.test(baseCommit)) {
        throw new ExecutorError("E_INVALID_INPUT", "baseCommit must be a full git object id", { baseCommit: String(baseCommit).slice(0, 80) });
      }
      if (typeof owner !== "string" || !OWNER_PATTERN.test(owner)) {
        throw new ExecutorError("E_INVALID_INPUT", "owner must be 1-128 printable characters", { length: typeof owner === "string" ? owner.length : -1 });
      }
      assertOpen();
      const base = await d.git.revParse(d.toplevel, baseCommit);
      return acquireSlot(() => claimTask(owner, base), { kind: "task", owner, base });
    },
    async acquireSpecial(planId, kind) {
      if (planId !== d.planId) throw new ExecutorError("E_INVALID_INPUT", "plan id differs from the pool's plan", { planId: String(planId).slice(0, 80) });
      if (kind !== "integration" && kind !== "ci") throw new ExecutorError("E_INVALID_INPUT", "kind must be integration or ci", { kind: String(kind).slice(0, 40) });
      assertOpen();
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
