/**
 * `router_plan` (4.1.2): the orchestrator's tool for the plan executor. `createRouterPlanTool(runtime)` returns the tool
 * definition; Phase 5.1 registers it (v2 only). Every failure is a text answer: `execute` never throws.
 */
import { posix, win32 } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { ExecutorError, type CompileSummary, type ExecutorRuntime } from "./types.js";

/** The `action` values of `router_plan`. */
export const ROUTER_PLAN_ACTIONS = [
  "compile", "residue", "approve", "status", "ready", "add-tasks", "answer", "done",
  "pause", "resume", "abort", "land", "adopt", "gc", "export", "purge",
] as const;

export type RouterPlanAction = (typeof ROUTER_PLAN_ACTIONS)[number];

/** The arguments as the host schema describes them; `execute` still re-validates (strict) because it never trusts them. */
export interface RouterPlanArgs {
  action: RouterPlanAction;
  planId?: string;
  path?: string;
  phases?: string[];
  doneBefore?: string;
  text?: string;
  inboxId?: string;
  task?: string;
  /** status: true renders only the inbox section of the board. */
  inbox?: boolean;
}

/** The part of the host tool context this tool reads. */
export interface RouterPlanContext {
  sessionID?: string;
  /** The project directory of the session; a relative compile `path` is resolved against it (else `worktree`). */
  directory?: string;
  worktree?: string;
}

type ArgKey = Exclude<keyof RouterPlanArgs, "action">;

interface ActionSpec {
  required: readonly ArgKey[];
  optional: readonly ArgKey[];
}

/** Which arguments each action takes; anything else is refused (strict schema, 4.1.2.b). */
const ACTION_SPECS: Readonly<Record<RouterPlanAction, ActionSpec>> = {
  compile: { required: ["path"], optional: ["phases", "doneBefore"] },
  residue: { required: ["planId", "text"], optional: [] },
  approve: { required: ["planId"], optional: [] },
  status: { required: [], optional: ["planId", "inbox"] },
  ready: { required: ["planId"], optional: [] },
  "add-tasks": { required: ["planId", "text"], optional: [] },
  // Without planId: the running or paused plan of the calling session (`runtime.planLine`); `/plan answer <id> <text>`
  // names no plan unless `--plan <id>` is given.
  answer: { required: ["inboxId", "text"], optional: ["planId"] },
  done: { required: ["planId", "task"], optional: [] },
  pause: { required: ["planId"], optional: [] },
  resume: { required: ["planId"], optional: [] },
  abort: { required: ["planId"], optional: [] },
  land: { required: ["planId"], optional: [] },
  adopt: { required: ["planId"], optional: [] },
  gc: { required: [], optional: [] },
  export: { required: ["planId"], optional: [] },
  purge: { required: ["planId"], optional: [] },
};

const KNOWN_KEYS: ReadonlySet<string> = new Set(["action", "planId", "path", "phases", "doneBefore", "text", "inboxId", "task", "inbox"]);

const MAX_ID = 200;
const MAX_PATH = 4096;
const MAX_TEXT = 2_000_000;
const MAX_PHASES = 200;
const MAX_LIST = 12;
const MAX_STATUS = 40_000;
const MAX_ERROR = 600;

const PREFIX = "[router_plan]";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** A plan id names a ledger directory and the `omr/<planId>/` ref namespace: no separators, wildcards or whitespace. */
function validId(v: string): boolean {
  if (v.length === 0 || v.length > MAX_ID) return false;
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || c === 0x7f) return false;
    if (ch === "/" || ch === "\\" || ch === "*" || ch === "?") return false;
  }
  return true;
}

type Parsed =
  | { ok: true; action: RouterPlanAction; a: RouterPlanArgs }
  | { ok: false; error: string };

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error: `${PREFIX} ${error}` };
}

/** Strict validation: known keys only, the action's required fields present, every field of the right type and size. */
function parseArgs(raw: unknown): Parsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse(`arguments must be an object with an "action" (${ROUTER_PLAN_ACTIONS.join(", ")}); got ${typeName(raw)}.`);
  }
  const rec = raw as Record<string, unknown>;
  const action = rec.action;
  if (!isString(action)) {
    return refuse(`"action" is required and must be a string: one of ${ROUTER_PLAN_ACTIONS.join(", ")}.`);
  }
  if (!(ROUTER_PLAN_ACTIONS as readonly string[]).includes(action)) {
    return refuse(`unknown action "${oneLine(action, 40)}". Use one of: ${ROUTER_PLAN_ACTIONS.join(", ")}.`);
  }
  const act = action as RouterPlanAction;
  const spec = ACTION_SPECS[act];
  const allowed = new Set<string>(["action", ...spec.required, ...spec.optional]);
  const unknownKeys = Object.keys(rec).filter(k => rec[k] !== undefined && !allowed.has(k));
  if (unknownKeys.length > 0) {
    const kind = unknownKeys.every(k => KNOWN_KEYS.has(k)) ? "not used by" : "unknown for";
    const takes = [...spec.required, ...spec.optional];
    return refuse(
      `${unknownKeys.map(k => oneLine(k, 40)).join(", ")} ${kind} action=${act}` +
        `${takes.length > 0 ? ` (it takes: ${takes.join(", ")})` : " (it takes no arguments)"}.`,
    );
  }
  const missing = spec.required.filter(k => rec[k] === undefined || rec[k] === null);
  if (missing.length > 0) {
    return refuse(`action=${act} needs ${missing.join(", ")}.`);
  }
  const a: RouterPlanArgs = { action: act };
  const fields: ArgKey[] = [...spec.required, ...spec.optional];
  for (const k of fields) {
    const v = rec[k];
    if (v === undefined || v === null) continue;
    if (k === "phases") {
      if (!Array.isArray(v) || !v.every(isString)) return refuse(`phases must be an array of phase id strings; got ${typeName(v)}.`);
      const ids = v.map(s => s.trim());
      if (ids.length === 0 || ids.length > MAX_PHASES || ids.some(s => !validId(s))) {
        return refuse(`phases must hold 1-${MAX_PHASES} phase ids without whitespace or path separators.`);
      }
      a.phases = ids;
      continue;
    }
    if (k === "inbox") {
      if (typeof v !== "boolean") return refuse(`inbox must be a boolean; got ${typeName(v)}.`);
      a.inbox = v;
      continue;
    }
    if (!isString(v)) return refuse(`${k} must be a string; got ${typeName(v)}.`);
    if (k === "text") {
      if (v.trim().length === 0) return refuse("text must not be empty.");
      if (v.length > MAX_TEXT) return refuse(`text is too long (${v.length} chars, max ${MAX_TEXT}).`);
      a.text = v;
      continue;
    }
    const s = v.trim();
    if (s.length === 0) return refuse(`${k} must not be empty.`);
    if (k === "path") {
      if (s.length > MAX_PATH) return refuse(`path is too long (max ${MAX_PATH}).`);
      a.path = s;
    } else if (!validId(s)) {
      return refuse(`${k} must be 1-${MAX_ID} characters without whitespace, path separators or wildcards.`);
    } else {
      a[k] = s;
    }
  }
  return { ok: true, action: act, a };
}

// The board (runtime.ts renderBoard) starts with `Plan <planId> [<status>] <path>`; open inbox items follow an `Inbox:`
// line, each starting with two spaces; only `Metrics:` comes after them. Only these shapes are read here.
const BOARD_HEAD = /^Plan (\S+) \[[^\]]*\]/;

/** The plan id of a board's first line, or null when the board does not start with one. */
export function boardPlanId(board: string): string | null {
  const id = BOARD_HEAD.exec(board.split("\n", 1)[0] ?? "")?.[1];
  return id !== undefined && validId(id) ? id : null;
}

// `runtime.planLine` (runtime.ts) is `plan <planId>: <done>/<total> done, ...` for the session's running or paused plan, and
// null when it has none. It is the one runtime view that skips completed and aborted plans (QA-4.1-5).
const PLAN_LINE_HEAD = /^plan (\S+): \d+\/\d+ done, /;

/** The plan id of a `planLine`, or null when there is none (no running or paused plan in the session). */
export function planLinePlanId(line: string | null): string | null {
  if (line === null) return null;
  const id = PLAN_LINE_HEAD.exec(line)?.[1];
  return id !== undefined && validId(id) ? id : null;
}

/** The plan this session runs now (running or paused), or null. Never the oldest plan of the session (QA-4.1-5). */
function sessionPlanId(runtime: ExecutorRuntime, sessionID: string): string | null {
  return planLinePlanId(runtime.planLine(sessionID));
}

/**
 * The board's first line plus its inbox section, with how to answer an item. `--plan` appears in the `/plan answer` hint
 * unless the board is the session's running plan, the one `/plan answer` without `--plan` picks.
 */
function inboxSection(board: string, sessionPlan: string | null): string {
  const lines = board.split("\n");
  const head = lines[0] ?? "";
  const start = lines.indexOf("Inbox:");
  if (start === -1) return `${head}\nInbox: no open items.`;
  // Up to `Metrics:` so an item text with a line break stays whole; the count is of item lines (two-space indent).
  const end = lines.findIndex((l, i) => i > start && l.startsWith("Metrics: "));
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const count = section.filter(l => l.startsWith("  ")).length;
  const planId = boardPlanId(board);
  const flag = planId !== null && planId !== sessionPlan ? `--plan ${planId} ` : "";
  return [
    head,
    `Inbox (${count}):`,
    ...section,
    `Answer: /plan answer ${flag}<id> <text>` +
      ` (tool: router_plan action=answer${planId === null ? "" : ` planId=${planId}`} inboxId=<id> text=<answer>).`,
  ].join("\n");
}

function listIds(ids: readonly string[]): string {
  if (ids.length === 0) return "none";
  const head = ids.slice(0, MAX_LIST).join(", ");
  return ids.length > MAX_LIST ? `${head} (+${ids.length - MAX_LIST} more)` : head;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtSummary(planId: string, s: CompileSummary): string {
  const lines = [
    `plan ${planId}: ${s.tasks} tasks, ${s.phases} phases, ${s.edges} edges; work ${fmtDuration(s.workMs)}, ` +
      `critical path ${fmtDuration(s.criticalPathMs)}, width ${s.width}, expected makespan ${fmtDuration(s.expectedMakespanMs)}.`,
  ];
  if (s.manual.length > 0) lines.push(`manual tasks (${s.manual.length}): ${listIds(s.manual)} - you run these and report each with action=done.`);
  if (s.warnings.length > 0) {
    lines.push(`warnings (${s.warnings.length}):`);
    for (const w of s.warnings.slice(0, 5)) lines.push(`- ${oneLine(w, 200)}`);
    if (s.warnings.length > 5) lines.push(`- (+${s.warnings.length - 5} more)`);
  }
  return lines.join("\n");
}

/** What to do next after a refusal, by error code. */
function hint(code: string): string {
  switch (code) {
    // QA-4.1-16 (round 3): adopt is no way around the user's approval.
    case "E_NOT_OWNER": return "That plan belongs to another session; do not act on it. Adoption is only for a running or paused plan " +
      "whose owning session is gone: then action=adopt planId=<id> takes it over. A plan awaiting approval is never adopted: " +
      "the user approves it in its own session, or it is compiled again.";
    case "E_PLAN_STATE": return "The plan is not in a state that allows this; action=status shows its status.";
    case "E_LEDGER_NOT_FOUND": return "No such plan; action=status (without planId) shows the plan of this session.";
    case "E_INVALID_INPUT": return "Fix the input and call again.";
    case "E_COMPILE": return "Fix the plan file at the line named and call action=compile again.";
    case "E_CYCLE": return "Remove one dependency from the cycle.";
    case "E_RESIDUE": return "Re-dispatch the residue prompt, or fix the JSON, and call action=residue again.";
    case "E_LOCK_HELD": return "Another process holds this plan's lock; retry later or, once it is gone, use action=adopt for a running or paused plan (a plan awaiting approval is never adopted).";
    default: return "";
  }
}

function describeError(action: string, error: unknown): string {
  if (error instanceof ExecutorError || (error instanceof Error && error.name === "ExecutorError")) {
    const code = (error as { code?: unknown }).code;
    const c = isString(code) ? code : "E_UNKNOWN";
    const h = hint(c);
    return `${PREFIX} ${action} refused (${c}): ${oneLine(error.message, MAX_ERROR)}${h ? ` ${h}` : ""}`;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return `${PREFIX} ${action} failed: ${oneLine(msg, MAX_ERROR)}`;
}

/**
 * Options of the factory. `approve` reads the effective `executor.approve` setting (config can change; default "ask"); it is
 * read only by compile and residue, the two actions that can finish a draft, so a failing getter breaks nothing else.
 */
export interface RouterPlanToolOptions {
  approve?: () => "ask" | "auto";
}

/** The `ask` answer once a draft is complete: approval is the user's decision, never the model's (QA-4.1-1). */
export function askApprovalText(planId: string): string {
  // QA-4.1-16: the user's "run this plan" is already in the conversation, so it must not read as approval.
  return "status: awaiting-approval. Stop here. This plan is not approved. A request to compile or run it is not approval. " +
    `Call action=approve only when the user approves plan ${planId} after seeing this summary, or types /plan approve ${planId}.`;
}

/** After a draft is complete: `approve: auto` approves it at once (no stop), otherwise the user is asked to approve it. */
async function approveStep(runtime: ExecutorRuntime, planId: string, sessionID: string, auto: boolean): Promise<string> {
  if (!auto) return askApprovalText(planId);
  try {
    await runtime.approve(planId, sessionID);
  } catch (error) {
    return `status: awaiting-approval. ${describeError("auto-approve", error)} Call router_plan action=approve planId=${planId} when fixed.`;
  }
  return `status: approved and running (approve: auto). Next: router_plan action=status planId=${planId}; run manual tasks as they appear.`;
}

/**
 * The plan path as the compiler needs it (absolute): a relative `path` is resolved against the project directory of the
 * calling session (QA-4.1-6). Null when it is relative and no project directory is known, and for a drive-relative path
 * (`C:foo`), which Windows resolves against drive C's current directory, outside the project (QA-4.1-20).
 */
export function resolvePlanPath(p: string, baseDir: string | null): string | null {
  if (isAbsolutePlanPath(p)) return p;
  if (baseDir === null || DRIVE_RELATIVE.test(p)) return null;
  // The form of the base decides the path flavour, so the result does not depend on the platform the tests run on.
  return WINDOWS_ABSOLUTE.test(baseDir) ? win32.resolve(baseDir, p) : posix.resolve(baseDir, p);
}

// What the compiler takes as absolute (compile/index.ts isAbsolutePlanPath): a drive path, a UNC path or a POSIX path.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

/** A drive letter without a separator after it: `C:foo`, `C:` (QA-4.1-20). Never resolved against the project. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

function isAbsolutePlanPath(p: string): boolean {
  return WINDOWS_ABSOLUTE.test(p) || p.startsWith("/");
}

/** The project directory of the tool context: `directory`, else `worktree`; only an absolute one counts. */
function projectDir(ctx: RouterPlanContext | undefined): string | null {
  for (const v of [ctx?.directory, ctx?.worktree]) if (isString(v) && isAbsolutePlanPath(v)) return v;
  return null;
}

interface RunContext {
  sessionID: string;
  baseDir: string | null;
  /**
   * Reads `executor.approve`; called only where a draft can complete (compile, residue) and, through `approvalGuard`,
   * when status or ready shows a plan awaiting approval.
   */
  auto: () => boolean;
}

const AWAITING_APPROVAL_HEAD = /^Plan (\S+) \[awaiting-approval\]/;

/**
 * QA-4.1-16 (round 3): a model that comes back to a plan awaiting approval through status or ready (after a resume, a
 * compaction or an adopt) gets the same stop text as after compile. Empty unless the board head says
 * `[awaiting-approval]`; empty with `approve: auto`. A throwing getter counts as "ask": it never breaks status.
 */
function approvalGuard(board: string, rc: RunContext): string {
  const id = AWAITING_APPROVAL_HEAD.exec(board.split("\n", 1)[0] ?? "")?.[1];
  if (id === undefined || !validId(id)) return "";
  let auto = false;
  try {
    auto = rc.auto();
  } catch {
    auto = false;
  }
  return auto ? "" : `\n${askApprovalText(id)}`;
}

/** The board of `planId`, or "" when it cannot be read (ready then shows no guard, as before). */
async function boardOrEmpty(runtime: ExecutorRuntime, planId: string, sessionID: string): Promise<string> {
  try {
    return await runtime.status(planId, sessionID);
  } catch {
    return "";
  }
}

async function run(runtime: ExecutorRuntime, a: RouterPlanArgs, rc: RunContext): Promise<string> {
  // `planId` is present for every action that requires it (parseArgs); the empty fallbacks only satisfy the types.
  const planId = a.planId ?? "";
  const text = a.text ?? "";
  const sessionID = rc.sessionID;
  switch (a.action) {
    case "compile": {
      const path = resolvePlanPath(a.path ?? "", rc.baseDir);
      if (path === null) {
        const why = DRIVE_RELATIVE.test(a.path ?? "")
          ? "is relative to a drive's current directory, not to the project"
          : "is relative and the project directory is unknown";
        return `${PREFIX} action=compile refused: path "${oneLine(a.path ?? "", 200)}" ${why}; pass an absolute path.`;
      }
      const auto = rc.auto();
      const r = await runtime.compile({
        path,
        ...(a.phases !== undefined ? { phases: a.phases } : {}),
        ...(a.doneBefore !== undefined ? { doneBefore: a.doneBefore } : {}),
        sessionID,
      });
      if (r.residuePrompt !== null) {
        return [
          `${fmtSummary(r.planId, r.summary)}`,
          `status: awaiting-residue. Dispatch the prompt below to a subagent (architect role, or heavy tier), then call ` +
            `router_plan action=residue planId=${r.planId} text=<its complete JSON reply>.`,
          "--- residue prompt ---",
          r.residuePrompt,
        ].join("\n");
      }
      return `${fmtSummary(r.planId, r.summary)}\n${await approveStep(runtime, r.planId, sessionID, auto)}`;
    }
    case "residue": {
      const auto = rc.auto();
      const s = await runtime.residue(planId, text, sessionID);
      return `${fmtSummary(planId, s)}\nresidue merged. ${await approveStep(runtime, planId, sessionID, auto)}`;
    }
    case "approve":
      await runtime.approve(planId, sessionID);
      return `plan ${planId} approved and running. Next: router_plan action=status planId=${planId}; run manual tasks as they appear.`;
    case "status": {
      // Without planId: the session's running or paused plan; with none, the runtime's pick (a finished plan of the session).
      const current = sessionPlanId(runtime, sessionID);
      const board = await runtime.status(a.planId ?? current, sessionID);
      const out = a.inbox === true ? inboxSection(board, current) : board;
      // The stop text goes after any truncation, so it is never cut off.
      const shown = out.length > MAX_STATUS ? `${out.slice(0, MAX_STATUS)}\n... (status truncated at ${MAX_STATUS} chars)` : out;
      return `${shown}${approvalGuard(board, rc)}`;
    }
    case "ready": {
      const r = await runtime.ready(planId);
      const lines = [`plan ${planId} ready: launchable ${r.launchable.length} (${listIds(r.launchable)}); manual ${r.manual.length} (${listIds(r.manual)}).`];
      // `ready` does not carry the plan status; the board head does (a read-only call). Its failure only drops the guard.
      const guard = approvalGuard(await boardOrEmpty(runtime, planId, sessionID), rc);
      if (r.manual.length > 0 && guard === "") lines.push(`Run each manual task yourself, then report it: router_plan action=done planId=${planId} task=<id>.`);
      return `${lines.join("\n")}${guard}`;
    }
    case "add-tasks": {
      const r = await runtime.addTasks(planId, text, sessionID);
      const parts = [`plan ${planId}: added ${r.added.length} (${listIds(r.added)})`];
      if (r.reopened.length > 0) parts.push(`returned to pending ${r.reopened.length} (${listIds(r.reopened)})`);
      return `${parts.join("; ")}.`;
    }
    case "answer": {
      const target = a.planId ?? sessionPlanId(runtime, sessionID);
      if (target === null) {
        return `${PREFIX} action=answer refused: this session runs no plan now; pass planId (the user: /plan answer --plan <planId> <id> <text>).`;
      }
      await runtime.answer(target, a.inboxId ?? "", text, sessionID);
      return `plan ${target}: inbox ${a.inboxId ?? ""} answered.`;
    }
    case "done":
      await runtime.done(planId, a.task ?? "", sessionID);
      return `plan ${planId}: task ${a.task ?? ""} marked done.`;
    case "pause":
      await runtime.pause(planId, sessionID);
      return `plan ${planId} paused. No new task starts; running ones finish. Resume: router_plan action=resume planId=${planId}.`;
    case "resume":
      await runtime.resume(planId, sessionID);
      return `plan ${planId} resumed.`;
    case "abort":
      await runtime.abort(planId, sessionID);
      return `plan ${planId} aborted. Integrated work stays. Clean up: router_plan action=gc, or action=purge planId=${planId}.`;
    case "land":
      await runtime.land(planId, sessionID);
      return `plan ${planId}: landing requested. Check router_plan action=status planId=${planId}.`;
    case "adopt":
      await runtime.adopt(planId, sessionID);
      return `plan ${planId} adopted by this session; it resumes after your next router call. Check router_plan action=status planId=${planId}.`;
    case "gc": {
      const r = await runtime.gc();
      return `gc: removed ${r.removed.length} (${listIds(r.removed)}); reported ${r.reported.length} (${listIds(r.reported)}).` +
        `${r.reported.length > 0 ? " Reported slots were not removed; inspect them by hand." : ""}`;
    }
    case "export":
      return runtime.exportPlan(planId);
    case "purge":
      await runtime.purge(planId, sessionID);
      return `plan ${planId} purged: slots, omr/${planId}/ refs and ledger removed.`;
  }
}

/**
 * Validates `rawArgs`, calls the runtime and renders a compact answer. Never throws: validation failures and
 * `ExecutorError`s come back as text that names what to do next.
 */
export async function executeRouterPlan(
  runtime: ExecutorRuntime,
  rawArgs: unknown,
  ctx?: RouterPlanContext,
  opts?: RouterPlanToolOptions,
): Promise<string> {
  let action = "router_plan";
  try {
    const parsed = parseArgs(rawArgs);
    if (!parsed.ok) return parsed.error;
    action = `action=${parsed.action}`;
    const sessionID = isString(ctx?.sessionID) ? ctx.sessionID : "";
    if (sessionID.length === 0) return `${PREFIX} ${action} refused: no calling session; plans are owned by the session that runs them.`;
    // QA-4.1-10: the approve getter is read lazily, inside compile and residue only.
    const auto = (): boolean => opts?.approve?.() === "auto";
    return await run(runtime, parsed.a, { sessionID, baseDir: projectDir(ctx), auto });
  } catch (error) {
    return describeError(action, error);
  }
}

export function createRouterPlanTool(runtime: ExecutorRuntime, options?: RouterPlanToolOptions): ReturnType<typeof tool> {
  return tool({
    description:
      "Drive the plan executor. Actions: compile (path, phases?, doneBefore?) -> summary or a residue prompt to dispatch; " +
      "residue (planId, text = architect JSON); approve (planId; only after the user approves it after seeing its summary (a request to run it is not approval); " +
      "with approve: auto, compile and residue approve by itself); " +
      "status (planId?, inbox?); ready (planId); add-tasks (planId, text); " +
      "answer (planId?, inboxId, text; without planId: this session's running plan); done (planId, task; manual/preflight tasks only); pause|resume|abort|land|adopt (planId); " +
      "gc; export (planId); purge (planId; completed or aborted only). A plan owned by another session is refused.",
    args: {
      action: tool.schema.enum(ROUTER_PLAN_ACTIONS).describe("What to do."),
      planId: tool.schema.string().optional().describe("The plan id (printed by compile)."),
      path: tool.schema.string().optional().describe("compile: path of the plan file, absolute or relative to the project directory."),
      phases: tool.schema.array(tool.schema.string()).optional().describe("compile: only these phase ids."),
      doneBefore: tool.schema.string().optional().describe("compile: treat every phase before this id as done."),
      text: tool.schema.string().optional().describe("residue / add-tasks / answer: the JSON or answer text."),
      inboxId: tool.schema.string().optional().describe("answer: the inbox item id."),
      task: tool.schema.string().optional().describe("done: the task id."),
      inbox: tool.schema.boolean().optional().describe("status: true shows only the open inbox items."),
    },
    async execute(args: RouterPlanArgs, toolCtx?: RouterPlanContext): Promise<string> {
      return executeRouterPlan(runtime, args, toolCtx, options);
    },
  });
}
