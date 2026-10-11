import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { SystemPart } from "@opencode/ai";
import type { V2Runtime } from "./v2-client";
import { V2_GRADER_AGENT } from "./v2-client";
import { DEPTH_BANNER, TASK_VERIFICATION } from "./child-session";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { loadConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { DEFER_MISSING_SUBAGENT_NOTICE, HOST_SEED_AGENTS, resolveSubagentOverrides } from "../router/subagents";
import { warnAgentOptionsEffortOnce } from "../router/agent-options";
import { pluginAgentMarker } from "../router/plugin-agents";
import { registerRoleAgents, roleAgentAlias, roleAgentOf, roleAgentSteps } from "../router/role-agents";
import { stripDelegateInstructions } from "../router/instructions";
import { createPluginLogger } from "../router/logger";
import { budgetClaimObserved, GRADER_SYSTEM } from "../verify/checker";
import { EXECUTION_END_TYPES, FLUSH_EVENT_TYPES, NOOP_INGEST } from "../routing/outcomes/ingest";
import type { Ingest } from "../routing/outcomes/ingest";
import { createEngineRuntime } from "../routing/wire/runtime";
import {
  annotateSubagentResult, childSessionOf, createDispatchRouter, forgetRoutedRole, gitWorktreeList, normalizeRootText, parseWorktreeList,
  roleMaxActions, routedRoleOf, takeSubagentAnnotations,
} from "../routing/wire/dispatch";
import type { RouterConfig } from "../router/config";
import { resolveRoles, type AuthorityAction, type RoleSpec } from "../router/roles";
import {
  BINDING_NOTES, bind, currentBinding, evict as evictBinding, evictCall, type Binding, type SessionLookup,
} from "../routing/roles/binding";
import type { DispatchGrant } from "../routing/roles/policy";
import {
  AUTHORITY_TEXT, AUTHORITY_TOOL_NAME, consumeAuthority, discardAuthority, evictAuthority, markAnnotated, previewAuthority, quoteChildText,
  requestedAuthority, type AuthorityDeps,
} from "../routing/roles/authority";
import { budgetExhausted, type BudgetSnapshot } from "../guard/enforce";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../router/prompts";
import { parseReturnPrefix } from "../routing/outcomes/signals";
import { lookupDispatch } from "../router/sessions";
import { createSystemAugmenter } from "../routing/wire/hint";
import { createTurnStateRegistry, placeTurnState, ROUTER_TURN_STATE_ATTACH, TURN_STATE_ROOT, type TurnStateRegistry } from "./turn-state";
import { CONTEXT7_DOC_TOOLS, evaluatePermission, permissionMatches, permissionRules, publishReadOnlyPermissions } from "../router/read-only";
import { filterSensitiveGrep, isSensitivePath } from "../router/sensitive-paths";
import { canonicalAuthorityPath, insideWorkRoot } from "../routing/roles/work-root";
import { appliedEffort, appliedThinkingBudget, createEffortStore, registerEffortChannel } from "../tui/effort-channel";
import {
  acquireLeaseRegistry, attemptLabel, COMPLETION_SETTLE_MS, createCompletionProcessor, createHeldResults, createInFlightRegistry,
  createLeaseGuard, decideBackground, PENDING_GUARANTEES_TEXT, PROVIDER_ORDER, renderCompleted, renderHeld, renderInFlight,
  ROUTER_FINISH_ATTACH,
} from "./background";
import { acquireTimingRecorder, classifyCapacity } from "../routing/outcomes/timings";
import type { TimingRecorderHolder } from "../routing/outcomes/timings";
import { createSideLogs, durationSeamsFor, nodePersistDeps, resolveOutcomesDir } from "../routing/outcomes/persist";
import { homedir, tmpdir } from "node:os";
import { installGitSearchFilter, nearestRepository, repositoryIdentity } from "../router/git-tools";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRouting } from "../router/config";

/** 2.1.5.f: the plugin-root notice is logged once per process. */
let pluginRootLogged = false;
import { createDurationModel, DURATION_MIN_SAMPLES } from "../routing/outcomes/durations";
import type { DurationModel } from "../routing/outcomes/durations";
import type {
  Attempt, CompletionProcessor, FinishApi, FinishAttach, HeldResults, InFlightRegistry, InflightJournal, LeaseGuard, PersistedRecord,
} from "./background";

/** Translate the router's own v1 tool vocabulary at the v2 boundary. */
export function v2Instructions(text: string): string {
  return text
    .replace(/\bTask(?=\s*\()/g, "subagent")
    .replace(/\bTask (calls?|tool)\b/g, "subagent $1")
    .replace(/\btask tool\b/g, "subagent tool")
    .replace(/`task`/g, "`subagent`")
    .replace(/\bsubagent_type\b/g, "agent")
    .replace(/\btask_id\b/g, "sessionID");
}

type LegacyAgent = Record<string, any>;
type LegacyConfig = { agent: Record<string, LegacyAgent>; command: Record<string, any>; mcp?: Parameters<NonNullable<Hooks["config"]>>[0]["mcp"] };
type LegacyHook = (input: any, output: any) => Promise<void>;

function modelRef(value: string, variant?: string): any {
  const slash = value.indexOf("/");
  if (slash < 1) throw new Error(`[model-router] Invalid model reference: ${value}`);
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1), ...(variant ? { variant } : {}) };
}

function taskArgs(toolName: string, input: unknown): any {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;
  if (toolName === "subagent") return { ...args, subagent_type: args.agent, task_id: args.sessionID };
  if (toolName === "shell") return { ...args, cwd: args.workdir };
  if (["read", "write", "edit"].includes(toolName)) return { ...args, filePath: args.path };
  return input;
}

/**
 * `background` (#84 P-5, Phase 2.1 D1): the `background` key the router sets on a `subagent` call, from `decideBackground`
 * (`undefined` = no key). With `routing.background.mode: "off"` that is `verifying || roleRouted ? false : undefined`: a role
 * dispatch or a verifying call is forced to the foreground, so the router can annotate its result (budget, authority) in
 * `execute.after`. It never marks the call as verifying.
 */
function nativeArgs(toolName: string, args: any, original: any, background: boolean | undefined): any {
  if (!args || typeof args !== "object") return args;
  if (toolName === "subagent") {
    const { subagent_type, task_id, ...rest } = args;
    return { ...rest, agent: subagent_type, ...(task_id === undefined ? {} : { sessionID: task_id }), ...(background === undefined ? {} : { background }) };
  }
  if (toolName === "shell") { const { cwd, ...rest } = args; return { ...rest, ...(cwd === undefined ? {} : { workdir: cwd }) }; }
  if (["read", "write", "edit"].includes(toolName)) {
    const { filePath, ...rest } = args;
    return { ...rest, path: filePath === original?.filePath ? rest.path : filePath };
  }
  return args;
}

function legacyToolName(name: string): string { return name === "subagent" ? "task" : name === "shell" ? "bash" : name; }

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

/** Rewrite new router prose without changing retained source code or user text. */
function translateAdded(before: string, after: string): string {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  return after.slice(0, prefix) + v2Instructions(after.slice(prefix, after.length - suffix)) + after.slice(after.length - suffix);
}

// ---------------------------------------------------------------------------
// #84 P2.1 (T2.1.3, T2.1.4): role-dispatch helpers of the adapter. Roles mode on v2 only; tiers mode never reaches them.
// ---------------------------------------------------------------------------

/** The text of one session-context message: its `text`, else its text parts (`content` or `parts`) joined. */
function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m.text === "string") return m.text;
  const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : undefined;
  if (parts === undefined) return undefined;
  const texts = parts.flatMap((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
    && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Handoff 32: `SessionLookup.firstText` — the text parts of the session's first user message, joined (the binding reads the
 * nonce from its last line). A context without a user message falls back to its first message with text.
 */
export function firstMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const isUser = (m: unknown): boolean => !!m && typeof m === "object"
    && ((m as Record<string, unknown>).role === "user" || (m as Record<string, unknown>).type === "user");
  const user = messages.find(isUser);
  return user !== undefined ? messageText(user) : messages.map(messageText).find((text) => text !== undefined);
}

/**
 * T2.1.4 (P-5, S6): resume guidance appended to the parent's result when a role child was stopped before finishing — by the
 * router's guard on its call budget (`guard`), or by the host itself: its step limit or a context overflow (`host`, handoff 22).
 */
export function roleBudgetNotice(agent: string, childSessionID: string, cause: "guard" | "host" = "guard"): string {
  const what = cause === "guard" ? "its tool-call budget" : "the host's step or context limit";
  // P2.2 handoff: the roles protocol tells the orchestrator to resume on a note that starts with ROUTER_BUDGET_NOTE_PREFIX.
  return `${ROUTER_BUDGET_NOTE_PREFIX} @${agent} stopped on ${what} before finishing: this is not a failed result. `
    + `NEXT: resume the same sessionID ("${childSessionID}") with @${agent} and the prompt "continue and finish"; `
    + "do not start a new task and do not set `model` (the router keeps the child's tier).";
}

/**
 * QA-G-A3-4: a `[router` that starts a line — after blanks and markdown quote, list or emphasis marks, any case, blanks allowed
 * between `[` and `router`. The router's notes start a line with it; a child's text must not. QA-G-A3-2-3: the blanks are every
 * Unicode space separator (`\p{Zs}`: no-break, ideographic, em …), tab and the zero-width ones (U+200B–U+200D, U+2060, U+FEFF);
 * the marks include `+` and numbered list marks (`1.`, `12)`); the bracket may be the full-width `［` (U+FF3B).
 */
const ROUTER_LINE_START = /^((?:[\p{Zs}\t\u200b-\u200d\u2060\ufeff>*_#`+\-]|\d{1,9}[.)])*)[\[\uff3b](?=[\p{Zs}\t\u200b-\u200d\u2060\ufeff]*router\b)/gimu;

/** QA-G-A3-4: `text` with the `[` (or `［`) of every line-start `[router` turned into `(`; every other character kept. */
export function defangRouterLines(text: string): string {
  return text.replace(ROUTER_LINE_START, "$1(");
}

/**
 * QA-G-A3-4: a role dispatch's result with the child's text defanged ({@link defangRouterLines}) in every place the parent reads
 * it: the text parts of `content` (or a string `content`) and the structured `output` (a string, or its `output` string). Fields
 * the result does not have stay absent.
 */
export function defangChildResult<R extends { readonly content?: unknown; readonly output?: unknown }>(result: R): R {
  const part = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const p = value as { type?: unknown; text?: unknown };
    return p.type === "text" && typeof p.text === "string" ? { ...p, text: defangRouterLines(p.text) } : value;
  };
  const out: Record<string, unknown> = { ...result };
  if (Array.isArray(result.content)) out.content = result.content.map(part);
  else if (typeof result.content === "string") out.content = defangRouterLines(result.content);
  const output = result.output;
  if (typeof output === "string") out.output = defangRouterLines(output);
  else if (output !== null && typeof output === "object" && typeof (output as { output?: unknown }).output === "string") {
    out.output = { ...(output as Record<string, unknown>), output: defangRouterLines((output as { output: string }).output) };
  }
  return out as R;
}

// ---------------------------------------------------------------------------
// #84 P2.1 (handoff 22): the host's own budget stops of a child, from the event stream (spike S4)
// ---------------------------------------------------------------------------

/** A budget stop as handed to the signals: observed true/false, or not observable for this attempt. */
export type HostBudgetObservation = boolean | "unobserved";

/**
 * S4 (measured on 2.0.24): a tool call made on the last allowed step is answered by the host with this error
 * (`session.tool.failed`). Only a model that ignores the step's `tool_choice: none` makes such a call.
 */
export const HOST_STEP_LIMIT_TOOL_ERROR = /maximum agent steps/i;
/**
 * NOT measured (S4 covers step limits and guard denials only): how a context-overflow failure is recognised in a
 * `session.step.failed` / `session.execution.failed` error (`type` and `message`). A failure that matches nothing here makes the
 * attempt's host observation `unobserved`, never `false`.
 */
export const HOST_CONTEXT_OVERFLOW_ERROR = /context.?(?:overflow|length|window|limit)|prompt is too long|too many tokens|maximum context/i;

export interface HostBudgetObserver {
  /** A role child's attempt starts again (a resume): its counters start over. */
  begin(childSessionID: string): void;
  /** Every host event (only step/tool/execution events of a session are read). Never throws. */
  onEvent(type: string, data: unknown): void;
  /**
   * The host stopped the child's current attempt: `true` when it ran `stepLimit` steps (S4: the last of N allowed steps carries the
   * host's max-steps note and `tool_choice: none`), a tool call was refused for the step limit, or a step failed with a context
   * overflow; `false` when its execution ended without any of these and without an unrecognised failure; else `unobserved`.
   */
  observe(childSessionID: string, stepLimit: number | null): HostBudgetObservation;
  /** Resolves when the child's execution end was seen, or after `timeoutMs` (the event may trail the tool result). */
  settled(childSessionID: string, timeoutMs: number): Promise<void>;
  forget(sessionID: string): void;
}

/**
 * QA-G-A3-2 / QA-G-A3-2-4: a tool error that is a permission refusal — only by STRUCTURE, or by this adapter's own text:
 * - a `_tag`/`name` `Permission.<…>Error` (spike S4 (d): the tool hook sees `Permission.BlockedError` on a plugin `evaluate` deny),
 *   or a `type` `permission.rejected` (the tool state's error type), on the error or its cause (two levels);
 * - a message this adapter's `evaluate` hook wrote: `Permission denied by role agent …` / `… plugin agent …` / `… read-only agent …`.
 * Never free text alone: an OS error such as ripgrep's `Permission denied (os error 13)` is a failed call, not a refusal. The
 * adapter's own `execute.before` refusals (`[router] Refused …`) are not one either: they are counted where they are thrown.
 */
const PERMISSION_TAG = /^Permission\.[A-Za-z]*Error$/;
const PERMISSION_TYPE = "permission.rejected";
const ROUTER_PERMISSION_TEXT = /^Permission denied by (?:role|plugin|read-only) agent /;

export function isPermissionRefusal(error: unknown): boolean {
  const refusal = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") return ROUTER_PERMISSION_TEXT.test(value);
    if (value === null || typeof value !== "object" || depth > 2) return false;
    const e = value as Record<string, unknown>;
    if ([e._tag, e.name].some((tag) => typeof tag === "string" && PERMISSION_TAG.test(tag))) return true;
    if (e.type === PERMISSION_TYPE || e._tag === PERMISSION_TYPE) return true;
    if (typeof e.message === "string" && ROUTER_PERMISSION_TEXT.test(e.message)) return true;
    return ["error", "cause", "data"].some((key) => refusal(e[key], depth + 1));
  };
  return refusal(error, 0);
}

/** Q1 (P2.3 decision at the P2.1 call site): an authority request of a child whose binding is not exact is never applied. */
export const AUTHORITY_BINDING_UNKNOWN_DROP = `${AUTHORITY_TEXT.dropped.bindingUnknown}.`;

/** QA-P21-1-8: logged once when `routing.delegation` becomes `roles` while OpenCode runs in tiers mode. */
export const ROLES_RESTART_NOTICE =
  "roles mode (OpenCode v2 only): routing.delegation is now `roles`, but this OpenCode instance started in tiers mode; restart OpenCode to register the role agents and tools (tiers mode stays active until then)";

/** Bounded per-instance state (oldest child first out). */
export function createHostBudgetObserver(max = 1000): HostBudgetObserver {
  interface ChildState {
    steps: number;
    /** QA-P21-1-12: assistant messages already counted as a step (a retried step that keeps its message counts once). */
    stepMessages: Set<string>;
    toolLimit: boolean;
    failure: "overflow" | "other" | null;
    ended: boolean;
    waiters: Set<() => void>;
  }
  const children = new Map<string, ChildState>();
  /**
   * One host step. QA-P21-1-12: a step event that names an assistant message already counted (a provider retry that reuses its
   * message) is the same step and counts once. A retry under a NEW message id cannot be told apart from a new step on the event
   * stream (no retry marker): it counts again, which can only make the step-limit observation earlier, never miss one.
   */
  const countStep = (state: ChildState, event: Record<string, unknown>): void => {
    const message = event.assistantMessageID;
    if (typeof message === "string" && message !== "") {
      if (state.stepMessages.has(message)) return;
      state.stepMessages.add(message);
    }
    state.steps += 1;
  };
  const wake = (state: ChildState): void => {
    for (const waiter of [...state.waiters]) waiter();
    state.waiters.clear();
  };
  const stateOf = (id: string): ChildState => {
    let state = children.get(id);
    if (state === undefined) {
      state = { steps: 0, stepMessages: new Set(), toolLimit: false, failure: null, ended: false, waiters: new Set() };
      children.set(id, state);
      while (children.size > max) {
        const oldest = children.keys().next().value as string;
        const dropped = children.get(oldest);
        children.delete(oldest);
        if (dropped !== undefined) wake(dropped);
      }
    }
    return state;
  };
  const errorText = (error: unknown): string => {
    if (typeof error === "string") return error;
    if (!error || typeof error !== "object") return "";
    const e = error as Record<string, unknown>;
    // QA-P21-2 nit 1: a host error may carry its text one level down (`error.data.message`).
    const data = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>) : undefined;
    return [e.type, e.name, e.message, data?.message].filter((part) => typeof part === "string").join(" ");
  };
  const classify = (state: ChildState, error: unknown): void => {
    if (state.failure === "overflow") return;
    state.failure = HOST_CONTEXT_OVERFLOW_ERROR.test(errorText(error)) ? "overflow" : "other";
  };
  return {
    begin(id) {
      const old = children.get(id);
      children.delete(id);
      if (old !== undefined) wake(old);
      stateOf(id);
    },
    onEvent(type, data) {
      if (!data || typeof data !== "object") return;
      const event = data as Record<string, unknown>;
      const id = event.sessionID;
      if (typeof id !== "string" || id === "") return;
      // QA-P21-1-12: the error text is read from `error` (type/name/message) and from the event's own `message` field.
      const failureOf = (): string => [errorText(event.error), typeof event.message === "string" ? event.message : ""].filter(Boolean).join(" ");
      if (type === "session.step.ended") {
        countStep(stateOf(id), event);
      } else if (type === "session.step.failed") {
        const state = stateOf(id);
        countStep(state, event);
        classify(state, failureOf());
      } else if (type === "session.tool.failed") {
        if (HOST_STEP_LIMIT_TOOL_ERROR.test(failureOf())) stateOf(id).toolLimit = true;
      } else if (EXECUTION_END_TYPES.has(type)) {
        const state = stateOf(id);
        if (type === "session.execution.failed" && (event.error !== undefined || typeof event.message === "string")) classify(state, failureOf());
        state.ended = true;
        wake(state);
      }
    },
    observe(id, stepLimit) {
      const state = children.get(id);
      if (state === undefined) return "unobserved";
      if (state.toolLimit || state.failure === "overflow" || (stepLimit !== null && stepLimit > 0 && state.steps >= stepLimit)) return true;
      return !state.ended || state.failure === "other" ? "unobserved" : false;
    },
    settled(id, timeoutMs) {
      const state = stateOf(id);
      if (state.ended || !(timeoutMs > 0)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          state.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        timer.unref?.();
        state.waiters.add(done);
      });
    },
    forget(id) {
      const state = children.get(id);
      children.delete(id);
      if (state !== undefined) wake(state);
    },
  };
}

/**
 * Handoffs 34 and 37: the parent's annotation when a role child stopped with `ESCALATE: authority` after recording a request
 * (`router_request_authority`). The child's reasons are quoted as data, never as instructions.
 */
export function roleAuthorityNotice(agent: string, childSessionID: string, actions: readonly string[], reasons: readonly string[]): string {
  const why = reasons.length > 0 ? ` Reasons: ${reasons.map(quoteChildText).join("; ")}.` : "";
  return `[router] @${agent} asked for more authority: ${actions.join(", ")}.${why} `
    + `NEXT: if the task needs it, resume the same sessionID ("${childSessionID}") with @${agent} to continue with the wider grant `
    + "(the router recomputes the tier floor; do not set `model`); otherwise dispatch the role the reply names.";
}

// ---------------------------------------------------------------------------
// #84 P2.3 (T2.3.1, T2.3.2): per-session authority of role agents (plan §2.2, §2.5, §2.8 I3/I5/I9; spikes S3, S8, S11;
// amendments P-3, P-12, P-13, P-17). The agent's MAX policy (registration, P2.1) bounds every child of a role; these helpers
// narrow ONE session to its dispatch grant. They only ever remove: an action the max policy refuses is refused before them.
// ---------------------------------------------------------------------------

/**
 * The role action a host permission action or tool name stands for (§2.2): `read`, `glob`, `grep`, `edit`, `webfetch`,
 * `websearch` and `router_run` as named; `write`, `patch`, `multiedit`, `apply_patch` are `edit`; every `router_git_*` is
 * `router_git`; every `context7_*` is `context7`; `external_directory` is its own class (a path check, local class). Anything else
 * (`execute`, `shell`, `subagent`, todo tools, MCP tools, …) stands for no role action: never granted to a role session.
 */
export function roleActionOf(name: string): AuthorityAction | "external_directory" | undefined {
  switch (name) {
    case "read": case "glob": case "grep": case "edit": case "webfetch": case "websearch": case "router_run":
      return name;
    case "write": case "patch": case "multiedit": case "apply_patch":
      return "edit";
    case "external_directory":
      return "external_directory";
    default:
      if (name.startsWith("router_git_")) return "router_git";
      if (name.startsWith("context7_")) return "context7";
      return undefined;
  }
}

// #84 P3.3 (QA-P33F1-1-2): the work-root containment rule lives in routing/roles/work-root.ts, shared with the verifier.
export { canonicalAuthorityPath, insideWorkRoot };

/**
 * QA-P23-A3: every path an `apply_patch` (`patch`) call touches, from the headers of the host's patch format (OpenCode v2
 * `Patch.parse`: `*** Add File:`, `*** Update File:`, `*** Delete File:` and the `*** Move to:` that follows an update; a header
 * with leading blanks counts too). Undefined — the caller refuses — when a header names no path or no header is found (a unified
 * diff, which the v2 host's tool does not take, therefore refuses).
 */
export function patchPaths(patchText: string): string[] | undefined {
  const paths: string[] = [];
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.trimStart();
    const header = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"].find((prefix) => line.startsWith(prefix));
    if (header === undefined) continue;
    const path = line.slice(header.length).trim();
    if (path === "") return undefined;
    paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * QA-P23-A9: a `glob` pattern or `grep` `include` glob that could reach outside the search root by itself — absolute,
 * drive-qualified (`C:…`), UNC/device (`\\…`, `//…`) or with a `..` segment. Residual (documented): links inside the work root
 * are followed or not by the host's own search (ripgrep), which the router does not see.
 */
export function unsafeSearchPattern(pattern: string): boolean {
  const text = pattern.trim();
  return /^[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(text);
}

/**
 * QA-P23-A2/A3: every path a role session's own `read`/`write`/`edit`/`apply_patch` call names — each string among `filePath`,
 * `path`, `file_path`, each `edits[]` entry's, and every path of a patch text. Undefined when the call names none, or a patch
 * cannot be read (the caller refuses).
 */
export function toolCallPaths(tool: string, args: unknown): string[] | undefined {
  const record = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
  const strings = (value: unknown): string[] => (typeof value === "string" && value.trim() !== "" ? [value] : []);
  const fields = (entry: Record<string, unknown>): string[] => [...strings(entry.filePath), ...strings(entry.path), ...strings(entry.file_path)];
  const paths = [...fields(record)];
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) if (edit !== null && typeof edit === "object") paths.push(...fields(edit as Record<string, unknown>));
  }
  if (tool === "patch" || tool === "apply_patch") {
    const text = [record.patchText, record.patch_text, record.patch, record.input].find((value) => typeof value === "string");
    if (typeof text !== "string") return paths.length > 0 ? paths : undefined;
    const fromPatch = patchPaths(text);
    if (fromPatch === undefined) return undefined;
    paths.push(...fromPatch);
  }
  return paths.length > 0 ? paths : undefined;
}

/**
 * QA-G-A2-2: a path segment that names git's metadata entry `.git` — compared case-insensitively (win32, and stricter
 * elsewhere), with the trailing dots and spaces win32 drops and an NTFS `:stream` suffix removed (`.git.`, `.GIT`,
 * `.git::$INDEX_ALLOCATION` all name `.git` there).
 */
function gitMetadataSegment(segment: string): boolean {
  return segment.replace(/:.*$/s, "").replace(/[. ]+$/, "").toLowerCase() === ".git";
}

/**
 * QA-G-A2-2: an edit of `path` (canonical `target`, inside `root`) would write `.git` or anything below it — the work root's own
 * repository pointer (a file in a linked worktree) or metadata (config, hooks, `commondir`), or a nested repository's. Such an
 * edit could redirect router_git_* (and the work-root guards) to another repository or a network path. Checked on the canonical
 * path below the root (a link or junction that resolves into `.git` counts, 8.3 spellings never reach here) and on every segment
 * of the path as written.
 */
export function editsGitMetadata(path: string, target: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, "");
  const below = target.length > base.length ? target.slice(base.length) : "";
  return [path, below].some((text) => text.split(/[\\/]/).some(gitMetadataSegment));
}

/** The decision for one role-session action: allowed, or refused with the reason the child sees. */
export type RoleAuthorityDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const ALLOW: RoleAuthorityDecision = Object.freeze({ allow: true });
const refuse = (reason: string): RoleAuthorityDecision => ({ allow: false, reason });

export interface RoleAuthorityInput {
  /** The host permission action (`event.action`) or the tool name (`execute.before`). */
  readonly action: string;
  /** The paths the action touches (read/edit files, glob/grep search roots, `external_directory` `<dir>/*` resources). */
  readonly paths: readonly string[];
  /** The child's binding ∩ its role max (binding.ts view). */
  readonly binding: Pick<Binding, "kind" | "grant">;
  /** The role is dynamic: `router_request_authority` is part of its catalog (ladder, §2.5). */
  readonly dynamic: boolean;
  /** Base of relative paths: the child session's directory (what the host resolves them against). */
  readonly sessionDirectory: string;
  /** Canonical long form of the plugin's own directory: the work root of a grant without one (`workRoot: null`, I9). */
  readonly fallbackRoot: string | undefined;
  readonly canonical?: (path: string, base: string) => string | undefined;
  /** `glob` patterns / `grep` include globs of the call (QA-P23-A9): refused when {@link unsafeSearchPattern}. */
  readonly patterns?: readonly string[];
  /**
   * QA-P23-2-A1: canonical paths of THIS session's own truncated tool outputs (the host's tool-output store): `read` and `grep`
   * of exactly these files — and, for an exact binding, `external_directory` of their directory — are allowed outside the work
   * root. Never `edit`, `glob` or anything else.
   */
  readonly ownOutputs?: ReadonlySet<string>;
}

/** The shape of a tool-output store file: `<data>/tool-output/tool_<id>` (`MANAGED_DIRECTORY`, `tool_${Identifier.ascending()}`). */
const TOOL_OUTPUT_FILE = /[\\/]tool-output[\\/]tool_[A-Za-z0-9_-]+$/;
/** The host's tool-output `external_directory` rule (`path.join(Global.Path.data, "tool-output", "*")`). */
const TOOL_OUTPUT_GLOB = /[\\/]tool-output[\\/]\*$/;

/**
 * QA-P23-3-1: the host's tool-success event — the only source of a session's own truncated outputs (its structured
 * `outputPaths`). OpenCode source (`packages/schema/src/session-event.ts` `SessionEvent.Tool.Success`, published by
 * `session/runner/publish-llm-event.ts` with the `outputPaths` of `ToolOutputStore.bound`, `tool/registry.ts`):
 * `session.next.tool.success`, versioned `.<n>` when published; the plugin protocol the router builds against (2.0.22) names it
 * `session.tool.success`. Exactly these names; no other event, and never text in a tool result, makes an output a session's own.
 */
export const HOST_TOOL_SUCCESS_EVENT = /^session\.(?:next\.)?tool\.success(?:\.\d+)?$/;

/** `target` (canonical) is exactly one of the session's own truncated outputs (win32 case folding, the max policy's matcher). */
function ownOutput(target: string, outputs: ReadonlySet<string> | undefined): boolean {
  if (outputs === undefined) return false;
  for (const file of outputs) if (permissionMatches(target, file)) return true;
  return false;
}

/** `dir` (canonical) is the directory of one of the session's own truncated outputs. */
function ownOutputDirectory(dir: string, outputs: ReadonlySet<string> | undefined): boolean {
  if (outputs === undefined) return false;
  for (const file of outputs) if (permissionMatches(dir, file.replace(/[\\/][^\\/]+$/, ""))) return true;
  return false;
}

/**
 * §2.2 / QA-P23-A4 / QA-P23-2-A3: `root` is still a worktree of `git worktree list --porcelain` (prunable entries dropped by
 * `parseWorktreeList`) whose `.git` still has a worktree's shape — a linked worktree's is a file; the main worktree's (the first
 * entry) a directory, or a file for a submodule's main checkout.
 */
export function listedWorktreeRoot(
  porcelain: string,
  root: string,
  opts: { realpath?: (path: string) => string; gitEntry?: (path: string) => "file" | "directory" | undefined } = {},
): boolean {
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  const gitEntry = opts.gitEntry ?? ((p: string) => {
    try {
      const stat = statSync(p);
      return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
    } catch {
      return undefined;
    }
  });
  const want = normalizeRootText(root);
  for (const [index, entry] of parseWorktreeList(porcelain).entries()) {
    let real: string | undefined;
    try {
      real = realpath(entry);
    } catch {
      real = undefined;
    }
    if (normalizeRootText(entry) !== want && (real === undefined || normalizeRootText(real) !== want)) continue;
    const kind = gitEntry(join(real ?? entry, ".git"));
    return index === 0 ? kind === "directory" || kind === "file" : kind === "file";
  }
  return false;
}

/**
 * T2.3.1 / T2.3.2: may this role session use `action` on `paths`? (plan §2.2, §2.5; I3, I5, I9; P-13)
 * - `execute` (Code Mode) never (R6/P-6: its inner calls are never evaluated); `router_request_authority` for dynamic roles only.
 * - an action outside every role class → refused; a role action outside the dispatch grant → refused (an unknown binding's grant
 *   is the role max ∩ local, binding.ts);
 * - `external_directory` (P-13): only an EXACT binding with a work root and a local action, every resource inside that root;
 *   an unknown binding or a grant without a root → refused (I9);
 * - path actions (`read`, `edit`, `glob`, `grep`): every path, canonical ({@link canonicalAuthorityPath}; case folded on win32),
 *   inside the bound work root — the plugin's directory when the grant has none, except for `edit`, which a grant without a work
 *   root never allows (QA-G-B-2); `read`/`edit` with no path refuse (QA-P23-A5);
 *   a `glob`/`grep` pattern that reaches outside its search root by itself refuses (QA-P23-A9); every edit tool refuses `.git`
 *   and everything below it ({@link editsGitMetadata}, QA-G-A2-2).
 */
export function roleAuthorityDecision(input: RoleAuthorityInput): RoleAuthorityDecision {
  const { action, binding } = input;
  const grant: DispatchGrant = binding.grant;
  if (action === "execute") return refuse("`execute` (Code Mode) is never available to a role agent");
  if (action === AUTHORITY_TOOL_NAME) {
    return input.dynamic ? ALLOW : refuse(`${AUTHORITY_TOOL_NAME} is only for dynamic roles`);
  }
  const canonical = input.canonical ?? ((path: string, base: string) => canonicalAuthorityPath(path, base));
  const cls = roleActionOf(action);
  if (cls === undefined) return refuse(`${action} is outside every role's authority`);
  if (cls === "external_directory") {
    if (binding.kind !== "exact") return refuse("external_directory: this session is not bound to its dispatch (binding unknown, I9)");
    const root = grant.workRoot;
    if (![...grant.actions].some((a) => a === "read" || a === "glob" || a === "grep" || a === "router_git")) {
      return refuse("external_directory: this dispatch grants no local action");
    }
    if (input.paths.length === 0) return refuse("external_directory: no path to check");
    // QA-P23-2-A1: the directory of the session's own truncated output, for `read`/`grep` of exactly those files.
    const outputs = grant.actions.has("read") || grant.actions.has("grep") ? input.ownOutputs : undefined;
    for (const resource of input.paths) {
      const dir = resource.replace(/[\\/]\*$/, "");
      const target = dir === "" ? undefined : canonical(dir, input.sessionDirectory);
      if (target !== undefined && root !== null && insideWorkRoot(target, root)) continue;
      if (target !== undefined && ownOutputDirectory(target, outputs)) continue;
      return refuse(root === null
        ? "external_directory: this dispatch has no work root (root=)"
        : `external_directory: ${resource} is outside this dispatch's work root ${root}`);
    }
    return ALLOW;
  }
  if (!grant.actions.has(cls)) return refuse(`${action} is not in this dispatch's grant (${[...grant.actions].join(", ") || "none"})`);
  if (cls === "read" || cls === "edit" || cls === "glob" || cls === "grep") {
    // QA-G-B-2 (R7 null-root contract, I3): an edit never falls back to the plugin's directory — without a bound work root it would
    // land in the base checkout. Only the local reads keep the fallback.
    if (cls === "edit" && grant.workRoot === null) return refuse(`${action}: this dispatch has no work root (root=)`);
    const root = grant.workRoot ?? input.fallbackRoot;
    if (root === undefined) return refuse(`${action}: no work root could be resolved`);
    if ((cls === "read" || cls === "edit") && input.paths.length === 0) return refuse(`${action}: no path to check`);
    for (const pattern of input.patterns ?? []) {
      if (unsafeSearchPattern(pattern)) return refuse(`${action}: the pattern ${pattern} reaches outside its search root (use a relative pattern and \`path\`)`);
    }
    for (const path of input.paths) {
      const target = canonical(path, input.sessionDirectory);
      if (target !== undefined && insideWorkRoot(target, root)) {
        if (cls === "edit" && editsGitMetadata(path, target, root)) {
          return refuse(`${action}: ${path} is repository metadata (\`.git\` or below it); a role never edits it`);
        }
        continue;
      }
      if (target !== undefined && (cls === "read" || cls === "grep") && ownOutput(target, input.ownOutputs)) continue; // QA-P23-2-A1
      return refuse(`${action}: ${path} is outside this dispatch's work root ${root} (use an absolute path inside it)`);
    }
  }
  return ALLOW;
}

/**
 * T2.3.2: a tool a role session keeps in its catalog — `execute` never (S8), `router_request_authority` for dynamic roles only
 * (also under an unknown binding: the ladder is how it asks), any other tool only when its role action is in the grant.
 */
export function roleToolKept(name: string, grant: Pick<DispatchGrant, "actions">, dynamic: boolean): boolean {
  if (name === "execute") return false;
  if (name === AUTHORITY_TOOL_NAME) return dynamic;
  const cls = roleActionOf(name);
  return cls !== undefined && cls !== "external_directory" && grant.actions.has(cls);
}

/** P-3: the parent's annotation when a role child's tool catalog could not be built for at least one of its steps. */
export function roleCatalogFailureNotice(agent: string, childSessionID: string): string {
  return `[router] @${agent} had no tools for at least one step; check that its result is grounded in tool output, otherwise dispatch `
    + `again (the router could not build its tool catalog for this dispatch: fail closed, session "${childSessionID}").`;
}

/**
 * Legacy agent-option aliases → the v2 per-turn keys (`reasoning_effort` → `reasoningEffort`, `reasoning_summary` →
 * `reasoningSummary`, `budget_tokens` → `thinking`); an explicit v2 key wins. Returns a copy: `options` is never modified.
 */
export function normalizeAgentOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { reasoning_effort, reasoning_summary, budget_tokens, ...rest } = options;
  const normalized: Record<string, unknown> = { ...rest };
  if (reasoning_effort !== undefined && normalized.reasoningEffort === undefined) normalized.reasoningEffort = reasoning_effort;
  if (reasoning_summary !== undefined && normalized.reasoningSummary === undefined) normalized.reasoningSummary = reasoning_summary;
  if (budget_tokens !== undefined && normalized.thinking === undefined) normalized.thinking = { type: "enabled", budgetTokens: budget_tokens };
  return normalized;
}

/** Register the existing router engine on the public OpenCode 2 domain APIs. */
/** One host completion element `<subagent sessionID="X" state="S">body</subagent>` in a message text (memo §4.4, C2). */
interface CompletionElement { child: string; state: "completed" | "error" | "cancelled"; body: string }
const COMPLETION_ELEMENT = /<subagent sessionID="([^"]+)" state="([^"]+)">([\s\S]*?)(?:<\/subagent>|$)/g;

/** The completion elements of a text part that STARTS with one (the host writes a completion as a whole message, C2). */
function completionElementsOf(text: string): CompletionElement[] {
  if (!text.startsWith("<subagent sessionID=\"")) return [];
  const found: CompletionElement[] = [];
  for (const m of text.matchAll(COMPLETION_ELEMENT)) {
    const state = m[2];
    if (state !== "completed" && state !== "error" && state !== "cancelled") continue;
    found.push({ child: m[1] ?? "", state, body: m[3] ?? "" });
  }
  return found;
}

/** Applies `defang` to the body of every `<subagent …>` element of a text (a pure rewrite; the element tags stay). */
function defangSubagentBodies(text: string, defang: (body: string) => string): string {
  if (!text.includes("<subagent sessionID=\"")) return text;
  return text.replace(COMPLETION_ELEMENT, (whole: string, child: string, state: string, body: string) => {
    const next = defang(body);
    if (next === body) return whole;
    return `<subagent sessionID="${child}" state="${state}">${next}${whole.endsWith("</subagent>") ? "</subagent>" : ""}`;
  });
}

/** Memo §12 (fail closed): replaces the body of every completion element whose child `isProcessed` rejects. Pure; the element tags stay. */
function redactUnprocessedElements(text: string, isProcessed: (child: string) => boolean): string {
  if (!text.includes("<subagent sessionID=\"")) return text;
  return text.replace(COMPLETION_ELEMENT, (whole: string, child: string, state: string) => {
    if (isProcessed(child)) return whole;
    const body = `[router] The result of session ${child} is withheld: the router could not restore its verification state.`;
    return `<subagent sessionID="${child}" state="${state}">${body}${whole.endsWith("</subagent>") ? "</subagent>" : ""}`;
  });
}

export async function registerV2Hooks(
  ctx: Context,
  hooks: Hooks,
  runtime?: Pick<V2Runtime, "withToolContext" | "applyChildSystem"> & Partial<Pick<V2Runtime, "dispose" | "forgetSession">>,
  /**
   * `ingest`: the plugin instance's telemetry ingest (M6, QA-2.1-7); without one the adapter ingests nothing.
   * `isBypassed`: the plugin's `/bypass` state (#84 P2.1: the role path's router-gate condition, S10/P-9).
   * `hostBudget`: the host-side budget observer (handoff 22); a private one when absent. `onHostBudget` receives its `observe`,
   * so the plugin's signals read the same observations (src/v2.ts).
   * `hostSettleMs`: how long a role dispatch's result waits for the child's execution-end event (default 500 ms).
   */
  options: {
    ingest?: Ingest; isBypassed?: () => boolean; hostBudget?: HostBudgetObserver; hostSettleMs?: number;
    onHostBudget?: (observe: (childSessionID: string, stepLimit: number | null) => HostBudgetObservation) => void;
    /**
     * QA-P21-1-3: the plugin's budget snapshot of a child (guard state AND the session store's read-only CAP state, the same
     * `captureBudget(child, readCapReached)` its signals read). Absent: the guard's `budgetExhausted` alone.
     */
    budgetSnapshot?: (childSessionID: string) => BudgetSnapshot;
    /** QA-P21-2-4: receives the adapter's "this role agent is registered" check, so the plugin's role runtime follows it. */
    onRoleLive?: (isLive: (agent: string) => boolean) => void;
    /** QA-P21-2 nit 3: `router_verify` is registered (index.ts `routerVerifyEnabled`); nothing is deferred otherwise. */
    routerVerifyEnabled?: () => boolean;
    /**
     * #84 P2.3 (§2.2): `git worktree list --porcelain` in a directory (stdout), for the fresh re-check of a sibling work root when
     * a role session's `external_directory` is evaluated. Default: `gitWorktreeList` (dispatch.ts).
     */
    listWorktrees?: (cwd: string) => Promise<string>;
    /** Role-agent registration (roles mode): the repository's worktree roots for the `external_directory` allow rules. Default: `listWorktrees` (role-agents.ts, a real `git worktree list`). */
    listRegistrationWorktrees?: (directory: string) => Promise<string[]>;
    /**
     * QA-G-A3-2: the plugin's count of a role child's call refused outside its guard (index.ts `recordRoleRefusal`): the router's
     * role-authority refusal here in `execute.before`, a host permission denial in `execute.after`. Returns the guard's text to
     * add to the refusal (its denied_cap stop or advisory banner), or undefined. Absent: refusals are not counted.
     */
    recordRefusal?: (sessionID: string, agent: string | undefined, tool: string, args: unknown) => string | undefined;
  } = {},
): Promise<() => Promise<void>> {
  // The old plugin surface uses separate mutable input/output bags. Keep those
  // casts confined to this adapter, rather than weakening the v2 event types.
  const legacy = hooks as unknown as Record<string, LegacyHook | undefined>;
  const registrations: Array<{ dispose(): Promise<void> }> = [];
  /** #90 P1.2: per session, what the context hook's `chat.params` bridge applied to the latest turn (the TUI's `effortOf`). */
  // One store per adapter instance, not module state: every instance of a location records the same turns; the last registration answers.
  const effortStore = createEffortStore();
  /**
   * #90 P1.2: records what a turn's request carries (read-only: `event.options` is normalised into a copy, never written), root and
   * child sessions alike. Only a non-empty string session id is recorded; a turn that cannot be read is forgotten, never left stale.
   */
  const recordEffortTurn = (event: SessionContext): void => {
    const sessionID: unknown = event.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return;
    try {
      const applied = normalizeAgentOptions(event.options);
      effortStore.record(sessionID, {
        effort: appliedEffort(applied, { providerID: event.model.providerID, modelID: event.model.id }),
        thinkingBudget: appliedThinkingBudget(applied), variant: event.model.variant,
        providerID: event.model.providerID, modelID: event.model.id, agent: event.agent, at: Date.now(),
      });
    } catch {
      effortStore.forget(sessionID);
    }
  };
  const abort = new AbortController();
  const verifyingCalls = new Set<string>();
  const depthBanners = new Map<string, string>();
  // M6 (2.1.3): child-session outcomes and costs reach the outcome store through the plugin instance's ingest, which
  // does nothing unless routing.engine != static (its settings are null otherwise: no bundle, no files).
  const ingestLogger = createPluginLogger();
  // Phase 1.2: the turn-state registry of this adapter instance. The legacy plugin registers its late/pending providers on it
  // through the attach hook; the system augmenter registers the route hint; `buildContext` places the tail (root sessions only).
  const turnState = createTurnStateRegistry({ logger: ingestLogger, translate: v2Instructions });
  const attachTurnState = (hooks as unknown as Record<PropertyKey, unknown>)[ROUTER_TURN_STATE_ATTACH];
  /** The plugin accepted the registry (its attach function returned `true`): only then does the tail carry the route hint. */
  let turnStateAttached = false;
  if (typeof attachTurnState === "function") {
    try {
      turnStateAttached = (attachTurnState as (registry: TurnStateRegistry) => unknown)(turnState) === true;
    } catch (error) {
      ingestLogger.warn("[router] turn state: the plugin could not attach the registry", { error: String(error) });
    }
  }
  let turnStateWarned = false;
  const warnTurnStateOnce = (error: unknown): void => {
    if (turnStateWarned) return;
    turnStateWarned = true;
    ingestLogger.warn("[router] turn state: the tail was not placed; the request goes on without it", { error: String(error) });
  };
  type ContextMessage = NonNullable<SessionContext["messages"]>[number];
  const tailMessage = (text: string): ContextMessage => ({ role: "user", content: [{ type: "text", text }] });
  const ingest: Ingest = options.ingest ?? NOOP_INGEST;
  // An ingestion error is logged and the loop carries on: it must never cost the router an event.
  const ingesting = async (what: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!abort.signal.aborted) ingestLogger.warn(`[router] telemetry ingestion: ${what} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // M7 (2.2): dispatch routing and the protocol/hint adaptation share one runtime; it touches nothing (no host call, no
  // store, no disk) while routing.engine is static, which is the default and what every config without a `routing` block is.
  const sessionOf = (sessionID: string): Promise<unknown> => ctx.session.get({ sessionID } as Parameters<typeof ctx.session.get>[0]);
  /**
   * QA-P21-1-8: this instance started in roles mode (set by the first agent build at setup). Role agents, role routing and the
   * role tools (index.ts registers them at start) exist only then; a switch to roles at runtime is refused with a notice
   * ("restart OpenCode"), and a switch back to tiers drops the role agents on the next build. Plan amendment R8.
   */
  let rolesStarted: boolean | undefined;
  /**
   * QA-P21-2-4: a role agent is live only when its registration succeeded (the agent map the transform publishes holds it as a
   * role agent). Set once the agent map exists; until then nothing is registered.
   */
  let registeredRole: (agent: string) => boolean = () => false;
  options.onRoleLive?.((agent) => rolesStarted === true && registeredRole(agent));
  const engine = createEngineRuntime({
    loadConfig: () => loadConfig(ctx.location.directory),
    listAgents: async () => (await ctx.agent.list()).data,
    listModels: async () => (await ctx.model.list({ location: { directory: ctx.location.directory } })).data,
    ...(ctx.generate === undefined ? {} : { generate: ctx.generate }),
    logger: ingestLogger,
  });
  const dispatchRouter = createDispatchRouter({
    runtime: engine, getSession: sessionOf, graderAgent: V2_GRADER_AGENT, directory: ctx.location.directory,
    logger: { warn: (message, extra) => ingestLogger.warn(message, extra), debug: (message, extra) => console.debug(message, extra ?? "") },
    ...(options.isBypassed === undefined ? {} : { isBypassed: () => options.isBypassed?.() === true }),
    // QA-P21-1-8 / QA-P21-2-4: started in roles mode AND this role agent's registration succeeded.
    rolesEnabled: (agent) => rolesStarted === true && registeredRole(agent),
    ...(options.routerVerifyEnabled === undefined ? {} : { routerVerifyEnabled: options.routerVerifyEnabled }),
  });
  // #84 P2.1: the role table of a config (empty in tiers mode, where every role branch below is skipped), cached per config object.
  // QA-P21-1-8: also empty unless this instance STARTED in roles mode (its role agents and tools are registered only then).
  const roleTables = new WeakMap<RouterConfig, ReadonlyMap<string, RoleSpec>>();
  const NO_ROLES: ReadonlyMap<string, RoleSpec> = new Map();
  const rolesOf = (cfg: RouterConfig): ReadonlyMap<string, RoleSpec> => {
    if (rolesStarted !== true) return NO_ROLES;
    let roles = roleTables.get(cfg);
    if (roles === undefined) {
      try {
        roles = resolveRoles(cfg, "v2");
      } catch (error) {
        roles = new Map();
        ingestLogger.warn("[router] roles: the role table could not be resolved; no role runtime for this config", { error: String(error) });
      }
      roleTables.set(cfg, roles);
    }
    // QA-P21-2-4: only the role agents whose registration succeeded are live.
    const live = [...roles].filter(([name]) => registeredRole(name));
    return live.length === roles.size ? roles : new Map(live);
  };
  const maxOfRoles = (roles: ReadonlyMap<string, RoleSpec>) => (agent: string) => roleMaxActions(roles.get(agent));
  /** Handoff 32: what the binding reads of a child session (parent, agent, title, first message text). */
  const bindingLookup: SessionLookup = async (id) => {
    const session = await ctx.session.get({ sessionID: id } as Parameters<typeof ctx.session.get>[0]) as unknown as Record<string, unknown>;
    let firstText: string | undefined;
    try {
      firstText = firstMessageText(await ctx.session.context({ sessionID: id } as Parameters<typeof ctx.session.context>[0]));
    } catch {
      firstText = undefined; // the title marker still binds
    }
    const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
    // QA-P23-2-B1: whether the session named an agent, for the context hook's "no binding" decision.
    lookupNamedAgent.delete(id);
    lookupNamedAgent.set(id, text(session.agent) !== undefined);
    while (lookupNamedAgent.size > 1000) lookupNamedAgent.delete(lookupNamedAgent.keys().next().value!);
    return {
      ...(text(session.parentID) === undefined ? {} : { parentID: text(session.parentID) }),
      ...(text(session.agent) === undefined ? {} : { agent: text(session.agent) }),
      ...(text(session.title) === undefined ? {} : { title: text(session.title) }),
      ...(firstText === undefined ? {} : { firstText }),
    };
  };
  /** QA-P23-2-B1: the last binding lookup of a session named an agent (bounded). */
  const lookupNamedAgent = new Map<string, boolean>();
  /** Handoff 22: the host's own stops of role children (step limit, context overflow), from the event stream. */
  const hostBudget = options.hostBudget ?? createHostBudgetObserver();
  options.onHostBudget?.((childSessionID, stepLimit) => hostBudget.observe(childSessionID, stepLimit));
  const hostSettleMs = options.hostSettleMs ?? 500;
  /** The host `steps` limit the router registers for a role agent (P-4); null for any other agent. */
  const hostStepLimitOf = (roles: ReadonlyMap<string, RoleSpec>, agent: string): number | null => {
    const spec = roles.get(agent);
    return spec === undefined ? null : roleAgentSteps(spec);
  };
  /** Handoff 36: the parent's last `subagent` call of each role child (the call a resume follows, `consumeAuthority` `afterCall`). */
  const lastCallOfChild = new Map<string, string>();
  const rememberLastCall = (child: string, callID: string): void => {
    lastCallOfChild.delete(child);
    lastCallOfChild.set(child, callID);
    while (lastCallOfChild.size > 1000) lastCallOfChild.delete(lastCallOfChild.keys().next().value!);
  };
  const authorityDeps = (roles: ReadonlyMap<string, RoleSpec>, fallbackAgent: string | undefined): AuthorityDeps => ({
    roleOf: (child) => roles.get(lookupDispatch(child)?.agent ?? fallbackAgent ?? ""),
    roles: () => roles,
    bindingOf: (child) => currentBinding(child, { maxOf: maxOfRoles(roles) }),
  });
  // -------------------------------------------------------------------------
  // #84 P2.3 (T2.3.1, T2.3.2): the per-session authority of a role session, shared by the evaluate, context and execute.before
  // hooks. Every view is the child's binding ∩ the role max of the agent the HOOK names ∩ the role max of the agent the child
  // was bound as (a session resumed under another role never gets the union).
  // -------------------------------------------------------------------------
  /**
   * Canonical long form of the plugin's directory: the work root of a grant without one (I9), for local reads only — never for
   * `edit` (QA-G-B-2); undefined when it does not resolve.
   * QA-P23-A11: only a resolved directory is cached; a failure is retried on the next call.
   */
  let pluginRoot: string | undefined;
  const fallbackRoot = (): string | undefined => {
    if (pluginRoot === undefined) {
      try {
        pluginRoot = realpathSync.native(ctx.location.directory);
      } catch {
        return undefined;
      }
    }
    return pluginRoot;
  };
  /**
   * The live role spec and the binding view of a role session; undefined when the role table has no live spec for `agent`.
   * `stored`: the decision is in the registry (QA-P23-B1/B2) — false when the session lookup failed or reported no parent/agent
   * (binding.ts does not cache those) or the session was deleted meanwhile.
   */
  const roleAuthorityOf = async (sessionID: string, agent: string): Promise<{ spec: RoleSpec; binding: Binding; stored: boolean } | undefined> => {
    const roles = rolesOf(loadConfig(ctx.location.directory));
    const spec = roles.get(agent);
    if (spec === undefined) return undefined;
    const own = roleMaxActions(spec) ?? [];
    const maxOf = (bound: string): AuthorityAction[] | undefined => {
      const boundMax = roleMaxActions(roles.get(bound));
      return boundMax === undefined ? undefined : boundMax.filter((action) => own.includes(action));
    };
    // P-2: lazy, at the first context build or permission evaluation (one decision per child, shared with execute.before).
    const binding = await bind(sessionID, bindingLookup, { maxOf });
    const stored = currentBinding(sessionID, { maxOf }) !== undefined;
    if (stored) dispatchRouter.noteBinding(sessionID, binding); // the observed kind (QA-P21-1-11), once per child; QA-P23-B2
    return { spec, binding, stored };
  };
  /**
   * QA-P23-A8: the role of a session the router knows as a role child — its dispatch record names a registered role agent, or the
   * binding registry holds a decision for it — whatever agent name a hook event carries (or lacks). Undefined otherwise.
   */
  const knownRoleSession = (sessionID: string): string | undefined => {
    const recorded = lookupDispatch(sessionID)?.agent;
    if (typeof recorded === "string" && registeredRole(recorded)) return recorded;
    return currentBinding(sessionID, { maxOf: () => [] }) !== undefined ? "(bound role session)" : undefined;
  };
  /** The directory the host resolves a session's relative paths against (its location), else the plugin's. */
  const sessionDirectoryOf = async (sessionID: string): Promise<string> => {
    const session = await ctx.session.get({ sessionID } as Parameters<typeof ctx.session.get>[0]) as unknown as { location?: { directory?: unknown } };
    const directory = session?.location?.directory;
    return typeof directory === "string" && directory !== "" ? directory : ctx.location.directory;
  };
  /**
   * §2.2: a sibling work root is re-checked against a fresh `git worktree list --porcelain` when `external_directory` is
   * evaluated (a removed worktree, or a plain directory created in its place, no longer counts). QA-P23-A4: `prunable` entries
   * never count (`parseWorktreeList`), and the listed root must still look like that worktree on disk — `<root>/.git` a directory
   * for the main worktree (the first entry), a file for a linked one. Cached 5 s per root; concurrent checks of one root share one
   * `git` run (QA-P23-A12); any failure → not listed (fail closed).
   */
  const listWorktreesOf = options.listWorktrees ?? gitWorktreeList;
  const worktreeChecks = new Map<string, { at: number; listed: Promise<boolean> }>();
  const checkWorktree = async (root: string): Promise<boolean> => {
    try {
      return listedWorktreeRoot(await listWorktreesOf(ctx.location.directory), root);
    } catch {
      return false;
    }
  };
  /**
   * QA-P23-2-A1 / QA-P23-3-1: per session, the canonical paths of its OWN truncated tool outputs — ONLY the structured
   * `outputPaths` the host puts on that session's own tool-success event ({@link HOST_TOOL_SUCCESS_EVENT}). Free text (a
   * truncation marker in a tool result, a file's content, a run's output) never makes a file a session's own. A path must have the
   * tool-output store's shape (`…/tool-output/tool_<id>`) before and after canonicalisation. Bounded (1000 sessions, 64 files each,
   * oldest first out); cleared on `session.deleted`.
   */
  const ownOutputs = new Map<string, Set<string>>();
  const rememberOutputs = (sessionID: unknown, paths: readonly string[]): void => {
    if (typeof sessionID !== "string" || sessionID === "" || paths.length === 0) return;
    for (const path of paths) {
      if (!(posix.isAbsolute(path) || win32.isAbsolute(path)) || !TOOL_OUTPUT_FILE.test(path) || /[*?\0]/.test(path)) continue;
      const canonical = canonicalAuthorityPath(path, path.replace(/[\\/][^\\/]+$/, ""));
      if (canonical === undefined || !TOOL_OUTPUT_FILE.test(canonical)) continue;
      const files = ownOutputs.get(sessionID) ?? new Set<string>();
      ownOutputs.delete(sessionID);
      files.delete(canonical);
      files.add(canonical);
      while (files.size > 64) files.delete(files.values().next().value!);
      ownOutputs.set(sessionID, files);
      while (ownOutputs.size > 1000) ownOutputs.delete(ownOutputs.keys().next().value!);
    }
  };
  const stillAWorktree = (root: string): Promise<boolean> => {
    const own = fallbackRoot();
    if (own !== undefined && normalizeRootText(own) === normalizeRootText(root)) return Promise.resolve(true);
    const cached = worktreeChecks.get(root);
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.listed;
    const listed = checkWorktree(root);
    worktreeChecks.delete(root);
    worktreeChecks.set(root, { at: Date.now(), listed });
    while (worktreeChecks.size > 64) worktreeChecks.delete(worktreeChecks.keys().next().value!);
    return listed;
  };
  /** QA-P23-A9: the `glob` pattern / `grep` include glob of a call, from the tool's input or the evaluated event. */
  const searchPatterns = (cls: ReturnType<typeof roleActionOf>, pattern: unknown, include: unknown): string[] => {
    const text = (value: unknown): string[] => (typeof value === "string" && value !== "" ? [value] : []);
    return cls === "glob" ? text(pattern) : cls === "grep" ? text(include) : [];
  };
  /**
   * T2.3.1: the reason a role session's permission request is refused, or undefined when its dispatch grants it. Paths
   * (OpenCode v2 host, `packages/core/src/tool`): the resources of `read`/`edit` (`write`, `apply_patch` assert `edit`) are
   * Location-relative or canonical absolute; `external_directory` resources are `<canonical dir>/*`. `glob`/`grep` resources are
   * their PATTERN, not a path, and the host asserts NO `external_directory` for them (QA-P23-N1): their search root comes from the
   * event's `metadata.path` (default `.`, the session's Location) and is checked here, and again from the call's own input in
   * `execute.before`.
   */
  const roleEvaluateRefusal = async (
    event: { sessionID: unknown; action: string; resources: readonly string[]; metadata?: Record<string, unknown> | undefined },
    agent: string,
  ): Promise<string | undefined> => {
    const sessionID = String(event.sessionID);
    const authority = await roleAuthorityOf(sessionID, agent);
    if (authority === undefined) return "the role table is unavailable (fail closed)";
    const cls = roleActionOf(event.action);
    const metadata = event.metadata !== null && typeof event.metadata === "object" ? event.metadata : undefined;
    const search = cls === "glob" || cls === "grep";
    const paths = cls === "read" || cls === "edit" || cls === "external_directory" ? event.resources
      : search && metadata !== undefined ? [typeof metadata.path === "string" && metadata.path !== "" ? metadata.path : "."] : [];
    const patterns = searchPatterns(cls, event.resources[0], metadata?.include);
    const decision = roleAuthorityDecision({
      action: event.action, paths, patterns, binding: authority.binding, dynamic: authority.spec.authority.mode === "dynamic",
      sessionDirectory: paths.length > 0 ? await sessionDirectoryOf(sessionID) : ctx.location.directory, fallbackRoot: fallbackRoot(),
      ownOutputs: ownOutputs.get(sessionID),
    });
    if (!decision.allow) return decision.reason;
    const root = authority.binding.grant.workRoot;
    if (cls === "external_directory" && root !== null && !(await stillAWorktree(root))) {
      return `external_directory: the work root ${root} is no longer a worktree listed by \`git worktree list --porcelain\``;
    }
    return undefined;
  };
  /**
   * T2.3.1 (P-12, S11): the `execute.before` side of EVERY tool call a role session makes — the tool's role action must be in the
   * grant and its paths inside the work root. Paths: every path a `read`/`write`/`edit`/`apply_patch` call names
   * ({@link toolCallPaths}: `filePath`, `path`, `file_path`, `edits[]`, patch headers; none → refused), the search root of
   * `glob`/`grep` (default: the session directory) and their pattern (QA-P23-A9). The only router check that fires for plugin tools
   * (`router_run`, `router_git_*`: no `evaluate`, S11) and for Code Mode `execute` (S8). A tool outside every role class —
   * `subagent` included — is refused here too (QA-P23-A7), whatever the agent's max policy or the parent's grants say.
   */
  const roleToolRefusal = async (event: { sessionID: unknown; tool: string }, args: any, agent: string): Promise<string | undefined> => {
    const cls = roleActionOf(event.tool);
    if (cls === undefined && event.tool !== "execute" && event.tool !== AUTHORITY_TOOL_NAME) return `${event.tool} is outside every role's authority`;
    const sessionID = String(event.sessionID);
    const authority = await roleAuthorityOf(sessionID, agent);
    if (authority === undefined) return "the role table is unavailable (fail closed)";
    const record = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
    const sessionDirectory = await sessionDirectoryOf(sessionID);
    let paths: string[] = [];
    if (cls === "read" || cls === "edit") {
      const named = toolCallPaths(event.tool, record);
      if (named === undefined) return `${event.tool}: no path to check (or a patch whose paths cannot be read)`;
      paths = named;
    } else if (cls === "glob" || cls === "grep") {
      paths = [typeof record.path === "string" && record.path !== "" ? record.path : sessionDirectory];
    }
    const decision = roleAuthorityDecision({
      action: event.tool, paths, patterns: searchPatterns(cls, record.pattern, record.include), binding: authority.binding,
      dynamic: authority.spec.authority.mode === "dynamic", sessionDirectory, fallbackRoot: fallbackRoot(), ownOutputs: ownOutputs.get(sessionID),
    });
    return decision.allow ? undefined : decision.reason;
  };
  /** P-3: role children whose catalog failure is already annotated for the parent's current call (cleared when it ends). */
  const catalogFailures = new Set<string>();
  // The augmenter keeps the hint in the tail only when the plugin accepted the registry; otherwise (stub or spread hooks, a failed
  // attach) nothing would render the tail's hint, so it takes the old system push.
  const systemAugmenter = createSystemAugmenter({
    runtime: engine, getSession: sessionOf, logger: ingestLogger, turnState: turnStateAttached ? turnState : undefined,
  });
  let eventTask: Promise<void> | undefined;
  let disposed = false;
  const within = <T>(context: ToolContext, operation: () => Promise<T>): Promise<T> =>
    runtime ? runtime.withToolContext(context, operation) : operation();
  const scopedArgs = async (event: { tool: string; input: unknown; sessionID: any }): Promise<any> => {
    const args = taskArgs(event.tool, event.input);
    if (["read", "write", "edit"].includes(event.tool) && typeof args?.filePath === "string" && !isAbsolute(args.filePath)) {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      args.filePath = resolve(session.location?.directory ?? ctx.location.directory, args.filePath);
    }
    return args;
  };
  const hookContext = (event: { sessionID: any; agent: any; messageID: any; id: any }): ToolContext => ({
    ...event, signal: abort.signal, progress: async () => {},
  });
  // ---------------------------------------------------------------------------------------------------------------------
  // Phase 2.1 startup (memo §4.1). Everything below is v2-only (this module is loaded by server.ts alone) and inert under
  // `routing.background.mode: "off"` + `routing.leases.mode: "off"` except the timing rows (telemetry, not visible to the user).
  // ---------------------------------------------------------------------------------------------------------------------
  const startRouting = resolveRouting(loadConfig(ctx.location.directory), "v2", ingestLogger);
  const outcomesDir = resolveOutcomesDir(startRouting.outcomes.path, { tmpdir: tmpdir(), homedir: homedir() });
  const nowMs = (): number => Date.now();
  /** Memo §4.1 step 3: the pending journal reload is awaited at most this long before the context hook registers (fail closed after, §12). */
  const PENDING_RELOAD_BOUND_MS = 5_000;
  /** Disposers run by `cleanup` (timers, shared registries, installed filters), in reverse order. */
  const bgDisposers: Array<() => void | Promise<void>> = [];
  /** 1.1: the timing recorder (whatever `routing.engine` is) and the duration model fed by its rows. */
  let timings: TimingRecorderHolder | undefined;
  let durations: DurationModel | undefined;
  try {
    const model = createDurationModel(durationSeamsFor(createSideLogs(outcomesDir, nodePersistDeps(ingestLogger)), nowMs));
    durations = model;
    void model.load(); // not awaited: until it loads, estimates are the prior (never selects a dispatch)
    const holder = acquireTimingRecorder({
      dir: outcomesDir, now: nowMs, logger: ingestLogger,
      onRow: (row) => { if (row.kind === "dispatch-timing") model.observe(row); },
    });
    timings = holder;
    bgDisposers.push(() => holder.release());
  } catch (error) {
    ingestLogger.warn("[router] timing: the recorder could not start; dispatch timings are not recorded", { error: String(error) });
  }
  /** Session kinds seen so far (bounded): `root` has no parent. A failed lookup is never cached (root semantics, memo §14.1). */
  const sessionKinds = new Map<string, "root" | "child">();
  const noteSessionKind = (sessionID: string, kind: "root" | "child"): void => {
    sessionKinds.delete(sessionID);
    sessionKinds.set(sessionID, kind);
    while (sessionKinds.size > 1000) sessionKinds.delete(sessionKinds.keys().next().value!);
  };
  const sessionKindOf = async (sessionID: string): Promise<"root" | "child"> => {
    const known = sessionKinds.get(sessionID);
    if (known !== undefined) return known;
    try {
      const session = await sessionOf(sessionID) as { parentID?: unknown } | undefined;
      const kind = typeof session?.parentID === "string" && session.parentID !== "" ? "child" : "root";
      noteSessionKind(sessionID, kind);
      return kind;
    } catch (error) {
      ingestLogger.warn("[router] leases: the session kind could not be read; treated as a root session", { error: String(error) });
      return "root";
    }
  };
  /**
   * The kind of a session WITHOUT a host call (`session.created` and the `prompt` hook record it): an unknown session is a root,
   * as in the lease guard (memo §14.1). The dispatch path must not add host calls (a static session stays silent, §1.2).
   */
  const knownKindOf = (sessionID: string): "root" | "child" => sessionKinds.get(sessionID) ?? "root";
  /** The in-flight registry and held results exist whatever the mode; they hold nothing until a background dispatch is acknowledged. */
  const bgMode = startRouting.background.mode;
  const inflight: InFlightRegistry = createInFlightRegistry({
    now: nowMs, logger: ingestLogger,
    onClosed: (attempt, cause) => { void closeAttempt?.(attempt, cause); },
  });
  let closeAttempt: ((attempt: Attempt, cause: string) => Promise<void>) | undefined;
  /**
   * ONE journal (memo §11): the plugin's `pending.jsonl` file journal, reached through the finish API once it is attached. The
   * in-memory set only answers `hasProcessed` before the attach (and when it fails: then nothing persists, fail-closed).
   */
  const processedKeys = new Set<string>();
  const journal: InflightJournal = {
    append: async (...args: Parameters<InflightJournal["append"]>): Promise<void> => {
      const record: PersistedRecord = args[0];
      if (record.kind === "processed") {
        // The processor writes `{callID, child}` (the attempt key is `child NUL callID`, memo §10).
        if (typeof record.key === "string") processedKeys.add(record.key);
        else if (typeof record.child === "string" && typeof record.callID === "string") processedKeys.add(`${record.child}\u0000${record.callID}`);
      }
      const shared = finishApi?.journal;
      if (shared !== undefined) await shared.append(...args);
    },
    hasProcessed: (key) => processedKeys.has(key) || finishApi?.journal?.hasProcessed(key) === true,
  };
  const syntheticRaw: unknown = Reflect.get(ctx.session, "synthetic");
  const syntheticOk = typeof syntheticRaw === "function";
  /** The held store, for the compaction hook registered before it exists. */
  let heldRef: HeldResults | undefined;
  /** Memo §4.4 step 5: the compaction hook runs the same matcher over the messages being summarised (C15). Registered only when mode ≠ off. */
  let compactionRegistered = false;
  if (bgMode !== "off") {
    try {
      registrations.push(await ctx.session.hook("compaction", async (event) => {
        const messages = event.messages;
        if (heldRef === undefined || !Array.isArray(messages)) return;
        const shaped = messages.map((source) => ({ source, parts: (source as { content?: unknown }).content }));
        adoptSession(String(event.sessionID));
        const result = heldRef.apply(String(event.sessionID), shaped);
        if (result === undefined) return;
        result.forEach((entry, index) => {
          if (entry.parts !== (entry.source as { content?: unknown }).content) {
            messages[index] = Object.assign(Object.create(Object.getPrototypeOf(entry.source)), entry.source, { content: entry.parts });
          }
        });
      }));
      compactionRegistered = true;
    } catch (error) {
      ingestLogger.warn("[router] background: the compaction hook could not be registered; held results are unavailable", { error: String(error) });
    }
  }
  const held: HeldResults = createHeldResults({
    synthetic: async (input) => { if (typeof syntheticRaw === "function") await Reflect.apply(syntheticRaw, ctx.session, [input]); },
    journal, available: syntheticOk && compactionRegistered, logger: ingestLogger,
  });
  heldRef = held;
  /** The legacy plugin's finish API (2.1.4). Absent (or `off`): no background processing, the guarantees behave as `off`. */
  let finishApi: FinishApi | undefined;
  /** Memo §12: the journal reload failed or timed out. Holding is off and every unprocessed `<subagent>` element is redacted. */
  let reloadFailed = false;
  /** Reloaded in-flight records (memo §11.3): dormant until this process sees the parent session. */
  const dormantInflight = new Map<string, PersistedRecord[]>();
  /** Set once the completion processor exists: recovers the adopted `inflight` records of a session. */
  let recoverInflight: ((sessionID: string) => void) | undefined;
  /** Background guarantees apply: mode ≠ off AND the finish API attached. Otherwise every code path below behaves as `off`. */
  const bgActive = (): boolean => bgMode !== "off" && finishApi !== undefined;
  /** `router_run` contamination notes from `execute.before`, appended in `execute.after` (bounded). */
  const runNotes = new Map<string, string>();
  /** 1.3: the process-wide lease registry and the guard over it (every v2 child; roots take none). */
  let leaseHandle: ReturnType<typeof acquireLeaseRegistry> | undefined;
  let leaseGuard: LeaseGuard | undefined;
  const holderLabel = (holderID: string): string => {
    const attempt = inflight.byChild(holderID);
    return attempt === undefined ? `session ${holderID}` : `${attemptLabel(attempt)} (session ${holderID})`;
  };
  if (startRouting.leases.mode === "enforce") {
    try {
      const snapshotPath = join(outcomesDir, "leases.json");
      const handle = acquireLeaseRegistry({
        runMode: startRouting.leases.run,
        seams: { realpath: (path) => realpathSync.native(path), repoKeyOf: repositoryIdentity, now: nowMs },
        snapshotPath, logger: ingestLogger,
      });
      leaseHandle = handle;
      bgDisposers.push(() => handle.release());
      try {
        handle.registry.restore(JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown, { dropCompleteHolders: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") ingestLogger.warn("[router] leases: the snapshot could not be restored", { error: String(error) });
      }
      leaseGuard = createLeaseGuard({
        registry: handle.registry, sessionKind: sessionKindOf, sessionDir: sessionDirectoryOf, gitRootOf: nearestRepository,
        holderLabel, planTaskOf: () => undefined, events: { onRelease: (cb) => handle.onRelease(cb) }, logger: ingestLogger, now: nowMs,
      });
      // `router_git_ls_files` searches: child sessions see no entry under edit by another holder (memo §15.1).
      bgDisposers.push(installGitSearchFilter(({ sessionID, root, paths }) => {
        if (sessionKinds.get(sessionID) !== "child") return { kept: paths };
        const tree = repositoryIdentity(root)?.tree ?? root;
        const absolute = paths.map((path) => join(root, path));
        const result = handle.registry.filterSearchResults({ holderID: sessionID, tree, isChild: true }, tree, absolute);
        if (result.omitted === 0 && result.invalid === undefined) return { kept: paths };
        const keptSet = new Set(result.kept);
        return {
          kept: paths.filter((_, index) => keptSet.has(absolute[index]!)),
          note: `[router] ${result.omitted} result(s) omitted: under edit by ${result.holders.map((h) => holderLabel(h.holderID)).join(", ")}.`,
        };
      }));
    } catch (error) {
      leaseGuard = undefined;
      ingestLogger.warn("[router] leases: the lease registry could not start; no lease checks", { error: String(error) });
    }
  }
  // Memo §4.1 steps 3-4: the finish API is attached once (with the lease gate when leases are enforced), then the pending journal
  // is reloaded, AWAITED with a 5 s bound before the context hook registers. A failure falls back to fail-closed redaction (§12).
  if (bgMode !== "off") {
    const attachFinish = (hooks as unknown as Record<PropertyKey, unknown>)[ROUTER_FINISH_ATTACH];
    if (typeof attachFinish === "function") {
      try {
        finishApi = (attachFinish as FinishAttach)({ host: "v2", held, ...(leaseGuard === undefined ? {} : { leaseGate: leaseGuard }) });
      } catch (error) {
        ingestLogger.warn("[router] background: the plugin could not attach the finish API; no background processing", { error: String(error) });
      }
    }
    if (finishApi !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          finishApi.reload(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pending journal reload timed out")), PENDING_RELOAD_BOUND_MS); }),
        ]);
      } catch (error) {
        reloadFailed = true;
        ingestLogger.warn("[router] background: the pending journal could not be reloaded; holding is off and unprocessed results are redacted", { error: String(error) });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
  /** Memo §11.3: the first sight of a parent session adopts its dormant records (claim file); idempotent per session. */
  const adoptedSessions = new Set<string>();
  const adoptSession = (sessionID: string): void => {
    if (finishApi === undefined || reloadFailed || adoptedSessions.has(sessionID)) return;
    adoptedSessions.add(sessionID);
    try {
      const adopted = finishApi.adopt(sessionID);
      if (adopted === undefined) return;
      if (adopted.holds.length > 0) held.restore(adopted.holds);
      if (adopted.inflight.length > 0) {
        dormantInflight.set(sessionID, [...adopted.inflight]);
        recoverInflight?.(sessionID);
      }
    } catch (error) {
      ingestLogger.warn("[router] background: the persisted records of a session could not be adopted", { sessionID, error: String(error) });
    }
  };
  // Sweeps on an unref'd 5-minute interval (memo §4.1): the timing recorder, the in-flight registry and the leases.
  const sweepTimer = setInterval(() => {
    try {
      if (timings !== undefined) void Promise.resolve(timings.sweep()).catch((error: unknown) => ingestLogger.warn("[router] timing: sweep failed", { error: String(error) }));
      for (const attempt of inflight.sweep(nowMs())) void closeAttempt?.(attempt, "sweep");
      leaseHandle?.registry.sweep();
    } catch (error) {
      ingestLogger.warn("[router] background: the periodic sweep failed", { error: String(error) });
    }
  }, 5 * 60_000);
  sweepTimer.unref?.();
  bgDisposers.push(() => clearInterval(sweepTimer));
  // 2.1.5.f: where the plugin runs from (QA records the sink). Logged once per process.
  if (!pluginRootLogged) {
    pluginRootLogged = true;
    try {
      // Debug level: a static, no-routing session stays silent on warn/info (§1.2); QA reads the debug sink.
      console.debug(`[router] plugin root ${realpathSync.native(join(fileURLToPath(new URL(".", import.meta.url)), "..", ".."))}`);
    } catch (error) {
      ingestLogger.warn("[router] plugin root could not be resolved", { error: String(error) });
    }
  }
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    for (const dispose of bgDisposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        ingestLogger.warn("[router] background: a disposer failed", { error: String(error) });
      }
    }
    await runtime?.dispose?.();
    // Before the event task: disposing releases a step handler that waits for the model catalog (QA-2.1-5).
    await ingest.dispose();
    dispatchRouter.dispose(); // this location no longer owns its sessions
    await engine.dispose();
    await eventTask;
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    await hooks.dispose?.();
  };

  try {
    // Captured once: after our own transform, ctx.agent.list() returns
    // router-modified agents, which would defeat the originals diff on refresh.
    const agents = await ctx.agent.list();
    const baseSeed: Record<string, LegacyAgent> = {};
    for (const agent of agents.data) baseSeed[agent.id] = {
      mode: agent.mode,
      model: agent.model && `${agent.model.providerID}/${agent.model.id}`,
      variant: agent.model?.variant,
    };
    let config: LegacyConfig = { agent: {}, command: {} };
    registeredRole = (agent) => roleAgentOf(config.agent[agent]) === agent; // QA-P21-2-4
    let originals = new Map<string, string>();
    let agentOptions = new Map<string, Record<string, unknown>>();
    const warnedPermissions = new Set<string>();
    const warnPermissionOnce = (message: string) => {
      if (warnedPermissions.has(message)) return;
      warnedPermissions.add(message);
      ingestLogger.warn(message);
    };
    const warnedRoles = new Set<string>();
    const warnRoleOnce = (key: string, message: string) => {
      if (warnedRoles.has(key)) return;
      warnedRoles.add(key);
      ingestLogger.warn(message);
    };
    // Plugin agents (#81) are protected like read-only tiers: readOnly ones and explicit-permission ones
    // (which start from `* deny`) both keep their own deny/ask rules against inherited session grants.
    // The config hook builds plugin agents in the v1 vocabulary (`bash`, `task`); the v2 host evaluates `shell`/`subagent`.
    const V2_ACTIONS: Readonly<Record<string, string>> = { bash: "shell", task: "subagent" };
    const v2Actions = (rules: ReturnType<typeof permissionRules>) => rules.map((rule) => ({ ...rule, action: V2_ACTIONS[rule.action] ?? rule.action }));
    const protectedAgent = (name: string | undefined) => name !== undefined
      && (config.agent[name]?.permission?.["*"] === "deny" || pluginAgentMarker(config.agent[name]) !== undefined);
    const agentLabel = (name: string | undefined): string => {
      const marker = name === undefined ? undefined : pluginAgentMarker(config.agent[name]);
      return marker !== undefined && !marker.readOnly ? "plugin agent" : "read-only agent";
    };
    // Host agents appear after setup (the host's config-agent plugin activates after the router). Names
    // the router created itself never count as host agents, or a tier would look like an existing one.
    const routerCreated = new Set<string>();
    let promptChecked = false;
    const pendingSubagentNames = (): string[] => {
      const routerConfig = loadConfig(ctx.location.directory);
      const tiers = getActiveTiers(routerConfig);
      return Object.keys(routerConfig.subagentTiers ?? {}).filter((name) =>
        !Object.hasOwn(tiers, name) && !Object.hasOwn(routerConfig.agents ?? {}, name) && !Object.hasOwn(baseSeed, name));
    };
    /** Adds host agents that appeared since setup to the seed; true when the seed grew. */
    const discoverHostAgents = async (): Promise<boolean> => {
      const pending = pendingSubagentNames();
      if (pending.length === 0) return false;
      let grew = false;
      for (const agent of (await ctx.agent.list()).data) {
        if (!pending.includes(agent.id) || routerCreated.has(agent.id) || Object.hasOwn(baseSeed, agent.id)) continue;
        baseSeed[agent.id] = {
          mode: agent.mode,
          model: agent.model && `${agent.model.providerID}/${agent.model.id}`,
          variant: agent.model?.variant,
        };
        grew = true;
      }
      return grew;
    };
    let lastConfig: unknown;
    // Returns the router config the registry state was built from; the caller
    // advances `lastConfig` only once the host registries have reloaded from it.
    const buildConfig = async (): Promise<unknown> => {
      const next: LegacyConfig = { agent: JSON.parse(JSON.stringify(baseSeed)), command: {} };
      const context7 = ctx.mcp && (await ctx.mcp.list()).data.some(server => server.name === "context7" && server.status.status !== "disabled");
      // Presence-only bridge input, never registered as an MCP definition.
      if (context7) next.mcp = { context7: { type: "local", command: [], enabled: true } };
      const nextOriginals = new Map(Object.entries(next.agent).map(([id, agent]) => [id, JSON.stringify(agent)]));
      // The "no such agent" notice for `subagentTiers` waits for the first prompt-time check (see the prompt hook).
      Object.defineProperty(next, DEFER_MISSING_SUBAGENT_NOTICE, { value: !promptChecked, enumerable: false });
      // Names in the setup seed are host built-in agents (not opencode.json entries the config hook can tell apart).
      Object.defineProperty(next, HOST_SEED_AGENTS, { value: new Set(Object.keys(baseSeed)), enumerable: false });
      await hooks.config?.(next);
      const routerConfig = loadConfig(ctx.location.directory);
      // #84 P2.1: the role agents (roles mode only; tiers mode returns at once). Built like plugin agents, so the transform
      // below publishes their max policy and protectedAgent() holds for each; fail closed (no role agent) on any error.
      // QA-P21-1-8: only when this instance STARTED in roles mode; a runtime switch to roles registers nothing (a restart does).
      const rolesRequested = routerConfig.routing?.delegation === "roles";
      rolesStarted ??= rolesRequested;
      if (rolesStarted) {
        const registration = await registerRoleAgents(next.agent, routerConfig, {
          context7: Boolean(context7), directory: ctx.location.directory, seed: baseSeed, warn: warnRoleOnce,
          ...(options.listRegistrationWorktrees ? { listWorktrees: options.listRegistrationWorktrees } : {}),
        });
        // #84 P2.3 (T2.3.3, §2.5): the ladder tool is a plugin tool, advertised to a deny-by-default agent only with an explicit
        // allow (S11 (a)); the router's catalog filter then keeps it for dynamic roles only. Fixed roles never get it.
        if (!registration.failed && registration.registered.length > 0) {
          let roleTable: ReadonlyMap<string, RoleSpec> = new Map();
          try {
            roleTable = resolveRoles(routerConfig, "v2");
          } catch {
            roleTable = new Map(); // no allow written: the role keeps no ladder (fail closed)
          }
          for (const name of registration.registered) {
            const definition = next.agent[name];
            if (roleTable.get(name)?.authority.mode !== "dynamic" || definition === undefined || roleAgentOf(definition) !== name) continue;
            const permission = definition.permission;
            if (permission !== null && typeof permission === "object") definition.permission = { ...permission, [AUTHORITY_TOOL_NAME]: "allow" };
          }
        }
      } else if (rolesRequested) {
        warnRoleOnce("roles:restart", ROLES_RESTART_NOTICE);
      }
      for (const name of Object.keys(next.agent)) if (!Object.hasOwn(baseSeed, name)) routerCreated.add(name);
      const nextOptions = new Map<string, Record<string, unknown>>();
      for (const [name, definition] of Object.entries(next.agent)) {
        if (nextOriginals.get(name) === JSON.stringify(definition) || !definition.options) continue;
        nextOptions.set(name, normalizeAgentOptions(definition.options));
      }
      config = next;
      originals = nextOriginals;
      agentOptions = nextOptions;
      return routerConfig;
    };
    lastConfig = await buildConfig();
    let refreshChain: Promise<void> = Promise.resolve();
    const refresh = (): Promise<void> => {
      const run = refreshChain.then(async () => {
        if (disposed) return;
        const built = await buildConfig();
        await ctx.agent.reload();
        await ctx.command.reload();
        // Only after both registries reloaded: a rejected reload leaves
        // `lastConfig` stale so the next prompt retries the refresh.
        lastConfig = built;
      });
      refreshChain = run.catch(() => {});
      return run;
    };
    registrations.push(await ctx.agent.transform((editor) => {
      if (runtime) editor.update(V2_GRADER_AGENT, (agent) => {
        agent.mode = "subagent";
        agent.hidden = true;
        agent.description = "Model router verification grader";
        agent.system = GRADER_SYSTEM;
      });
      for (const [name, definition] of Object.entries(config.agent)) {
        if (originals.get(name) === JSON.stringify(definition)) continue;
        editor.update(name, (agent) => {
          if (definition.model) agent.model = modelRef(definition.model, definition.variant);
          if (definition.mode) agent.mode = definition.mode;
          if (definition.description !== undefined) agent.description = definition.description;
          // A plugin agent's prompt is the user's own text: used verbatim, never rewritten for the host vocabulary.
          const marker = pluginAgentMarker(definition);
          if (definition.prompt !== undefined) agent.system = marker ? definition.prompt : v2Instructions(definition.prompt);
          if (definition.color !== undefined) agent.color = definition.color;
          if (definition.steps !== undefined) agent.steps = definition.steps;
          if (definition.permission) {
            const inherited = (agent.permissions ?? []) as ReturnType<typeof permissionRules>;
            let rules = marker ? v2Actions(permissionRules(definition.permission)) : permissionRules(definition.permission);
            // #84 QA-P23-2-A1: a reading role agent keeps the host's own tool-output directory rule (`<data>/tool-output/*`, host
            // plugin/agent.ts TRUNCATION_GLOB) so a child can read its truncated output; the router's evaluate hook narrows it to
            // the session's own files. Placed before the inherited denies, which still win.
            if (roleAgentOf(definition) === name && evaluatePermission(rules, "read", "x.ts") !== "deny") {
              const outputs = inherited.filter((rule) => rule.action === "external_directory" && rule.effect === "allow"
                && TOOL_OUTPUT_GLOB.test(rule.resource));
              rules = [...rules, ...outputs.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }))];
            }
            agent.permissions = publishReadOnlyPermissions(
              name, rules, inherited, warnPermissionOnce, { plugin: marker !== undefined },
            );
          }
        });
      }
    }));

    // Enforce the protected agent's own deny/ask without destroying inherited
    // grants: the same session can later resume as medium/heavy (P-R2-3).
    /** #84 P2.3: a registered role agent (its registration succeeded); every role agent is also a protected agent (P-19). */
    const roleAgentName = (name: unknown): string | undefined => (typeof name === "string" && registeredRole(name) ? name : undefined);
    registrations.push(await ctx.permission.hook("evaluate", async event => {
      let name: string | undefined = event.agent;
      let protectedKnown = protectedAgent(name);
      let role = roleAgentName(name);
      try {
        // An explicit event agent is authoritative, even when session lookup
        // would fail or still refers to the previous agent during a switch.
        name ??= (await ctx.session.get({ sessionID: event.sessionID })).agent;
        if (name === undefined) {
          // QA-P23-2-A2: neither the event nor the session names an agent — a session the router knows as a role child is denied.
          const known = knownRoleSession(String(event.sessionID));
          if (known !== undefined) {
            event.effect = "deny";
            event.message = `Permission denied by role agent ${known}: the session names no agent (fail closed)`;
            return;
          }
        }
        protectedKnown = protectedAgent(name);
        role = roleAgentName(name);
        if (!protectedKnown && role === undefined) return; // QA-P23-A10: every role agent is protected; never skip one
        const agent = (await ctx.agent.list()).data.find(agent => agent.id === name);
        const effects = agent ? event.resources.map(resource => evaluatePermission(agent.permissions, event.action, resource)) : ["deny"];
        if (effects.includes("deny")) {
          event.effect = "deny";
          event.message = `Permission denied by ${agentLabel(name)} ${name}: ${event.action}`;
        } else if (effects.includes("ask") && event.effect === "allow") {
          event.effect = "ask";
          event.message = `Approval required by ${agentLabel(name)} ${name}: ${event.action}`;
        }
        // #84 P2.3 (T2.3.1, P-13, I3/I9): a role session is narrowed to ITS dispatch grant and work root. Only ever a deny: an
        // action the max policy refused stays refused, a sensitive-read ask stays an ask when the grant covers it.
        if (role !== undefined && event.effect !== "deny") {
          const refusal = await roleEvaluateRefusal(event, role);
          if (refusal !== undefined) {
            event.effect = "deny";
            event.message = `Permission denied by role agent ${role} for this dispatch: ${refusal}`;
          }
        }
      } catch (error) {
        // QA-P23-A8: no agent on the event and the session lookup failed — a session the router knows as a role child (its
        // dispatch record or its binding) is still a role session, and is denied.
        if (role === undefined && event.agent === undefined) role = knownRoleSession(String(event.sessionID));
        if (protectedKnown) event.effect = "deny";
        // P-3: a role agent's evaluation error is an explicit deny; other agents keep today's behaviour.
        if (role !== undefined) {
          event.effect = "deny";
          event.message = `Permission denied by role agent ${role}: the router could not check this dispatch's authority (fail closed)`;
        }
        warnPermissionOnce(`read-only permission evaluation failed for ${name ?? "unknown agent"}: ${String(error)}`);
      }
    }));

    registrations.push(await ctx.command.transform((editor) => {
      for (const [name, definition] of Object.entries(config.command)) editor.add({
        name,
        description: definition.description,
        execute: async (invocation) => {
          const text = String(definition.template ?? "").replaceAll("$ARGUMENTS", () => invocation.prompt.text);
          const output = { parts: text ? [{ type: "text", text }] : [] };
          await legacy["command.execute.before"]?.({
            command: name, arguments: invocation.prompt.text, sessionID: invocation.sessionID,
          }, output);
          if (name === "router-reload") {
            const reloadText = output.parts.map((part) => v2Instructions(part.text)).join("\n\n");
            await refresh();
            await ctx.session.synthetic({
              sessionID: invocation.sessionID, text: reloadText, description: "Model router config reload", resume: false,
            });
            return;
          }
          if (name === "preset") await refresh();
          await ctx.session.prompt({
            ...invocation.prompt,
            sessionID: invocation.sessionID,
            delivery: invocation.delivery,
            text: output.parts.map((part) => v2Instructions(part.text)).join("\n\n"),
          });
        },
      });
    }));

    registrations.push(await ctx.tool.transform((editor) => {
      // execute is denied for read-only tiers. Keep the explicitly allowed docs
      // lookups directly callable rather than stranding them in Code Mode.
      if (config.mcp?.context7) for (const name of CONTEXT7_DOC_TOOLS) editor.update(name, definition => {
        const { pinned: _pinned, ...options } = definition.options ?? {};
        definition.options = { ...options, codemode: false };
      });
      for (const [name, definition] of Object.entries(hooks.tool ?? {})) editor.add({
        name,
        description: v2Instructions(definition.description),
        input: tool.schema.object(definition.args),
        // Router tools must remain directly callable, matching v1 tool exposure.
        options: { codemode: false },
        execute: async (args, context) => within(context, async () => {
          const directory = name.startsWith("router_git_")
            ? (await ctx.session.get({ sessionID: context.sessionID })).location?.directory ?? ctx.location.directory
            : ctx.location.directory;
          // Memo §15.1: the `ls_files` filter is synchronous and reads the session-kind cache; resolve an unknown kind here, once
          // (memoized by `sessionKindOf`), so the filter applies to EVERY child session. No other tool pays this lookup.
          if (name === "router_git_ls_files" && leaseGuard !== undefined) await sessionKindOf(String(context.sessionID));
          const result = await definition.execute(args, {
            sessionID: context.sessionID, messageID: context.messageID, agent: context.agent,
            directory, worktree: name.startsWith("router_git_") ? "" : ctx.location.project.directory, // Session.Info.location has no project; discover from its directory, never the plugin's project.
            abort: context.signal,
            metadata: (metadata) => { void context.progress(metadata); },
            ask: async () => { throw new Error("[model-router] This tool cannot request v1 permissions on OpenCode 2"); },
          });
          if (typeof result === "string") return { content: result };
          return {
            content: [
              { type: "text" as const, text: result.output },
              ...(result.attachments ?? []).map((file) => ({
                type: "file" as const, uri: file.url, mime: file.mime, ...(file.filename ? { name: file.filename } : {}),
              })),
            ],
            metadata: { ...result.metadata, ...(result.title ? { title: result.title } : {}) },
          };
        }),
      });
    }));

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      // Phase 2.1 (memo §4.5): a session without a parent is a root: its turns are timed and its kind is known to the leases.
      noteSessionKind(String(event.sessionID), session.parentID ? "child" : "root");
      if (!session.parentID) adoptSession(String(event.sessionID));
      if (!session.parentID && timings !== undefined) {
        const rootTimings = timings;
        try {
          rootTimings.markRootSession(String(event.sessionID));
          void rootTimings.onRootPrompt(String(event.sessionID), nowMs(), typeof event.messageID === "string" ? event.messageID : undefined).catch((error: unknown) => ingestLogger.warn("[router] timing: the turn boundary could not be recorded", { error: String(error) }));
        } catch (error) {
          ingestLogger.warn("[router] timing: the root prompt could not be recorded", { error: String(error) });
        }
      }
      const output = { message: { agent: session.agent }, parts: [{ type: "text", text: event.prompt.text }] };
      await legacy["chat.message"]?.({ sessionID: event.sessionID, agent: session.agent }, output);
      event.prompt.text = output.parts.map((part) => part.text).join("\n\n");
      // Host agents defined in opencode.json appear after setup: refresh once a pending `subagentTiers` name shows up.
      const discovered = await discoverHostAgents();
      if (loadConfig(ctx.location.directory) !== lastConfig || discovered) await refresh();
      if (!promptChecked) {
        promptChecked = true;
        for (const name of pendingSubagentNames()) {
          warnAgentOptionsEffortOnce(`subagent-tiers:missing:${name}`, `subagentTiers: '${name}' is not defined in opencode.json or the router \`agents\` block; skipped (the router never creates it)`, ingestLogger);
        }
      }
    }));
    // ---- Phase 2.1 message helpers (memo §4.4): `HeldResults.apply` reads `parts`; the host's context messages carry `content`. ----
    const withContent = (source: ContextMessage, content: ContextMessage["content"]): ContextMessage =>
      Object.assign(Object.create(Object.getPrototypeOf(source)), source, { content });
    /** The held-result matcher over context messages (copies; `undefined` = unchanged). */
    const applyHeldTo = (sid: string, messages: readonly ContextMessage[]): ContextMessage[] | undefined => {
      const shaped = messages.map((source) => ({ source, parts: source.content }));
      const result = held.apply(sid, shaped);
      if (result === undefined) return undefined;
      return result.map((entry) => (entry.parts === entry.source.content ? entry.source : withContent(entry.source, entry.parts)));
    };
    /** Auto/model: `[router` line starts in every `<subagent …>` element body are defanged (parity with `defangChildResult`). */
    const defangMessages = (messages: readonly ContextMessage[]): ContextMessage[] | undefined => {
      let changed = false;
      const next = messages.map((message) => {
        if (!Array.isArray(message.content)) return message;
        let touched = false;
        const content = message.content.map((part) => {
          if (part.type !== "text") return part;
          const text = defangSubagentBodies(part.text, defangRouterLines);
          if (text === part.text) return part;
          touched = true;
          return { ...part, text };
        });
        if (!touched) return message;
        changed = true;
        return withContent(message, content);
      });
      return changed ? next : undefined;
    };
    /**
     * A root session's request: every completion element of an acknowledged attempt starts its processing (not awaited), and the
     * first request that sees an attempt waits for it at most COMPLETION_SETTLE_MS (one shared budget, never again for that attempt).
     */
    const scanCompletions = async (sid: string, messages: readonly ContextMessage[]): Promise<void> => {
      if (processor === undefined) return;
      const waits: string[] = [];
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== "text") continue;
          for (const element of completionElementsOf(part.text)) {
            const attempt = inflight.byChild(element.child);
            if (attempt === undefined || attempt.parentSessionID !== sid) continue;
            if (attempt.state === "acknowledged" || attempt.state === "child-ended") {
              void processor.process(element.child, { kind: "completion", state: element.state, body: element.body, at: nowMs() });
            }
            if (!attempt.waitedOnce && !waits.includes(element.child)) {
              attempt.waitedOnce = true;
              waits.push(element.child);
            }
          }
        }
      }
      if (waits.length > 0) await Promise.all(waits.map((child) => processor?.settled(child, COMPLETION_SETTLE_MS)));
    };
    /** The context hook's body (QA-P23-B5: declared before the hook that calls it). */
    async function buildContext(event: SessionContext, role: string | undefined): Promise<void> {
      // Phase 2.1 (memo §4.4 step 1-2): FIRST, before `chat.params` and before the augmenter reads `event.messages`: no held output
      // reaches the request, and (auto/model) child text cannot pose as a router line. Mode `off`: no matcher, no defang.
      const rawMessages = event.messages;
      if (bgActive() && event.messages !== undefined) {
        const sid = String(event.sessionID);
        adoptSession(sid);
        if (reloadFailed) {
          // Memo §12: without a reloaded journal every completion not known as processed is redacted (fail closed).
          const isProcessed = (child: string): boolean => {
            const attempt = inflight.byChild(child);
            return attempt !== undefined && journal.hasProcessed(attempt.key);
          };
          event.messages = event.messages.map((message) => {
            if (!Array.isArray(message.content)) return message;
            let touched = false;
            const content = message.content.map((part) => {
              if (part.type !== "text") return part;
              const text = redactUnprocessedElements(part.text, isProcessed);
              if (text === part.text) return part;
              touched = true;
              return { ...part, text };
            });
            return touched ? withContent(message, content) : message;
          });
        }
        const hidden = applyHeldTo(sid, event.messages);
        if (hidden !== undefined) event.messages = hidden;
        const defanged = defangMessages(event.messages);
        if (defanged !== undefined) event.messages = defanged;
      }
      if (protectedAgent(event.agent)) {
        try {
          // Catalogs use merged session rules; remove widened tools from this
          // request snapshot only. Resource-specific asks remain callable.
          const agent = (await ctx.agent.list()).data.find(agent => agent.id === event.agent);
          for (const name of Object.keys(event.tools ?? {})) {
            // QA-G-A1-1: every host edit tool (`write`, `patch`, `multiedit`, `apply_patch`) is checked as `edit`, the permission
            // the host asserts for it; a rule naming the tool itself (never the `*` catch-all) can still deny it.
            const action = roleActionOf(name) === "edit" ? "edit" : name;
            const denied = (checked: string): boolean => evaluatePermission(agent!.permissions, checked, "*") === "deny"
              && !agent!.permissions.some(rule => rule.effect !== "deny" && rule.action === checked && rule.resource !== "*");
            const ownDeny = (): boolean => action !== name
              && evaluatePermission(agent!.permissions.filter(rule => rule.action !== "*"), name, "*") === "deny";
            if (!agent || denied(action) || ownDeny()) delete event.tools[name];
          }
        } catch (error) {
          // QA-P23-B1: a role session's failure goes to the hook's own catch (empty catalog AND the parent's annotation).
          if (role !== undefined) throw error;
          // Known protected agent: no usable catalog is safer than widened
          // tools. Never turn a hook rejection into a host operation failure.
          for (const name of Object.keys(event.tools ?? {})) delete event.tools[name];
          warnPermissionOnce(`read-only tool catalog failed for ${event.agent}: ${String(error)}`);
        }
      }
      // #84 P2.3 (T2.3.2, I3): a role session keeps only the tools of ITS dispatch grant (this request snapshot only; sibling
      // sessions of the same agent are untouched), `execute` never (S8), `router_request_authority` for dynamic roles only — also
      // under an unknown binding, whose grant is the role max ∩ local (I9). The binding is made here at the latest (P-2).
      if (role !== undefined) {
        const authority = await roleAuthorityOf(String(event.sessionID), role);
        if (authority === undefined) throw new Error(`role ${role}: no live role spec (fail closed)`);
        // QA-P23-B1: a decision the registry could not keep (the session lookup failed or named no parent/agent) is not a
        // binding: the catalog is emptied and the parent told, instead of a silently reduced child.
        // QA-P23-2-B1: only a failed lookup or a session that names no agent; one with an agent but no parent is an unknown
        // binding (I9 (a): the role max ∩ local), not a failure.
        if (!authority.stored && (authority.binding.grant.notes.includes(BINDING_NOTES.lookupFailed)
          || lookupNamedAgent.get(String(event.sessionID)) !== true)) {
          throw new Error(`role ${role}: the session could not be bound to its dispatch (lookup failed or no agent)`);
        }
        const dynamic = authority.spec.authority.mode === "dynamic";
        for (const name of Object.keys(event.tools ?? {})) if (!roleToolKept(name, authority.binding.grant, dynamic)) delete event.tools[name];
      }
      const input = { sessionID: event.sessionID, agent: event.agent, model: { ...event.model, modelID: event.model.id } };
      // V2 consumes per-turn options, not Agent.Info.request.settings.
      for (const [key, value] of Object.entries(agentOptions.get(event.agent) ?? {})) {
        if (!(key in event.options)) event.options[key] = value;
      }
      await legacy["chat.params"]?.(input, event.options);
      // #90 P1.2 (A3): what this turn's request carries after the router's hook; no effort key records none (clearing a stale one).
      // The channel never changes the hook's outcome.
      // Host v2.0.24 core/src/session/model-request.ts:408-411 fires `context` for primary requests only (compaction, generate, title have their own hooks).
      recordEffortTurn(event);
      const routerConfig = loadConfig(ctx.location.directory);
      const verify = routerConfig.enforcement?.verify;
      if (event.agent === V2_GRADER_AGENT
        && (verify?.graderTemperature === null
          || !(verify?.graderTemperatureModels ?? []).includes(`${event.model.providerID}/${event.model.id}`))) {
        delete event.options.temperature;
      }
      const original = new Map<string, SystemPart[]>();
      for (const part of event.system) {
        const copies = original.get(part.text) ?? [];
        copies.push(part);
        original.set(part.text, copies);
      }
      const output: { system: string[]; [TURN_STATE_ROOT]?: boolean } = { system: event.system.map((part) => part.text) };
      // The router pushes its own instructions, but may splice edited user text.
      // Only pushed text belongs to the router and may have its vocabulary translated.
      const added = new Set<string>();
      Object.defineProperty(output.system, "push", { value: (...texts: string[]) => {
        for (const text of texts) added.add(text);
        return Array.prototype.push.apply(output.system, texts);
      } });
      await legacy["experimental.chat.system.transform"]?.(input, output);
      // M7 (2.2): advise/enforce swap the R: line, append the route-line paragraph and add the per-turn hint.
      // static/shadow (and every config without a routing block) leave `output.system` exactly as the legacy hook built it.
      await systemAugmenter.augment({
        sessionID: event.sessionID, agent: event.agent, parentModel: `${event.model.providerID}/${event.model.id}`, messages: event.messages, cfg: routerConfig,
      }, output.system, added);
      event.system = output.system.map((text): SystemPart =>
        original.get(text)?.shift() ?? { type: "text", text: added.has(text) ? v2Instructions(text) : text });
      runtime?.applyChildSystem(event.sessionID, event.system);
      // Native reads load nested AGENTS.md as synthetic user-role messages.
      // Correlate their IDs with durable attribution before removing anything;
      // a user prompt containing identical text must remain untouched.
      const candidates = event.messages?.filter((message) => message.role === "user"
        && message.content.some((part) => part.type === "text" && /^Instructions from:/m.test(part.text)));
      if (candidates?.length) {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        if (session.parentID) {
          const history = await ctx.session.context({ sessionID: event.sessionID });
          const attributed = new Map(history.filter((message) => message.type === "synthetic"
            && message.metadata?.instruction && typeof message.metadata.instruction === "object"
            && "paths" in message.metadata.instruction && Array.isArray(message.metadata.instruction.paths))
            .map((message) => [message.id, message]));
          for (const message of candidates) {
            const source = message.id ? attributed.get(message.id) : undefined;
            if (!source || source.type !== "synthetic") continue;
            const filtered = { system: [source.text] };
            stripDelegateInstructions(filtered, loadConfig(ctx.location.directory), session.location?.directory ?? ctx.location.directory);
            const retained = filtered.system.join("");
            if (retained === source.text) continue;
            const index = event.messages.indexOf(message);
            const content = message.content.flatMap((part) => part.type === "text" && part.text === source.text
              ? retained ? [{ ...part, text: retained }] : [] : [part]);
            if (content.length) event.messages[index] = Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content });
            else event.messages.splice(index, 1);
          }
        }
      }
      // Phase 1.2: a root session's turn state (pending list, late notices, route hint) rides in a trailing user message; the
      // system parts above are never changed for it. A failure here only loses the tail, never the request.
      if (output[TURN_STATE_ROOT] === true && event.messages !== undefined) {
        if (bgActive() && rawMessages !== undefined) {
          // The ORIGINAL completion text (before the matcher) feeds the processor; failures never cost the request.
          try {
            await scanCompletions(String(event.sessionID), rawMessages);
          } catch (error) {
            ingestLogger.warn("[router] background: completions could not be scanned", { error: String(error) });
          }
        }
        try {
          const placed = placeTurnState(event.messages, turnState.buildTurnState(String(event.sessionID)), tailMessage);
          if (placed !== undefined) event.messages = placed;
        } catch (error) {
          warnTurnStateOnce(error);
        }
      }
    }
    // #90 P1.2 (A1): the TUI's `effortOf` rpc, answered from `effortStore`; tiers and roles mode alike. Feature-detected (a host
    // without `ctx.rpc.register` gets nothing), bounded (2 s; a late registration is kept), never throws; disposed with the other
    // registrations. GA-4: not awaited here, so a slow `register` never delays the hooks below; its dispose waits for the
    // registration to settle (at most the 2 s bound) and then disposes it.
    const effortChannel = registerEffortChannel(ctx.rpc, effortStore, ingestLogger).catch(() => async () => {});
    registrations.push({ dispose: async () => { await (await effortChannel)(); } });
    registrations.push(await ctx.session.hook("context", async (event) => {
      // #84 P2.3 (P-3, I9): a role session's context hook never fails the child. ANY error below empties its catalog (the
      // strictest outcome) and is annotated for the parent's `subagent` result; every other agent keeps today's behaviour.
      const role = roleAgentName(event.agent);
      try {
        await buildContext(event, role);
      } catch (error) {
        if (role === undefined) {
          // #90 P1.2: the request does not go out, so nothing is recorded for it (not even a record made earlier in this turn).
          if (typeof event.sessionID === "string") effortStore.forget(event.sessionID);
          throw error;
        }
        for (const name of Object.keys(event.tools ?? {})) delete event.tools[name];
        recordEffortTurn(event); // #90 P1.2: the role session goes on fail-closed with these options: they are what is recorded
        warnPermissionOnce(`role tool catalog failed for ${role}: ${String(error)}`);
        const child = String(event.sessionID);
        if (!catalogFailures.has(child)) {
          catalogFailures.add(child);
          while (catalogFailures.size > 1000) catalogFailures.delete(catalogFailures.values().next().value!);
          annotateSubagentResult("authority", child, roleCatalogFailureNotice(role, child));
        }
      }
    }));

    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      const args = await scopedArgs(event);
      // #84 P2.1 (P-2, handoffs 11/32/33): a role child binds to its dispatch before its tool runs, so `router_run` and
      // `router_git_*` resolve the bound work root and the guard reads the dispatch budget. Tiers mode: no role table, no call.
      const callerRoles = rolesOf(loadConfig(ctx.location.directory));
      if (callerRoles.size > 0 && typeof event.agent === "string" && callerRoles.has(event.agent)) {
        const maxOf = maxOfRoles(callerRoles);
        const binding = await bind(String(event.sessionID), bindingLookup, { maxOf });
        // QA-P21-1-11: the observed kind, once per child; QA-P23-B2: only a decision the registry kept.
        if (currentBinding(String(event.sessionID), { maxOf }) !== undefined) dispatchRouter.noteBinding(String(event.sessionID), binding);
      }
      // #84 P2.3 (T2.3.1, I3, P-12): EVERY tool call of a role session (`subagent` included, QA-P23-A7) stays inside its dispatch
      // grant and work root. This is the router check that fires for plugin tools and Code Mode `execute` (no `evaluate` does,
      // S8/S11); errors refuse (fail closed). QA-P23-A8: an event without an agent from a session the router knows as a role child
      // is refused outright.
      // QA-G-A3-2: a refusal here is thrown before the legacy hook (and its guard) sees the call: the plugin counts it on the
      // child's guard state, and the guard's stop (denied_cap) or advisory banner is added to the refusal the child sees.
      const refused = (message: string, agent: string | undefined): Error => {
        const guard = options.recordRefusal?.(String(event.sessionID), agent, event.tool, args);
        return new Error(guard === undefined ? message : `${message}\n${guard}`);
      };
      if (typeof event.agent !== "string" || event.agent === "") {
        const known = knownRoleSession(String(event.sessionID));
        if (known !== undefined) throw refused(`[router] Refused for role session ${String(event.sessionID)}: the calling agent is unknown (fail closed)`, known);
      }
      const callerRole = roleAgentName(event.agent);
      if (callerRole !== undefined) {
        let refusal: string | undefined;
        try {
          refusal = await roleToolRefusal(event, args, callerRole);
        } catch {
          refusal = "the router could not check this dispatch's authority (fail closed)";
        }
        if (refusal !== undefined) throw refused(`[router] Refused for role agent ${callerRole} in this dispatch: ${refusal}`, callerRole);
      }
      // Phase 2.1 (memo §4.2): authority checks first, then the held refusal, then the leases (all before the legacy hook).
      if (bgActive()) {
        adoptSession(String(event.sessionID));
        const heldRefusal = held.refusal(String(event.sessionID), event.tool, args);
        if (heldRefusal !== undefined) throw refused(heldRefusal, callerRole);
      }
      // Only the tools the guard checks (file tools, `router_git_*`, `router_run`) reach it: no host call for any other tool.
      const leaseClass = roleActionOf(event.tool);
      if (leaseGuard !== undefined && (leaseClass === "read" || leaseClass === "edit" || event.tool.startsWith("router_git_") || event.tool === "router_run")) {
        const lease = await leaseGuard.before({ sessionID: String(event.sessionID), tool: event.tool, args, callID: event.id });
        if (lease.refuse !== undefined) throw refused(lease.refuse, callerRole);
        if (lease.runNote !== undefined) {
          runNotes.delete(event.id);
          runNotes.set(event.id, lease.runNote);
          while (runNotes.size > 1000) runNotes.delete(runNotes.keys().next().value!);
        }
      }
      // #84 P-5: a routed role dispatch runs in the foreground (separate from `verifying`).
      let roleForeground = false;
      if (event.tool === "subagent" && args && typeof args.agent === "string") {
        // The model `subagentTiers` would fill in when the call names none (unchanged behaviour: only then, only for a mapped agent).
        const cfg = loadConfig(ctx.location.directory);
        // #84 P-7: roles mode dispatches the host-native `explore` as the `explorer` role agent. Legacy shape: nativeArgs
        // derives `agent` from `subagent_type`; `args.agent` is set too, so everything below keys on the role name.
        const alias = roleAgentAlias(args.agent, cfg, (name) => roleAgentOf(config.agent[name]) === name);
        if (alias !== undefined) { args.agent = alias; args.subagent_type = alias; }
        let tierModel: string | undefined;
        if (args.model === undefined) {
          if (cfg.subagentTiers?.[args.agent]) {
            const actual = await ctx.agent.list();
            const overrides = actual.data.some((agent) => agent.id === args.agent) ? resolveSubagentOverrides({
              subagentTiers: cfg.subagentTiers, tiers: getActiveTiers(cfg), pluginAgents: cfg.agents,
              existingAgents: Object.fromEntries(actual.data.map((agent) => [agent.id, { mode: agent.mode }])),
            }) : {};
            const override = overrides[args.agent];
            if (override) tierModel = `${override.model}${override.variant ? `#${override.variant}` : ""}`;
          }
        }
        // M7 (2.2): the engine goes first. Static (the default) returns untouched without any host call; shadow/advise only
        // log and strip `[route …]`; enforce may also replace agent and model. `subagentTiers` then only fills a missing model.
        // #84 P2.1 (handoff 36): a resume of a role child applies the authority its previous call recorded and annotated; the
        // widened actions recompute the tier floor in `route()`. QA-P21-1-10: the request is only READ before routing and
        // consumed once `route()` succeeded — a refused dispatch keeps it and queues no notice. Q1 (P2.3 call site): only an
        // EXACT binding widens; any other drops the request ("binding unknown: dispatch a fresh task"), shown on this result.
        // QA-G-A1-2: a resume by another session than the one the request was escalated to drops it, with the notice.
        const roles = rolesOf(cfg);
        const resumeID = typeof args.sessionID === "string" && args.sessionID !== "" ? args.sessionID : undefined;
        let widened: AuthorityAction[] | undefined;
        let afterRoute: (() => void) | undefined;
        if (resumeID !== undefined && roles.has(args.agent)) {
          hostBudget.begin(resumeID); // handoff 22: the host's step count starts over with the resumed attempt
          // QA-P21-2 nit 2: one preview (authority.ts) decides what consumeAuthority would do; Q1 via `exactOnly`. QA-G-A1-2: only
          // the session the request was escalated to may apply it (`parentSessionID`); any other resuming session drops it.
          const deps = authorityDeps(roles, args.agent);
          const resume = { afterCall: lastCallOfChild.get(resumeID) ?? "", exactOnly: true, parentSessionID: String(event.sessionID) };
          const preview = previewAuthority(resumeID, deps, resume);
          if (preview.status === "widened") widened = [...preview.widened];
          if (preview.status === "dropped" && preview.reason === AUTHORITY_TEXT.dropped.bindingUnknown) {
            afterRoute = () => {
              evictAuthority(resumeID); // consumeAuthority would widen a non-exact binding: the request is dropped here instead
              annotateSubagentResult("authority", resumeID, `[router] ${AUTHORITY_BINDING_UNKNOWN_DROP}`);
            };
          } else if (preview.status !== "none") {
            afterRoute = () => {
              // QA-G-A1-3: `exactOnly` here too, so the consume can never widen a binding the preview did not see as exact.
              const consumed = consumeAuthority(resumeID, deps, resume);
              if (consumed.status === "dropped") annotateSubagentResult("authority", resumeID, `[router] ${consumed.reason}.`);
            };
          }
        }
        const routed = await dispatchRouter.route({
          callID: event.id, sessionID: event.sessionID, agent: event.agent, args, tierModel, cfg,
          ...(widened === undefined ? {} : { widened }),
        });
        // QA-G-A1-2: a delegate's resume (the unparsed, floor-rung path) never consumes the request: it widens nothing, and the
        // request stays for the session it was escalated to. QA-G-A1-2-2: neither does a resume route() left untouched (no role
        // decision: a runner-announced call, a call another instance handled) — consuming it would widen the binding outside a
        // routed decision, with no floor recomputed.
        if (routed.role !== undefined && routed.role.delegate !== true) afterRoute?.();
        if (routed.prompt !== undefined) args.prompt = routed.prompt;
        // #84 P2.1-C: a fresh role dispatch carries its nonce at the END of the description (title marker, handoff 31).
        if (routed.description !== undefined) args.description = routed.description;
        if (routed.role !== undefined) roleForeground = true;
        if (routed.agent !== undefined) { args.agent = routed.agent; args.subagent_type = routed.agent; }
        if (routed.model !== undefined) args.model = routed.model;
        if (args.model === undefined && tierModel !== undefined) args.model = tierModel;
      }
      // After routing: the prompt the legacy hook starts from is the one the engine left (a stripped route line is not "added" text).
      try {
        const original = args && typeof args === "object" ? { ...args } : args;
        const output = { args };
        await within(hookContext(event), async () => {
          await legacy["tool.execute.before"]?.({ ...event, tool: legacyToolName(event.tool), callID: event.id }, output);
        });
        const verifying = (output as Record<PropertyKey, unknown>)[TASK_VERIFICATION] === true;
        const banner = (output as Record<PropertyKey, unknown>)[DEPTH_BANNER];
        if (typeof banner === "string") {
          depthBanners.delete(event.id);
          depthBanners.set(event.id, banner);
          while (depthBanners.size > 1000) depthBanners.delete(depthBanners.keys().next().value!);
        }
        if (verifying) {
          verifyingCalls.add(event.id);
          while (verifyingCalls.size > 1000) verifyingCalls.delete(verifyingCalls.values().next().value!);
        }
        if (event.tool === "subagent" && typeof output.args?.prompt === "string") {
          const prompt = typeof original?.prompt === "string" ? original.prompt : typeof original?.description === "string" ? original.description : "";
          output.args.prompt = translateAdded(prompt, output.args.prompt);
        }
        // Phase 2.1 (memo §4.2 step 5, §6): under `off` (or without the finish API) this is today's `verifying || roleRouted ? false : undefined`.
        let background: boolean | undefined = verifying || roleForeground ? false : undefined;
        if (event.tool === "subagent" && bgActive() && finishApi !== undefined) {
          const parent = String(event.sessionID);
          const info = dispatchRouter.decisionOf(event.id);
          const roleLabel = info?.role ?? "unknown";
          const verification = finishApi.verificationFor(event.id);
          const decision = decideBackground({
            mode: startRouting.background.mode,
            explicit: typeof output.args?.background === "boolean" ? output.args.background : undefined,
            verifying, verificationMode: verification?.mode ?? "none", roleRouted: roleForeground,
            estimate: info === undefined ? undefined : durations?.estimate({ role: roleLabel, class: info.class, scope: info.scope }),
            minPredictedMs: startRouting.background.minPredictedMs, minSamples: DURATION_MIN_SAMPLES,
            acceptance: verification?.acceptance ?? { testsPass: false, buildPasses: false },
            planTask: false,
            holdingAvailable: held.available && !reloadFailed && finishApi.canHold(parent),
            parentIsRoot: knownKindOf(parent) === "root", liveCount: inflight.liveCount(),
          });
          background = decision.background;
          inflight.decide({
            callID: event.id, parentSessionID: parent, agent: String(output.args?.agent ?? ""), ...(info?.role === undefined ? {} : { role: info.role }),
            description: typeof output.args?.description === "string" ? output.args.description : "", verifying,
            verificationMode: verification?.mode ?? "none", decision,
            ...(typeof output.args?.sessionID === "string" && output.args.sessionID !== "" ? { resumeOf: output.args.sessionID } : {}),
            at: nowMs(),
          });
        }
        event.input = nativeArgs(event.tool, output.args, original, background);
      } catch (error) {
        dispatchRouter.onCallFinished(event.id); // the hook chain rejected the call: it will never reach execute.after (2.2)
        inflight.cancel(event.id);
        throw error;
      }
      // The input the host will execute (after the legacy hook): the dispatch is registered for ingestion from it, not from what the engine decided (2.2).
      dispatchRouter.commit(event.id, event.input);
      // 1.1 handoff: the timing starts after `commit` (not inside it); a hook-chain rejection above makes no call.
      if (event.tool === "subagent" && timings !== undefined) {
        try {
          const info = dispatchRouter.decisionOf(event.id);
          const sent = event.input as { sessionID?: unknown; background?: unknown };
          const resumed = sent.sessionID;
          timings.recordDispatchStart({
            callID: event.id, childSessionID: typeof resumed === "string" && resumed !== "" ? resumed : null, parentSessionID: String(event.sessionID),
            role: info?.role ?? "unknown", class: info?.class ?? "unknown", scope: info?.scope ?? "unknown",
            tier: info?.tier ?? "unknown", model: info?.model ?? "unknown", background: sent.background === true, at: nowMs(),
          });
        } catch (error) {
          ingestLogger.warn("[router] timing: the dispatch start could not be recorded", { error: String(error) });
        }
      }
    }));
    /**
     * #84 P2.1 (T2.1.4; handoffs 28, 34, 37): the parent's `subagent` call of a role child ended. Computed BEFORE the legacy hook
     * (whose signals read the authority record and the guard state): the notices for the parent's result — resume guidance when
     * the guard stopped the child on its budget, the child's recorded authority request on `ESCALATE: authority`, a request this
     * resume dropped. `finish()` runs after the legacy hook: the request is attached to this call on `ESCALATE: authority`
     * (`markAnnotated`), else dropped (`discardAuthority`); then the call's pending binding entry is evicted (`evictCall`).
     * `undefined` for every call that is not a role dispatch (tiers mode: always).
     */
    const roleAfterCall = async (end: {
      readonly id: string; readonly sessionID: string; readonly status: string; readonly result: unknown; readonly input: unknown;
    }): Promise<{ readonly notice: string | undefined; readonly finish: () => void; readonly child: string | null } | undefined> => {
      const record = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const routedRole = routedRoleOf(end.id);
      const calledAgent = record(end.input)?.agent;
      const agent = routedRole?.agent ?? (typeof calledAgent === "string" ? calledAgent : undefined);
      const roles = rolesOf(loadConfig(ctx.location.directory));
      if (agent === undefined || (routedRole === undefined && !roles.has(agent))) return undefined;
      const child = end.status === "completed" ? childSessionOf(end.result) : null;
      const structured = record(end.result)?.output;
      const running = record(structured)?.status === "running";
      const output = record(structured)?.output;
      const text = typeof output === "string" ? output : contentText(record(end.result)?.content);
      const contract = child === null || running ? null : parseReturnPrefix(text);
      const escalated = contract?.prefix === "escalate" && contract.claim === "authority";
      const notices: string[] = [];
      if (child !== null && !running) {
        const request = requestedAuthority(child);
        if (escalated && request !== undefined && request.actions.length > 0 && (!request.annotated || request.callID === end.id)) {
          annotateSubagentResult("authority", child, roleAuthorityNotice(agent, child, request.actions, request.reasons));
        }
        // Handoff 22: the host's own stop (step limit, context overflow) counts like the guard's; its events may trail the result.
        await hostBudget.settled(child, hostSettleMs);
        // QA-P21-1-3: the plugin's snapshot (guard stop OR the read-only CAP reached), as its signals read it.
        const snapshot = options.budgetSnapshot?.(child);
        // QA-P21-3-1: a reached read cap counts only with a `NEED MORE` return (a DONE at the cap is a finished task).
        const capStop = snapshot?.readCapReached === true && contract?.prefix === "need-more";
        // QA-G-A3-1: in advisory mode the guard enforces no stop; a `NEED MORE: budget` return of a tracked child whose budget is
        // used up is one all the same (the signals' rule), so the parent gets the resume guidance too.
        const stopped = snapshot === undefined ? budgetExhausted(child) : snapshot.stopped || capStop || budgetClaimObserved(text, snapshot);
        if (stopped) annotateSubagentResult("budget", child, roleBudgetNotice(agent, child));
        else if (hostBudget.observe(child, hostStepLimitOf(roles, agent)) === true) annotateSubagentResult("budget", child, roleBudgetNotice(agent, child, "host"));
        for (const annotation of takeSubagentAnnotations(child)) notices.push(annotation.text);
      }
      return {
        notice: notices.length > 0 ? notices.join("\n\n") : undefined,
        child,
        finish: () => {
          try {
            if (child !== null) {
              if (!running && !(escalated && markAnnotated(child, end.id, end.sessionID))) discardAuthority(child, end.id);
              rememberLastCall(child, end.id);
              if (!running) catalogFailures.delete(child); // P-3: the next attempt's catalog failure is annotated again
            }
            // Phase 2.1: a running ack under background guarantees keeps the pending binding: the processor evicts it at completion
            // (otherwise an auto-backgrounded role child loses its binding before its first request).
            if (!(running && bgActive() && inflight.byCall(end.id) !== undefined)) evictCall(end.sessionID, end.id);
          } catch (error) {
            ingestLogger.warn("[router] roles: the finished role dispatch could not be released", { error: String(error) });
          }
        },
      };
    };
    // Phase 2.1 (memo §4.7): the completion processor. Only when the plugin attached its finish API; otherwise nothing is processed.
    let processor: CompletionProcessor | undefined;
    /** The child's last assistant message (`ctx.session.context`, C7/O1); also the recovery read of a persisted dispatch. */
    const lastAssistantText = async (child: string): Promise<{ text: string } | undefined> => {
      const history = await ctx.session.context({ sessionID: child } as Parameters<typeof ctx.session.context>[0]);
      const messages: readonly unknown[] = Array.isArray(history) ? history : [];
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
        if (message?.role === "assistant") return { text: contentText(message.content) };
      }
      return undefined;
    };
    if (finishApi !== undefined) {
      const api = finishApi;
      const captureDeltaOf = api.captureDelta?.bind(api);
      processor = createCompletionProcessor(inflight, {
        finish: (input) => within(hookContext({ sessionID: input.parentSessionID, agent: inflight.byCall(input.callID)?.agent, messageID: "", id: input.callID }), () => api.finish(input)),
        readChildResult: lastAssistantText,
        // The `!running` half of `roleAfterCall`: budget and authority notices, plus its evictions (run through its own `finish`).
        roleCompletion: async (attempt, text) => {
          const completed = await roleAfterCall({
            id: attempt.callID, sessionID: attempt.parentSessionID, status: "completed",
            result: { output: { status: "completed", output: text, sessionID: attempt.childSessionID }, content: [{ type: "text", text }] },
            input: { agent: attempt.agent },
          });
          if (completed === undefined) return [];
          completed.finish();
          evictCall(attempt.parentSessionID, attempt.callID);
          return completed.notice === undefined ? [] : [completed.notice];
        },
        releaseLeases: (holderID) => { leaseGuard?.releaseChild(holderID); leaseHandle?.notifyReleased(); },
        held, persist: journal, now: nowMs, logger: ingestLogger,
        // 2.1.4.b: the change set at child end, so a background completion verifies what the child changed.
        ...(captureDeltaOf === undefined ? {} : { captureDelta: captureDeltaOf }),
      });
      const closing = processor;
      closeAttempt = (attempt, cause) => closing.closeUnknown(attempt, cause);
      // Memo §11.3: an adopted `inflight` record without `processed` is recovered through the child's own history: finished ->
      // process; otherwise lost. The attempt is re-registered first so the processor has its key; a failure leaves it to the sweep.
      recoverInflight = (sessionID) => {
        const records = dormantInflight.get(sessionID);
        dormantInflight.delete(sessionID);
        for (const rec of records ?? []) {
          const callID = typeof rec.callID === "string" ? rec.callID : undefined;
          const child = typeof rec.childSessionID === "string" ? rec.childSessionID : typeof rec.child === "string" ? rec.child : undefined;
          if (callID === undefined || child === undefined) continue;
          const mode = rec.verificationMode === "required" || rec.verificationMode === "deferred" ? rec.verificationMode : "none";
          const registered = inflight.decide({
            callID, parentSessionID: sessionID, agent: typeof rec.agent === "string" ? rec.agent : "",
            ...(typeof rec.role === "string" ? { role: rec.role } : {}),
            description: typeof rec.description === "string" ? rec.description : "",
            verifying: rec.verifying === true, verificationMode: mode,
            decision: { background: true, hold: false, reason: "prior" }, at: typeof rec.at === "number" ? rec.at : nowMs(),
          });
          const handle = typeof rec.hold === "string" ? rec.hold : typeof rec.handle === "string" ? rec.handle : undefined;
          if (!registered || inflight.acknowledge(callID, child, { userBackgrounded: true, ...(handle === undefined ? {} : { hold: { handle } }) }) === undefined) continue;
          void (async () => {
            let finished: { text: string } | undefined;
            try {
              finished = await lastAssistantText(child);
            } catch (error) {
              ingestLogger.warn("[router] background: the child of a persisted dispatch could not be read; treated as lost", { child, error: String(error) });
            }
            await closing.process(child, finished === undefined
              ? { kind: "recovery", outcome: "lost", text: undefined, at: nowMs() }
              : { kind: "recovery", outcome: "succeeded", text: finished.text, at: nowMs() });
          })().catch((error: unknown) => {
            ingestLogger.warn("[router] background: a persisted dispatch could not be recovered", { child, error: String(error) });
          });
        }
      };
      for (const sessionID of [...dormantInflight.keys()]) recoverInflight(sessionID);
    }
    // Phase 2.1 (memo §13): the three turn-state providers. They render nothing (and are not registered) under `off`.
    if (bgActive() && processor !== undefined) {
      const completing = processor;
      const LIVE_STATES: ReadonlySet<Attempt["state"]> = new Set<Attempt["state"]>(["acknowledged", "child-ended", "processing"]);
      const unregisters = [
          turnState.registerTurnStateProvider({
            name: "completed", order: PROVIDER_ORDER.completed,
            render: (sid) => renderCompleted(completing.completedFor(sid)),
            active: (sid) => completing.completedFor(sid).length > 0,
          }),
          turnState.registerTurnStateProvider({
            name: "held", order: PROVIDER_ORDER.held,
            render: (sid) => renderHeld(held.heldFor(sid)),
            active: (sid) => held.heldFor(sid).length > 0,
          }),
          turnState.registerTurnStateProvider({
            name: "in-flight", order: PROVIDER_ORDER.inFlight,
            render: (sid) => renderInFlight(inflight.listForParent(sid).filter((attempt) => LIVE_STATES.has(attempt.state)), nowMs()),
            active: (sid) => inflight.listForParent(sid).some((attempt) => LIVE_STATES.has(attempt.state)),
          }),
      ];
      registrations.push({ dispose: async () => { for (const unregister of unregisters) unregister(); } });
    }
    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      // 2.2: the result names the child. A dispatch still waiting for it is registered under it, and a heuristic claim that picked
      // the wrong child is corrected here, before the legacy hook below records the verdict. A call without a result is just dropped.
      const resultChild = event.status === "completed" ? childSessionOf(event.result) : null;
      dispatchRouter.onCallResult(event.id, resultChild);
      const runNote = runNotes.get(event.id);
      runNotes.delete(event.id);
      // Phase 2.1 (memo §4.3 steps 1-2). Timing: a non-null child binds the open start; a null child drops it.
      let ackText: string | undefined;
      if (event.tool === "subagent") {
        const running = resultChild !== null && ((event as { result?: { output?: { status?: unknown } } }).result)?.output?.status === "running";
        if (timings !== undefined) {
          try {
            if (resultChild === null) timings.cancelStart(event.id);
            else {
              timings.bindChild(event.id, resultChild);
              if (running) timings.setBackground(event.id, true);
            }
          } catch (error) {
            ingestLogger.warn("[router] timing: the dispatch result could not be recorded", { error: String(error) });
          }
        }
        if (resultChild === null) inflight.cancel(event.id);
        // A running result under mode ≠ off with a root parent: register the attempt (and its hold) BEFORE anything can render a completion.
        const parent = String(event.sessionID);
        const rec = running && bgActive() && finishApi !== undefined ? inflight.byCall(event.id) : undefined;
        if (rec !== undefined && resultChild !== null && knownKindOf(parent) === "root") {
          try {
            const hold = verifyingCalls.has(event.id) && rec.verificationMode === "required" && held.available && !reloadFailed && finishApi?.canHold(parent) === true;
            const handle = hold ? finishApi?.reserveHeld(parent, event.id) : undefined;
            const attempt = inflight.acknowledge(event.id, resultChild, {
              userBackgrounded: rec.decision.background !== true, ...(handle === undefined ? {} : { hold: { handle } }),
            });
            if (attempt !== undefined) {
              const notRunning = `[router] Running in the background (${resultChild}).`;
              ackText = handle !== undefined ? `${notRunning} Its result is held until verification finishes.`
                : verifyingCalls.has(event.id) ? `${notRunning} Its result will arrive unverified; the verdict follows in the router state.`
                : `${notRunning} Router guarantees apply when it completes.`;
              await journal.append({
                v: 1, kind: "inflight", key: attempt.key, callID: event.id, parentSessionID: parent, childSessionID: resultChild,
                label: attemptLabel(attempt), ...(handle === undefined ? {} : { handle }), at: nowMs(),
                agent: rec.agent, description: rec.description, verifying: rec.verifying, verificationMode: rec.verificationMode,
                ...(rec.role === undefined ? {} : { role: rec.role }), hold: handle ?? null,
              }, { fsync: true });
              if (handle !== undefined) {
                await held.hold({ handle, parentSessionID: parent, childSessionID: resultChild, callID: event.id, label: attemptLabel(attempt) });
              }
              const early = inflight.takeEarlyEnd(resultChild);
              if (early !== undefined) void processor?.process(resultChild, { kind: "early-end", end: early });
            }
          } catch (error) {
            ingestLogger.warn("[router] background: the dispatch could not be registered as running", { error: String(error) });
          }
        }
      }
      const role = event.tool === "subagent" ? await roleAfterCall({
        id: event.id, sessionID: String(event.sessionID), status: event.status,
        result: (event as { result?: unknown }).result, input: (event as { input?: unknown }).input,
      }) : undefined;
      try {
      const depthBanner = depthBanners.get(event.id);
      // The role notices ride with the depth banner: appended last to the parent's result on every path below.
      const banner = role?.notice === undefined ? depthBanner : depthBanner === undefined ? role.notice : `${depthBanner}\n\n${role.notice}`;
      depthBanners.delete(event.id);
      const verifying = verifyingCalls.delete(event.id);
      // QA-G-A3-2: a role child's call the host refused on a permission (the agent's policy, or this adapter's `evaluate` deny) never
      // ran and never reached the guard's after-hook: the plugin counts it like the guard's own refusals.
      if (event.status === "error" && isPermissionRefusal(event.error)) {
        const agent = roleAgentName(event.agent) ?? (typeof event.agent === "string" && event.agent !== "" ? undefined : knownRoleSession(String(event.sessionID)));
        if (agent !== undefined) options.recordRefusal?.(String(event.sessionID), agent, event.tool, (event as { input?: unknown }).input);
      }
      if (event.status !== "completed") {
        if (event.tool === "subagent") inflight.cancel(event.id);
        return;
      }
      // Phase 2.1: a completed (non-running) subagent result is terminal for the processor: the legacy path ran in-line.
      if (event.tool === "subagent" && resultChild !== null && ackText === undefined
        && (event.result as { output?: { status?: unknown } } | undefined)?.output?.status !== "running") {
        inflight.foreground(event.id, resultChild);
      }
      // 1.3 (memo §14.3): a `router_run` result carries the contamination note the lease check produced in `execute.before`.
      if (event.tool === "router_run" && runNote !== undefined) {
        const base = Array.isArray(event.result.content) ? [...event.result.content]
          : typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : [];
        event.result = { ...event.result, content: [...base, { type: "text" as const, text: runNote }] };
      }
      if (event.tool === "grep" && protectedAgent(event.agent)) {
        const content = event.result.content;
        event.result = {
          ...event.result,
          content: filterSensitiveGrep(contentText(content)),
          // Native grep also exposes raw matches to SDK callers. Do not leave
          // their text behind after scrubbing the model-facing representation.
          ...(Array.isArray(event.result.output) ? { output: event.result.output.filter(match => {
            if (!match || typeof match !== "object" || !("entry" in match)) return false;
            const entry = match.entry;
            return entry !== null && typeof entry === "object" && "path" in entry
              && typeof entry.path === "string" && !isSensitivePath(entry.path);
          }) } : {}),
        };
      }
      // QA-G-A3-4 (§2.5): a role child's own text reaches the parent, and a line of it that starts with `[router` would pose as a
      // router note (`[router budget] … resume …`, `[router ✓ verified: deterministic]`). Every such line start of the child's
      // text is defanged to `(router` BEFORE the router reads the result and appends its own notes. Role dispatches only: a tier
      // dispatch's result is untouched (I1); a running acknowledgement is the host's text, not the child's.
      if (role !== undefined && event.tool === "subagent" && event.result.output?.status !== "running") {
        event.result = defangChildResult(event.result);
      }
      // 1.3 (memo §14.2): `glob`/`grep` of a child session: entries under edit by another holder are left out, plus one note line.
      if (leaseGuard !== undefined && (event.tool === "glob" || event.tool === "grep")) {
        try {
          // The guard gets the host result exactly as received (`content` + `output`) and filters both forms by the same paths.
          const searched = leaseGuard.afterSearch({ sessionID: String(event.sessionID), tool: event.tool, result: event.result });
          if (searched !== undefined && searched.result !== null && typeof searched.result === "object" && !Array.isArray(searched.result)) {
            const merged: typeof event.result = { ...event.result, ...searched.result };
            const note = searched.note;
            const body: unknown = merged.content;
            event.result = note === undefined ? merged : {
              ...merged,
              content: Array.isArray(body) ? [...body, { type: "text" as const, text: note }]
                : [{ type: "text" as const, text: typeof body === "string" ? `${body.trimEnd()}\n${note}` : note }],
            };
          }
        } catch (error) {
          ingestLogger.warn("[router] leases: a search result could not be filtered", { error: String(error) });
        }
      }
      const structured = event.result.output;
      // A user can background a foreground subagent while it is running. That
      // acknowledgement is not a final result and must never enter acceptance.
      if (event.tool === "subagent" && structured?.status === "running") {
        const notices = [
          ...(ackText !== undefined ? [ackText]
            : verifying ? ["[router] This subagent is still running. Its result has not been verified; automatic acceptance requires a completed foreground return."] : []),
          ...(banner === undefined ? [] : [banner]),
        ];
        if (!notices.length) return;
        const notice = notices.join("\n\n");
        const content = Array.isArray(event.result.content) ? [...event.result.content]
          : typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : [];
        event.result = {
          ...event.result,
          content: [...content, { type: "text", text: notice }],
          output: { ...structured, output: `${typeof structured.output === "string" ? structured.output + "\n\n" : ""}${notice}` },
        };
        return;
      }
      const text = event.tool === "subagent" && structured && typeof structured === "object" && typeof structured.output === "string"
        ? structured.output : contentText(event.result.content);
      // QA-P21-1-3: the plugin's signals and gate read the child from the legacy metadata; a role result names it there too when
      // the host reports it only in the structured output (spike S1: `result.output.sessionID`). Tier calls: unchanged.
      const resultMetadata = event.result.metadata as Record<string, unknown> | undefined;
      const output = {
        title: "", output: text,
        metadata: {
          ...resultMetadata,
          ...(role?.child != null && resultMetadata?.sessionID === undefined && resultMetadata?.sessionId === undefined ? { sessionID: role.child } : {}),
        },
      };
      await within(hookContext(event), async () => {
        await legacy["tool.execute.after"]?.({
          ...event, tool: legacyToolName(event.tool),
          callID: event.id, args: await scopedArgs(event),
        }, output);
      });
      const changed = output.output !== text;
      if (!changed && banner === undefined) return;
      const routed = changed ? translateAdded(text, output.output) : text;
      const final = banner === undefined ? routed : [routed.trimEnd(), banner].filter(Boolean).join("\n\n");
      const content = Array.isArray(event.result.content) ? [...event.result.content]
        : typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : [];
      const childText = text.trimEnd();
      const routedText = routed.trimEnd();
      let visible;
      if (event.tool === "subagent" && structured && typeof structured === "object" && typeof structured.output === "string"
        && content.some((part) => part.type === "text") && routedText.startsWith(childText)) {
        // The host's visible text owns the session envelope (and resume handle).
        // Footer helpers trim the bare output. Compare trimmed tails before taking
        // only the router's suffix; other rewrites must replace, not repeat, it.
        const suffix = changed ? routedText.slice(childText.length) : "";
        const notices = [suffix, banner].filter((part) => part !== undefined && part !== "").join("\n\n");
        visible = [
          ...content,
          ...(notices ? [{ type: "text" as const, text: notices }] : []),
        ];
      } else {
        visible = [{ type: "text" as const, text: final }, ...content.filter((part) => part.type !== "text")];
      }
      event.result = {
        ...event.result,
        content: visible,
        metadata: output.metadata,
        ...(typeof structured === "string" ? { output: final }
          : structured && typeof structured === "object" && typeof structured.output === "string"
            ? { output: { ...structured, output: final } } : {}),
      };
      } finally {
        role?.finish();
        if (event.tool === "subagent") forgetRoutedRole(event.id);
      }
    }));

    // V2 events are immutable facts. A completed-text warning is a synthetic
    // transcript entry, instead of mutating an already-persisted text part.
    eventTask = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (abort.signal.aborted) break;
        try {
          const data = event.data as Record<string, any>;
          hostBudget.onEvent(event.type, data); // handoff 22 (S4): step counts, step-limit tool refusals, overflow failures
          // QA-P23-2-A1 / QA-P23-3-1: the host names a tool result's saved full output on that session's tool-success event only.
          if (HOST_TOOL_SUCCESS_EVENT.test(event.type) && data && Array.isArray(data.outputPaths)) {
            rememberOutputs(data.sessionID, data.outputPaths.filter((path: unknown): path is string => typeof path === "string"));
          }
          // Phase 2.1 (memo §4.6): timing, leases and the completion processor, before any existing `continue` below.
          if (typeof data?.sessionID === "string") {
            const sid: string = data.sessionID;
            if (event.type === "session.created") {
              noteSessionKind(sid, data.parentID ? "child" : "root");
              if (!data.parentID) timings?.markRootSession(sid);
            } else if (event.type === "session.step.ended") {
              if (timings !== undefined) {
                if (timings.isRootSession(sid)) {
                  const tokens = typeof data.tokens === "object" && data.tokens !== null ? data.tokens as Record<string, any> : {};
                  timings.onRootStep(sid, {
                    input: Number(tokens.input) || 0, cacheRead: Number(tokens.cache?.read) || 0, cacheWrite: Number(tokens.cache?.write) || 0,
                  }, event.id);
                } else if (!sessionKinds.has(sid)) {
                  const recorder = timings; // one lazy lookup per unregistered session (cached by sessionKindOf), not awaited
                  void sessionKindOf(sid).then((kind) => { if (kind === "root") recorder.markRootSession(sid); });
                }
              }
            } else if (event.type === "session.step.failed" || event.type === "session.retry.scheduled") {
              const failure: unknown = data.error ?? data;
              const detail = typeof failure === "object" && failure !== null ? failure as { type?: unknown; status?: unknown } : {};
              const capacity = classifyCapacity({
                type: typeof detail.type === "string" ? detail.type : null, status: typeof detail.status === "number" ? detail.status : null,
              });
              if (capacity !== null) timings?.onCapacitySignal(sid, capacity, nowMs());
            } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
              const outcome = event.type === "session.execution.succeeded" ? "succeeded" : event.type === "session.execution.failed" ? "failed" : "interrupted";
              const created: unknown = (event as { created?: unknown }).created;
              const at = created instanceof Date ? created.getTime() : typeof created === "number" ? created : nowMs();
              if (timings !== undefined) await timings.onExecutionOutcome(sid, event.id, outcome, at);
              leaseGuard?.releaseChild(sid);
              leaseHandle?.notifyReleased();
              if (bgActive() && processor !== undefined) {
                const attempt = inflight.byChild(sid);
                if (attempt !== undefined) {
                  if (attempt.state === "acknowledged") void processor.process(sid, { kind: "end-event", outcome, eventID: event.id, at });
                } else if (sessionKinds.get(sid) === "child") {
                  inflight.noteEarlyEnd(sid, { outcome, eventID: event.id, at });
                }
                if (sessionKinds.get(sid) === "root") processor.endTurn(sid);
              }
            }
          }
          if (event.type === "session.step.ended" || event.type === "session.step.failed") {
            // Cost and tokens of a registered child dispatch (ingest ignores every other session).
            await ingesting(event.type, () => ingest.onStepEnded(event));
            continue;
          }
          // A new child session: the dispatch the engine routed for it is registered with the 2.1 registry (2.2).
          if (event.type === "session.created") dispatchRouter.onSessionCreated({ sessionID: data.sessionID, parentID: data.parentID, agent: data.agent, title: data.title });
          if (event.type === "session.deleted") {
            runtime?.forgetSession?.(data.sessionID);
            // #84 P2.1 (handoff 35): the session's binding (as a parent: its pending dispatches and children's bindings) and its
            // authority requests go with it.
            if (typeof data.sessionID === "string") {
              evictBinding(data.sessionID);
              evictAuthority(data.sessionID);
              ownOutputs.delete(data.sessionID); // QA-P23-2-A1
              lookupNamedAgent.delete(data.sessionID);
              lastCallOfChild.delete(data.sessionID);
              hostBudget.forget(data.sessionID);
              effortStore.forget(data.sessionID); // #90 P1.2: a deleted session is no longer answered
              // Phase 2.1 (memo §4.6): the session's attempts, holds, leases and cached kind go with it.
              inflight.forgetSession(data.sessionID);
              processor?.forgetSession(data.sessionID);
              held.forgetSession(data.sessionID);
              leaseGuard?.releaseChild(data.sessionID);
              leaseHandle?.notifyReleased();
              sessionKinds.delete(data.sessionID);
            }
            await ingesting("session.deleted", () => ingest.onSessionGone(data.sessionID));
          } else if (FLUSH_EVENT_TYPES.has(event.type)) {
            // The v2 equivalents of session.idle: coalesced, throttled flush (D15); never awaited.
            await ingesting(event.type, () => {
              // The child's attempt is over: fold it before the flush that persists it.
              if (EXECUTION_END_TYPES.has(event.type)) ingest.onExecutionEnded(data.sessionID, event.id);
              ingest.sweep();
              ingest.requestFlush();
            });
          }
          if (event.type === "session.text.ended") {
            const output = { text: data.text };
            await legacy["experimental.text.complete"]?.({ sessionID: data.sessionID, messageID: data.assistantMessageID }, output);
            if (typeof data.text === "string" && output.text.startsWith(data.text) && output.text !== data.text && !abort.signal.aborted) {
              await ctx.session.synthetic({ sessionID: data.sessionID, text: output.text.slice(data.text.length).trim(), description: "Model router narration warning", resume: false });
            }
            continue;
          }
          const translated = event.type === "session.created"
            ? { type: event.type, properties: { info: { ...data, id: data.sessionID } } }
            : event.type === "session.deleted"
              ? { type: event.type, properties: { info: { id: data.sessionID } } }
              : ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)
                ? { type: "session.idle", properties: { sessionID: data.sessionID } } : undefined;
          if (translated) await legacy.event?.({ event: translated }, undefined);
        } catch (error) {
          if (!abort.signal.aborted) console.warn("[model-router] OpenCode 2 event handling failed", error);
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) console.warn("[model-router] OpenCode 2 event subscription failed", error);
    });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
