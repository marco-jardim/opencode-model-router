/**
 * Phase 3.1.4: task expansion (the launch prompt of one plan task attempt).
 *
 * Design memo: docs/qa/critical-path-execution/phase-3.1.md M36 and §8 "expand.ts (3.1.4)".
 * Pure except `loadExpansionEnv`, which reads the worktree list and `core.longpaths` through the `GitRunner` seam.
 * The route line is re-serialized from whitelisted tokens; plan text never reaches it.
 */
import * as path from "node:path";
import { DETECTIONS, NEEDS, RISKS, SCOPES, TASK_CLASSES } from "../routing/classify/types";
import { slotEnvFor } from "./slots/env";
import {
  ABSOLUTE_PATH_PATTERN,
  ExecutorError,
  FINDINGS_FORMAT,
  formatLaunchPrompt,
  type GitRunner,
  type LedgerV1,
  type SlotLease,
  type TaskId,
  type TaskNode,
} from "./types";

/** What the expansion needs from git (M36): the repository's worktree paths and whether `core.longpaths` is on. */
export interface ExpansionEnv {
  worktrees: readonly string[];
  longPaths: boolean;
}

/**
 * Prefix sets of one expansion (M36). `mappable` prefixes are rewritten to `slot`; any other absolute path under an
 * `inRepo` prefix is unmappable and fails. Both are sorted longest first.
 */
export interface PathMap {
  mappable: readonly string[];
  inRepo: readonly string[];
  slot: string;
  longPaths: boolean;
}

/** Input of `expandTask`: one attempt `attempt` of `taskId`, with its durable nonce, its slot and the git environment. */
export interface ExpandInput {
  ledger: Readonly<LedgerV1>;
  taskId: TaskId;
  attempt: number;
  nonce: string;
  slot: SlotLease;
  env: ExpansionEnv;
}

/** The expansion: the full launch prompt, the re-serialized route line and the slot-relative check inputs. */
export interface ExpandedTask {
  prompt: string;
  routeLine: string;
  acceptance: string | null;
  verify: string | null;
  workRoot: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Absolute path prefixes (M36 "Prefixes" and "Matching")
// ---------------------------------------------------------------------------------------------------------------

/** Windows `MAX_PATH`: a longer path needs `core.longpaths` in the slot (M36). */
export const MAX_PATH_CHARS = 260;

const DRIVE_OR_UNC = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

/** A drive or UNC path: matched through `path.win32` and case-insensitively on every OS. */
function isWindowsPath(p: string): boolean {
  return DRIVE_OR_UNC.test(p);
}

/** Characters that end a path token in prose (none of them can be part of a Windows file name segment). */
const PATH_TERMINATORS = new Set([..." \t\r\n\f\v\"'`<>|*?:;,()[]{}"]);
/** Characters that end a token only when followed by a terminator or the end of the text (sentence punctuation). */
const TRAILING_PUNCTUATION = new Set([".", ","]);

function isSeparator(c: string | undefined): boolean {
  return c === "\\" || c === "/";
}

function isTerminator(c: string | undefined): boolean {
  return c === undefined || PATH_TERMINATORS.has(c);
}

/** True iff a prefix ending at `end` (exclusive) ends at a segment boundary of `text`. */
function atSegmentBoundary(text: string, end: number): boolean {
  const c = text[end];
  if (c === undefined || isSeparator(c) || isTerminator(c)) return true;
  return TRAILING_PUNCTUATION.has(c) && isTerminator(text[end + 1]);
}

/** True iff a path may start at `start`: not inside a word or another path. */
function atPathStart(text: string, start: number): boolean {
  if (start === 0) return true;
  const c = text[start - 1];
  return c !== undefined && !/[A-Za-z0-9._~$%\\/-]/.test(c);
}

/** The end (exclusive) of the path token that starts at `start`, without trailing sentence punctuation. */
function tokenEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && !isTerminator(text[end])) end++;
  while (end > start && TRAILING_PUNCTUATION.has(text[end - 1] ?? "")) end--;
  return end;
}

/**
 * The canonical form of a prefix: drive/UNC through `path.win32.normalize` (backslashes), POSIX through
 * `path.posix.normalize`; no trailing separator except at a root. Null for a relative or empty path.
 */
export function normalizePrefix(p: string): string | null {
  const s = p.trim();
  if (s === "" || !ABSOLUTE_PATH_PATTERN.test(s)) return null;
  if (isWindowsPath(s)) {
    const n = path.win32.normalize(s);
    const root = path.win32.parse(n).root;
    return n.length > root.length ? n.replace(/[\\/]+$/, "") : n;
  }
  const n = path.posix.normalize(s);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** Normalized, de-duplicated (case-insensitively for drive/UNC), longest first, ties in code-unit order. */
function prefixList(paths: Iterable<string>): string[] {
  const out = new Map<string, string>();
  for (const p of paths) {
    const n = normalizePrefix(p);
    if (n === null) continue;
    const key = isWindowsPath(n) ? n.toLowerCase() : n;
    if (!out.has(key)) out.set(key, n);
  }
  return [...out.values()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function foldWin(c: string): string {
  return c === "/" ? "\\" : c.toLowerCase();
}

/** True iff `prefix` (normalized) occurs in `text` at `start`, segment-bounded at its end. */
function prefixAt(text: string, start: number, prefix: string): boolean {
  if (start + prefix.length > text.length) return false;
  if (isWindowsPath(prefix)) {
    for (let k = 0; k < prefix.length; k++) {
      if (foldWin(text[start + k] ?? "") !== foldWin(prefix[k] ?? "")) return false;
    }
  } else if (text.startsWith(prefix, start) === false) {
    return false;
  }
  // A root prefix (`C:\`, `/`) already ends at a separator.
  return isSeparator(prefix[prefix.length - 1]) || atSegmentBoundary(text, start + prefix.length);
}

/** Throws the one error this module raises (M36): the expansion of this attempt cannot be launched. */
function fail(message: string, detail: Record<string, string | number | boolean | null> = {}): never {
  throw new ExecutorError("E_LAUNCH_TASK", message, detail);
}

/** The longest prefix of `prefixes` (already longest first) at `start`, or null. */
function matchPrefix(text: string, start: number, prefixes: readonly string[]): string | null {
  for (const p of prefixes) if (prefixAt(text, start, p)) return p;
  return null;
}

/**
 * Rewrites every absolute path under a `mappable` prefix to the same path under `map.slot` (M36). The prefix matches
 * at a segment boundary only, through `path.win32` and case-insensitively for drive/UNC paths on every OS,
 * case-sensitively for POSIX paths; the rest of the path is kept byte for byte. Any other path under an `inRepo`
 * prefix is unmappable. A rewritten drive/UNC path longer than `MAX_PATH_CHARS` needs `map.longPaths`.
 * Throws ExecutorError E_LAUNCH_TASK on an unmappable or too long path.
 */
export function rewriteAbsolutePaths(text: string, map: PathMap): string {
  const mappable = prefixList(map.mappable);
  const inRepo = prefixList([...map.inRepo, ...map.mappable]);
  const winSlot = isWindowsPath(map.slot);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const candidate = (isSeparator(c) || /[A-Za-z]/.test(c)) && atPathStart(text, i);
    const hit = candidate ? matchPrefix(text, i, mappable) : null;
    if (hit !== null) {
      const end = tokenEnd(text, i + hit.length);
      const sep = isSeparator(hit[hit.length - 1]) ? text[i + hit.length - 1] ?? "" : "";
      const rewritten = `${map.slot}${sep}${text.slice(i + hit.length, end)}`;
      if (winSlot && !map.longPaths && rewritten.length > MAX_PATH_CHARS) {
        fail(`path longer than ${MAX_PATH_CHARS} characters in the slot and core.longpaths is off`, {
          path: rewritten, length: rewritten.length,
        });
      }
      out += rewritten;
      i = end;
      continue;
    }
    if (candidate && matchPrefix(text, i, inRepo) !== null) {
      const inRepoHit = matchPrefix(text, i, inRepo) ?? "";
      fail("absolute path in the repository cannot be mapped into the slot", {
        path: text.slice(i, tokenEnd(text, i + inRepoHit.length)),
      });
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Git environment (the only I/O of this module, through the GitRunner seam)
// ---------------------------------------------------------------------------------------------------------------

function gitFailure(args: readonly string[], cwd: string, detail: string): never {
  throw new ExecutorError("E_GIT", `git ${args.join(" ")} failed`, { cwd, detail });
}

/**
 * Reads `git worktree list --porcelain` in `toplevel` (every listed path, in git's order, drive/UNC paths in
 * `path.win32` form) and `core.longpaths` as the slot sees it. A missing `core.longpaths` is false.
 * Throws ExecutorError E_GIT when git fails or exits non-zero (exit 1 of `git config --get` means "unset").
 */
export async function loadExpansionEnv(
  git: GitRunner,
  i: { toplevel: string; slotPath: string; timeoutMs: number },
): Promise<ExpansionEnv> {
  const listArgs = ["worktree", "list", "--porcelain"] as const;
  const list = await git.run(listArgs, { cwd: i.toplevel, timeoutMs: i.timeoutMs });
  if (list.code !== 0) gitFailure(listArgs, i.toplevel, list.stderr.trim() || `exit ${String(list.code)}`);
  const worktrees: string[] = [];
  for (const raw of list.stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length);
    const n = normalizePrefix(p);
    if (n !== null) worktrees.push(n);
  }
  const configArgs = ["config", "--bool", "--get", "core.longpaths"] as const;
  const config = await git.run(configArgs, { cwd: i.slotPath, timeoutMs: i.timeoutMs });
  if (config.code !== 0 && config.code !== 1) {
    gitFailure(configArgs, i.slotPath, config.stderr.trim() || `exit ${String(config.code)}`);
  }
  return { worktrees, longPaths: config.code === 0 && config.stdout.trim() === "true" };
}

// ---------------------------------------------------------------------------------------------------------------
// Route line (M36 "Route line"): re-serialized from whitelisted tokens, never concatenated from plan text
// ---------------------------------------------------------------------------------------------------------------

/** `root="D:\my dir"`: the reference grammar's only way to carry whitespace in a value (extracted before tokenising). */
const QUOTED_ROOT_RE = /\broot\s*=\s*"([^"]*)"/i;
/** `needs=shell, edit`: whitespace after a needs comma is not a separator (as in the reference grammar). */
const NEEDS_LIST_RE = /(\bneeds=[a-z_]*)((?:\s*,\s*[a-z_]+(?![a-z_]|\s*=))+)/gi;

const ROUTE_CLASSES: readonly string[] = TASK_CLASSES;
const ROUTE_RISKS: readonly string[] = RISKS;
const ROUTE_SCOPES: readonly string[] = SCOPES;
const ROUTE_NEEDS: readonly string[] = NEEDS;
const ROUTE_DS: readonly string[] = DETECTIONS;
const ROUTE_TIERS: readonly string[] = ["fast", "medium", "heavy"];
/** A token value: lowercase letters, digits and `_` only (no whitespace, `]`, `[`, `"`, newline or separator). */
const TOKEN_VALUE_RE = /^[a-z0-9_]+$/;
/** The whole route line, brackets included: no nested bracket and no line break inside. */
const ROUTE_LINE_SHAPE_RE = /^\[route(?:[ \t]+([^[\]\r\n]*))?\]$/i;
/**
 * A slot path usable as `root=`: drive-absolute or POSIX, no brackets, quotes, commas, semicolons, `..`, NUL, control
 * characters or line breaks. Plain spaces are allowed: such a path is sent quoted (`root="D:\my dir"`, QUOTED_ROOT_RE).
 */
const ROOT_VALUE_RE = /^(?:[A-Za-z]:[\\/]|\/(?![\\/]))[^\x00-\x1f\x7f[\]",;]*$/;
/** Whitespace (only plain spaces get past ROOT_VALUE_RE) in a slot path: the value is quoted. */
const ROOT_NEEDS_QUOTES_RE = /\s/;

function routeFail(reason: string, detail: Record<string, string | number | boolean | null> = {}): never {
  return fail(`route line cannot be rendered: ${reason}`, detail);
}

function isMemberOf(values: readonly string[], v: string): boolean {
  return values.includes(v);
}

/** The whitelisted fields of the task's own route line (the plan's `[route ...]`), never its raw text. */
interface RouteFields {
  cls: string | null;
  risk: string | null;
  scope: string | null;
  needs: string[];
  d: string | null;
  tier: string | null;
  pin: boolean | null;
}

function parseRouteFields(line: string): RouteFields {
  const f: RouteFields = { cls: null, risk: null, scope: null, needs: [], d: null, tier: null, pin: null };
  const trimmed = line.trim();
  if (trimmed === "") return f;
  const shape = ROUTE_LINE_SHAPE_RE.exec(trimmed);
  if (shape === null) routeFail("the task's route line is not one well-formed [route ...] line", { line: trimmed.slice(0, 80) });
  const body = (shape[1] ?? "")
    .replace(QUOTED_ROOT_RE, " ")
    .replace(/\s*=\s*/g, "=")
    .replace(NEEDS_LIST_RE, (_whole: string, head: string, tail: string) => head + tail.replace(/\s+/g, ""));
  const seen = new Set<string>();
  for (const token of body.split(/\s+/).filter((t) => t !== "")) {
    const eq = token.indexOf("=");
    const key = (eq === -1 ? token : token.slice(0, eq)).toLowerCase();
    const raw = eq === -1 ? null : token.slice(eq + 1).toLowerCase();
    if (seen.has(key)) routeFail(`duplicate field ${key}`);
    seen.add(key);
    if (key === "root" || key === "budget") continue; // replaced by the slot / not carried
    if (key === "pin") {
      if (raw === null || raw === "true" || raw === "yes" || raw === "1") f.pin = true;
      else if (raw === "false" || raw === "no" || raw === "0") f.pin = false;
      else routeFail("value of pin is outside its token pattern", { value: raw.slice(0, 40) });
      continue;
    }
    if (raw === null || (key !== "needs" && !TOKEN_VALUE_RE.test(raw))) {
      routeFail(`value of ${key} is outside its token pattern`, { key });
    }
    const value = raw ?? "";
    switch (key) {
      case "class": if (!isMemberOf(ROUTE_CLASSES, value)) routeFail("unknown class", { value: value.slice(0, 40) }); f.cls = value; break;
      case "risk": if (!isMemberOf(ROUTE_RISKS, value)) routeFail("unknown risk", { value: value.slice(0, 40) }); f.risk = value; break;
      case "scope": if (!isMemberOf(ROUTE_SCOPES, value)) routeFail("unknown scope", { value: value.slice(0, 40) }); f.scope = value; break;
      case "d": if (!isMemberOf(ROUTE_DS, value)) routeFail("unknown d", { value: value.slice(0, 40) }); f.d = value; break;
      case "tier": if (!isMemberOf(ROUTE_TIERS, value)) routeFail("unknown tier", { value: value.slice(0, 40) }); f.tier = value; break;
      case "needs":
        for (const n of value.split(",")) {
          if (!isMemberOf(ROUTE_NEEDS, n)) routeFail("unknown need", { value: n.slice(0, 40) });
          if (!f.needs.includes(n)) f.needs.push(n);
        }
        break;
      default: routeFail(`unknown field ${key.slice(0, 40)}`);
    }
  }
  return f;
}

/**
 * The route line sent with the attempt (M36): re-serialized from the whitelisted tokens class, risk, scope, needs, d,
 * `root=<slotPath>` (quoted when the path holds a space), tier and pin. `task.route.tier` and `task.route.pin` (`[tier:X]` gives `tier=X pin`) win over the
 * line's own `tier=`/`pin`. A value outside its token pattern, or holding whitespace, `]` or a line break, fails with
 * E_LAUNCH_TASK. The plan text (title, text, subtasks) is never read here.
 */
export function renderRouteLine(task: TaskNode, slotPath: string): string {
  if (!ROOT_VALUE_RE.test(slotPath) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(slotPath)) {
    routeFail("the slot path is not a usable root= value", { slotPath: slotPath.slice(0, 120) });
  }
  const f = parseRouteFields(task.route.line);
  const tier = task.route.tier ?? f.tier;
  if (tier !== null && !isMemberOf(ROUTE_TIERS, tier)) routeFail("unknown tier", { value: String(tier).slice(0, 40) });
  const pin = task.route.pin || f.pin === true;
  const parts: string[] = [];
  if (f.cls !== null) parts.push(`class=${f.cls}`);
  if (f.risk !== null) parts.push(`risk=${f.risk}`);
  if (f.scope !== null) parts.push(`scope=${f.scope}`);
  const needs = ROUTE_NEEDS.filter((n) => f.needs.includes(n));
  if (needs.length > 0) parts.push(`needs=${needs.join(",")}`);
  if (f.d !== null) parts.push(`d=${f.d}`);
  parts.push(ROOT_NEEDS_QUOTES_RE.test(slotPath) ? `root="${slotPath}"` : `root=${slotPath}`);
  if (tier !== null) parts.push(`tier=${tier}`);
  if (pin) parts.push("pin");
  return `[route ${parts.join(" ")}]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Task block (M36 "taskBlock order")
// ---------------------------------------------------------------------------------------------------------------

/** The three plan rules of 3.1.4, verbatim (M36 item 7). */
export const MUST_NOT_DO_RULES: readonly string[] = [
  "no AI attribution in code, comments or docs",
  "never run git",
  "write only the `Writes:` paths",
];

/** The qa instruction (M36 item 8): one json fenced block matching `FINDINGS_FORMAT`, the last block of the answer. */
export const FINDINGS_INSTRUCTION =
  "End your final answer with exactly one ```json fenced block whose content matches this JSON schema:\n" +
  JSON.stringify(FINDINGS_FORMAT);

/** Formatting rule of M36: line breaks become `\n` and trailing spaces/tabs are removed; nothing else changes. */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
}

/** `ENVIRONMENT` entries of the slot (M36 item 4): `slotEnvFor` entries sorted by key, then the PATH prefix, then unset names. */
function environmentLines(slot: SlotLease): string[] {
  const out = [`Working directory: ${slot.path}`, `Base commit: ${slot.commit}`];
  const env = slotEnvFor(slot.path);
  if (env === null) return out;
  for (const key of Object.keys(env.set).sort()) out.push(`${key}=${env.set[key] ?? ""}`);
  for (const dir of env.prependPath) out.push(`PATH prepend: ${dir}`);
  for (const name of [...env.unset].sort()) out.push(`unset: ${name}`);
  return out;
}

/**
 * The task block of one attempt (M36 "taskBlock order"). Plan text (title, text, subtasks, acceptance criteria) has
 * every in-repo absolute path rewritten through `map` first. `\n` only, no trailing spaces.
 */
export function renderTaskBlock(ledger: Readonly<LedgerV1>, task: TaskNode, slot: SlotLease, map: PathMap): string {
  void ledger;
  const rw = (s: string): string => rewriteAbsolutePaths(s, map);
  const out: string[] = [];
  out.push(`TASK ${task.id}: ${rw(task.title)}`);
  if (task.text.trim() !== "") out.push(rw(task.text));
  if (task.subtasks.length > 0) {
    out.push("", "SUBTASKS");
    task.subtasks.forEach((s, i) => out.push(`${i + 1}. ${rw(s)}`));
  }
  const list = (paths: readonly string[]): string => (paths.length === 0 ? "(none)" : paths.join(", "));
  out.push("", `Writes: ${list(task.footprint.writes)}`, `Reads: ${list(task.footprint.reads)}`);
  out.push("", "ENVIRONMENT", ...environmentLines(slot));
  if (task.acceptance !== null) {
    const criteria = acceptanceCriteria(rw(task.acceptance));
    if (criteria.length > 0) out.push("", "ACCEPTANCE", ...criteria.map((c) => `- ${c}`));
  }
  const latest = task.attempts[task.attempts.length - 1];
  if (latest !== undefined && latest.context.trim() !== "") out.push("", "ATTEMPT CONTEXT", rw(latest.context));
  out.push("", "MUST NOT DO", ...MUST_NOT_DO_RULES.map((r) => `- ${r}`));
  if (task.kind === "qa") out.push("", "FINDINGS FORMAT", FINDINGS_INSTRUCTION);
  return tidy(out.join("\n"));
}

/** The `criteria:` lines of an `[acceptance]` block as plain sentences (the machine checks are not shown to the child). */
function acceptanceCriteria(block: string): string[] {
  const out: string[] = [];
  for (const raw of block.split(/\r\n|\n|\r/)) {
    const m = /^\s*criteria\s*:\s*(.+?)\s*$/i.exec(raw);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** The prefix maps of one expansion (M36 "Prefixes"). */
function buildPathMap(ledger: Readonly<LedgerV1>, task: TaskNode, slot: SlotLease, env: ExpansionEnv): PathMap {
  const own = declaredRoot(task.route.line);
  const mappable = prefixList([...env.worktrees, ...(own === null ? [] : [own])]);
  const planRoots: string[] = [];
  for (const t of Object.values(ledger.tasks)) {
    const r = declaredRoot(t.route.line);
    if (r !== null) planRoots.push(r);
  }
  const inRepo = prefixList([...mappable, ledger.repo.toplevel, ...planRoots]);
  return { mappable, inRepo, slot: slot.path, longPaths: env.longPaths };
}

/** The `root=` of a route line (quoted or bare), or null. Only used to build prefix sets; never re-emitted. */
function declaredRoot(line: string): string | null {
  const q = QUOTED_ROOT_RE.exec(line);
  if (q?.[1] !== undefined) return q[1];
  const m = /\broot\s*=\s*([^\s\]]+)/i.exec(line);
  return m?.[1] === undefined ? null : m[1].replace(/[,;]+$/, "");
}

/**
 * Expands attempt `attempt` of `taskId` (M36). Deterministic: the same input gives the same bytes; a different attempt
 * gives a different header line. The one input outside `ExpandInput` is the ENVIRONMENT block, which reads the
 * process-wide slot registry through `slotEnvFor(slot.path)` (it resolves real paths): the bytes are stable for a given
 * slot registration, and change if the slot's environment registration does. Throws ExecutorError E_LAUNCH_TASK for an unknown task, an unmappable or too long path, or a
 * route line that cannot be re-serialized.
 */
export function expandTask(i: ExpandInput): ExpandedTask {
  const task = Object.prototype.hasOwnProperty.call(i.ledger.tasks, i.taskId) ? i.ledger.tasks[i.taskId] : undefined;
  if (task === undefined) fail("task is not in the ledger", { taskId: i.taskId });
  const map = buildPathMap(i.ledger, task, i.slot, i.env);
  const routeLine = renderRouteLine(task, i.slot.path);
  const taskBlock = renderTaskBlock(i.ledger, task, i.slot, map);
  const prompt = formatLaunchPrompt(
    i.ledger.sharedContext,
    { planId: i.ledger.planId, taskId: i.taskId, attempt: i.attempt, nonce: i.nonce },
    taskBlock,
  );
  return {
    prompt,
    routeLine,
    acceptance: task.acceptance === null ? null : rewriteAbsolutePaths(task.acceptance, map),
    verify: task.verify === "none" ? null : task.verify,
    workRoot: i.slot.path,
  };
}

export type { LedgerV1, TaskId, TaskNode };
