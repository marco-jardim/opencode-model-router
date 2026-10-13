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
import { basename, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { loadConfig, resolveRolesRouting } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { DEFER_MISSING_SUBAGENT_NOTICE, HOST_SEED_AGENTS, resolveSubagentOverrides } from "../router/subagents";
import { warnAgentOptionsEffortOnce } from "../router/agent-options";
import { pluginAgentMarker } from "../router/plugin-agents";
import { registerRoleAgents, roleAgentAlias, roleAgentOf, roleAgentSteps } from "../router/role-agents";
import { readApprovals, type RepoApproval } from "../routing/roles/approvals";
// Static, not `await import`: a dynamic import made a bundle split src/router/config.ts into a chunk where its tiers.json
// lookup fails.
import { approvalReloadLine, approvalsChangedOf } from "../commands/approvals";
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
  BINDING_NOTES, bind, bindPlanChild, currentBinding, evict as evictBinding, evictCall, type Binding, type SessionLookup,
} from "../routing/roles/binding";
import type { DispatchGrant } from "../routing/roles/policy";
import { forgetWorkingSet, workingSetOf } from "../routing/wire/working-set";
import {
  createRepoProbe, displaySafe, gitMetadataSegment, readSetEligible, readSetPredicate, type InReadSet,
} from "../routing/roles/read-set";
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
// 3.1.7 W6: the `plan` provider after the background ones (completed 30, held 40, in-flight 50), before the route hint (90).
import { PLAN_PROVIDER_NAME, PLAN_PROVIDER_ORDER } from "./turn-state";
import { CONTEXT7_DOC_TOOLS, evaluatePermission, permissionMatches, permissionRules, publishReadOnlyPermissions } from "../router/read-only";
import { filterSensitiveGrep, isSensitivePath } from "../router/sensitive-paths";
import { canonicalAuthorityPath, insideWorkRoot } from "../routing/roles/work-root";
import { appliedEffort, appliedThinkingBudget, createEffortStore, registerEffortChannel } from "../tui/effort-channel";
import {
  acquireLeaseRegistry, ADOPTION_RETRY_MS, attemptLabel, COMPLETION_SETTLE_MS, createCompletionProcessor, createHeldResults, createInFlightRegistry,
  isExecutorOwned,
  createLeaseGuard, decideBackground, isAdoptionRefused, PENDING_GUARANTEES_TEXT, PROVIDER_ORDER, renderCompleted, renderHeld, renderInFlight,
  restoredDispatchOf, ROUTER_FINISH_ATTACH,
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
  RestoredDispatch, RestoredHold, RestoredHolds,
} from "./background";
import { PENDING_JOURNAL_VANISHED, pendingRecordIdentity } from "../verify/pending";
import type { ExecutorRuntimeHandle, LeaseRegistryPort } from "../executor/runtime";
import type {
  ChildEnd, ChildRunner, DispatchBookkeeping, HostError, HostSessionContext, HostSessionEvent, HostSessions, IsoTime, LaunchRequest, MetricPayload, PlanId, RouteResolver,
  SlotVerifier, TaskLauncher,
} from "../executor/types";
import type { PlanRoleBindings } from "../executor/launch";
import { LAUNCH_HEADER_PATTERN, parseLaunchHeader, type LaunchHeaderFields } from "../executor/types";
import { withoutHostPreamble } from "../executor/host-preamble";
import { grantFor } from "../routing/roles/policy";
import { NEEDS, UNKNOWN_FACTS, type Need } from "../routing/classify/types";

/** §7 grammar (`formatLaunchPrompt`): every launcher prompt starts with this line. */
const PLAN_CONTEXT_PREFIX = "PLAN CONTEXT\n";

/**
 * The status of an executor launch's `runner` trigger. QA-3.1 nit 4: the child's observed end (`execution.*`) decides;
 * QA-3.1-24: else the launch's settled end kind the launcher passes (its runner result can settle before the child's
 * `execution.succeeded` is seen); else the registry's outcome. A child that settled with none of them (lost, cancelled, a
 * runner error) did not succeed: interrupted.
 */
export function executorRunnerStatus(
  observed: "succeeded" | "failed" | "interrupted" | undefined,
  settled: ChildEnd["kind"] | undefined,
  registry: string | undefined,
): "succeeded" | "failed" | "interrupted" {
  if (observed !== undefined) return observed;
  if (settled === "completed") return "succeeded";
  if (settled === "failed" || settled === "capacity") return "failed";
  if (settled === "interrupted") return "interrupted";
  return registry === "succeeded" || registry === "failed" || registry === "interrupted" ? registry : "interrupted";
}

/**
 * QA-4.2-27: the kind of one entry of a child's host history, with the one precedence every reader of that history uses. The
 * host's context entries are discriminated by `type` ("user" | "assistant" | "synthetic"); model-facing messages use `role`:
 * `type: "synthetic"` first, then assistant (either field), then user (either field); anything else (a tool turn) is `other`.
 */
export function historyEntryKind(message: unknown): "synthetic" | "assistant" | "user" | "other" {
  if (message === null || typeof message !== "object") return "other";
  const m = message as Record<string, unknown>;
  if (m.type === "synthetic") return "synthetic";
  if (m.type === "assistant" || m.role === "assistant") return "assistant";
  if (m.type === "user" || m.role === "user") return "user";
  return "other";
}

/** QA-4.2-27: what a child's own history says about its end (`childHistoryEnd`). */
export type ChildHistoryEnd =
  /** No entry but synthetic ones. */
  | { kind: "none" }
  /** QA-DF1-21: a user or tool turn last, or a step without its end (cut mid-stream or mid-tool-call): it may still run. */
  | { kind: "open" }
  /** The newest step ended; `text` is its text, absent when the step has none. */
  | { kind: "ended"; outcome: "succeeded" | "failed" | "interrupted"; text: string | undefined };

/**
 * QA-4.2-27: the ONE end rule over a child's own history (QA-2.1-6, QA-2.1-18, QA-DF1-21), shared by the background recovery
 * (`childEndState`) and the executor's `HostSessions.context` (`executorHostContext`). Synthetic entries are skipped; the newest
 * other entry decides. An assistant entry with an error failed (interrupted, for an abort, interrupt or cancel); one with a
 * completion marker (`assistantStepCompleted`: a finish reason other than `tool-calls`, or a completed time, and no open tool
 * part) succeeded, with or without text. Anything else is not an end.
 */
export function childHistoryEnd(history: unknown): ChildHistoryEnd {
  const entries: readonly unknown[] = Array.isArray(history) ? history : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index];
    const kind = historyEntryKind(message);
    if (kind === "synthetic") continue;
    if (kind !== "assistant") return { kind: "open" };
    const m = message as { error?: unknown; info?: { error?: unknown } };
    const text = messageText(message);
    const error = m.error ?? m.info?.error;
    if (error !== undefined && error !== null && error !== false) {
      const described = typeof error === "string" ? error : JSON.stringify(error) ?? "";
      return { kind: "ended", outcome: /abort|interrupt|cancel/i.test(described) ? "interrupted" : "failed", text };
    }
    // QA-2.1-18: text alone is not an end: a child cut mid-step has partial text.
    if (!assistantStepCompleted(message)) return { kind: "open" };
    return { kind: "ended", outcome: "succeeded", text };
  }
  return { kind: "none" };
}

/**
 * QA-4.2-2: the executor's `HostSessions.context` over the host's history (amendment to memo R1 rule 5). User and assistant
 * entries (`historyEntryKind`) keep their role and text; every other entry (synthetic, tool turns) is a non-terminal `assistant`
 * entry without text, never `idle`. One explicit terminal entry `{ role: "idle", text: null, outcome }` is appended ONLY when
 * the history shows the child ended (`childHistoryEnd`), with that end's real outcome. QA-4.2-27: a completed step without text
 * is an end (succeeded), as the live launcher treats it; the runtime then reads an empty result.
 */
export function executorHostContext(history: unknown): HostSessionContext {
  const entries: readonly unknown[] = Array.isArray(history) ? history : [];
  const messages: HostSessionContext["messages"] = entries.map((m) => {
    const kind = historyEntryKind(m);
    if (kind === "user") return { role: "user" as const, text: messageText(m) ?? null, outcome: null };
    if (kind === "assistant") return { role: "assistant" as const, text: messageText(m) ?? null, outcome: null };
    return { role: "assistant" as const, text: null, outcome: null };
  });
  const end = childHistoryEnd(entries);
  if (end.kind === "ended") messages.push({ role: "idle", text: null, outcome: end.outcome });
  return { messages };
}

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
  if (typeof m.content === "string") return m.content;
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
/**
 * Cross-repo P4.7 (SD-P4-11, spike T6): whether reloading the role agents after `/router approve` makes the host allow the
 * approved directory at once. True: the adapter says "Role agents reloaded; dispatch again with root=<path>."; false: "Restart
 * OpenCode to use it." (as after a failed reload).
 */
export const APPROVAL_RELOAD_APPLIES: boolean = true;

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

/**
 * What allowed a path action (QA-1 F6): every path inside the work root W, some only in the read set R (P1.5), or some only as the
 * session's own truncated output (QA-P23-2-A1) — the last one present wins (`own-output` over `read-set` over `work-root`).
 */
export type RoleAuthorityAllowance = "work-root" | "read-set" | "own-output";

/**
 * The decision for one role-session action: allowed (`via`: what allowed it, for an action with paths), or refused with the reason
 * the child sees.
 */
export type RoleAuthorityDecision =
  | { readonly allow: true; readonly via?: RoleAuthorityAllowance }
  | { readonly allow: false; readonly reason: string };

const ALLOW: RoleAuthorityDecision = Object.freeze({ allow: true });
const refuse = (reason: string): RoleAuthorityDecision => ({ allow: false, reason });
const ALLOWANCE_ORDER: readonly RoleAuthorityAllowance[] = ["work-root", "read-set", "own-output"];
/** The allowance of a decision over several paths: the widest one any path needed. */
const widerAllowance = (a: RoleAuthorityAllowance | undefined, b: RoleAuthorityAllowance): RoleAuthorityAllowance =>
  a === undefined || ALLOWANCE_ORDER.indexOf(b) > ALLOWANCE_ORDER.indexOf(a) ? b : a;
const allowedVia = (via: RoleAuthorityAllowance | undefined): RoleAuthorityDecision => (via === undefined ? ALLOW : { allow: true, via });

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
  /**
   * Cross-repo P1.5: the read set R beyond the work root (`routing/roles/read-set.ts`) — where a CANONICAL target lies when it is
   * in R, undefined (or no predicate at all) when it is not. Used only for an exact binding with a work root (I9): `read`, `glob`
   * and `grep` may reach R, `external_directory` too when the grant has a local read action; an edit never, it only names where
   * the file lies.
   */
  readonly inReadSet?: (canonicalTarget: string) => { readonly repository: string; readonly name: string; readonly branch: string | null } | undefined;
  /**
   * QA-1 F1: the paths are the host's own resources (`evaluate`): a relative `read`/`edit` resource is the host's Location-relative
   * form of a file the call's `execute.before` already checked as the call wrote it, so it may reach R. Without it (the call's own
   * arguments, `execute.before`) a relative path never reaches R: it resolves against the session directory, which may itself be
   * a repository of R, and the role would read another checkout's file silently.
   */
  readonly hostRelative?: boolean;
  /**
   * QA-1 F1: the one path is a `glob`/`grep` search root the call did not name (the session directory, or the host's `.`): it never
   * reaches R, only W.
   */
  readonly implicitRoot?: boolean;
}

/**
 * Cross-repo P1.5 (§5 refusal wording): where an edit outside the work root `root` lands — another worktree of the bound
 * repository (and the same file's path in the work root), or a repository of R this dispatch may only read. Undefined when it is
 * neither: the caller keeps the plain "outside this dispatch's work root" text.
 */
function editElsewhereReason(
  action: string, path: string, target: string, root: string, location: DispatchGrant["location"],
  readSet: RoleAuthorityInput["inReadSet"], canonicalOf: (path: string) => string | undefined,
): string | undefined {
  // QA-1 F2: names, branches and paths from the filesystem (and the call's own path) are echoed display-safe.
  const branch = (name: string | null): string => displaySafe(name ?? "(detached)");
  const shown = displaySafe(path);
  if (location !== undefined) {
    let match: { dir: string; branch: string | null } | undefined;
    for (const entry of location.worktrees) {
      const dir = canonicalOf(entry.path);
      if (dir === undefined || permissionMatches(dir, root) || !insideWorkRoot(target, dir)) continue;
      if (match === undefined || dir.length > match.dir.length) match = { dir, branch: entry.branch };
    }
    if (match !== undefined) {
      const rel = target.slice(match.dir.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
      return `${action}: ${shown} is in worktree ${displaySafe(match.dir)} (repository ${displaySafe(location.name)}, branch ${branch(match.branch)}); `
        + `this dispatch edits only in ${displaySafe(root)} (branch ${branch(location.branch)}). The same file in your work root is `
        + `${displaySafe(rel === "" ? root : join(root, rel))}.`;
    }
  }
  const repo = readSet?.(target);
  if (repo === undefined) return undefined;
  const name = displaySafe(repo.name);
  return `${action}: ${shown} is in repository ${name} (branch ${branch(repo.branch)}), which this dispatch may read but not edit. `
    + `Finish the ${displaySafe(location?.name ?? basename(root))} part and return NEED MORE: naming the ${name} change; it needs a dispatch with repo=${name}.`;
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
 * - `external_directory` (P-13): only an EXACT binding with a work root and a local action, every resource inside that root —
 *   or inside the read set R (cross-repo P1.5, `inReadSet`) when the grant has a local read action; an unknown binding or a grant
 *   without a root → refused (I9);
 * - cross-repo P1.5: `read`/`glob`/`grep` may also reach R (exact binding with a work root only); an edit outside W stays refused,
 *   and its text names another worktree of the bound repository or a repository of R ({@link editElsewhereReason});
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
  // Cross-repo P1.5: R beyond W only for an exact binding with a bound work root (I9: an unknown binding, or a grant without a
  // root, never reaches outside its directory).
  const readSet = binding.kind === "exact" && grant.workRoot !== null ? input.inReadSet : undefined;
  if (cls === "external_directory") {
    if (binding.kind !== "exact") return refuse("external_directory: this session is not bound to its dispatch (binding unknown, I9)");
    const root = grant.workRoot;
    if (![...grant.actions].some((a) => a === "read" || a === "glob" || a === "grep" || a === "router_git")) {
      return refuse("external_directory: this dispatch grants no local action");
    }
    if (input.paths.length === 0) return refuse("external_directory: no path to check");
    // QA-P23-2-A1: the directory of the session's own truncated output, for `read`/`grep` of exactly those files.
    const outputs = grant.actions.has("read") || grant.actions.has("grep") ? input.ownOutputs : undefined;
    // P1.5: a directory of R only for a grant with a local READ action; `router_git` alone keeps W only.
    const reads = grant.actions.has("read") || grant.actions.has("glob") || grant.actions.has("grep");
    let via: RoleAuthorityAllowance | undefined;
    for (const resource of input.paths) {
      const dir = resource.replace(/[\\/]\*$/, "");
      const target = dir === "" ? undefined : canonical(dir, input.sessionDirectory);
      if (target !== undefined && root !== null && insideWorkRoot(target, root)) {
        via = widerAllowance(via, "work-root");
        continue;
      }
      if (target !== undefined && ownOutputDirectory(target, outputs)) {
        via = widerAllowance(via, "own-output");
        continue;
      }
      // QA-1 F1/F7: the host's resources are canonical absolute; never `.git` or below in R.
      if (target !== undefined && reads && readSetEligible(dir, target) && readSet?.(target) !== undefined) {
        via = widerAllowance(via, "read-set");
        continue;
      }
      return refuse(root === null
        ? "external_directory: this dispatch has no work root (root=)"
        : `external_directory: ${resource} is outside this dispatch's work root ${root}`);
    }
    return allowedVia(via);
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
    // QA-1 F1: R only for a path the call wrote fully qualified (or the host's own Location-relative resource) and a search root
    // the call named; a relative path or a search without a path that lands outside W keeps the refusal it had before P1.5.
    const mayReachReadSet = (path: string, target: string): boolean =>
      cls !== "edit" && input.implicitRoot !== true && readSetEligible(path, target, input.hostRelative === true);
    let via: RoleAuthorityAllowance | undefined;
    for (const path of input.paths) {
      const target = canonical(path, input.sessionDirectory);
      if (target !== undefined && insideWorkRoot(target, root)) {
        if (cls === "edit" && editsGitMetadata(path, target, root)) {
          return refuse(`${action}: ${path} is repository metadata (\`.git\` or below it); a role never edits it`);
        }
        via = widerAllowance(via, "work-root");
        continue;
      }
      if (target !== undefined && (cls === "read" || cls === "grep") && ownOutput(target, input.ownOutputs)) { // QA-P23-2-A1
        via = widerAllowance(via, "own-output");
        continue;
      }
      if (target !== undefined && mayReachReadSet(path, target) && readSet?.(target) !== undefined) { // P1.5: read/glob/grep in R
        via = widerAllowance(via, "read-set");
        continue;
      }
      const elsewhere = cls === "edit" && target !== undefined
        ? editElsewhereReason(action, path, target, root, grant.location, readSet, (named) => canonical(named, input.sessionDirectory))
        : undefined;
      if (elsewhere !== undefined) return refuse(elsewhere);
      return refuse(`${action}: ${path} is outside this dispatch's work root ${root} (use an absolute path inside it)`);
    }
    return allowedVia(via);
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
// Further attributes after `state` (the host may add some) are tolerated and kept.
const COMPLETION_ELEMENT = /<subagent sessionID="([^"]+)" state="([^"]+)"[^>]*>([\s\S]*?)(?:<\/subagent>|$)/g;

/** QA-2.1-8: the refusal of a resume while the pending journal is not reloaded (the session may be held). */
export function reloadFailedResumeText(child: string): string {
  // QA-2.1-16: the retry is real: each refused call (and each later hook or event) starts another reload, or rebuilds a
  // vanished journal, at most every PENDING_RELOAD_RETRY_MS.
  return `[router] Refused: the router could not reload its pending journal, so session ${child} may be held for verification. Try the resume again shortly: each attempt makes the router retry the reload (at most every ${PENDING_RELOAD_RETRY_MS / 1000} s).`;
}

/** QA-2.1-20: a `sessionID` / `task_id` key given a string literal in Code Mode code (`sessionID: "x"`, `"task_id": 'x'`, `task_id = "x"`). */
const CODE_RESUME_TARGET = /\b(?:sessionID|task_id)["']?\s*[:=]\s*(["'`])([^"'`\r\n]+)\1/g;

/**
 * QA-2.1-8 / QA-2.1-20: the sessions a tool call may resume: a `subagent` call's `sessionID` / `task_id`, and for Code Mode
 * `execute` every string literal its code gives to those keys (the caller's own session excepted: it is not a resume). The
 * reload-failed refusal reads the same calls `held.refusal` does (`subagent` args and `execute` code).
 */
export function resumeTargetsOf(tool: string, args: unknown, caller: string): string[] {
  if (args === null || typeof args !== "object") return [];
  if (tool === "subagent") {
    return ["sessionID", "task_id"].flatMap((key) => {
      const target: unknown = Reflect.get(args, key);
      return typeof target === "string" && target !== "" ? [target] : [];
    });
  }
  if (tool !== "execute") return [];
  const code: unknown = Reflect.get(args, "code");
  if (typeof code !== "string") return [];
  const targets = new Set<string>();
  for (const match of code.matchAll(CODE_RESUME_TARGET)) {
    const target = match[2];
    if (target !== undefined && target !== "" && target !== caller) targets.add(target);
  }
  return [...targets];
}

/** QA-2.1-6: what a persisted dispatch's child history says about its end. */
/** `incomplete` (QA-DF1-21): the child's last step has no end (no step end, no execution end): it may still be running. */
type ChildEndState =
  | { outcome: "succeeded" | "failed" | "interrupted"; text?: string }
  | { outcome: "lost"; text?: undefined; incomplete?: boolean };

/**
 * QA-2.1-18: whether an assistant entry of a child's history ended its step (top level or under `info`): a finish reason other
 * than a tool-call continuation, or a completed time; and no tool part still `pending` or `running`. A step cut mid-stream has
 * none of these, and a `tool-calls` finish means the child meant to go on: neither is an end, whatever text it already has.
 */
function assistantStepCompleted(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  const info = m.info !== null && typeof m.info === "object" ? m.info as Record<string, unknown> : undefined;
  const parts: readonly unknown[] = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
  const toolOpen = parts.some((part) => {
    if (part === null || typeof part !== "object" || (part as Record<string, unknown>).type !== "tool") return false;
    const state = (part as Record<string, unknown>).state;
    const status = state !== null && typeof state === "object" ? (state as Record<string, unknown>).status : state ?? (part as Record<string, unknown>).status;
    // The v2 tool state is `streaming` | `running` | `completed` | `error` (`pending` is the v1 name of the first).
    return status === "streaming" || status === "pending" || status === "running";
  });
  if (toolOpen) return false;
  const finish = m.finish ?? info?.finish;
  if (typeof finish === "string" && finish !== "") return finish !== "tool-calls" && finish !== "unknown";
  const time = m.time ?? info?.time;
  // `time.completed` is set once the step ended: epoch millis on the wire, a DateTime once decoded; either counts.
  const completed = time !== null && typeof time === "object" ? (time as Record<string, unknown>).completed : undefined;
  return completed !== undefined && completed !== null && completed !== "" && completed !== false;
}

/**
 * QA-2.1-11: a failed session-directory lookup is not repeated for this long (the lease guard calls it per tool call).
 * QA-2.1-25: a failed directory means no lease check and no lease for that call, like a failed kind, so the window is as short.
 */
export const SESSION_DIR_NEGATIVE_TTL_MS = 2_000;
/**
 * QA-2.1-25: a failed session-kind lookup is not repeated for this long. Short on purpose: the failure answers `unknown` (root
 * semantics, no lease), so a write in that window is unguarded; the window only spares a burst of tool calls a failing host call each.
 */
export const SESSION_KIND_NEGATIVE_TTL_MS = 2_000;
/**
 * DF-1.1-4: the lease registry's `repoKeyOf` seam. Write keys are per checkout (`repo` = the work tree), so ordinary writers
 * of one repo-relative path in two linked worktrees of a repository never refuse each other. `shared` (the common git
 * directory every linked worktree has) keeps the leases of plan tasks (`until-integrated`) repository-wide: the tasks of a
 * plan are integrated into one branch.
 */
export function leaseRepoKeyOf(dir: string): { repo: string; tree: string; shared: string } | undefined {
  const id = repositoryIdentity(dir);
  return id === undefined ? undefined : { repo: id.tree, tree: id.tree, shared: id.repo };
}
/**
 * QA-DF1-23 (DF-1-9): the background decision waits at most this long for the kind of an unrecorded parent; past it the parent
 * is no root (the dispatch stays foreground). Short: the dispatch's `execute.before` waits for it.
 */
export const SESSION_KIND_DISPATCH_TIMEOUT_MS = 1_000;
/** QA-2.1-11: session directories cached (oldest first out). */
const MAX_SESSION_DIRS = 1000;
/** QA-2.1-13: parent sessions remembered as adopted (oldest first out). */
const MAX_ADOPTED_SESSIONS = 5000;
/** DF-1-4: the children whose completion elements are remembered, and the elements kept per child. */
const MAX_SEEN_COMPLETION_CHILDREN = 1000;
const MAX_SEEN_COMPLETION_ELEMENTS = 64;
/** QA-2.1-8: a failed pending-journal reload is tried again at most this often (fail closed meanwhile). */
export const PENDING_RELOAD_RETRY_MS = 30_000;
/** QA-2.1-8: `dispose` waits at most this long for the background work in flight (verdict posts, recoveries). */
const BACKGROUND_DRAIN_MS = 5_000;
/**
 * Non-enumerable slot on the cleanup function `registerV2Hooks` returns: `() => Promise<void>` that resolves once no background
 * work is in flight (verdict posts, recoveries, reloads, including work they start). Lets integration tests await what an
 * adoption or a gate started instead of polling for it; nothing in the plugin reads it.
 */
export const V2_BACKGROUND_SETTLED: unique symbol = Symbol("opencode-model-router.v2.background-settled");
// QA-2.1-26: a module-private `Symbol()` (not the global registry `Symbol.for`): only code importing this module reaches the seam.

/** The completion elements of a text part that STARTS with one (the host writes a completion as a whole message, C2). */
function completionElementsOf(text: string): CompletionElement[] {
  if (!text.trimStart().startsWith("<subagent sessionID=\"")) return [];
  const found: CompletionElement[] = [];
  for (const m of text.matchAll(COMPLETION_ELEMENT)) {
    const state = m[2];
    if (state !== "completed" && state !== "error" && state !== "cancelled") continue;
    found.push({ child: m[1] ?? "", state, body: m[3] ?? "" });
  }
  return found;
}

/** QA-DF1-21: the global slot of this process's journal token (`Symbol.for`: one token for every module copy in the process). */
const PROCESS_TOKEN_SLOT = Symbol.for("opencode-model-router.v2.process-token");
/**
 * QA-DF1-21: this process's identity, stamped on the `inflight` records it journals. A record bearing it was written by an
 * instance of this very process (an owning location the host evicted), never by an earlier one: a later process may reuse the
 * pid, never the token.
 */
export function processToken(): string {
  const known: unknown = Reflect.get(globalThis, PROCESS_TOKEN_SLOT);
  if (typeof known === "string") return known;
  const token = `${process.pid.toString(16)}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  Reflect.set(globalThis, PROCESS_TOKEN_SLOT, token);
  return token;
}

/**
 * QA-DF1-20: the identity of the message that holds a completion element, never its content: the host's message id when the
 * message carries one, else its position in the request's history (a session's history only grows between its requests).
 */
function completionMessageKey(message: object, index: number): string {
  const id = "id" in message ? message.id : undefined;
  if (typeof id === "string" && id !== "") return `id:${id}`;
  return `at:${index}`;
}

/** Applies `defang` to the body of every `<subagent …>` element of a text (a pure rewrite; the element tags stay). */
function defangSubagentBodies(text: string, defang: (body: string) => string): string {
  if (!text.includes("<subagent sessionID=\"")) return text;
  return text.replace(COMPLETION_ELEMENT, (whole: string, _child: string, _state: string, body: string) => {
    const next = defang(body);
    if (next === body) return whole;
    const closed = whole.endsWith("</subagent>");
    const open = whole.slice(0, whole.length - body.length - (closed ? "</subagent>".length : 0));
    return `${open}${next}${closed ? "</subagent>" : ""}`;
  });
}

/** Memo §12 (fail closed): replaces the body of every completion element whose child `isProcessed` rejects. Pure; the element tags stay. */
function redactUnprocessedElements(text: string, isProcessed: (child: string) => boolean): string {
  if (!text.includes("<subagent sessionID=\"")) return text;
  return text.replace(COMPLETION_ELEMENT, (whole: string, child: string, _state: string, was: string) => {
    if (isProcessed(child)) return whole;
    const body = `[router] The result of session ${child} is withheld: the router could not restore its verification state.`;
    const closed = whole.endsWith("</subagent>");
    const open = whole.slice(0, whole.length - was.length - (closed ? "</subagent>".length : 0));
    return `${open}${body}${closed ? "</subagent>" : ""}`;
  });
}

/** 3.1.7 W4: a v2 event error (`type`, `message`, an optional HTTP status) as the executor's `HostError`. */
function toHostError(error: unknown): HostError {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const type = typeof record.type === "string" ? record.type : typeof record.name === "string" ? record.name : "unknown";
  const message = typeof record.message === "string" ? record.message : typeof error === "string" ? error : "";
  const raw = record.status ?? record.statusCode;
  return { type, status: typeof raw === "number" && Number.isFinite(raw) ? raw : null, message };
}

/**
 * Host adapters v2-hooks builds for the plan executor (3.1.7 W1, memo 3.1.1 §8). The executor factory composes the
 * launcher and the runtime over them; v2-hooks never constructs the runtime itself (its collaborators arrive later).
 */
export interface V2ExecutorHost {
  /** `HostSessions` over `ctx.session` plus the one host-event emitter (M46). */
  hosts: HostSessions;
  /**
   * The routing kernel with the tier pin and the agent/model. null here: `dispatchRouter.route` is asynchronous and the port is
   * synchronous, so the factory supplies the resolver (open for 3.1.8 / 5.1).
   */
  routes: RouteResolver | null;
  /** `bindPlanChild` / binding.ts `evict`. */
  bindings: PlanRoleBindings;
  /** Decision row, dispatch start and the background in-flight registry; rows tagged `source: "executor"`. */
  bookkeeping: DispatchBookkeeping;
  /** The verification engine as a slot verifier; null when this host has none. */
  verifier: SlotVerifier | null;
  /** The Phase 1.3 lease registry; null when this host has none. */
  leaseRegistry: LeaseRegistryPort | null;
  /** The child runner the launcher drives (v2-client); null when the runtime passed to v2-hooks has none. */
  runner: ChildRunner | null;
  /** `childRunner.pin`: keeps the orchestrator's retained context alive while its plan runs. */
  pinOrchestrator(sessionID: string): () => void;
  /** `TaskLauncherDeps.onMetric`: forwards to `ExecutorRuntimeHandle.recordMetric` once the executor exists. */
  onLauncherMetric(planId: PlanId, m: MetricPayload): void;
  /** `TaskLauncherDeps.knownAgent`. */
  knownAgent(agent: string): boolean;
  /** Plugin lifetime (`TaskLauncherDeps.lifetime`); aborted on dispose. */
  lifetime: AbortSignal;
}

/** The composed executor: the runtime plus the launcher it drives (W7 disposes both, runtime first). */
export interface V2Executor {
  runtime: ExecutorRuntimeHandle;
  launcher: Pick<TaskLauncher, "dispose">;
}

/** Builds the executor over the host adapters, or null when the executor is not enabled (M3: then nothing changes). */
export type V2ExecutorFactory = (host: V2ExecutorHost) => V2Executor | null;

export async function registerV2Hooks(
  ctx: Context,
  hooks: Hooks,
  runtime?: Pick<V2Runtime, "withToolContext" | "applyChildSystem"> & Partial<Pick<V2Runtime, "dispose" | "forgetSession" | "childRunner">>,
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
    /** Cross-repo Phase 4 (SD-P4-15): directory of the repository approvals store read at role registration. Default: `dirname(statePath())` (approvals.ts). */
    approvalsDir?: string;
    /**
     * QA-G-A3-2: the plugin's count of a role child's call refused outside its guard (index.ts `recordRoleRefusal`): the router's
     * role-authority refusal here in `execute.before`, a host permission denial in `execute.after`. Returns the guard's text to
     * add to the refusal (its denied_cap stop or advisory banner), or undefined. Absent: refusals are not counted.
     */
    recordRefusal?: (sessionID: string, agent: string | undefined, tool: string, args: unknown) => string | undefined;
    /**
     * Plan task 3.1.7: builds the plan executor over the host adapters (W1). Absent, or returning null: no executor, and nothing
     * changes (M3). The fail-closed check of plan children (M41) is on either way.
     */
    executor?: V2ExecutorFactory;
    /** W1: the Phase 1.3 lease registry the executor's leases go through; absent: the executor gets none. */
    leaseRegistry?: LeaseRegistryPort;
    /** W1: the verification engine as a slot verifier; absent: the executor gets none. */
    slotVerifier?: SlotVerifier;
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
  // ---------------------------------------------------------------------------------------------------------------
  // Plan task 3.1.7 (memo 3.1.1 §8): the plan executor's seams. `executor` stays null unless `options.executor` builds one
  // (M3: then nothing below changes behaviour); the fail-closed check of plan children (M41) is on either way.
  // ---------------------------------------------------------------------------------------------------------------
  let executor: V2Executor | null = null;
  /** W1: the plugin lifetime the launcher combines with each launch's own controller; aborted on dispose (W7). */
  const executorLifetime = new AbortController();
  /** M46: the one host-event path. v2-hooks only emits; the runtime and the launcher subscribe through `hosts.onEvent`. */
  const hostEventListeners = new Set<(e: HostSessionEvent) => void>();
  const emitHostEvent = (e: HostSessionEvent): void => {
    if (executor === null || hostEventListeners.size === 0) return;
    for (const listener of [...hostEventListeners]) {
      try {
        listener(e);
      } catch (error) {
        ingestLogger.warn("[router] executor: a host-event listener failed", { error: String(error) });
      }
    }
  };
  /**
   * W4 (M19), QA-3.1-8: the adapter is the single owner of the step key `<sessionID>:<k>`; it sets the key on every forwarded
   * retry/step event and on the retry-hook call (the runtime prefers `e.stepKey`). k counts `step.started` after a closed step;
   * `step.ended` closes the step, `step.failed` closes it only when no retry is pending (memo :163; the retry's own
   * `step.started` clears the pending mark), `execution.*` closes it and ends the session. So the retries of one step (C10:
   * `step.started`, `retry.scheduled`…, `step.ended`) carry one key. Only kept while an executor exists; an LRU map capped at
   * `EXECUTOR_STEPS_CAP` that evicts ended sessions first.
   */
  const EXECUTOR_STEPS_CAP = 1000;
  /** `early`: the step was opened by the retry hook before its `step.started` was processed (QA-3.1-21). */
  type ExecutorStep = { k: number; open: boolean; retryPending: boolean; ended: boolean; early: boolean };
  const executorSteps = new Map<string, ExecutorStep>();
  const touchExecutorStep = (sessionID: string): ExecutorStep => {
    const st = executorSteps.get(sessionID) ?? { k: 0, open: false, retryPending: false, ended: false, early: false };
    executorSteps.delete(sessionID); // LRU: the latest use goes last
    executorSteps.set(sessionID, st);
    while (executorSteps.size > EXECUTOR_STEPS_CAP) {
      let victim: string | undefined;
      for (const [id, s] of executorSteps) {
        if (s.ended && id !== sessionID) {
          victim = id;
          break;
        }
      }
      victim ??= executorSteps.keys().next().value!;
      executorSteps.delete(victim);
    }
    return st;
  };
  const noteExecutorStep = (
    sessionID: string, edge: "started" | "ended" | "failed" | "retry" | "retry-stop" | "execution",
  ): void => {
    if (executor === null) return;
    const st = touchExecutorStep(sessionID);
    if (edge === "started") {
      if (st.early) {
        // QA-3.1-21: the `step.started` of a step the retry hook already opened: a no-op (no second advance, the retry mark kept)
        st.early = false;
        return;
      }
      st.ended = false;
      st.retryPending = false;
      if (!st.open) {
        st.k += 1;
        st.open = true;
      }
    } else if (edge === "retry" || edge === "retry-stop") {
      // a scheduled retry, or a retry-hook call that let the host retry, is pending; a hook that stopped it leaves none
      st.retryPending = edge === "retry";
    } else if (edge === "failed") {
      st.early = false;
      if (!st.retryPending) st.open = false;
    } else {
      st.early = false;
      st.open = false;
      st.retryPending = false;
      if (edge === "execution") st.ended = true;
    }
  };
  /**
   * QA-3.1-21: the retry hook can run before the event loop processed the step's `session.step.started` (the loop can wait on an
   * ingest). A step that is not open is opened here, so the key the hook reads names this step; its `step.started`, processed
   * later, is then a no-op (`early`).
   */
  const openExecutorStepForHook = (sessionID: string): void => {
    if (executor === null || executorSteps.get(sessionID)?.open === true) return;
    noteExecutorStep(sessionID, "started");
    touchExecutorStep(sessionID).early = true;
  };
  const executorStepKey = (sessionID: string): string => `${sessionID}:${executorSteps.get(sessionID)?.k ?? 0}`;
  /**
   * 3.1.7 M41 (always on, memo §8): plan children are bound (`bindPlanChild`) before their first tool call. A child session whose
   * first user message is a launcher prompt (QA-3.1-9: it starts with "PLAN CONTEXT\n", at offset 0 or right after the host's one
   * exact preamble line (QA-3.1-16), and its launch header sits at the §7 grammar position, `planPromptHeader`) and that has no
   * plan binding, or one naming another plan task, joins
   * `refusedPlanChildren` and is refused every tool call (fail closed). The check runs in the context hook; a first tool call
   * that comes before it (a restart) runs it in `execute.before`. Every caller awaits the same in-flight check (QA-3.1-9 b).
   */
  const refusedPlanChildren = new Set<string>();
  /** Per session, the (in-flight or settled) check of its first user message (bounded). */
  const planChildChecks = new Map<string, Promise<void>>();
  const rememberPlanChildCheck = (sessionID: string, check: Promise<void>): void => {
    planChildChecks.set(sessionID, check);
    while (planChildChecks.size > 5000) planChildChecks.delete(planChildChecks.keys().next().value!);
  };
  /**
   * QA-3.1-9 (a): the launch header of a launcher prompt (`formatLaunchPrompt`), read by `parseLaunchHeader` at its grammar
   * position, or null. The shared context has no header-shaped line (the launcher refuses one), so the first header-shaped line
   * is the header and the text between the prefix and it is the shared context.
   */
  const planPromptHeader = (firstText: string): LaunchHeaderFields | null => {
    // QA-3.1-16: the grammar is checked at offset 0, or right after the host's one exact preamble line, never elsewhere
    const text = withoutHostPreamble(firstText);
    if (!text.startsWith(PLAN_CONTEXT_PREFIX)) return null;
    const m = LAUNCH_HEADER_PATTERN.exec(text);
    if (m === null || m.index - 2 < PLAN_CONTEXT_PREFIX.length) return null;
    return parseLaunchHeader(text, text.slice(PLAN_CONTEXT_PREFIX.length, m.index - 2));
  };
  /** M41: the session has a plan binding and the prompt's header names that plan task. */
  const planBindingMatches = (sessionID: string, header: LaunchHeaderFields): boolean => {
    const plan = currentBinding(sessionID, { maxOf: () => [] })?.plan;
    return plan !== undefined && header.planId === plan.planId && header.taskId === plan.taskId;
  };
  /** The verdict on one session's first user message text: a plan prompt in a non-root session without its binding is refused. */
  const planChildVerdict = async (sessionID: string, firstText: string): Promise<void> => {
    const header = planPromptHeader(firstText);
    if (header === null) return; // not a launcher prompt: never refused, the session kind is not even looked up
    let kind: Awaited<ReturnType<typeof sessionKindOf>>;
    try {
      kind = await sessionKindOf(sessionID);
    } catch {
      kind = "unknown"; // a plan prompt in a session of unknown kind: checked as a child (fail closed)
    }
    if (kind === "root") return;
    let matches: boolean;
    try {
      matches = planBindingMatches(sessionID, header);
    } catch {
      matches = false; // the binding could not be read: fail closed, with the refusal's own message
    }
    if (matches) return;
    refusedPlanChildren.add(sessionID);
    while (refusedPlanChildren.size > 5000) refusedPlanChildren.delete(refusedPlanChildren.values().next().value!);
    ingestLogger.warn("[router] executor: a plan child without its plan binding is refused every tool call", { sessionID });
  };
  const planChildGuard = {
    /** The check on the first user message text of a session; once per session, shared by every caller while in flight. */
    check(sessionID: string, firstText: string | undefined): Promise<void> {
      if (sessionID === "" || firstText === undefined) return Promise.resolve();
      const known = planChildChecks.get(sessionID);
      if (known !== undefined) return known;
      const check = planChildVerdict(sessionID, firstText);
      rememberPlanChildCheck(sessionID, check);
      return check;
    },
    /** `execute.before`: the fallback check (or the in-flight one), then the refusal. */
    async assertToolAllowed(sessionID: string): Promise<void> {
      if (sessionID !== "" && sessionKinds.get(sessionID) !== "root") {
        let check = planChildChecks.get(sessionID);
        if (check === undefined) {
          /** True when a verdict was reached; false when the first message could not be read. */
          const verdict = (async (): Promise<boolean> => {
            let firstText: string | undefined;
            try {
              firstText = firstMessageText(await ctx.session.context({ sessionID } as Parameters<typeof ctx.session.context>[0]));
            } catch {
              firstText = undefined;
            }
            if (firstText === undefined) return false;
            await planChildVerdict(sessionID, firstText);
            return true;
          })();
          const fallback: Promise<void> = verdict.then((checked) => {
            // not checked yet: the next call (or the context hook) tries again
            if (!checked && planChildChecks.get(sessionID) === fallback) planChildChecks.delete(sessionID);
          });
          check = fallback;
          rememberPlanChildCheck(sessionID, fallback);
        }
        await check;
      }
      if (refusedPlanChildren.has(sessionID)) {
        throw new Error(`[router] Refused for session ${sessionID}: its prompt carries a plan task header but the session has no matching plan binding (fail closed)`);
      }
    },
  };
  /**
   * W4/W6 (M34, M46): a v2 session event as the executor's `HostSessionEvent`, emitted on the one path (the orchestrator's
   * events included, so the runtime sees root idleness). `session.step.started` carries the provider (`model.providerID`).
   */
  const forwardHostEvent = (type: string, sessionID: string, data: Record<string, unknown>, created: unknown): void => {
    if (executor === null) return;
    const ms = created instanceof Date ? created.getTime() : typeof created === "number" && Number.isFinite(created) ? created : Date.now();
    const at: IsoTime = new Date(ms).toISOString();
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const error = (): HostError => toHostError(data.error ?? data);
    // QA-3.1-8: every step/retry event carries the adapter's step key, read after the edge that opens a step and before the
    // edge that closes it.
    if (type === "session.step.started") {
      noteExecutorStep(sessionID, "started");
      const model = typeof data.model === "object" && data.model !== null ? (data.model as Record<string, unknown>) : {};
      emitHostEvent({
        type: "step.started", sessionID, providerID: text(model.providerID), modelID: text(model.id ?? model.modelID),
        stepKey: executorStepKey(sessionID), at,
      });
    } else if (type === "session.retry.scheduled") {
      noteExecutorStep(sessionID, "retry");
      emitHostEvent({ type: "retry", sessionID, stepKey: executorStepKey(sessionID), source: "scheduled", error: error(), at });
    } else if (type === "session.step.ended") {
      emitHostEvent({ type: "step.ended", sessionID, stepKey: executorStepKey(sessionID), at });
      noteExecutorStep(sessionID, "ended");
    } else if (type === "session.step.failed") {
      emitHostEvent({ type: "step.failed", sessionID, error: error(), stepKey: executorStepKey(sessionID), at });
      noteExecutorStep(sessionID, "failed");
    } else if (type === "session.execution.failed") {
      executorInFlight.noteEnd(sessionID, "failed");
      emitHostEvent({ type: "execution.failed", sessionID, error: error(), stepKey: executorStepKey(sessionID), at });
      noteExecutorStep(sessionID, "execution");
    } else if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
      executorInFlight.noteEnd(sessionID, type === "session.execution.succeeded" ? "succeeded" : "interrupted");
      emitHostEvent({ type: type === "session.execution.succeeded" ? "execution.completed" : "execution.interrupted", sessionID, at });
      noteExecutorStep(sessionID, "execution");
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
  /**
   * The directory the host resolves a session's relative paths against (its location), else the plugin's; and the session's
   * parent (cross-repo P1.5: the orchestrator whose working set widens R). QA-2.1-11: cached per session (a session's location
   * and parent do not move), concurrent lookups share one host call, and a failed lookup is remembered for
   * SESSION_DIR_NEGATIVE_TTL_MS so a tool hook does not pay a failing `ctx.session.get` per call. Bounded; forgotten with the session.
   */
  type SessionInfo = { directory: string; parentID: string | undefined };
  const sessionDirs = new Map<string, { at: number; info: Promise<SessionInfo>; failed: boolean }>();
  const sessionInfoOf = (sessionID: string): Promise<SessionInfo> => {
    const cached = sessionDirs.get(sessionID);
    if (cached !== undefined && (!cached.failed || Date.now() - cached.at < SESSION_DIR_NEGATIVE_TTL_MS)) return cached.info;
    const entry: { at: number; failed: boolean; info: Promise<SessionInfo> } = {
      at: Date.now(), failed: false, info: Promise.resolve<SessionInfo>({ directory: ctx.location.directory, parentID: undefined }),
    };
    entry.info = (async () => {
      const session = await ctx.session.get({ sessionID } as Parameters<typeof ctx.session.get>[0]) as unknown as {
        location?: { directory?: unknown }; parentID?: unknown;
      };
      const directory = session?.location?.directory;
      const parentID = session?.parentID;
      return {
        directory: typeof directory === "string" && directory !== "" ? directory : ctx.location.directory,
        parentID: typeof parentID === "string" && parentID !== "" ? parentID : undefined,
      };
    })();
    entry.info.catch(() => {
      // Negative cache: the rejection itself reaches every caller of this entry until the TTL passes.
      entry.failed = true;
      entry.at = Date.now();
    });
    sessionDirs.delete(sessionID);
    sessionDirs.set(sessionID, entry);
    while (sessionDirs.size > MAX_SESSION_DIRS) sessionDirs.delete(sessionDirs.keys().next().value!);
    return entry.info;
  };
  /** The directory half of {@link sessionInfoOf} (the work-lease wiring's `sessionDir`). */
  const sessionDirectoryOf = (sessionID: string): Promise<string> => sessionInfoOf(sessionID).then((info) => info.directory);
  /**
   * Cross-repo P1.5: the read set R of a role session beyond its work root (`routing/roles/read-set.ts`) — the worktrees of its
   * orchestrator's working set (the session that dispatched it: its dispatch record, else the session's parent) and the
   * repositories below `routing.repoParents`. Only for an exact binding with a work root; undefined when R adds nothing (no
   * parents and no working set: I9). The probe (`.git` and `HEAD`, synchronous) is cached 5 s per directory.
   */
  const repoProbe = createRepoProbe();
  const readSetOf = (sessionID: string, binding: Pick<Binding, "kind" | "grant">, parentID: string | undefined): InReadSet | undefined => {
    if (binding.kind !== "exact" || binding.grant.workRoot === null) return undefined;
    const routing = resolveRolesRouting(loadConfig(ctx.location.directory), "v2");
    const recorded = lookupDispatch(sessionID)?.parentSessionID;
    const orchestrator = typeof recorded === "string" && recorded !== "" ? recorded : parentID;
    const workingSet = orchestrator === undefined ? [] : workingSetOf(orchestrator);
    return readSetPredicate({ parents: routing.repoParents, depth: routing.repoDepth, exclude: routing.repoExclude }, workingSet, repoProbe);
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
  /** Cross-repo P1.5: lists the repository of the binding's grant (`grant.location.repository`), else the plugin's directory. */
  const checkWorktree = async (root: string, repository: string): Promise<boolean> => {
    try {
      return listedWorktreeRoot(await listWorktreesOf(repository), root);
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
  const stillAWorktree = (root: string, repository: string): Promise<boolean> => {
    const own = fallbackRoot();
    if (own !== undefined && normalizeRootText(own) === normalizeRootText(root)) return Promise.resolve(true);
    const key = `${normalizeRootText(repository)}\u0000${root}`;
    const cached = worktreeChecks.get(key);
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.listed;
    const listed = checkWorktree(root, repository);
    worktreeChecks.delete(key);
    worktreeChecks.set(key, { at: Date.now(), listed });
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
  ): Promise<{ readonly refusal: string | undefined; readonly exact: boolean; readonly lift: boolean }> => {
    const sessionID = String(event.sessionID);
    const authority = await roleAuthorityOf(sessionID, agent);
    if (authority === undefined) return { refusal: "the role table is unavailable (fail closed)", exact: false, lift: false };
    const exact = authority.binding.kind === "exact";
    const cls = roleActionOf(event.action);
    const metadata = event.metadata !== null && typeof event.metadata === "object" ? event.metadata : undefined;
    const search = cls === "glob" || cls === "grep";
    // QA-1 F1: a search the call named no root for (the host's `.`) never reaches R.
    const namedRoot = search && typeof metadata?.path === "string" && metadata.path !== "" ? metadata.path : undefined;
    const paths = cls === "read" || cls === "edit" || cls === "external_directory" ? event.resources
      : search && metadata !== undefined ? [namedRoot ?? "."] : [];
    const patterns = searchPatterns(cls, event.resources[0], metadata?.include);
    const info = paths.length > 0 ? await sessionInfoOf(sessionID) : undefined;
    const readSet = info === undefined ? undefined : readSetOf(sessionID, authority.binding, info.parentID);
    const decision = roleAuthorityDecision({
      action: event.action, paths, patterns, binding: authority.binding, dynamic: authority.spec.authority.mode === "dynamic",
      sessionDirectory: info?.directory ?? ctx.location.directory, fallbackRoot: fallbackRoot(),
      ownOutputs: ownOutputs.get(sessionID), inReadSet: readSet,
      // QA-1 F1: a relative read/edit resource is the host's Location-relative form; execute.before checked the call as written.
      hostRelative: cls === "read" || cls === "edit",
      implicitRoot: search && namedRoot === undefined,
    });
    if (!decision.allow) return { refusal: decision.reason, exact, lift: false };
    const grant = authority.binding.grant;
    const root = grant.workRoot;
    if (cls === "external_directory" && root !== null && !(await stillAWorktree(root, grant.location?.repository ?? ctx.location.directory))) {
      return { refusal: `external_directory: the work root ${root} is no longer a worktree listed by \`git worktree list --porcelain\``, exact, lift: false };
    }
    // QA-1 F6 (D13, I18): the lift is for an exact binding's `external_directory` allowed by W or R only — never by the session's
    // own output directory — and only while cross-repo is in use (`routing.repoParents`, a working set, or a grant that carries its
    // repository's location); otherwise a host ask stays an ask (I9).
    const crossRepo = readSet !== undefined || grant.location !== undefined;
    const lift = exact && cls === "external_directory" && crossRepo && (decision.via === "work-root" || decision.via === "read-set");
    return { refusal: undefined, exact, lift };
  };
  /**
   * T2.3.1 (P-12, S11): the `execute.before` side of EVERY tool call a role session makes — the tool's role action must be in the
   * grant and its paths inside the work root. Paths: every path a `read`/`write`/`edit`/`apply_patch` call names
   * ({@link toolCallPaths}: `filePath`, `path`, `file_path`, `edits[]`, patch headers; none → refused), the search root of
   * `glob`/`grep` (default: the session directory) and their pattern (QA-P23-A9). The only router check that fires for plugin tools
   * (`router_run`, `router_git_*`: no `evaluate`, S11) and for Code Mode `execute` (S8). A tool outside every role class —
   * `subagent` included — is refused here too (QA-P23-A7), whatever the agent's max policy or the parent's grants say.
   */
  const roleToolRefusal = async (event: { sessionID: unknown; tool: string; input?: unknown }, args: any, agent: string): Promise<string | undefined> => {
    const cls = roleActionOf(event.tool);
    if (cls === undefined && event.tool !== "execute" && event.tool !== AUTHORITY_TOOL_NAME) return `${event.tool} is outside every role's authority`;
    const sessionID = String(event.sessionID);
    const authority = await roleAuthorityOf(sessionID, agent);
    if (authority === undefined) return "the role table is unavailable (fail closed)";
    const record = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
    const info = await sessionInfoOf(sessionID);
    const sessionDirectory = info.directory;
    let paths: string[] = [];
    let implicitRoot = false;
    if (cls === "read" || cls === "edit") {
      // QA-2: `scopedArgs` resolves a relative `filePath` against the session directory (and `taskArgs` maps `path` onto `filePath`),
      // so the call's RAW arguments are read too: a path written relative stays among the checked ones as written, and is never
      // eligible for R (`readSetEligible`) — only a path inside W passes. The resolved forms are checked next to them.
      const scoped = toolCallPaths(event.tool, record);
      const raw = toolCallPaths(event.tool, event.input);
      if (scoped === undefined && raw === undefined) return `${event.tool}: no path to check (or a patch whose paths cannot be read)`;
      paths = [...new Set([...(raw ?? []), ...(scoped ?? [])])];
    } else if (cls === "glob" || cls === "grep") {
      const named = typeof record.path === "string" && record.path !== "" ? record.path : undefined;
      implicitRoot = named === undefined; // QA-1 F1: the session directory by default — W only, never R
      paths = [named ?? sessionDirectory];
    }
    const decision = roleAuthorityDecision({
      action: event.tool, paths, patterns: searchPatterns(cls, record.pattern, record.include), binding: authority.binding,
      dynamic: authority.spec.authority.mode === "dynamic", sessionDirectory, fallbackRoot: fallbackRoot(), ownOutputs: ownOutputs.get(sessionID),
      inReadSet: paths.length > 0 ? readSetOf(sessionID, authority.binding, info.parentID) : undefined, implicitRoot,
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
  /** QA-PDF12-7: a context rebuilt from journaled data runs its operation but never becomes the parent's retained context. */
  const withinRebuilt = <T>(context: ToolContext, operation: () => Promise<T>): Promise<T> =>
    runtime ? runtime.withToolContext(context, operation, { retain: false }) : operation();
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
  /** QA-PDF12-1: how long a rebuilt context waits for the parent session's current agent. */
  const CALLER_AGENT_LOOKUP_MS = 2_000;
  /**
   * QA-PDF12-1: the caller agent of a rebuilt context: the journaled one, else (a record journaled before DF-1.1-1) the parent
   * session's current agent, looked up within CALLER_AGENT_LOOKUP_MS; undefined when neither is known. Never throws.
   */
  /** Runs `work` (a host lookup) for at most CALLER_AGENT_LOOKUP_MS; undefined when it fails or is too slow. Never throws. */
  const boundedLookup = async (work: () => Promise<string | undefined>): Promise<string | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = work().then((value) => value, () => undefined);
      const timeout = new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), CALLER_AGENT_LOOKUP_MS);
        if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
      });
      return await Promise.race([lookup, timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * QA-PDF12-14: the parent lookups made while at least one restore pass runs are shared per parent, so N restored holds of one
   * parent cost one lookup each, not N. Dropped when the last running pass ends (a later pass looks again).
   */
  let restorePass: { passes: number; agents: Map<string, Promise<string | undefined>>; messages: Map<string, Promise<string | undefined>> } | undefined;
  const sharedPerParent = (kind: "agents" | "messages", parent: string, work: () => Promise<string | undefined>): Promise<string | undefined> => {
    const cache = restorePass?.[kind];
    if (cache === undefined) return boundedLookup(work);
    let pending = cache.get(parent);
    if (pending === undefined) {
      pending = boundedLookup(work);
      cache.set(parent, pending);
    }
    return pending;
  };
  const duringRestorePass = async <T>(pass: () => Promise<T>): Promise<T> => {
    restorePass ??= { passes: 0, agents: new Map(), messages: new Map() };
    restorePass.passes += 1;
    try {
      return await pass();
    } finally {
      if (restorePass !== undefined && (restorePass.passes -= 1) <= 0) restorePass = undefined;
    }
  };
  const callerAgentOf = (parentSessionID: string, journaled: string | undefined): Promise<string | undefined> => {
    if (journaled !== undefined && journaled !== "") return Promise.resolve(journaled);
    return sharedPerParent("agents", parentSessionID, async () => {
      const session: unknown = await ctx.session.get({ sessionID: parentSessionID } as Parameters<typeof ctx.session.get>[0]);
      const agent = (session as { agent?: unknown } | null | undefined)?.agent;
      return typeof agent === "string" && agent !== "" ? agent : undefined;
    });
  };
  /**
   * QA-PDF12-12: the message id of a rebuilt context: the journaled one, else (a record journaled before QA-PDF12-5) the id of
   * the parent's latest assistant message, read from its context within the same bound; undefined when that fails.
   */
  const callerMessageIDOf = (parentSessionID: string, journaled: string | undefined): Promise<string | undefined> => {
    if (journaled !== undefined && journaled !== "") return Promise.resolve(journaled);
    return sharedPerParent("messages", parentSessionID, async () => {
      const history: unknown = await ctx.session.context({ sessionID: parentSessionID } as Parameters<typeof ctx.session.context>[0]);
      const list: unknown = Array.isArray(history) ? history : Reflect.get(Object(history), "messages");
      if (!Array.isArray(list)) return undefined;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const message: unknown = list[i];
        if (message === null || typeof message !== "object") continue;
        const role: unknown = Reflect.get(message, "role") ?? Reflect.get(message, "type");
        const id: unknown = Reflect.get(message, "id");
        if (role === "assistant" && typeof id === "string" && id !== "") return id;
      }
      return undefined;
    });
  };
  /**
   * QA-PDF12-1/-5/-7/-9: runs `operation` (a background finish, a restored hold's gate) in the context of the dispatch's caller,
   * rebuilt from the data the dispatch journaled: its call, the message that made it and the caller agent (else the parent's
   * current one). The context is never retained as the parent's context.
   */
  const withinCaller = async <T>(
    caller: { parentSessionID: string; callID: string; callerAgent?: string; callerMessageID?: string },
    operation: () => Promise<T>,
    /** QA-PDF12-14: false when nothing in `operation` launches as the caller (a completion that did not succeed runs no grader). */
    lookup = true,
  ): Promise<T> => {
    const [agent, messageID] = lookup ? await Promise.all([
      callerAgentOf(caller.parentSessionID, caller.callerAgent),
      callerMessageIDOf(caller.parentSessionID, caller.callerMessageID),
    ]) : [caller.callerAgent, caller.callerMessageID];
    return withinRebuilt(hookContext({ sessionID: caller.parentSessionID, agent, messageID: messageID ?? "", id: caller.callID }), operation);
  };
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
  /**
   * QA-2.1-11: a failed kind lookup is remembered for SESSION_KIND_NEGATIVE_TTL_MS (bounded, like `sessionDirs`), so a tool hook
   * does not pay a failing host call per call, and it answers `unknown`: root semantics in the lease guard (memo §14.1), child
   * wording in what it says (a child misread as a root must not be told it is the orchestrator).
   * QA-2.1-25: `unknown` means no lease, so the window is short (not the 30 s of a session directory): a transient host failure
   * must not let a child write unleased for long; the next hook after the window asks the host again.
   */
  const failedKinds = new Map<string, number>();
  const sessionKindOf = async (sessionID: string): Promise<"root" | "child" | "unknown"> => {
    const known = sessionKinds.get(sessionID);
    if (known !== undefined) return known;
    const failedAt = failedKinds.get(sessionID);
    if (failedAt !== undefined && Date.now() - failedAt < SESSION_KIND_NEGATIVE_TTL_MS) return "unknown";
    try {
      const session = await sessionOf(sessionID) as { parentID?: unknown } | undefined;
      const kind = typeof session?.parentID === "string" && session.parentID !== "" ? "child" : "root";
      failedKinds.delete(sessionID);
      noteSessionKind(sessionID, kind);
      return kind;
    } catch (error) {
      failedKinds.delete(sessionID);
      failedKinds.set(sessionID, Date.now());
      while (failedKinds.size > MAX_SESSION_DIRS) failedKinds.delete(failedKinds.keys().next().value!);
      // QA-DF1-23: one lookup serves the leases and the background decision; the warning names what each does with the failure.
      ingestLogger.warn("[router] the session kind could not be read: leases use root semantics with child wording; a background decision stays foreground", {
        session: sessionID, error: String(error),
      });
      return "unknown";
    }
  };
  /**
   * QA-DF1-23 (DF-1-9): the background decision's lookup of an unrecorded parent, bounded by SESSION_KIND_DISPATCH_TIMEOUT_MS. A
   * slow host answers `unknown` (no root: the dispatch stays foreground) once the bound passes; the lookup itself goes on and
   * records the kind for the next dispatch.
   */
  const dispatchSessionKindOf = async (sessionID: string): Promise<"root" | "child" | "unknown"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"unknown">((resolve) => {
      timer = setTimeout(() => resolve("unknown"), SESSION_KIND_DISPATCH_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([sessionKindOf(sessionID), bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  /**
   * The kind of a session WITHOUT a host call (`session.created` and the `prompt` hook record it): an unknown session is a root,
   * as in the lease guard (memo §14.1). The dispatch path adds no host call of its own (a static session stays silent, §1.2),
   * with one exception: DF-1-9 / QA-DF1-23, never for the background decision — while background routing is active
   * (`bgActive()`), an unrecorded parent is resolved once with `dispatchSessionKindOf` (one `session.get`, bounded by
   * SESSION_KIND_DISPATCH_TIMEOUT_MS, cached once answered; `unknown` is no root).
   */
  const knownKindOf = (sessionID: string): "root" | "child" => sessionKinds.get(sessionID) ?? "root";
  /** The in-flight registry and held results exist whatever the mode; they hold nothing until a background dispatch is acknowledged. */
  const bgMode = startRouting.background.mode;
  const inflight: InFlightRegistry = createInFlightRegistry({
    now: nowMs, logger: ingestLogger,
    onClosed: (attempt, cause) => { void closeAttempt?.(attempt, cause); },
  });
  // QA-2.1-13: the process-wide call claims of this instance go with it (a reload must not inherit them).
  bgDisposers.push(() => inflight.dispose());
  /**
   * 3.1.7 W1/W5: the executor's in-flight entries (`owner: "executor"`), one call record per task attempt. The launcher calls
   * `decisionRow`, `recordDispatchStart`, `registerInFlight(.., null)`, then `registerInFlight(.., child)` once the child exists,
   * and `unregisterInFlight` when its launch completion settles (the only settle point): that submits the `runner` trigger (with
   * the child's own end status, `noteEnd`, else the launch's settled end kind the launcher passes, QA-3.1-24), so
   * the processor's D2 dedupe makes a later `execution.*` trigger a duplicate. Excluded from the ordinary completion and
   * verification path (background.ts `isExecutorOwned`). Keyed by task attempt (the bookkeeping port carries no plan id).
   */
  const executorLaunches = new Map<string, {
    req: LaunchRequest; callID: string; child: string | null; end?: "succeeded" | "failed" | "interrupted";
  }>();
  const executorAttemptKey = (taskId: string, attempt: number): string => `${taskId}#${attempt}`;
  const executorInFlight = {
    /**
     * QA-3.1 nit 4: the child's own end (its `execution.*` event), carried into the `runner` trigger `unregister` submits.
     * The latest end wins; a child of no executor launch is ignored.
     */
    noteEnd(child: string, status: "succeeded" | "failed" | "interrupted"): void {
      for (const entry of executorLaunches.values()) {
        if (entry.child === child) entry.end = status;
      }
    },
    remember(req: LaunchRequest): void {
      const key = executorAttemptKey(req.taskId, req.attempt);
      executorLaunches.delete(key);
      executorLaunches.set(key, { req, callID: `executor:${req.planId}:${req.taskId}#${req.attempt}:${req.nonce}`, child: null });
      while (executorLaunches.size > 1000) executorLaunches.delete(executorLaunches.keys().next().value!);
    },
    register(taskId: string, attempt: number, child: string | null): void {
      const entry = executorLaunches.get(executorAttemptKey(taskId, attempt));
      if (entry === undefined) return;
      if (inflight.byCall(entry.callID) === undefined) {
        inflight.decide({
          callID: entry.callID, parentSessionID: entry.req.orchestratorSessionID, agent: entry.req.route.agent, role: entry.req.role,
          description: `plan ${entry.req.planId} task ${taskId}#${attempt}`, verifying: false, verificationMode: "none",
          decision: { background: true, hold: false, reason: "plan-task" }, at: nowMs(), owner: "executor",
        });
      }
      if (child !== null && entry.child === null) {
        entry.child = child;
        noteSessionKind(child, "child");
        inflight.acknowledge(entry.callID, child, { userBackgrounded: false });
      }
    },
    unregister(taskId: string, attempt: number, settled?: ChildEnd["kind"]): void {
      const key = executorAttemptKey(taskId, attempt);
      const entry = executorLaunches.get(key);
      executorLaunches.delete(key);
      if (entry === undefined) return;
      if (entry.child === null) {
        inflight.cancel(entry.callID);
        return;
      }
      // QA-3.1 nit 4, QA-3.1-24: the observed end, else the launch's settled end kind, else the registry's outcome
      const status = executorRunnerStatus(entry.end, settled, inflight.byChild(entry.child)?.outcome);
      const sink = executorProcessor;
      if (sink !== undefined) trackBackground(sink.process(entry.child, { kind: "runner", status, text: "", at: nowMs() }));
      else inflight.foreground(entry.callID, entry.child);
    },
  };
  /** W5: the completion processor once the hooks created it (it lives in the hook block below); undefined before and without one. */
  let executorProcessor: CompletionProcessor | undefined;
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
      if (shared === undefined) return;
      try {
        await shared.append(...args);
      } catch (error) {
        if (!(error instanceof Error && error.message === PENDING_JOURNAL_VANISHED)) throw error;
        // QA-2.1-8: a journal that vanished under this process fails closed exactly like a failed reload, until QA-2.1-16
        // rewrites it from the in-memory state; then this append is tried once more.
        noteVanished();
        if (!(await recreateJournal())) throw error;
        // QA-2.1-16: the state behind this record is usually in memory already (an attempt is acknowledged, a hold text or a
        // verdict text is kept, before its append), so the recreation wrote it: once per write, never twice.
        const identity = recordIdentity(record);
        if (identity !== undefined && recreatedIdentities.has(identity)) return;
        await shared.append(...args);
      }
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
        adoptSession(String(event.sessionID));
        if (finishApi !== undefined && reloadFailed) {
          // QA-2.1-8: fail closed exactly like the context hook (memo §12): a summary must not carry a completion this process
          // cannot prove processed while the journal is not reloaded.
          const isProcessed = (child: string): boolean => {
            const attempt = inflight.byChild(child);
            return attempt !== undefined && journal.hasProcessed(attempt.key);
          };
          messages.forEach((source, index) => {
            const content: unknown = (source as { content?: unknown }).content;
            if (!Array.isArray(content)) return;
            let touched = false;
            const next = content.map((part: unknown) => {
              const text: unknown = part !== null && typeof part === "object" ? Reflect.get(part, "text") : undefined;
              const type: unknown = part !== null && typeof part === "object" ? Reflect.get(part, "type") : undefined;
              if (typeof text !== "string" || (type !== undefined && type !== "text")) return part;
              const redacted = redactUnprocessedElements(text, isProcessed);
              if (redacted === text) return part;
              touched = true;
              return { ...(part as object), text: redacted };
            });
            if (touched) messages[index] = Object.assign(Object.create(Object.getPrototypeOf(source)), source, { content: next });
          });
        }
        const shaped = messages.map((source) => ({ source, parts: (source as { content?: unknown }).content }));
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
  /**
   * Memo §12: the journal reload failed or timed out, or the journal vanished under this process (QA-2.1-8). Holding is off,
   * every unprocessed `<subagent>` element is redacted (context and compaction hooks) and a resume of a session this process
   * does not know is refused (it may be held). A failed reload is retried by `retryReload` (at most every
   * PENDING_RELOAD_RETRY_MS); a vanished journal is recreated from this process's in-memory state by `recreateJournal`
   * (QA-2.1-16), and a successful reload or recreation ends the state.
   */
  let reloadFailed = false;
  let lastReloadAt = 0;
  let reloading: Promise<boolean> | undefined;
  /** QA-2.1-8: background work that outlives its hook (verdict posts, recoveries, reloads); `dispose` waits for it (bounded). */
  const inFlightWork = new Set<Promise<unknown>>();
  const trackBackground = (work: Promise<unknown>): void => {
    const tracked = work.catch((error: unknown) => {
      ingestLogger.warn("[router] background: a background task failed", { error: String(error) });
    });
    inFlightWork.add(tracked);
    void tracked.finally(() => inFlightWork.delete(tracked));
  };
  /** V2_BACKGROUND_SETTLED: waits until the in-flight set is empty (work a settled task started is waited for too). Never rejects. */
  const settleBackground = async (): Promise<void> => {
    for (;;) {
      while (inFlightWork.size > 0) await Promise.allSettled([...inFlightWork]);
      // QA-2.1-21: the held gates the plugin runs behind `finish` (and the verdict posts they start here) count too.
      const api = finishApi;
      if (api === undefined) return;
      try {
        await api.idle();
      } catch (error) {
        ingestLogger.warn("[router] background: the plugin's held gates could not be awaited", { error: String(error) });
        return;
      }
      if (inFlightWork.size === 0) return;
    }
  };
  /** QA-2.1-8: one bounded reload of the pending journal (concurrent callers share it); success ends the fail-closed state. */
  const reloadJournal = (): Promise<boolean> => {
    if (reloading !== undefined) return reloading;
    const api = finishApi;
    if (api === undefined) return Promise.resolve(false);
    lastReloadAt = nowMs();
    reloading = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          api.reload(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pending journal reload timed out")), PENDING_RELOAD_BOUND_MS); }),
        ]);
        if (reloadFailed) ingestLogger.warn("[router] background: the pending journal was reloaded; holding is available again");
        reloadFailed = false;
        return true;
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        // QA-2.1-16: a vanished journal is never found again by a reload: it is rewritten from the in-memory state.
        if (error instanceof Error && error.message === PENDING_JOURNAL_VANISHED) {
          noteVanished();
          return await recreateJournal();
        }
        reloadFailed = true;
        ingestLogger.warn("[router] background: the pending journal could not be reloaded; holding is off and unprocessed results are redacted", { error: String(error) });
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        reloading = undefined;
      }
    })();
    return reloading;
  };
  /** QA-2.1-16: told once per vanishing (until a recreation succeeds). */
  let vanishedWarned = false;
  /** QA-2.1-8: a journal that vanished under this process fails closed exactly like a failed reload (until it is recreated). */
  const noteVanished = (): void => {
    reloadFailed = true;
    lastReloadAt = nowMs();
    if (vanishedWarned) return;
    vanishedWarned = true;
    ingestLogger.warn("[router] background: the pending journal vanished; it is recreated from memory, and until then holding is off and unprocessed results are redacted");
  };
  /**
   * QA-2.1-16: the records of this adapter's in-memory state a later restore needs: the live attempts not processed yet
   * (`inflight`, with their dispatch data), every hold (`hold`, `hold-text`, `posting`, `posted`) and the dormant
   * `inflight` records of sessions not seen yet. The plugin adds its pending entries and dormant records.
   */
  const adapterRecords = (): PersistedRecord[] => {
    const out: PersistedRecord[] = [];
    for (const attempt of inflight.list()) {
      if (attempt.state !== "acknowledged" && attempt.state !== "child-ended" && attempt.state !== "processing") continue;
      if (journal.hasProcessed(attempt.key)) continue;
      // QA-3.1-10: an executor-owned attempt is the plan ledger's to recover; journaled here (without its owner) a restart's
      // `recoverInflight` would take it for an ordinary dispatch.
      if (isExecutorOwned(attempt)) continue;
      const dispatch = restoredDispatches.get(attempt.callID) ?? finishApi?.dispatchOf(attempt.callID);
      out.push({
        v: 1, kind: "inflight", key: attempt.key, callID: attempt.callID, parentSessionID: attempt.parentSessionID,
        childSessionID: attempt.childSessionID, label: attemptLabel(attempt), at: attempt.ackAt ?? attempt.at,
        agent: attempt.agent, description: attempt.description, verifying: attempt.verifying, verificationMode: attempt.verificationMode,
        ...(attempt.callerAgent === undefined ? {} : { callerAgent: attempt.callerAgent }),
        ...(attempt.callerMessageID === undefined ? {} : { callerMessageID: attempt.callerMessageID }),
        ...(attempt.role === undefined ? {} : { role: attempt.role }),
        ...(attempt.hold === undefined ? {} : { handle: attempt.hold.handle }), hold: attempt.hold?.handle ?? null,
        ...(dispatch === undefined ? {} : { dispatch }), process: processToken(),
      });
    }
    out.push(...held.persisted());
    for (const records of dormantInflight.values()) out.push(...records);
    return out;
  };
  /**
   * QA-2.1-16: what identifies a record a recreation rewrites from memory: its kind and its attempt key or hold handle. The
   * same identity the recreation itself merges by (QA-2.1-33, `mergePendingSnapshots`).
   */
  const recordIdentity = (record: PersistedRecord): string | undefined => pendingRecordIdentity(record);
  /** QA-2.1-16: the identities the last successful recreation wrote; a retried append among them is not written again. */
  let recreatedIdentities = new Set<string>();
  let recreating: Promise<boolean> | undefined;
  /**
   * QA-2.1-16: rewrites a vanished journal from the in-memory state (`FinishApi.recreateJournal`); concurrent callers share
   * one rewrite. Success ends the fail-closed state; a failure keeps it, and the next append or `retryReload` tries again.
   */
  const recreateJournal = (): Promise<boolean> => {
    if (recreating !== undefined) return recreating;
    const api = finishApi;
    if (api === undefined) return Promise.resolve(false);
    lastReloadAt = nowMs();
    recreating = (async () => {
      try {
        const records = adapterRecords();
        await api.recreateJournal(records);
        recreatedIdentities = new Set(records.map(recordIdentity).filter((id): id is string => id !== undefined));
        if (reloadFailed) ingestLogger.warn("[router] background: the pending journal was recreated from memory; holding is available again");
        reloadFailed = false;
        vanishedWarned = false;
        return true;
      } catch (error) {
        reloadFailed = true;
        ingestLogger.warn("[router] background: the pending journal could not be recreated; holding stays off and it is tried again", { error: String(error) });
        return false;
      } finally {
        recreating = undefined;
      }
    })();
    return recreating;
  };
  /** QA-2.1-8: while the reload is failed, a hook or event starts another try (never awaited, at most every PENDING_RELOAD_RETRY_MS). */
  const retryReload = (): void => {
    if (!reloadFailed || reloading !== undefined || finishApi === undefined || nowMs() - lastReloadAt < PENDING_RELOAD_RETRY_MS) return;
    trackBackground(reloadJournal());
  };
  /** Reloaded in-flight records (memo §11.3): dormant until this process sees the parent session. */
  const dormantInflight = new Map<string, PersistedRecord[]>();
  /**
   * Set once the completion processor exists: recovers the adopted `inflight` records of a session. Returns the call ids
   * of the attempts acknowledged for recovery (QA-2.1-29: their holds get their verdict from that recovery).
   */
  let recoverInflight: ((sessionID: string) => Set<string>) | undefined;
  /** QA-2.1-17: the dispatch data journaled with the `inflight` records being recovered, by call id (bounded). */
  const restoredDispatches = new Map<string, RestoredDispatch>();
  /** QA-2.1-29: restored holds of sessions adopted before the processor existed, waiting for the start-up recovery. */
  const deferredRestores = new Map<string, RestoredHolds>();
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
        seams: { realpath: (path) => realpathSync.native(path), repoKeyOf: leaseRepoKeyOf, now: nowMs },
        snapshotPath, logger: ingestLogger,
      });
      leaseHandle = handle;
      bgDisposers.push(() => handle.release());
      try {
        const restored = handle.registry.restore(JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown, { dropCompleteHolders: true });
        if (!restored.ok) ingestLogger.warn("[router] leases: the snapshot was rejected", { error: restored.message });
        else if (restored.skipped !== undefined) ingestLogger.warn("[router] leases: snapshot lines skipped on restore", { skipped: restored.skipped });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") ingestLogger.warn("[router] leases: the snapshot could not be restored", { error: String(error) });
      }
      leaseGuard = createLeaseGuard({
        registry: handle.registry, sessionKind: sessionKindOf, sessionDir: sessionDirectoryOf, gitRootOf: nearestRepository,
        holderLabel,
        // 3.1.7 W3: a plan child (its binding has `plan`) acquires as holder = child, `taskRef`, `until-integrated`, tree = slot;
        // nothing releases it at child end (`releaseChild` keeps until-integrated leases): only the executor's `releaseTask`.
        planTaskOf: (sid) => {
          const binding = currentBinding(sid, { maxOf: () => [] });
          const slot = binding?.grant.workRoot;
          return binding?.plan === undefined || typeof slot !== "string" || slot === ""
            ? undefined
            : { planId: binding.plan.planId, taskId: binding.plan.taskId, slot };
        },
        events: { onRelease: (cb) => handle.onRelease(cb) }, logger: ingestLogger, now: nowMs,
      });
      // QA-3.1-6: a lease release can unblock a plan task waiting on a lease, so the executor runtime gets its tick
      // (`onLeaseReleased`, called only when the runtime offers it). Never throws into the registry.
      const offLeaseTick = handle.onRelease(() => {
        const runtime: unknown = executor?.runtime;
        if (typeof runtime !== "object" || runtime === null) return;
        const tick: unknown = Reflect.get(runtime, "onLeaseReleased");
        if (typeof tick !== "function") return;
        try {
          Reflect.apply(tick, runtime, []);
        } catch (error) {
          ingestLogger.warn("[router] executor: the lease-release tick failed", { error: String(error) });
        }
      });
      bgDisposers.push(() => offLeaseTick());
      // `router_git_ls_files` searches: child sessions see no entry under edit by another holder (memo §15.1). `root` is the
      // directory git listed (the work root, or the repository a `root=` call inspects), so the checkout key is that one's own
      // (DF-1.1-4), never the session's.
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
        // QA-2.1-8: a verdict the gate posts through the sink is background work `dispose` waits for (bounded), like a recovery.
        const trackedHeld: HeldResults = {
          ...held,
          verdict: (handle, v) => {
            const posting = held.verdict(handle, v);
            trackBackground(posting);
            return posting;
          },
        };
        finishApi = (attachFinish as FinishAttach)({ host: "v2", held: trackedHeld, ...(leaseGuard === undefined ? {} : { leaseGate: leaseGuard }) });
        // QA-2.1-33: a recreation of the shared journal by another plugin instance of this process writes these records too.
        finishApi?.setAdapterSnapshot?.(adapterRecords);
      } catch (error) {
        ingestLogger.warn("[router] background: the plugin could not attach the finish API; no background processing", { error: String(error) });
      }
    }
    if (finishApi !== undefined) await reloadJournal();
  }
  /**
   * Memo §11.3: the first sight of a parent session adopts its dormant records (claim file); idempotent per session. Bounded
   * (QA-2.1-13): a forgotten session leaves the set, and the oldest sightings go first past MAX_ADOPTED_SESSIONS (a second
   * adoption of an evicted session finds no dormant records: `adopt` hands each session over once). QA-2.1-34: a refused
   * adoption (another live instance holds the claim) leaves the session unmarked; a later sighting tries again, at most
   * once per ADOPTION_RETRY_MS (`refusedAdoptions`).
   */
  const adoptedSessions = new Set<string>();
  /**
   * QA-2.1-34: when the adoption of a session was last refused (another live instance holds its claim). The session is not
   * marked adopted; a later sighting tries again once ADOPTION_RETRY_MS has passed. Bounded like `adoptedSessions`.
   */
  const refusedAdoptions = new Map<string, number>();
  const adoptSession = (sessionID: string): void => {
    if (reloadFailed) retryReload();
    if (finishApi === undefined || reloadFailed || adoptedSessions.has(sessionID)) return;
    const refusedAt = refusedAdoptions.get(sessionID);
    if (refusedAt !== undefined && nowMs() - refusedAt < ADOPTION_RETRY_MS) return;
    adoptedSessions.add(sessionID);
    for (const old of adoptedSessions) {
      if (adoptedSessions.size <= MAX_ADOPTED_SESSIONS) break;
      adoptedSessions.delete(old);
    }
    try {
      const adopted = finishApi.adopt(sessionID);
      if (isAdoptionRefused(adopted)) {
        adoptedSessions.delete(sessionID);
        refusedAdoptions.delete(sessionID);
        refusedAdoptions.set(sessionID, nowMs());
        for (const old of refusedAdoptions.keys()) {
          if (refusedAdoptions.size <= MAX_ADOPTED_SESSIONS) break;
          refusedAdoptions.delete(old);
        }
        return;
      }
      refusedAdoptions.delete(sessionID);
      if (adopted === undefined) return;
      const restored = adopted.holds.length > 0 ? held.restore(adopted.holds) : { reposts: [], unverified: [] };
      let recovering = new Set<string>();
      if (adopted.inflight.length > 0) {
        dormantInflight.set(sessionID, [...adopted.inflight]);
        if (recoverInflight === undefined) {
          // Recovered once the processor exists (the start-up loop): their holds wait for that recovery.
          for (const rec of adopted.inflight) if (typeof rec.callID === "string") recovering.add(rec.callID);
          deferredRestores.set(sessionID, { reposts: [], unverified: restored.unverified.filter((h) => recovering.has(h.callID)) });
        } else {
          // QA-2.1-29: only the attempts actually acknowledged for recovery settle their holds; a record whose recovery is
          // skipped (`decide` refused, `acknowledge` undefined) leaves its hold to `settleRestoredHolds` below.
          recovering = recoverInflight(sessionID);
        }
      }
      // R20/R21 (QA-2.1-2, QA-2.1-6): the restored holds still owe their verdict; a hold whose child is recovered above gets it there.
      if (restored.reposts.length > 0 || restored.unverified.some((h) => !recovering.has(h.callID))) {
        // QA-PDF12-14: the holds of one pass share their parent lookups.
        const pendingRestore = duringRestorePass(() => settleRestoredHolds(sessionID, restored, recovering));
        trackBackground(pendingRestore);
      }
    } catch (error) {
      ingestLogger.warn("[router] background: the persisted records of a session could not be adopted", { sessionID, error: String(error) });
    }
  };
  /** R21 (QA-2.1-2): the handles among `handles` whose verdict already reached `parent` (`metadata.router.handle`, or its entry text). */
  const postedVerdictHandles = async (parent: string, handles: ReadonlySet<string>): Promise<Set<string>> => {
    const history: unknown = await ctx.session.context({ sessionID: parent } as Parameters<typeof ctx.session.context>[0]);
    const found = new Set<string>();
    const visit = (value: unknown, depth: number): void => {
      if (typeof value === "string") {
        const match = /^<router-verdict handle="([^"]+)"/.exec(value);
        if (match !== null && handles.has(match[1]!)) found.add(match[1]!);
        return;
      }
      if (depth > 8 || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      const router: unknown = Reflect.get(value, "router");
      if (router !== null && typeof router === "object") {
        const handle: unknown = Reflect.get(router, "handle");
        if (typeof handle === "string" && handles.has(handle)) found.add(handle);
      }
      for (const key of Object.keys(value)) visit(Reflect.get(value, key), depth + 1);
    };
    visit(history, 0);
    return found;
  };
  /** Set with the completion processor: runs the gate again for a restored hold that has its child text (R20, QA-2.1-6). */
  let reverifyRestored: ((hold: RestoredHold) => Promise<void>) | undefined;
  /**
   * R20/R21 (QA-2.1-2, QA-2.1-6): settles the restored holds of an adopted parent. A verdict the parent already shows is recorded
   * as posted; a journaled `posting` text is posted again; any other hold re-runs the gate on its persisted child text (or, with
   * none, ends UNVERIFIABLE). A hold whose dispatch is recovered from its `inflight` record is left to that recovery.
   */
  const settleRestoredHolds = async (parent: string, restored: RestoredHolds, recovering: ReadonlySet<string>): Promise<void> => {
    const owed = new Set<string>([
      ...restored.reposts.map((r) => r.handle),
      ...restored.unverified.filter((h) => !recovering.has(h.callID)).map((h) => h.handle),
    ]);
    let posted = new Set<string>();
    try {
      posted = await postedVerdictHandles(parent, owed);
    } catch (error) {
      // A duplicate verdict is visible and harmless; a missing one keeps the child held for good.
      ingestLogger.warn("[router] background: the parent's history could not be read; restored verdicts are posted again", { parent, error: String(error) });
    }
    // QA-2.1-31: a verdict posted here (or found posted) bypasses the plugin's gate: its restored pending entry is settled
    // with it, so `router_verify` stops saying that the verdict follows.
    const settleEntry = (handle: string, verdict: "PASS" | "FAIL" | "UNVERIFIABLE", reason?: string): void => {
      try {
        finishApi?.settleHeldDirect(parent, handle, { verdict, ...(reason === undefined ? {} : { reason }) });
      } catch (error) {
        ingestLogger.warn("[router] background: the pending entry of a restored hold could not be settled", { handle, error: String(error) });
      }
    };
    for (const r of restored.reposts) {
      await held.settleRestored(r.handle, posted.has(r.handle));
      settleEntry(r.handle, verdictOfText(r.text));
    }
    for (const h of restored.unverified) {
      if (recovering.has(h.callID)) continue;
      if (posted.has(h.handle)) {
        await held.settleRestored(h.handle, true);
        settleEntry(h.handle, "UNVERIFIABLE", "verdict posted before the restart");
        continue;
      }
      if (reverifyRestored !== undefined) {
        await reverifyRestored(h);
        continue;
      }
      await held.verdict(h.handle, { verdict: "UNVERIFIABLE", text: "[router] not verified: lost in restart", reason: "lost in restart" });
      settleEntry(h.handle, "UNVERIFIABLE", "lost in restart");
      finishApi?.releaseHeld(h.handle);
    }
  };
  /** QA-2.1-31: the verdict a journaled verdict text names (UNVERIFIABLE when it names none). */
  const verdictOfText = (text: string): "PASS" | "FAIL" | "UNVERIFIABLE" => {
    const match = /\b(PASS|FAIL|UNVERIFIABLE)\b/.exec(text);
    return match === null ? "UNVERIFIABLE" : (match[1] as "PASS" | "FAIL" | "UNVERIFIABLE");
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
    // QA-2.1-8: verdict posts, recoveries and reloads in flight finish (bounded) before anything they write to is torn down.
    if (inFlightWork.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlightWork]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, BACKGROUND_DRAIN_MS); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    // QA-2.1-21: the held gates the plugin runs behind `finish` (and the verdict posts they start here) end too, same bound.
    if (finishApi !== undefined) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settleBackground(),
        new Promise<void>((resolve) => { idleTimer = setTimeout(resolve, BACKGROUND_DRAIN_MS); }),
      ]);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }
    // 3.1.7 W7: the executor first (runtime, then its launcher, which aborts the signals it owns), before the background
    // registry and the child runner it drives go away. Nothing reaches it after this: the emitter is a no-op without it.
    const ownedExecutor = executor;
    executor = null;
    hostEventListeners.clear();
    if (ownedExecutor !== null) {
      for (const [what, run] of [["runtime", () => ownedExecutor.runtime.dispose()], ["launcher", () => ownedExecutor.launcher.dispose()]] as const) {
        try {
          await run();
        } catch (error) {
          ingestLogger.warn(`[router] executor: the ${what} could not be disposed`, { error: String(error) });
        }
      }
    }
    executorLifetime.abort();
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
        // Cross-repo Phase 4 (SD-P4-15): the approvals store, read without git and only in roles mode with parents (no store
        // I/O otherwise, I9). An invalid store or a read failure gives no approved repository (fail closed).
        let approvedRoots: readonly RepoApproval[] = [];
        try {
          if (rolesRequested && resolveRolesRouting(routerConfig, "v2").repoParents.length > 0) {
            const read = readApprovals(options.approvalsDir !== undefined ? { dir: options.approvalsDir } : {});
            approvedRoots = read.invalid === undefined ? read.approvals : [];
          }
        } catch (error) {
          warnRoleOnce("roles:approvals", `roles mode (OpenCode v2 only): the repository approvals could not be read (${error instanceof Error ? error.message : String(error)}); no approved repository is granted`);
        }
        const registration = await registerRoleAgents(next.agent, routerConfig, {
          context7: Boolean(context7), directory: ctx.location.directory, seed: baseSeed, warn: warnRoleOnce, approvedRoots,
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
        // #84 P2.3 (T2.3.1, P-13, I3/I9): a role session is narrowed to ITS dispatch grant and work root: an action the max
        // policy refused stays refused, a sensitive-read ask stays an ask when the grant covers it. The one widening is D13 below.
        if (role !== undefined && event.effect !== "deny") {
          const { refusal, lift } = await roleEvaluateRefusal(event, role);
          if (refusal !== undefined) {
            event.effect = "deny";
            event.message = `Permission denied by role agent ${role} for this dispatch: ${refusal}`;
          } else if (lift && event.effect === "ask" && event.action === "external_directory") {
            // Cross-repo P4.5 / D13, I18 (lift only inside the grant): a host `ask` for `external_directory` becomes `allow` when the
            // binding is exact and the router's own decision allowed every resource — inside W (still a listed worktree) or R —
            // while cross-repo is in use (QA-1 F6: never for the session's own output directory, never without cross-repo: I9).
            // Never another action, never an unknown binding, never over a `deny` (host or configured: both skip this branch).
            event.effect = "allow";
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
          if (name === "router") {
            // Cross-repo P4.7 (SD-P4-11): after `/router approve|revoke` wrote the store, reload the role agents (their
            // `external_directory` patterns come from the store), then say whether the change is usable now. The text still goes
            // through `session.prompt` below, so the orchestrator sees it and dispatches again.
            const change = approvalsChangedOf(output.parts);
            if (change !== undefined) {
              let reloadError: string | undefined;
              try {
                await refresh();
              } catch (error) {
                reloadError = error instanceof Error ? error.message : String(error);
              }
              output.parts.push({ type: "text", text: approvalReloadLine(change, APPROVAL_RELOAD_APPLIES, reloadError) });
            }
          }
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
     * DF-1-4: per child, the completion elements already seen in its parent's context, by the message that holds them (QA-DF1-20:
     * message id, part and element index; never their content); bounded. Per adapter copy and lost on restart: a `child-ended`
     * attempt is read again on its parent's next request, so a skipped element never leaves it waiting for the sweep.
     */
    const seenCompletionElements = new Map<string, Set<string>>();
    /** Records a completion element of `child`; true only the first time it is seen. */
    const noteCompletionElement = (child: string, signature: string): boolean => {
      let seen = seenCompletionElements.get(child);
      if (seen?.has(signature)) return false;
      if (seen === undefined) {
        seen = new Set<string>();
        seenCompletionElements.set(child, seen);
        for (const old of seenCompletionElements.keys()) {
          if (seenCompletionElements.size <= MAX_SEEN_COMPLETION_CHILDREN) break;
          seenCompletionElements.delete(old);
        }
      }
      seen.add(signature);
      for (const old of seen) {
        if (seen.size <= MAX_SEEN_COMPLETION_ELEMENTS) break;
        seen.delete(old);
      }
      return true;
    };
    /** QA-DF1-17: per parent session, the completion elements (child, identity) of its last scanned history; bounded. */
    const lastScannedElements = new Map<string, ReadonlyArray<{ child: string; signature: string }>>();
    /**
     * QA-DF1-17: a resume of `child` is decided. Every completion element of that child in its parent's last scanned history belongs
     * to an earlier turn, whatever that turn's attempt state was when it was scanned (a `processing` one left it unremembered):
     * each is remembered now, so the resumed attempt never takes it.
     */
    const rememberElementsOnResume = (parent: string, child: string): void => {
      for (const element of lastScannedElements.get(parent) ?? []) {
        if (element.child === child) noteCompletionElement(child, element.signature);
      }
    };
    /**
     * A root session's request: every completion element of an acknowledged attempt starts its processing (not awaited), and the
     * first request that sees an attempt waits for it at most COMPLETION_SETTLE_MS (one shared budget, never again for that attempt).
     */
    const scanCompletions = async (sid: string, messages: readonly ContextMessage[]): Promise<void> => {
      if (processor === undefined) return;
      const waits: string[] = [];
      const scanned: Array<{ child: string; signature: string }> = [];
      /** The children an element of this request started processing for. */
      const taken = new Set<string>();
      for (const [messageIndex, message] of messages.entries()) {
        if (!Array.isArray(message.content)) continue;
        const messageKey = completionMessageKey(message, messageIndex);
        for (const [partIndex, part] of message.content.entries()) {
          if (part.type !== "text") continue;
          for (const [elementIndex, element] of completionElementsOf(part.text).entries()) {
            const attempt = inflight.byChild(element.child);
            if (attempt === undefined || attempt.parentSessionID !== sid) {
              ingestLogger.warn("[router] background: a completion element names a child with no attempt of this parent", {
                parent: sid, child: element.child, state: element.state, attempt: attempt === undefined ? "none" : attempt.parentSessionID,
              });
              continue;
            }
            // DF-1-4: the parent's history keeps the completion element of every earlier turn of a resumed child. An element is
            // remembered once an attempt took it or had finished when it was seen; a remembered one never starts a later attempt
            // (the resume's own element, or its end event, follows). Seen during a processing, it is left for the next request,
            // unless a resume of its child is decided first (QA-DF1-17: the resume marks every element of the child last scanned).
            // QA-DF1-20: an element is identified by the message that holds it (message id, part and element index), never by its
            // state and body: a resumed turn's byte-identical answer is a new element.
            const signature = `${messageKey}\0${partIndex}\0${elementIndex}`;
            scanned.push({ child: element.child, signature });
            const open = attempt.state === "acknowledged" || attempt.state === "child-ended";
            if (open && !noteCompletionElement(element.child, signature)) continue;
            if (!open && attempt.state !== "processing") noteCompletionElement(element.child, signature);
            if (open) {
              taken.add(element.child);
              trackBackground(processor.process(element.child, { kind: "completion", state: element.state, body: element.body, at: nowMs() }));
            }
            if (!attempt.waitedOnce && !waits.includes(element.child)) {
              attempt.waitedOnce = true;
              waits.push(element.child);
            }
          }
        }
      }
      // QA-DF1-20: an attempt whose end left it `child-ended` (its answer not readable yet) that no element of this request took
      // reads its child again now, instead of waiting for an element that may never be new to this copy, or for the sweep.
      for (const attempt of inflight.listForParent(sid)) {
        if (attempt.state !== "child-ended" || taken.has(attempt.childSessionID)) continue;
        if (inflight.byChild(attempt.childSessionID) !== attempt) continue;
        const outcome = attempt.outcome;
        if (outcome === undefined || outcome === "unknown") continue;
        // The end it met is replayed as is (its outcome and time): only the child's answer is read again.
        const end = { outcome, eventID: `reread:${attempt.key}`, at: attempt.endedAt ?? nowMs() };
        trackBackground(processor.process(attempt.childSessionID, { kind: "early-end", end }));
      }
      lastScannedElements.delete(sid);
      lastScannedElements.set(sid, scanned);
      for (const old of lastScannedElements.keys()) {
        if (lastScannedElements.size <= MAX_SEEN_COMPLETION_CHILDREN) break;
        lastScannedElements.delete(old);
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
      // 3.1.7 M41 (always on): the first user message of the session decides whether it is an unbound plan child (fail closed).
      if (typeof event.sessionID === "string") await planChildGuard.check(event.sessionID, firstMessageText(event.messages));
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

    // 3.1.7 W4: the host's retry hook is registered with the executor below (W1), only when the factory built one (M3).
    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      // 3.1.7 M41 (always on): a plan child without its plan binding is refused every tool call (fail closed). The context hook
      // checks a session's first user message; a first tool call that comes before that hook performs the same check here.
      await planChildGuard.assertToolAllowed(String(event.sessionID));
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
        // `args` (scopedArgs) rewrites `task_id` from `sessionID`: a call that names the child by `task_id` must still be seen.
        const rawInput = event.input !== null && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
        const heldArgs = rawInput === undefined || args === null || typeof args !== "object" || typeof rawInput.task_id !== "string"
          ? args
          : { ...args, task_id: rawInput.task_id };
        const heldRefusal = held.refusal(String(event.sessionID), event.tool, heldArgs);
        if (heldRefusal !== undefined) throw refused(heldRefusal, callerRole);
        // QA-2.1-8: while the journal is not reloaded the restored holds are unknown, so a resume of a session this process has no
        // attempt for may be a resume of a held child: refused (fail closed) until a reload succeeds.
        // QA-2.1-20: Code Mode `execute` code is inspected too, as `held.refusal` does: a session it resumes by name is refused alike.
        if (reloadFailed) {
          // QA-2.1-16: the refusal promises a retry; each refused attempt starts one (bounded by PENDING_RELOAD_RETRY_MS).
          retryReload();
          for (const target of resumeTargetsOf(event.tool, heldArgs, String(event.sessionID))) {
            if (inflight.byChild(target) === undefined) throw refused(reloadFailedResumeText(target), callerRole);
          }
        }
      }
      // Only the tools the guard checks (file tools, `router_git_*`, `router_run`) and the search tools (`glob`/`grep`, whose
      // result the guard filters, so the actor must be resolved before them) reach it: no host call for any other tool.
      const leaseClass = roleActionOf(event.tool);
      if (leaseGuard !== undefined && (leaseClass === "read" || leaseClass === "edit" || event.tool === "glob" || event.tool === "grep" || event.tool.startsWith("router_git_") || event.tool === "router_run")) {
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
        // DF-1-9: a role decision read the session (dispatch.ts routeRoleCall): the floor rung is a delegate's (it has a parent), any
        // other is the orchestrator's — the kind of an unrecorded session is known without another host call. A root is marked for
        // the timing recorder too, as `session.created` does (a recorded kind skips the step path's own lookup).
        if (routed.role !== undefined && !sessionKinds.has(String(event.sessionID))) {
          const kind = routed.role.delegate === true ? "child" : "root";
          noteSessionKind(String(event.sessionID), kind);
          if (kind === "root") timings?.markRootSession(String(event.sessionID));
        }
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
        /** QA-PDF12-6: another copy of the plugin in this process claimed the call first; its background flag stands. */
        let lostClaim = false;
        if (event.tool === "subagent" && bgActive() && finishApi !== undefined) {
          const parent = String(event.sessionID);
          // DF-1-9: a parent the plugin never recorded (a reload, past the bound) is resolved, never assumed a root: an
          // unrecorded child must not reach the `auto` rows (A-2.1-1, root parents only). A lookup that fails stays foreground;
          // QA-DF1-23: so does one the host has not answered within SESSION_KIND_DISPATCH_TIMEOUT_MS.
          const recordedKind = sessionKinds.get(parent);
          const parentKind = recordedKind ?? await dispatchSessionKindOf(parent);
          if (recordedKind === undefined && parentKind === "root") timings?.markRootSession(parent); // as the step path's lookup does
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
            parentIsRoot: parentKind === "root", liveCount: inflight.liveCount(),
          });
          const resumeOf = typeof output.args?.sessionID === "string" && output.args.sessionID !== "" ? output.args.sessionID : undefined;
          // QA-DF1-17: the earlier turns' completion elements of a resumed child are never the resume's, whatever their state.
          if (resumeOf !== undefined) rememberElementsOnResume(parent, resumeOf);
          const claimed = inflight.decide({
            callID: event.id, parentSessionID: parent, agent: String(output.args?.agent ?? ""),
            ...(typeof event.agent === "string" && event.agent !== "" ? { callerAgent: event.agent } : {}),
            // QA-PDF12-5: the message that made the call, so a rebuilt caller context carries real ids, never an empty one.
            ...(typeof event.messageID === "string" && event.messageID !== "" ? { callerMessageID: event.messageID } : {}),
            ...(info?.role === undefined ? {} : { role: info.role }),
            description: typeof output.args?.description === "string" ? output.args.description : "", verifying,
            verificationMode: verification?.mode ?? "none", decision,
            ...(resumeOf === undefined ? {} : { resumeOf }),
            at: nowMs(),
          });
          // QA-PDF12-6: a copy that lost the call's claim to another copy leaves the call's background flag as it found it.
          if (claimed) background = decision.background;
          else {
            // QA-PDF12-10: the owner copy holds the verification and the result; this copy must not treat the call as verifying.
            lostClaim = true;
            verifyingCalls.delete(event.id);
          }
        }
        // QA-PDF12-6: without the claim, `undefined` keeps the `background` key the input already has (set by the copy that claimed).
        event.input = nativeArgs(event.tool, output.args, original, lostClaim ? undefined : background);
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
    /**
     * The child's last assistant message of its current turn (after its newest user prompt, DF-1-4) (`ctx.session.context`,
     * C7/O1); also the recovery read of a persisted dispatch.
     */
    const lastAssistantText = async (child: string): Promise<{ text: string } | undefined> => {
      const history = await ctx.session.context({ sessionID: child } as Parameters<typeof ctx.session.context>[0]);
      const messages: readonly unknown[] = Array.isArray(history) ? history : [];
      for (let index = messages.length - 1; index >= 0; index--) {
        // The host's context entries are discriminated by `type` ("user" | "assistant" | "synthetic", see the instruction filter in
        // the system hook); the model-facing messages of the context hook use `role`. Both name the assistant the same way.
        const message = messages[index] as { type?: unknown; role?: unknown } | undefined;
        if (message?.type === "assistant" || message?.role === "assistant") {
          const text = messageText(message);
          if (text !== undefined) return { text };
        }
        // DF-1-4: the newest user prompt opens the current turn; an answer before it belongs to an earlier turn (a resume).
        if (message?.type === "user" || message?.role === "user") break;
      }
      ingestLogger.warn("[router] background: the child's context holds no assistant message", {
        child,
        shape: Array.isArray(history) ? `array(${messages.length})` : typeof history,
        keys: history !== null && typeof history === "object" ? Object.keys(history).slice(0, 12).join(",") : "",
        lastMessage: JSON.stringify(messages.at(-1) ?? null)?.slice(0, 300) ?? "",
      });
      return undefined;
    };
    /**
     * QA-2.1-6: the end state of a persisted dispatch's child, from its own history. The newest non-synthetic entry decides: an
     * assistant message with an error failed (or was interrupted, for an abort); one with text succeeded only when it carries a
     * completion marker (QA-2.1-18, `assistantStepCompleted`: a finish reason other than `tool-calls` or a completed time, and no
     * pending or running tool part); anything else (no entry, a user or tool turn last, a step cut mid-stream) never finished,
     * which after a restart means lost.
     */
    const childEndState = async (child: string): Promise<ChildEndState> => {
      // QA-4.2-27: the shared end rule (`childHistoryEnd`, also the executor's `HostSessions.context`).
      const end = childHistoryEnd(await ctx.session.context({ sessionID: child } as Parameters<typeof ctx.session.context>[0]));
      if (end.kind === "none") return { outcome: "lost" };
      // QA-DF1-21: a user or tool turn last, or a step without its end, is an execution that has not ended (`incomplete`).
      if (end.kind === "open") return { outcome: "lost", incomplete: true };
      // Background's own rule on top (QA-2.1-6, kept): a succeeded step without text is a result that never arrived, so the
      // dispatch is lost and its parent is told to dispatch it again (the executor reads it as an empty result instead).
      if (end.outcome === "succeeded" && end.text === undefined) return { outcome: "lost" };
      return { outcome: end.outcome, ...(end.text === undefined ? {} : { text: end.text }) };
    };
    /** QA-2.1-6: one `resume: true` entry tells the parent that a background dispatch was lost in a restart. Never throws. */
    const wakeParentLost = async (attempt: Attempt): Promise<void> => {
      if (typeof syntheticRaw !== "function") return;
      try {
        await Reflect.apply(syntheticRaw, ctx.session, [{
          sessionID: attempt.parentSessionID,
          text: `[router] The background dispatch ${attemptLabel(attempt)} (${attempt.childSessionID}) was lost in a restart: its result never arrived. Dispatch it again if you still need it.`,
          description: "Model router notice",
          metadata: { router: { kind: "lost-dispatch", child: attempt.childSessionID, callID: attempt.callID } },
          resume: true,
        }]);
      } catch (error) {
        ingestLogger.warn("[router] background: the parent of a lost dispatch could not be told", { child: attempt.childSessionID, error: String(error) });
      }
    };
    if (finishApi !== undefined) {
      const api = finishApi;
      const captureDeltaOf = api.captureDelta?.bind(api);
      // R20 (QA-2.1-6): a restored hold with its child text runs the gate again; without one it ends UNVERIFIABLE.
      reverifyRestored = async (hold) => {
        // QA-2.1-31: every verdict posted here bypasses the plugin's gate; the restored pending entry is settled with it.
        const settleEntry = (verdict: "PASS" | "FAIL" | "UNVERIFIABLE", reason?: string): void => {
          try {
            api.settleHeldDirect(hold.parentSessionID, hold.handle, { verdict, ...(reason === undefined ? {} : { reason }) });
          } catch (error) {
            ingestLogger.warn("[router] background: the pending entry of a restored hold could not be settled", { handle: hold.handle, error: String(error) });
          }
        };
        const unverifiable = async (reason: string): Promise<void> => {
          await held.verdict(hold.handle, { verdict: "UNVERIFIABLE", text: `${hold.childText === undefined ? "" : `${hold.childText}\n`}[router] not verified: ${reason}`, reason });
          settleEntry("UNVERIFIABLE", reason);
          api.releaseHeld(hold.handle);
        };
        // QA-2.1-17: a verdict the gate reached before the restart (its `state` record) is posted as it was, never recomputed.
        const stored = hold.verdict;
        if (stored !== undefined) {
          const line = `[router] ${stored.verdict}${stored.reason === undefined ? "" : ` — ${stored.reason}`}`;
          await held.verdict(hold.handle, {
            verdict: stored.verdict, text: hold.childText === undefined ? line : `${hold.childText}\n\n${line}`,
            ...(stored.reason === undefined ? {} : { reason: stored.reason }),
          });
          settleEntry(stored.verdict, stored.reason);
          api.releaseHeld(hold.handle);
          return;
        }
        // QA-2.1-17: `hold-text` is journaled for a succeeded child only, so a missing text is a child that did not
        // succeed, or one the restart cut before its text was kept.
        const childText = hold.childText;
        if (childText === undefined) {
          await unverifiable("lost in restart");
          return;
        }
        try {
          // QA-2.1-17: the plugin rebuilds the gate inputs from the journaled dispatch and the restored pending entry, and
          // re-posts a verdict the entry already reached.
          const result = await withinCaller(hold, () => api.finish({
            callID: hold.callID, parentSessionID: hold.parentSessionID, childSessionID: hold.childSessionID, outputText: childText,
            status: "succeeded", mode: "background", heldHandle: hold.handle, endedAt: nowMs(), restored: hold.dispatch,
          }));
          // The gate runs behind `finish`; it posts the verdict through the HeldSink when it settles.
          if (result.verification.kind === "held") return;
          api.releaseHeld(hold.handle);
          const v = result.verification;
          if (v.kind === "required") {
            await held.verdict(hold.handle, { verdict: v.verdict, text: result.outputText });
            settleEntry(v.verdict, v.verdict === "UNVERIFIABLE" ? "verification data lost in restart" : undefined);
            return;
          }
          await held.verdict(hold.handle, { verdict: "UNVERIFIABLE", text: `${result.outputText}\n[router] not verified: no verification ran`, reason: "no verification ran" });
          settleEntry("UNVERIFIABLE", "no verification ran");
        } catch (error) {
          await unverifiable(`verification after a restart failed: ${String(error)}`);
        }
      };
      processor = executorProcessor = createCompletionProcessor(inflight, { // 3.1.7 W5: also the executor's runner-trigger sink
        // QA-PDF12-9: the caller is the one the processor's attempt carries (journaled at decide), not a capped call-id lookup.
        // QA-PDF12-14: only a succeeded completion can launch a grader as the caller, so only it waits for the caller lookups.
        finish: (input, caller) => withinCaller({ parentSessionID: input.parentSessionID, callID: input.callID, ...caller }, () => api.finish(input), input.status === "succeeded"),
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
        // QA-2.1-4: a held attempt that ends without a held register gives its reserved handle back.
        releaseHeld: (handle) => api.releaseHeld(handle),
        // QA-2.1-17: a recovery finishes with the dispatch data its `inflight` record journaled.
        restoredDispatch: (attempt) => {
          const dispatch = restoredDispatches.get(attempt.callID);
          restoredDispatches.delete(attempt.callID);
          return dispatch;
        },
      });
      const closing = processor;
      closeAttempt = (attempt, cause) => closing.closeUnknown(attempt, cause);
      // Memo §11.3: an adopted `inflight` record without `processed` is recovered through the child's own history: finished ->
      // process; otherwise lost. The attempt is re-registered first so the processor has its key; a failure leaves it to the sweep.
      recoverInflight = (sessionID) => {
        const records = dormantInflight.get(sessionID);
        dormantInflight.delete(sessionID);
        const recovering = new Set<string>();
        for (const rec of records ?? []) {
          const callID = typeof rec.callID === "string" ? rec.callID : undefined;
          const child = typeof rec.childSessionID === "string" ? rec.childSessionID : typeof rec.child === "string" ? rec.child : undefined;
          if (callID === undefined || child === undefined) continue;
          // QA-DF1-21: written by this very process (its token, never just its pid, which a later process may reuse).
          const sameProcess = rec.process === processToken();
          const mode = rec.verificationMode === "required" || rec.verificationMode === "deferred" ? rec.verificationMode : "none";
          const registered = inflight.decide({
            callID, parentSessionID: sessionID, agent: typeof rec.agent === "string" ? rec.agent : "",
            ...(typeof rec.callerAgent === "string" && rec.callerAgent !== "" ? { callerAgent: rec.callerAgent } : {}),
            ...(typeof rec.callerMessageID === "string" && rec.callerMessageID !== "" ? { callerMessageID: rec.callerMessageID } : {}),
            ...(typeof rec.role === "string" ? { role: rec.role } : {}),
            description: typeof rec.description === "string" ? rec.description : "",
            verifying: rec.verifying === true, verificationMode: mode,
            decision: { background: true, hold: false, reason: "prior" }, at: typeof rec.at === "number" ? rec.at : nowMs(),
          });
          const handle = typeof rec.hold === "string" ? rec.hold : typeof rec.handle === "string" ? rec.handle : undefined;
          // A held dispatch is recovered only while its hold is live here (restored or still journaled); otherwise it is a plain one.
          const holdHandle = handle !== undefined && held.isHeld(child) ? handle : undefined;
          const attempt = registered
            ? inflight.acknowledge(callID, child, { userBackgrounded: true, ...(holdHandle === undefined ? {} : { hold: { handle: holdHandle } }) })
            : undefined;
          if (attempt === undefined) continue;
          recovering.add(callID);
          restoredDispatches.delete(callID);
          restoredDispatches.set(callID, restoredDispatchOf(rec.dispatch));
          while (restoredDispatches.size > MAX_ADOPTED_SESSIONS) restoredDispatches.delete(restoredDispatches.keys().next().value!);
          trackBackground((async () => {
            // QA-2.1-6: the child's END STATE decides (succeeded / failed / interrupted / never finished), not just "some text exists".
            let end: ChildEndState = { outcome: "lost" };
            try {
              end = await childEndState(child);
            } catch (error) {
              ingestLogger.warn("[router] background: the child of a persisted dispatch could not be read; treated as lost", { child, error: String(error) });
            }
            // QA-DF1-21: a record of this very process (an owning location the host evicted, not a restart) whose child's last step
            // has no end is a child still running here: its attempt stays acknowledged (dormant) until its end event processes it.
            if (end.outcome === "lost" && end.incomplete === true && sameProcess) {
              ingestLogger.info?.("[router] background: an adopted dispatch of this process is still running; waiting for its end", { child, callID });
              return;
            }
            await closing.process(child, end.outcome === "lost"
              ? { kind: "recovery", outcome: "lost", text: undefined, at: nowMs() }
              : { kind: "recovery", outcome: end.outcome, text: end.text ?? "", at: nowMs() });
            // QA-2.1-6: a lost dispatch without a hold wakes its parent once (a held one is woken by its verdict post). Once per child:
            // the processor runs once per attempt and journals `processed`, so the next start does not recover it again.
            if (end.outcome === "lost" && holdHandle === undefined) await wakeParentLost(attempt);
          })());
        }
        return recovering;
      };
      for (const sessionID of [...dormantInflight.keys()]) {
        const recovered = recoverInflight(sessionID);
        // QA-2.1-29: a hold adopted before the processor existed waited for this recovery; a skipped one is settled now.
        const waiting = deferredRestores.get(sessionID);
        deferredRestores.delete(sessionID);
        if (waiting !== undefined && waiting.unverified.some((h) => !recovered.has(h.callID))) {
          trackBackground(settleRestoredHolds(sessionID, waiting, recovered));
        }
      }
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
    // 3.1.7 W1: the executor's host adapters and its (nullable, M3) construction. Without `options.executor`, or when it answers
    // null, nothing below registers anything and every seam above stays a no-op.
    const childRunner = runtime?.childRunner;
    if (options.executor !== undefined && childRunner !== undefined) {
      const hosts: HostSessions = {
        get: async (sessionID) => {
          const session = await sessionOf(sessionID) as { id?: unknown; parentID?: unknown } | null | undefined;
          if (session === null || session === undefined) return null;
          return { id: typeof session.id === "string" ? session.id : sessionID, parentID: typeof session.parentID === "string" && session.parentID !== "" ? session.parentID : null };
        },
        context: async (sessionID) => executorHostContext(await ctx.session.context({ sessionID } as Parameters<typeof ctx.session.context>[0])),
        activity: async () => "unknown",
        interrupt: async (sessionID) => { await ctx.session.interrupt({ sessionID }); },
        synthetic: async (i) => {
          // QA-3.1 nit 1: the metadata goes through to the host.
          await ctx.session.synthetic({ sessionID: i.sessionID, text: i.text, description: i.description, metadata: i.metadata, resume: i.resume });
        },
        move: async (sessionID, directory) => { await ctx.session.move({ sessionID, directory }); },
        onEvent: (listener) => {
          hostEventListeners.add(listener);
          return () => { hostEventListeners.delete(listener); };
        },
      };
      const bookkeeping: DispatchBookkeeping = {
        decisionRow: (req) => executorInFlight.remember(req),
        recordDispatchStart: (req, startedAt) => {
          const entry = executorLaunches.get(executorAttemptKey(req.taskId, req.attempt));
          const at = Date.parse(startedAt);
          timings?.recordDispatchStart({
            callID: entry?.callID ?? `executor:${req.planId}:${req.taskId}#${req.attempt}:${req.nonce}`, childSessionID: null,
            parentSessionID: req.orchestratorSessionID, role: req.role, class: "unknown", scope: "unknown",
            tier: req.route.heavy ? "heavy" : "unknown", model: `${req.route.model.providerID}/${req.route.model.modelID}`,
            background: true, at: Number.isFinite(at) ? at : nowMs(),
          });
        },
        registerInFlight: (taskId, attempt, child) => executorInFlight.register(taskId, attempt, child),
        unregisterInFlight: (taskId, attempt, status) => executorInFlight.unregister(taskId, attempt, status),
      };
      /**
       * QA-3.1-2: a plan child's grant, computed as the role dispatch path computes one (`grantFor`): the role's base actions
       * (the local read actions every role gets; an implementer also edits) plus the route `needs` mapped to actions (`edit` →
       * edit, `shell`/`network` → router_run; `web` and `external_dir` add none, the work root satisfies `external_dir`), all
       * within the role's maximum and the separation rule. An unknown role gets nothing (fail closed).
       */
      const planChildGrant = (agent: string, needs: readonly string[], workRoot: string): string[] => {
        const spec = rolesOf(loadConfig(ctx.location.directory)).get(agent);
        if (spec === undefined) {
          if (rolesStarted === true) ingestLogger.warn("[router] executor: a plan child's agent is no live role agent; it is bound with no action", { agent });
          return [];
        }
        const routeNeeds = needs.filter((n): n is Need => (NEEDS as readonly string[]).includes(n));
        return [...grantFor(spec, { ...UNKNOWN_FACTS, needs: routeNeeds }, [], workRoot).actions];
      };
      const host: V2ExecutorHost = {
        hosts,
        routes: null,
        bindings: {
          // QA-3.1-2: the launch request's grant holds the route `needs`; the binding gets the role grant they map to.
          bind: (i) => bindPlanChild({ ...i, grant: planChildGrant(i.agent, i.grant, i.workRoot) }),
          evict: (childSessionID) => evictBinding(childSessionID),
        },
        bookkeeping,
        verifier: options.slotVerifier ?? null,
        leaseRegistry: options.leaseRegistry ?? null,
        runner: childRunner,
        pinOrchestrator: (sessionID) => childRunner.pin(sessionID),
        onLauncherMetric: (planId, m) => executor?.runtime.recordMetric(planId, m),
        knownAgent: (agent) => config.agent[agent] !== undefined,
        lifetime: executorLifetime.signal,
      };
      try {
        executor = options.executor(host);
      } catch (error) {
        executor = null;
        ingestLogger.warn("[router] executor: it could not be built; plans are not executed", { error: String(error) });
      }
      const built = executor;
      if (built !== null) {
        // W2 (3.1.7.a): every router tool call of a bound orchestrator refreshes the executor (guard 6, the ready set).
        const unsubscribe = childRunner.onContextCaptured((c) => {
          try {
            built.runtime.onRouterToolCall(c.sessionID);
          } catch (error) {
            ingestLogger.warn("[router] executor: a router tool call could not be fed", { error: String(error) });
          }
        });
        // W6 (3.1.7.e): the plan line and the manual tasks ready for the orchestrator.
        const unregisterPlan = turnState.registerTurnStateProvider({
          name: PLAN_PROVIDER_NAME, order: PLAN_PROVIDER_ORDER,
          render: (sid) => {
            const line = built.runtime.planLine(sid);
            const manual = built.runtime.manualReady(sid);
            const lines = [
              ...(line === null ? [] : [line]),
              ...(manual.length === 0 ? [] : ["[router] Ready for you:", ...manual.map((t) => `- ${t.taskId}: manual (${t.kind})`)]),
            ];
            return lines.length === 0 ? undefined : lines.join("\n");
          },
          active: (sid) => built.runtime.planLine(sid) !== null || built.runtime.manualReady(sid).length > 0,
        });
        registrations.push({ dispose: async () => { unsubscribe(); unregisterPlan(); } });
        // W4 (3.1.7.c, ADR 0007 D13): the host's retry decision feeds the capacity signals; the executor stops the retry of a plan
        // child only. Registered only when an executor exists (M3); on any error the decision stays unchanged.
        registrations.push(await ctx.session.hook("retry", async (event) => {
          try {
            const sessionID = String(event.sessionID);
            // QA-3.1-21: the step's `step.started` may still wait in the event loop: the key must name this step, not the last one
            openExecutorStepForHook(sessionID);
            const { stop } = built.runtime.onRetryHook({ sessionID, stepKey: executorStepKey(sessionID), error: toHostError(event.error) });
            // QA-3.1-8: a retry is pending only when neither the executor nor the host's own decision (`{retry: false}` for a
            // usage limit, C10) stops it; a stopped one no longer keeps the step open.
            const hostRetries = (event.decision as { retry?: unknown } | undefined)?.retry !== false;
            noteExecutorStep(sessionID, !stop && hostRetries ? "retry" : "retry-stop");
            // QA-3.1-3: the memo's `decision.retry = false`. The host's `SessionRetry` carries a writable `decision` (C10 probe), so
            // a plan child's retry stops; the runtime records the stop (`capacityStopped`) either way.
            if (stop) {
              if (event.decision !== undefined && event.decision !== null) event.decision = { retry: false };
              else ingestLogger.warn("[router] executor: a plan child's retry should stop; this host offered no retry decision", { sessionID });
            }
          } catch (error) {
            ingestLogger.warn("[router] executor: the retry signal could not be fed", { error: String(error) });
          }
        }));
        trackBackground(built.runtime.start().catch((error: unknown) => {
          ingestLogger.warn("[router] executor: it could not start", { error: String(error) });
        }));
      }
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
              const unheldText = verifyingCalls.has(event.id) || handle !== undefined
                ? `${notRunning} Its result will arrive unverified; the verdict follows in the router state.`
                : `${notRunning} Router guarantees apply when it completes.`;
              let journaled = true;
              // QA-2.1-17: the prompt, cwd and work root go with the records, so a gate after a restart has its inputs.
              let dispatch: RestoredDispatch | undefined;
              try {
                dispatch = finishApi?.dispatchOf(event.id);
              } catch (error) {
                ingestLogger.warn("[router] background: the dispatch data could not be read; a restart cannot verify it", { error: String(error) });
              }
              try {
                await journal.append({
                  v: 1, kind: "inflight", key: attempt.key, callID: event.id, parentSessionID: parent, childSessionID: resultChild,
                  label: attemptLabel(attempt), ...(handle === undefined ? {} : { handle }), at: nowMs(),
                  agent: rec.agent, description: rec.description, verifying: rec.verifying, verificationMode: rec.verificationMode,
                  ...(rec.callerAgent === undefined ? {} : { callerAgent: rec.callerAgent }),
                  ...(rec.callerMessageID === undefined ? {} : { callerMessageID: rec.callerMessageID }),
                  ...(rec.role === undefined ? {} : { role: rec.role }), hold: handle ?? null,
                  ...(dispatch === undefined ? {} : { dispatch }), process: processToken(),
                }, { fsync: true });
              } catch (error) {
                journaled = false;
                ingestLogger.warn("[router] background: the dispatch could not be journaled; its result is not held", { error: String(error) });
              }
              let holding = false;
              if (handle !== undefined && journaled) {
                try {
                  await held.hold({
                    handle, parentSessionID: parent, childSessionID: resultChild, callID: event.id, label: attemptLabel(attempt),
                    ...(rec.callerAgent === undefined ? {} : { callerAgent: rec.callerAgent }),
                    ...(rec.callerMessageID === undefined ? {} : { callerMessageID: rec.callerMessageID }),
                    ...(dispatch === undefined ? {} : { dispatch }),
                  });
                  holding = true;
                } catch (error) {
                  ingestLogger.warn("[router] background: the result could not be held; it arrives unverified", { error: String(error) });
                }
              }
              if (handle !== undefined && !holding) {
                // QA-2.1-3: no hold exists, so nothing may say "held": the attempt is a plain verifying one and the handle goes back.
                delete attempt.hold;
                try {
                  finishApi?.releaseHeld?.(handle);
                } catch (error) {
                  ingestLogger.warn("[router] background: the reserved handle could not be released", { error: String(error) });
                }
              }
              // QA-2.1-3: the acknowledgement text is chosen only after both writes settled.
              ackText = holding ? `${notRunning} Its result is held until verification finishes.` : unheldText;
              const early = inflight.takeEarlyEnd(resultChild);
              if (early !== undefined && processor !== undefined) trackBackground(processor.process(resultChild, { kind: "early-end", end: early }));
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
      // QA-P21-1-3: the plugin's signals and gate read the child from the legacy metadata; a result names it there when the host
      // reports it only in the structured output (spike S1: `result.output.sessionID`). A role call takes the child the role
      // path resolved; a tier subagent call takes the structured output's non-empty string `sessionID`, as v1 always had it, so the
      // child's tool-observed edits and unobservable-writer tally reach the producer lineage. Metadata that already names the
      // child (`sessionID` or `sessionId`) is never overwritten; every other call's metadata passes through unchanged.
      const resultMetadata = event.result.metadata as Record<string, unknown> | undefined;
      const structuredChild = event.tool === "subagent" && typeof structured?.sessionID === "string" && structured.sessionID !== ""
        ? structured.sessionID : undefined;
      const namedChild = role?.child != null ? role.child : structuredChild;
      const output = {
        title: "", output: text,
        metadata: {
          ...resultMetadata,
          ...(namedChild !== undefined && resultMetadata?.sessionID === undefined && resultMetadata?.sessionId === undefined ? { sessionID: namedChild } : {}),
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
    /**
     * QA-2.1-21: the handling of each event is background work from the moment the loop takes it until the loop asks for the
     * next one (a `continue` and a `break` included), so the settled seam and `dispose` never miss what an event starts after
     * an await (the timing store's file write before the processor starts). Only the events that start background work are
     * tracked (a child's creation adopts, its end processes): a step event's handler may wait for the model catalog until
     * `dispose` (QA-2.1-5), which the settled seam must never wait for.
     */
    const trackedEvents = async function* <T>(source: AsyncIterable<T>): AsyncGenerator<T> {
      for await (const event of source) {
        const type: unknown = event !== null && typeof event === "object" ? Reflect.get(event, "type") : undefined;
        if (typeof type !== "string" || (type !== "session.created" && !type.startsWith("session.execution."))) {
          yield event;
          continue;
        }
        let handled: () => void = () => undefined;
        trackBackground(new Promise<void>((resolve) => { handled = resolve; }));
        try {
          yield event;
        } finally {
          handled();
        }
      }
    };
    eventTask = (async () => {
      for await (const event of trackedEvents(ctx.event.subscribe({ signal: abort.signal }))) {
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
            // 3.1.7 W4/W6 (M46): the executor's one host-event path; a no-op without an executor.
            forwardHostEvent(event.type, sid, data, (event as { created?: unknown }).created);
            if (event.type === "session.created") {
              noteSessionKind(sid, data.parentID ? "child" : "root");
              if (!data.parentID) timings?.markRootSession(sid);
              // QA-2.1-6: the event loop adopts too, so a parent that only shows up through events still gets its records.
              adoptSession(typeof data.parentID === "string" && data.parentID !== "" ? data.parentID : sid);
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
              // QA-2.1-21: the end handling is background work from its first await on (the timing store writes to disk
              // before the processor starts): tracked, so the settled seam and `dispose` never miss the processing it starts.
              const timingDone = timings === undefined ? undefined : timings.onExecutionOutcome(sid, event.id, outcome, at);
              if (timingDone !== undefined) {
                const endHandled = Promise.resolve(timingDone).then(() => undefined);
                trackBackground(endHandled);
                await endHandled;
              }
              // DF-1-5: a root run's end closes its orchestrator turn, whatever the background mode: under background-first dispatch
              // the kickoff and each synthetic wake-up are runs without a `prompt` hook, so no prompt would ever close them.
              if (timings?.isRootSession(sid) === true) {
                const turnDone = timings.onRootExecutionEnd(sid, event.id)
                  .catch((error: unknown) => ingestLogger.warn("[router] timing: the turn boundary could not be recorded", { error: String(error) }));
                trackBackground(turnDone);
                await turnDone;
              }
              leaseGuard?.releaseChild(sid);
              leaseHandle?.notifyReleased();
              // QA-2.1-6: an end event adopts the parent's records: the root itself, or (for a child this process has no attempt for)
              // its parent, looked up once (`sessionOf`) and never awaited here.
              if (sessionKinds.get(sid) === "root") adoptSession(sid);
              else if (bgActive() && inflight.byChild(sid) === undefined && !sessionKinds.has(sid)) {
                // QA-2.1-30: only a session of unknown kind is looked up: a child seen at `session.created` had its parent
                // adopted there, and a looked-up child is remembered, so later ends never call `sessionOf` again.
                trackBackground(sessionOf(sid).then((session) => {
                  const parentID: unknown = session !== null && typeof session === "object" ? Reflect.get(session, "parentID") : undefined;
                  if (typeof parentID === "string" && parentID !== "") {
                    noteSessionKind(sid, "child");
                    adoptSession(parentID);
                  } else {
                    adoptSession(sid);
                  }
                }));
              }
              if (bgActive() && processor !== undefined) {
                const attempt = inflight.byChild(sid);
                if (attempt !== undefined) {
                  // QA-2.1-21: tracked, so `dispose` and the settled seam wait for the completion it starts.
                  // DF-1-4: a `child-ended` attempt met an end before its turn had an answer to read: this end delivers it.
                  if (attempt.state === "acknowledged" || attempt.state === "child-ended") trackBackground(processor.process(sid, { kind: "end-event", outcome, eventID: event.id, at }));
                  else ingestLogger.warn("[router] background: an end event met an attempt that is not awaiting one", { child: sid, state: attempt.state, outcome });
                } else if (sessionKinds.get(sid) !== "root") {
                  // A session whose kind is not yet known may be a child whose acknowledgement is still to come (bounded, TTL).
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
              forgetWorkingSet(data.sessionID); // cross-repo P1.4: the orchestrator's bound repository locations
              evictAuthority(data.sessionID);
              ownOutputs.delete(data.sessionID); // QA-P23-2-A1
              lookupNamedAgent.delete(data.sessionID);
              lastCallOfChild.delete(data.sessionID);
              hostBudget.forget(data.sessionID);
              effortStore.forget(data.sessionID); // #90 P1.2: a deleted session is no longer answered
              // Phase 2.1 (memo §4.6): the session's attempts, holds, leases and cached kind go with it.
              inflight.forgetSession(data.sessionID);
              seenCompletionElements.delete(data.sessionID);
              lastScannedElements.delete(data.sessionID);
              processor?.forgetSession(data.sessionID);
              held.forgetSession(data.sessionID);
              leaseGuard?.releaseChild(data.sessionID);
              leaseHandle?.notifyReleased();
              sessionKinds.delete(data.sessionID);
              // QA-2.1-11 / QA-2.1-13: the cached directory, the failed kind lookup and the adoption mark go with the session.
              sessionDirs.delete(data.sessionID);
              failedKinds.delete(data.sessionID);
              adoptedSessions.delete(data.sessionID);
              refusedAdoptions.delete(data.sessionID);
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
    Object.defineProperty(cleanup, V2_BACKGROUND_SETTLED, { value: settleBackground, enumerable: false });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
