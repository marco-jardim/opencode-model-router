/**
 * Cross-repo Phase 4: the store of repositories outside `routing.repoParents` that a human approved
 * with `/router approve` (design `docs/design/cross-repo-phase4-plan.md`, SD-P4-1..3, -8, -9).
 *
 * No git runs in this file. The store is a small JSON file next to the router state:
 * `{version: 1, approvals: [{path, commonDir, roots[], origin, approvedAt, lastUsedAt}]}` (times in
 * epoch ms). A file that is not valid as a whole (JSON, version, size, entry count) means no approvals
 * (fail closed) and one notice. A single invalid entry is dropped when read. Writes run one at a time
 * in the process, re-read the file, apply one operation and go through a tmp file and a rename.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { configPath, overridePath, statePath } from "../../router/config";
import { REPO_APPROVAL_CAP_DAYS } from "../../router/roles-config";
import { permissionMatches } from "../../router/read-only";
import { resolvePendingJournalDir } from "../../verify/pending";
import { EXECUTOR_HOME_DIRNAME, resolveExecutorHome } from "../../executor/paths";
// Static, not `await import`: dynamic imports made a bundle split src/router/config.ts into a chunk where its tiers.json
// lookup fails. The cycle with admission.ts is safe: each side uses the other only inside functions.
import * as admission from "./admission";
import { displaySafe } from "./read-set";

export const APPROVALS_FILE_NAME = "opencode-model-router.repo-approvals.json";
export const APPROVALS_VERSION = 1;
/** At most this many entries; a file with more is invalid, and `put` refuses at this count. */
export const MAX_APPROVALS = 32;
/** The store file is at most this many bytes; checked with `stat` before reading. */
export const MAX_APPROVALS_BYTES = 256 * 1024;
/** A stored time further than this in the future invalidates its entry. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** `touch` writes at most once per this interval per path. */
export const TOUCH_INTERVAL_MS = 60 * 60_000;
/** Shown when there is no origin. */
export const NO_ORIGIN = "none";
/** Origins shown to the human are capped at this many characters. */
export const MAX_ORIGIN_CHARS = 200;

const DAY_MS = 86_400_000;
const MAX_PATH_CHARS = 1024;
const MAX_ROOTS = 64;
const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY_KEYS = new Set(["path", "commonDir", "roots", "origin", "approvedAt", "lastUsedAt"]);

/** One approved repository (a main worktree). */
export interface RepoApproval {
  /** Canonical path of the main worktree, as text. */
  readonly path: string;
  /** Canonical git common dir (`<path>\.git`). */
  readonly commonDir: string;
  /** Sorted root commits (`git rev-list --max-parents=0 HEAD`). */
  readonly roots: readonly string[];
  /** Sanitized origin ({@link sanitizeOrigin}); `none` when absent. */
  readonly origin: string;
  readonly approvedAt: number;
  readonly lastUsedAt: number;
}

/** Fields of a new approval; the store sets the times. */
export interface NewRepoApproval {
  readonly path: string;
  readonly commonDir: string;
  readonly roots: readonly string[];
  /** Raw or sanitized origin; stored through {@link sanitizeOrigin}. */
  readonly origin?: string;
}

/** Injectable environment, for tests. */
export interface ApprovalsEnv {
  /** Directory of the store; default `dirname(statePath())`. */
  readonly dir?: string;
  /** Clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
  /** Sink for the one notice about an invalid file; default `console.warn`. */
  readonly warn?: (message: string) => void;
  /** Test only: runs after the tmp file is written and before the rename (throw to simulate a crash). */
  readonly beforeRename?: (tmp: string) => void;
}

export interface ApprovalsRead {
  /** The store file. */
  readonly file: string;
  /** Valid entries (expired ones included; see {@link isApprovalValid}). Empty when `invalid` is set. */
  readonly approvals: readonly RepoApproval[];
  /** Set when the file as a whole is invalid: no approvals apply and `put`/`delete` refuse. */
  readonly invalid?: string;
  /** One line per entry dropped by the per-entry validation. */
  readonly dropped: readonly string[];
}

export type ApprovalOp =
  | { readonly kind: "put"; readonly approval: NewRepoApproval; readonly days: number }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "touch"; readonly path: string; readonly roots: readonly string[]; readonly days: number };

export type ApplyOutcome =
  | { readonly status: "written"; readonly file: string; readonly entry?: RepoApproval }
  | { readonly status: "unchanged"; readonly file: string; readonly reason: "absent" | "mismatch" | "expired" | "throttled" }
  | {
    readonly status: "refused";
    readonly file: string;
    readonly reason: "invalid-store" | "invalid-entry" | "full" | "io" | "read-back";
    readonly message: string;
  };

const warned = new Set<string>();
const lastTouched = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

/** Test only: re-arm the invalid-file notice and forget the in-memory touch throttle and the identity caches. */
export function resetApprovalsState(): void {
  warned.clear();
  lastTouched.clear();
  resetIdentityCaches();
}

/** The store file: `dirname(statePath())/opencode-model-router.repo-approvals.json`. */
export function approvalsPath(env: ApprovalsEnv = {}): string {
  return path.join(env.dir ?? path.dirname(statePath()), APPROVALS_FILE_NAME);
}

function clock(env: ApprovalsEnv): number {
  return (env.now ?? Date.now)();
}

/** Comparison key of a path: case-insensitive on Windows. */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 1;
  return Math.min(Math.max(Math.trunc(days), 1), REPO_APPROVAL_CAP_DAYS);
}

/** `min(lastUsedAt + days, approvedAt + 90 days)`, in epoch ms. */
export function expiresAt(entry: Pick<RepoApproval, "approvedAt" | "lastUsedAt">, days: number): number {
  return Math.min(entry.lastUsedAt + clampDays(days) * DAY_MS, entry.approvedAt + REPO_APPROVAL_CAP_DAYS * DAY_MS);
}

/** An approval is valid iff `now < expiresAt(entry, days)`. */
export function isApprovalValid(entry: Pick<RepoApproval, "approvedAt" | "lastUsedAt">, days: number, now: number): boolean {
  return now < expiresAt(entry, days);
}

/** Problem with a stored path text, or undefined: absolute, already normalized, no device prefix, no glob or control characters. */
function storedPathProblem(p: unknown): string | undefined {
  if (typeof p !== "string" || p === "") return "is not a non-empty string";
  if (p.length > MAX_PATH_CHARS) return `is longer than ${MAX_PATH_CHARS} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "contains a control character";
  if (/[*?"<>|]/.test(p)) return "contains a glob or reserved character";
  if (p.startsWith("\\\\?\\") || p.startsWith("\\\\.\\") || p.startsWith("//?/") || p.startsWith("//./")) return "is a device path";
  if (!path.isAbsolute(p)) return "is not absolute";
  if (path.resolve(p) !== p) return "is not in normalized form";
  return undefined;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function rootsProblem(roots: unknown): string | undefined {
  if (!Array.isArray(roots) || roots.length === 0) return "roots is not a non-empty array";
  if (roots.length > MAX_ROOTS) return `roots has more than ${MAX_ROOTS} entries`;
  const seen = new Set<string>();
  for (const r of roots as unknown[]) {
    if (typeof r !== "string" || !HEX_SHA.test(r)) return "roots holds a value that is not a hex SHA";
    if (seen.has(r)) return "roots holds a duplicate";
    seen.add(r);
  }
  return undefined;
}

function entryProblem(raw: unknown, now: number): string | undefined {
  if (!isPlainRecord(raw)) return "is not an object";
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) return `has an unknown field ${JSON.stringify(key)}`;
  const p = storedPathProblem(raw.path);
  if (p !== undefined) return `path ${p}`;
  const c = storedPathProblem(raw.commonDir);
  if (c !== undefined) return `commonDir ${c}`;
  const r = rootsProblem(raw.roots);
  if (r !== undefined) return r;
  if (typeof raw.origin !== "string" || raw.origin.length > MAX_ORIGIN_CHARS || sanitizeOrigin(raw.origin) !== raw.origin) {
    return "origin is not a sanitized origin";
  }
  if (!isTime(raw.approvedAt) || !isTime(raw.lastUsedAt)) return "a time is not an epoch-ms integer";
  if (raw.approvedAt > raw.lastUsedAt) return "approvedAt is after lastUsedAt";
  if (raw.lastUsedAt > now + MAX_FUTURE_SKEW_MS) return "a time is more than 5 minutes in the future";
  return undefined;
}

function toEntry(raw: Record<string, unknown>): RepoApproval {
  return Object.freeze({
    path: raw.path as string,
    commonDir: raw.commonDir as string,
    roots: Object.freeze([...(raw.roots as string[])].sort()),
    origin: raw.origin as string,
    approvedAt: raw.approvedAt as number,
    lastUsedAt: raw.lastUsedAt as number,
  });
}

function notice(env: ApprovalsEnv, file: string, problem: string): void {
  const key = `${file}\u0000${problem}`;
  if (warned.has(key)) return;
  warned.add(key);
  const message = `repository approvals file ${file} is invalid (${problem}); no approvals apply until it is fixed or removed`;
  if (env.warn) env.warn(message);
  else console.warn(`[model-router] ${message}`);
}

function invalidRead(env: ApprovalsEnv, file: string, problem: string): ApprovalsRead {
  notice(env, file, problem);
  return Object.freeze({ file, approvals: Object.freeze([]), invalid: problem, dropped: Object.freeze([]) });
}

function errCode(e: unknown): string | undefined {
  return isPlainRecord(e) && typeof e.code === "string" ? e.code : undefined;
}

/**
 * Reads the store without git. A missing file is an empty store. A file that is not a regular file,
 * is larger than {@link MAX_APPROVALS_BYTES} (checked with `stat` first), is not JSON, has another
 * version or more than {@link MAX_APPROVALS} entries gives no approvals, `invalid` set and one notice.
 * An invalid entry is dropped; two entries with the same path are both dropped.
 */
export function readApprovals(env: ApprovalsEnv = {}): ApprovalsRead {
  const file = approvalsPath(env);
  let stat: fs.Stats;
  try {
    // lstat: a link in place of the store is not a regular file (fail closed).
    stat = fs.lstatSync(file);
  } catch (e) {
    if (errCode(e) === "ENOENT") return Object.freeze({ file, approvals: Object.freeze([]), dropped: Object.freeze([]) });
    return invalidRead(env, file, `cannot be read: ${errCode(e) ?? "error"}`);
  }
  if (!stat.isFile()) return invalidRead(env, file, "is not a regular file");
  if (stat.size > MAX_APPROVALS_BYTES) return invalidRead(env, file, `is larger than ${MAX_APPROVALS_BYTES / 1024} KiB`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (errCode(e) === "ENOENT") return Object.freeze({ file, approvals: Object.freeze([]), dropped: Object.freeze([]) });
    return invalidRead(env, file, `cannot be read: ${errCode(e) ?? "error"}`);
  }
  if (buf.length > MAX_APPROVALS_BYTES) return invalidRead(env, file, `is larger than ${MAX_APPROVALS_BYTES / 1024} KiB`);
  let data: unknown;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch {
    return invalidRead(env, file, "is not valid JSON");
  }
  if (!isPlainRecord(data)) return invalidRead(env, file, "is not a JSON object");
  if (data.version !== APPROVALS_VERSION) return invalidRead(env, file, `has an unknown version (expected ${APPROVALS_VERSION})`);
  const list = data.approvals;
  if (!Array.isArray(list)) return invalidRead(env, file, "has no approvals array");
  if (list.length > MAX_APPROVALS) return invalidRead(env, file, `has more than ${MAX_APPROVALS} entries`);

  const now = clock(env);
  const dropped: string[] = [];
  const valid: { index: number; entry: RepoApproval }[] = [];
  (list as unknown[]).forEach((raw, index) => {
    const problem = entryProblem(raw, now);
    if (problem !== undefined) dropped.push(`approvals[${index}] ${problem}; dropped`);
    else valid.push({ index, entry: toEntry(raw as Record<string, unknown>) });
  });
  const counts = new Map<string, number>();
  for (const { entry } of valid) counts.set(pathKey(entry.path), (counts.get(pathKey(entry.path)) ?? 0) + 1);
  const approvals: RepoApproval[] = [];
  for (const { index, entry } of valid) {
    if ((counts.get(pathKey(entry.path)) ?? 0) > 1) dropped.push(`approvals[${index}] path is a duplicate; dropped`);
    else approvals.push(entry);
  }
  return Object.freeze({ file, approvals: Object.freeze(approvals), dropped: Object.freeze(dropped) });
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameEntry(a: RepoApproval, b: RepoApproval): boolean {
  return a.path === b.path && a.commonDir === b.commonDir && sameRoots(a.roots, b.roots) && a.origin === b.origin
    && a.approvedAt === b.approvedAt && a.lastUsedAt === b.lastUsedAt;
}

/**
 * Writes the store through a tmp file and a rename, like `writeState` (config.ts). Returns an error
 * message, or undefined. A crash before the rename leaves the previous file as it was.
 */
function writeStore(env: ApprovalsEnv, file: string, approvals: readonly RepoApproval[]): string | undefined {
  const body = `${JSON.stringify({ version: APPROVALS_VERSION, approvals }, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_APPROVALS_BYTES) return `the store would be larger than ${MAX_APPROVALS_BYTES / 1024} KiB`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    env.beforeRename?.(tmp);
    fs.renameSync(tmp, file);
    return undefined;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // the tmp file may not exist
    }
    return `cannot write ${file}: ${errCode(e) ?? (e instanceof Error ? e.message : "error")}`;
  }
}

function serialized<T>(file: string, fn: () => T): Promise<T> {
  const key = pathKey(file);
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function applyNow(op: ApprovalOp, env: ApprovalsEnv): ApplyOutcome {
  const file = approvalsPath(env);
  const now = clock(env);

  if (op.kind === "touch") {
    // In memory: the last known `lastUsedAt` of the path, so a touch within the hour needs no I/O at all.
    const throttleKey = `${pathKey(file)}\u0000${op.path}`;
    const last = lastTouched.get(throttleKey);
    if (last !== undefined && now >= last && now - last < TOUCH_INTERVAL_MS) return { status: "unchanged", file, reason: "throttled" };
    const current = readApprovals(env);
    if (current.invalid !== undefined) return { status: "unchanged", file, reason: "absent" };
    const entry = current.approvals.find((a) => a.path === op.path);
    if (entry === undefined) return { status: "unchanged", file, reason: "absent" };
    if (!sameRoots(entry.roots, op.roots)) return { status: "unchanged", file, reason: "mismatch" };
    if (!isApprovalValid(entry, op.days, now)) return { status: "unchanged", file, reason: "expired" };
    if (now - entry.lastUsedAt < TOUCH_INTERVAL_MS) {
      if (now >= entry.lastUsedAt) lastTouched.set(throttleKey, entry.lastUsedAt);
      return { status: "unchanged", file, reason: "throttled" };
    }
    const next: RepoApproval = Object.freeze({ ...entry, lastUsedAt: now });
    const problem = writeStore(env, file, current.approvals.map((a) => (a === entry ? next : a)));
    if (problem !== undefined) return { status: "refused", file, reason: "io", message: problem };
    lastTouched.set(throttleKey, now);
    return { status: "written", file, entry: next };
  }

  const current = readApprovals(env);
  if (current.invalid !== undefined) {
    return {
      status: "refused",
      file,
      reason: "invalid-store",
      message: `the approvals file ${file} is invalid (${current.invalid}); fix or remove it first`,
    };
  }

  if (op.kind === "delete") {
    const key = pathKey(op.path);
    if (!current.approvals.some((a) => pathKey(a.path) === key)) return { status: "unchanged", file, reason: "absent" };
    const problem = writeStore(env, file, current.approvals.filter((a) => pathKey(a.path) !== key));
    if (problem !== undefined) return { status: "refused", file, reason: "io", message: problem };
    const back = readApprovals(env);
    if (back.invalid !== undefined || back.approvals.some((a) => pathKey(a.path) === key)) {
      return { status: "refused", file, reason: "read-back", message: `the approval is still in ${file} after the write` };
    }
    return { status: "written", file };
  }

  const raw = {
    path: op.approval.path,
    commonDir: op.approval.commonDir,
    roots: [...new Set(op.approval.roots)].sort(),
    origin: sanitizeOrigin(op.approval.origin),
    approvedAt: now,
    lastUsedAt: now,
  };
  const problem = entryProblem(raw, now);
  if (problem !== undefined) return { status: "refused", file, reason: "invalid-entry", message: `the approval ${problem}` };
  const entry = toEntry(raw);
  const key = pathKey(entry.path);
  const kept = current.approvals.filter((a) => pathKey(a.path) !== key && isApprovalValid(a, op.days, now));
  if (kept.length >= MAX_APPROVALS) {
    return {
      status: "refused",
      file,
      reason: "full",
      message: `${file} already holds ${MAX_APPROVALS} approvals; revoke one first`,
    };
  }
  const writeProblem = writeStore(env, file, [...kept, entry]);
  if (writeProblem !== undefined) return { status: "refused", file, reason: "io", message: writeProblem };
  const back = readApprovals(env);
  const stored = back.approvals.find((a) => pathKey(a.path) === key);
  if (back.invalid !== undefined || stored === undefined || !sameEntry(stored, entry)) {
    return { status: "refused", file, reason: "read-back", message: `the approval is not in ${file} after the write` };
  }
  return { status: "written", file, entry: stored };
}

/**
 * Applies one operation to the store, one at a time in the process. Each operation reads the file
 * again first. `put` replaces the entry of the same path (resetting `approvedAt`), drops expired
 * entries and refuses at {@link MAX_APPROVALS}; `delete` removes the entry of a path; both read the
 * file back. `touch` moves `lastUsedAt` to now only when the entry still has the same path and roots
 * and is still valid, at most once per {@link TOUCH_INTERVAL_MS} per path, so it never resurrects a
 * revoked or expired entry. `put` and `delete` refuse on an invalid file; `touch` leaves it alone.
 * Never throws.
 */
export function applyApproval(op: ApprovalOp, env: ApprovalsEnv = {}): Promise<ApplyOutcome> {
  const file = approvalsPath(env);
  return serialized(file, () => {
    try {
      return applyNow(op, env);
    } catch (e) {
      const outcome: ApplyOutcome = {
        status: "refused",
        file,
        reason: "io",
        message: `cannot update ${file}: ${e instanceof Error ? e.message : String(e)}`,
      };
      return outcome;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Protected locations (SD-P4-8)

/** How a protected location relates to a candidate it refuses. */
export type ProtectedMode = "any" | "equal-or-ancestor";

export interface ProtectedLocation {
  readonly label: string;
  readonly dir: string;
  /** `any`: equal, ancestor or inside is refused; `equal-or-ancestor`: inside is allowed. */
  readonly mode: ProtectedMode;
}

/** An absolute directory from an environment variable, or undefined. */
function envDir(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" && path.isAbsolute(v) ? v : undefined;
}

/** `$XDG_<kind>_HOME/opencode` when set, and always `~/<fallback>/opencode` (opencode's xdg-basedir layout). */
function opencodeDirs(xdgVar: string, ...fallback: string[]): string[] {
  const dirs = [path.join(os.homedir(), ...fallback, "opencode")];
  const xdg = envDir(xdgVar);
  if (xdg !== undefined) dirs.push(path.join(xdg, "opencode"));
  return dirs;
}

/**
 * The directory of the config file named by `OPENCODE_CONFIG` (resolved against the working directory,
 * as opencode reads it), or undefined when the variable is unset or empty.
 */
function opencodeConfigFileDir(): string | undefined {
  const v = process.env.OPENCODE_CONFIG;
  return v !== undefined && v.trim() !== "" ? path.dirname(path.resolve(v)) : undefined;
}

/**
 * The protected locations: the opencode config dir (the router's `dirname(overridePath())`, plus
 * `$XDG_CONFIG_HOME/opencode`), `OPENCODE_CONFIG_DIR`, the directory of the `OPENCODE_CONFIG` file and
 * `~/.opencode`, the opencode data, state and cache dirs, this plugin's install dir
 * (`dirname(configPath())`), the store's dir and the router state directory of the pending journal
 * (`resolvePendingJournalDir`) (equal, ancestor or inside), and the user profile (equal or ancestor).
 * Filesystem roots are checked separately by {@link protectedProblem}; the executor home, which is per
 * repository, by {@link inspectCandidate}.
 */
export function protectedLocations(env: ApprovalsEnv = {}): ProtectedLocation[] {
  const out: ProtectedLocation[] = [];
  const add = (label: string, dir: string, mode: ProtectedMode = "any"): void => {
    if (!out.some((l) => l.label === label && cmpForm(l.dir) === cmpForm(dir))) out.push({ label, dir, mode });
  };
  add("the opencode config directory", path.dirname(overridePath()));
  for (const d of opencodeDirs("XDG_CONFIG_HOME", ".config")) add("the opencode config directory", d);
  const custom = envDir("OPENCODE_CONFIG_DIR");
  if (custom !== undefined) add("OPENCODE_CONFIG_DIR", custom);
  const configFileDir = opencodeConfigFileDir();
  if (configFileDir !== undefined) add("the directory of OPENCODE_CONFIG", configFileDir);
  add("the ~/.opencode directory", path.join(os.homedir(), ".opencode"));
  for (const d of opencodeDirs("XDG_DATA_HOME", ".local", "share")) add("the opencode data directory", d);
  for (const d of opencodeDirs("XDG_STATE_HOME", ".local", "state")) add("the opencode state directory", d);
  for (const d of opencodeDirs("XDG_CACHE_HOME", ".cache")) add("the opencode cache directory", d);
  add("the plugin install directory", path.dirname(configPath()));
  add("the approvals store directory", path.dirname(approvalsPath(env)));
  // The pending journal's directory, resolved as the v2 wiring resolves it: its verdict records are re-posted after a restart.
  add("the router state directory", resolvePendingJournalDir({ homedir: os.homedir(), platform: process.platform, xdgStateHome: process.env.XDG_STATE_HOME }));
  add("the user profile", os.homedir(), "equal-or-ancestor");
  return out;
}

/** Normalized comparison form: resolved, no trailing separator except at a root, case-folded on Windows. */
function cmpForm(p: string): string {
  let r = path.resolve(p);
  const root = path.parse(r).root;
  while (r.length > root.length && (r.endsWith(path.sep) || r.endsWith("/"))) r = r.slice(0, -1);
  return pathKey(r);
}

function within(child: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) || parent.endsWith("/") ? parent : `${parent}${path.sep}`;
  return child !== parent && child.startsWith(prefix);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Why a candidate may not be approved because of where it is, or undefined. `text` is what the human
 * typed (absolute), `canonical` its realpath; both are checked against every protected location
 * (literal and canonical forms) and against filesystem roots. No git.
 */
export function protectedProblem(text: string, canonical: string, env: ApprovalsEnv = {}): string | undefined {
  const candidates = [...new Set([text, canonical].filter((c) => c !== "" && path.isAbsolute(c)).map(cmpForm))];
  if (candidates.length === 0) return "is not an absolute path";
  for (const c of candidates) {
    if (cmpForm(path.parse(c).root) === c) return "is a drive or filesystem root";
  }
  const locations = protectedLocations(env).map((loc) => ({
    loc,
    forms: [...new Set([cmpForm(loc.dir), cmpForm(realOrSelf(loc.dir))])],
  }));
  // Equality first, so the message names the location itself rather than one it contains.
  for (const { loc, forms } of locations) {
    if (candidates.some((c) => forms.includes(c))) return `is ${loc.label} (${loc.dir})`;
  }
  for (const { loc, forms } of locations) {
    for (const c of candidates) {
      for (const d of forms) {
        if (within(d, c)) return `contains ${loc.label} (${loc.dir})`;
        if (loc.mode === "any" && within(c, d)) return `is inside ${loc.label} (${loc.dir})`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Origin shown to the human (SD-P4-9)

const URL_FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/;

/**
 * The origin as shown to the human and stored. URL forms lose user-info, query and fragment; the scp
 * form (`user@host:path`) and local paths are kept. Then `displaySafe`, capped at
 * {@link MAX_ORIGIN_CHARS} characters; `none` when there is no origin.
 */
export function sanitizeOrigin(raw: string | undefined): string {
  if (raw === undefined) return NO_ORIGIN;
  let text = raw.trim();
  if (text === "") return NO_ORIGIN;
  const m = URL_FORM.exec(text);
  if (m !== null) {
    const authority = m[2] ?? "";
    const at = authority.lastIndexOf("@");
    const host = at === -1 ? authority : authority.slice(at + 1);
    text = `${m[1]}://${host}${m[3] ?? ""}`;
  }
  let shown = displaySafe(text);
  if (shown.trim() === "") return NO_ORIGIN;
  if (shown.length > MAX_ORIGIN_CHARS) shown = `${shown.slice(0, MAX_ORIGIN_CHARS - 1)}…`;
  return shown;
}

// ---------------------------------------------------------------------------------------------
// Candidate inspection and identity check (SD-P4-4, -6, -8)

/** {@link inspectCandidate} results are cached this long per path (SD-P4-8). */
export const INSPECT_CACHE_MS = 5_000;

/** What git says about a candidate main worktree (SD-P4-4, -8, -9). */
export interface CandidateIdentity {
  /** Canonical path of the main worktree. */
  readonly path: string;
  /** Canonical git common dir (`<path>\.git`). */
  readonly commonDir: string;
  /** Sorted root commits (`git rev-list --max-parents=0 HEAD`). */
  readonly roots: readonly string[];
  /** Sanitized origin ({@link sanitizeOrigin}); `none` when absent. */
  readonly origin: string;
  /** Current branch, display-safe; `(detached)` when `HEAD` is detached. */
  readonly branch: string;
  /** HEAD commit, display-safe. */
  readonly head: string;
}

/** The parts of `fs.Stats` that {@link inspectCandidate} and {@link verifyIdentity} use. */
export interface EntryStat {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Injectable I/O of {@link verifyIdentity} (and {@link inspectCandidate}); every member defaults to the real one. */
export interface IdentityDeps {
  /** `realpathSync.native`; throws when the path does not resolve. */
  readonly realpath?: (p: string) => string;
  /** `lstatSync` (links are not followed); throws when the entry is absent. */
  readonly lstat?: (p: string) => EntryStat;
  /** Hardened `git rev-parse --show-toplevel` in `cwd`; undefined on failure. */
  readonly showToplevel?: (cwd: string) => Promise<string | undefined>;
  /** Hardened `git rev-parse --git-common-dir` in `cwd`, absolute; undefined on failure. */
  readonly commonDir?: (cwd: string) => Promise<string | undefined>;
  /** Hardened sorted root commits of `HEAD`; undefined on failure and without commits. */
  readonly rootCommits?: (cwd: string) => Promise<string[] | undefined>;
  /** Hardened raw `remote.origin.url`; undefined when unset and on failure. */
  readonly origin?: (cwd: string) => Promise<string | undefined>;
  /** Hardened `HEAD` commit and branch; undefined on failure and without commits. */
  readonly headInfo?: (cwd: string) => Promise<import("./admission").GitHeadInfo | undefined>;
  /** Options of the default git helpers (tests: an injected spawn or a shorter bound). */
  readonly git?: import("./admission").GitBoundedOptions;
  /** Clock of the caches; default `Date.now`. */
  readonly now?: () => number;
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * {@link inspectCandidate} only: the executor home resolved from `dir` (default `resolveExecutorHome`, hardened git);
   * throws when `dir` has none.
   */
  readonly executorHome?: (dir: string) => Promise<string>;
}

/** Injectable I/O and configuration of {@link inspectCandidate}. */
export interface InspectDeps extends IdentityDeps {
  /** `routing.repoExclude`: absolute globs matched against the text and the canonical form of the candidate. */
  readonly exclude?: readonly string[];
  /** Store environment: the store's directory is a protected location. */
  readonly env?: ApprovalsEnv;
  /**
   * Ask git now, never a cached result (`/router approve`, S2: what is stored comes from git at approve time). The fresh
   * result still replaces the cached one.
   */
  readonly fresh?: boolean;
}

/** The end of every refusal of a candidate that is not a main worktree (SD-P4-4). */
export const APPROVE_MAIN_WORKTREE = "approve the main worktree";

type AdmissionModule = typeof admission;

interface TimedResult<T> { readonly at: number; readonly value: Promise<T> }
const IDENTITY_CACHE_MAX = 64;
const inspected = new Map<string, TimedResult<string | CandidateIdentity>>();
const rootsByHead = new Map<string, Promise<string[] | undefined>>();

/** Test only: forget the {@link inspectCandidate} results and the root commits cached per (common dir, HEAD). */
export function resetIdentityCaches(): void {
  inspected.clear();
  rootsByHead.clear();
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > IDENTITY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function settle<T>(run: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

function realpathOf(deps: IdentityDeps): (p: string) => string {
  return deps.realpath ?? ((p: string) => fs.realpathSync.native(p));
}

/** The git helpers: the injected ones, else the hardened ones of `admission.ts` (bounded, `deps.git` options). */
function gitIo(deps: IdentityDeps, adm: AdmissionModule): Required<Pick<IdentityDeps, "showToplevel" | "commonDir" | "rootCommits" | "origin" | "headInfo">> {
  const git = deps.git;
  return {
    showToplevel: deps.showToplevel ?? ((cwd: string) => adm.gitShowToplevel(cwd, git)),
    commonDir: deps.commonDir ?? ((cwd: string) => adm.gitCommonDir(cwd, git)),
    rootCommits: deps.rootCommits ?? ((cwd: string) => adm.gitRootCommits(cwd, git)),
    origin: deps.origin ?? ((cwd: string) => adm.gitOrigin(cwd, git)),
    headInfo: deps.headInfo ?? ((cwd: string) => adm.gitHeadInfo(cwd, git)),
  };
}

/** Whether git's absolute `listed` path names `real` (canonical): text first, `realpath` only when the text differs. */
function samePlace(listed: string, real: string, realpath: (p: string) => string): boolean {
  if (!path.isAbsolute(listed)) return false;
  if (cmpForm(listed) === cmpForm(real)) return true;
  try {
    return cmpForm(realpath(listed)) === cmpForm(real);
  } catch {
    return false;
  }
}

/** SD-P4-4: `<real>\.git` must be a local directory (`lstat`: not a link, not a gitfile). No git. */
function gitDirectoryProblem(real: string, deps: IdentityDeps): string | undefined {
  const lstat = deps.lstat ?? ((p: string) => fs.lstatSync(p));
  let stat: EntryStat;
  try {
    stat = lstat(path.join(real, ".git"));
  } catch {
    return `has no .git directory (it is not the main worktree of a git repository); ${APPROVE_MAIN_WORKTREE}`;
  }
  if (stat.isSymbolicLink()) return `has a .git link instead of a .git directory; ${APPROVE_MAIN_WORKTREE}`;
  if (!stat.isDirectory()) {
    return `has a .git file (a linked worktree, a submodule or a separate git dir) instead of a .git directory; ${APPROVE_MAIN_WORKTREE}`;
  }
  return undefined;
}

/**
 * QA-SYNC1-5: whether `text` or `canonical` is the executor home of a repository (`<git common dir>\omr-executor`, which holds
 * the executor's plan directories and slot markers) or lies inside one. The home is per repository, so it is not a fixed
 * {@link protectedLocations} entry: every ancestor named {@link EXECUTOR_HOME_DIRNAME} is checked against the home that
 * `resolveExecutorHome` gives for its parent, exactly as the executor resolves it. Git runs only for such an ancestor.
 */
async function executorHomeProblem(text: string, canonical: string, deps: IdentityDeps): Promise<string | undefined> {
  const resolveHome = deps.executorHome ?? ((dir: string) => resolveExecutorHome(dir));
  const name = pathKey(EXECUTOR_HOME_DIRNAME);
  const checked = new Set<string>();
  for (const candidate of [text, canonical]) {
    if (candidate === "" || !path.isAbsolute(candidate)) continue;
    const self = cmpForm(candidate);
    for (let dir = path.resolve(candidate); ; dir = path.dirname(dir)) {
      const form = cmpForm(dir);
      if (pathKey(path.basename(dir)) === name && !checked.has(form)) {
        checked.add(form);
        let home: string | undefined;
        try {
          home = await resolveHome(path.dirname(dir));
        } catch {
          home = undefined;
        }
        if (home !== undefined && [cmpForm(home), cmpForm(realOrSelf(home))].some((h) => h === form || h === cmpForm(realOrSelf(dir)))) {
          return form === self ? `is the executor home (${home})` : `is inside the executor home (${home})`;
        }
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return undefined;
}

/** `routing.repoExclude` pattern matching `p` (as given and, on win32, with native separators), or undefined. */
function excludedBy(p: string, exclude: readonly string[], win: boolean, matches: (input: string, pattern: string) => boolean): string | undefined {
  const forms = win && p.includes("/") ? [p, p.replace(/\//g, "\\")] : [p];
  for (const form of forms) {
    const input = win ? form.toLowerCase() : form;
    const hit = exclude.find((pattern) => pattern.trim() !== "" && matches(input, win ? pattern.toLowerCase() : pattern));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The git part of {@link inspectCandidate}, in the canonical main worktree `real` whose `.git` directory was checked. */
async function inspectGit(real: string, deps: IdentityDeps, adm: AdmissionModule): Promise<string | CandidateIdentity> {
  const realpath = realpathOf(deps);
  const io = gitIo(deps, adm);
  // All five are hardened and bounded; run together, the whole inspection stays within one bound.
  const [top, common, roots, origin, head] = await Promise.all([
    settle(() => io.showToplevel(real)),
    settle(() => io.commonDir(real)),
    settle(() => io.rootCommits(real)),
    settle(() => io.origin(real)),
    settle(() => io.headInfo(real)),
  ]);
  if (top === undefined) return "is not a repository git can read (git rev-parse --show-toplevel failed or timed out)";
  if (!samePlace(top, real, realpath)) return `is not the top level of its git repository (git names ${displaySafe(top)}); ${APPROVE_MAIN_WORKTREE}`;
  if (common === undefined) return "is not a repository git can read (git rev-parse --git-common-dir failed or timed out)";
  let commonReal: string;
  try {
    commonReal = realpath(common);
  } catch {
    return `has a git common dir that does not resolve (${displaySafe(common)}); ${APPROVE_MAIN_WORKTREE}`;
  }
  if (cmpForm(commonReal) !== cmpForm(path.join(real, ".git"))) {
    return `uses the git directory ${displaySafe(commonReal)}, not its own .git directory; ${APPROVE_MAIN_WORKTREE}`;
  }
  if (roots === undefined || roots.length === 0) return "has no commits yet, or git rev-list --max-parents=0 HEAD failed or timed out";
  if (head === undefined) return "has no HEAD commit git can report (git rev-parse HEAD failed or timed out)";
  return Object.freeze({
    path: real,
    commonDir: commonReal,
    roots: Object.freeze([...new Set(roots)].sort()),
    origin: sanitizeOrigin(origin),
    branch: head.branch === undefined ? "(detached)" : displaySafe(head.branch),
    head: displaySafe(head.head),
  });
}

/**
 * What git says about the candidate `text` (SD-P4-4, -8, -9): a problem phrase (to follow the path, as in "D:\x <problem>"), or
 * the identity of its canonical main worktree. Before any git call: {@link rootTextProblem} (admission.ts) on the text and on
 * the canonical form, `routing.repoExclude` on both, {@link protectedProblem}, the executor home (`executorHomeProblem`, git only
 * for an ancestor named like the executor home), and `<canonical>\.git` must be a local directory
 * (`lstat`: not a link, not a gitfile). Then hardened, bounded git: the canonical form must be the top level, its canonical common
 * dir must be `<canonical>\.git`, and it must have at least one commit. The git part is cached {@link INSPECT_CACHE_MS} per
 * canonical path (`deps.fresh` skips the cached result); the checks before it run every time. Never throws.
 */
export async function inspectCandidate(text: string, deps: InspectDeps = {}): Promise<string | CandidateIdentity> {
  try {
    const adm: AdmissionModule = admission;
    const platform = deps.platform ?? process.platform;
    const win = platform === "win32";
    const exclude = deps.exclude ?? [];
    const shown = text.trim();
    const textProblem = adm.rootTextProblem(shown, platform);
    if (textProblem !== undefined) return textProblem;
    const byText = excludedBy(shown, exclude, win, permissionMatches);
    if (byText !== undefined) return `is excluded by routing.repoExclude (${byText})`;
    let real: string;
    try {
      real = realpathOf(deps)(shown);
    } catch {
      return "does not resolve to an existing directory";
    }
    if (typeof real !== "string" || real === "") return "does not resolve to an existing directory";
    const realProblem = adm.rootTextProblem(real, platform);
    if (realProblem !== undefined) return `resolves to ${displaySafe(real)}, which ${realProblem}`;
    const byReal = excludedBy(real, exclude, win, permissionMatches);
    if (byReal !== undefined) return `resolves to ${displaySafe(real)}, which is excluded by routing.repoExclude (${byReal})`;
    const placed = protectedProblem(shown, real, deps.env);
    if (placed !== undefined) return placed;
    const executorHome = await executorHomeProblem(shown, real, deps);
    if (executorHome !== undefined) return executorHome;
    const gitDir = gitDirectoryProblem(real, deps);
    if (gitDir !== undefined) return gitDir;

    const now = (deps.now ?? Date.now)();
    const key = cmpForm(real);
    const hit = deps.fresh === true ? undefined : inspected.get(key);
    if (hit !== undefined && now >= hit.at && now - hit.at < INSPECT_CACHE_MS) return await hit.value;
    const value = inspectGit(real, deps, adm);
    remember(inspected, key, { at: now, value });
    return await value;
  } catch (e) {
    return `could not be inspected (${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * SD-P4-6: why `entry` no longer names the approved repository, as a phrase (to follow "the approved repository <path>"), or
 * undefined when it still does: `realpath(path)` is `path` (comparison form), `<path>\.git` is a local directory, git names
 * `path` as the top level, the canonical common dir is the stored one and the sorted root commits of `HEAD` are the stored ones.
 * The root commits are cached per (common dir, HEAD commit); pass cached `showToplevel` / `commonDir` for the 5 s caches. Never
 * throws.
 */
export async function verifyIdentity(entry: Pick<RepoApproval, "path" | "commonDir" | "roots">, deps: IdentityDeps = {}): Promise<string | undefined> {
  try {
    const adm: AdmissionModule = admission;
    const platform = deps.platform ?? process.platform;
    const textProblem = adm.rootTextProblem(entry.path, platform);
    if (textProblem !== undefined) return `has a path that ${textProblem}`;
    const realpath = realpathOf(deps);
    let real: string;
    try {
      real = realpath(entry.path);
    } catch {
      return "no longer resolves";
    }
    if (typeof real !== "string" || cmpForm(real) !== cmpForm(entry.path)) return `now resolves to ${displaySafe(String(real))}`;
    const gitDir = gitDirectoryProblem(entry.path, deps);
    if (gitDir !== undefined) return gitDir;
    const io = gitIo(deps, adm);
    const [top, common, head] = await Promise.all([
      settle(() => io.showToplevel(entry.path)),
      settle(() => io.commonDir(entry.path)),
      settle(() => io.headInfo(entry.path)),
    ]);
    if (top === undefined || !samePlace(top, entry.path, realpath)) return "is no longer the top level of a git repository (or git failed)";
    if (common === undefined) return "has no git common dir git can report (git failed or timed out)";
    let commonReal: string;
    try {
      commonReal = realpath(common);
    } catch {
      return "has a git common dir that does not resolve";
    }
    if (cmpForm(commonReal) !== cmpForm(entry.commonDir)) return `now uses the git directory ${displaySafe(commonReal)}, not ${entry.commonDir}`;
    if (head === undefined) return "has no HEAD commit git can report (git failed or timed out)";
    const key = `${cmpForm(commonReal)}\u0000${head.head}`;
    let roots = rootsByHead.get(key);
    if (roots === undefined) {
      const loaded = settle(() => io.rootCommits(entry.path));
      roots = loaded;
      remember(rootsByHead, key, loaded);
      // A failure is not reused.
      void loaded.then((value) => {
        if (value === undefined && rootsByHead.get(key) === loaded) rootsByHead.delete(key);
      });
    }
    const current = await roots;
    if (current === undefined) return "has root commits git cannot list (git rev-list --max-parents=0 HEAD failed or timed out)";
    if (!sameRoots(current, entry.roots)) {
      return "has other root commits than when it was approved (another repository at the same path, an orphan branch, a deepened clone or rewritten history)";
    }
    return undefined;
  } catch (e) {
    return `could not be verified (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** The approvals that apply now (no git): a valid store's entries with `now < expiresAt(entry, days)`. */
export function validApprovals(days: number, env: ApprovalsEnv = {}): readonly RepoApproval[] {
  const now = clock(env);
  return readApprovals(env).approvals.filter((entry) => isApprovalValid(entry, days, now));
}
