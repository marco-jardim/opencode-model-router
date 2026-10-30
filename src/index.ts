import type { Plugin } from "@opencode-ai/plugin";
import { completionIdentity, observeV2 } from "./compat/v2-observations";
import type { RouterPluginInput } from "./compat/child-session";
import { DEPTH_BANNER, ResumeRejectedError, TASK_VERIFICATION } from "./compat/child-session";

// Imports for internal use within this module
import {
  loadConfig,
  resolvePresetName,
  writeState,
  invalidateConfigCache,
  getConfigReloadError,
  overridePath,
  localOverridePath,
  findProjectOverride,
  resolveVerifyBudget,
  resolveDepthLimit,
  resolveRouting,
  resolveRolesRouting,
  resolveVariantSteps,
  routerStatusLines,
  warnConfigIssues,
  resolveActiveTiers,
} from "./router/config";
import type { RouterConfig, TierConfig, Preset, ModeConfig, EffortLevel } from "./router/config";
import { buildAgentOptions, warnAgentOptionsEffortOnce } from "./router/agent-options";
import { gitTools, nearestCheckout, type GitRootResolver } from "./router/git-tools";
import { isReadOnlyTier, legacyReadOnlyTools, mergePermissions, readOnlyPermissions } from "./router/read-only";
import { buildPluginAgentDefinition, mergeHostAgentEntry, pluginAgentMarker } from "./router/plugin-agents";
import { filterSensitiveGrep } from "./router/sensitive-paths";
import { selectTierPrompt, TOOL_AUTHORITY_CLAUSE } from "./router/prompts";
import { stripDelegateInstructions } from "./router/instructions";
import { buildDispatchHeader, DISPATCH_HEADER_PREFIX, DISPATCH_HEADER_SEPARATOR, routeLineRoot, stripDispatchHeader } from "./router/dispatch-header";
import { detectFalseRefusal, parseTaskResult as parseRefusalTaskResult } from "./router/false-refusal";
import {
  buildTiersOutput,
  buildPresetList,
  buildPresetSwitched,
  buildUnknownPreset,
  buildNoModes,
  buildBudgetList,
  buildBudgetSwitched,
  buildUnknownMode,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildOverridesOutput,
  buildRouterHelp,
  buildModelsOutput,
  formatModelIssues,
} from "./commands/output";
import {
  resolveSubagentOverrides,
  DEFER_MISSING_SUBAGENT_NOTICE,
  HOST_SEED_AGENTS,
  mergeSubagentOverride,
} from "./router/subagents";
import { fingerprintToolCall } from "./guard/fingerprint";
import { detectNarration } from "./guard/narration";
import {
  getActiveTiers,
  buildDelegationProtocol,
  isClaudeModel,
  CLAUDE_TIER_PREFIX,
  CLAUDE_ORCHESTRATOR_PREFIX,
  CLAUDE_ANTI_NARRATION,
  assembleSystemPrompt,
  assembleRolesSystemPrompt,
  DELEGATE_TOOL_DESCRIPTION,
} from "./router/protocol";
import { resolveRoles, type RoleSpec } from "./router/roles";
import { routerRunTool, type RunRecord } from "./router/run-tools";
import type { WorkRootAnswer } from "./router/git-tools";
import { GUARD_CUMULATIVE_MULTIPLIER, roleGuardProfile, type GuardProfile } from "./router/guard-profile";
import { currentBinding } from "./routing/roles/binding";
import { readRoleOrphans } from "./routing/roles/orphans";
import { authorityTool, requestedAuthority } from "./routing/roles/authority";
import {
  CARRIED_NO_PROCESS_REASON, lapsedApprovalReason, pruneLapsedApprovals, roleAttemptVerification, roleEscalationAfterFail, roleMaxActions,
  routedRoleOf, strippedRouteRoot,
} from "./routing/wire/dispatch";
import { roleTierOrder } from "./routing/engine/ladders";
import { acceptanceScriptsOf, detectRedispatch, returnSignal, runSignal, parseReturnPrefix, type DispatchText } from "./routing/outcomes/signals";
import type { IngestSettings } from "./routing/outcomes/ingest";
import { captureBudget } from "./guard/enforce";
import { budgetClaimObserved, isIncompleteVerdict } from "./verify/checker";
import { lookupDispatch } from "./router/sessions";
import { resolveEnforcementMode } from "./router/enforcement";
import { createPluginLogger } from "./router/logger";
import { createCatalogPricing, createIngest, ingestSettings } from "./routing/outcomes/ingest";
import type { Ingest } from "./routing/outcomes/ingest";
import { isAnnotationRow, verdictGraderOf, verdictOf, type LogRow } from "./routing/outcomes/types";
import { createPersister, nodePersistDeps, summarizeRoles } from "./routing/outcomes";
import { countUnknownBindings } from "./routing/outcomes/stats";
import { roleAgentSteps } from "./router/role-agents";
import type { HostBudgetObservation } from "./compat/v2-hooks";
import { ROUTER_TURN_STATE_ATTACH, TURN_STATE_ROOT, type TurnStateRegistry } from "./compat/turn-state";
import { ADOPTION_REFUSED, ROUTER_FINISH_ATTACH, type AdoptedRecords, type AdoptionRefused, type FinishApi, type FinishAttach, type FinishInput, type FinishResult, type HeldSink, type InflightJournal, type LeaseGuard, type PersistedRecord, type RestoredDispatch, type RoutedRoleSnapshot } from "./compat/background";
import type { DispatchDelta } from "./verify/dispatch";
import { configAsWritten, configuredV2OnlyKeys, setConfigNoticeHost } from "./router/config";

/** Phase 2.1: the v2-only config keys already announced as ignored on a v1 host (once per key per process). */
const warnedV2OnlyKeys = new Set<string>();
import { checkpointLine, formatStatsReply, runStatsCommand } from "./routing/commands/stats";
import { agentInfosForPlan, buildAnnotateDirectives } from "./routing/commands/annotate-plan";
import { annotateSteps } from "./routing/engine/plan";
import { classifyMany as classifyPlanSteps } from "./routing/classify";
import { applyV1Roles, hasExplicitV1Roles, v1AgentInfos } from "./routing/commands/v1-roles";
import type { HostAgentInfo } from "./routing/engine/types";
import { createEngineRuntime } from "./routing/wire/runtime";
import type { EngineRuntime } from "./routing/wire/runtime";
import { forgetWorkingSet, workingSetOf } from "./routing/wire/working-set";
import {
  advisorSettings,
  catalogFromProviders,
  createAdvisorNotifier,
  formatFindings,
  hostConfigFromAgents,
  runAdvisor,
} from "./routing/advisor";
import type { AdvisorCatalogModel, AdvisorExtras, HostConfigView } from "./routing/advisor";
import {
  findOrphanedStrongPatterns,
  normalizeCatalog,
  validateModels,
} from "./router/catalog";
import type { Catalog } from "./router/catalog";
import {
  createSessionStore,
  parseCapDirective,
  buildCapBanner,
  DEFAULT_TIER_CAPS,
  READ_ONLY_TOOLS,
  awaitExecutionEnd,
  lastStepContext,
} from "./router/sessions";
import type { Cap, SubagentState } from "./router/sessions";
import { EXECUTOR_READ_CAP_LINE, type ExecutorChildGuardPort } from "./executor/types";
import { executorChildRound, publishExecutorChildRound } from "./executor/child-guards";
import { createTrajectoryStore } from "./telemetry/trajectory";
import { createGuardStore } from "./guard/store";
import { createIdleTtlSweeper } from "./router/idle-sweep";
import { guardBeforeCall, guardAfterCall, guardRefusedCall, formatScorecard } from "./guard/enforce";
import { mkdirSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { scrubText } from "./guard/scrub";
import { accept, unverifiableGateResult } from "./verify/gate";
import { applyDispatchCaveats, createVerificationWiring, resolvePendingTtlMs, dispatchDirectiveText, extractAssistantText, parseRouterVerifyArgs, type DispatchStart, type HandleReport } from "./verify/wiring";
import { waitTreeFreeExcept } from "./verify/wiring";
import { createLeaseSelfExemptions, createPlanTaskVerifier, planTaskGit, planTreeKey } from "./verify/plan-task";
import { locationOutsideWorkRoots } from "./router/work-roots";
import { CLAIM_REFRESH_MS, HEAD_LOST_REASON, PENDING_INSTANCES_DIRNAME, PERIMETER_LOST_REASON, type DispatchHeadState, claimPendingSession, createInstanceClaimToken, createPendingFileJournal, foldDormantRecords, refreshPendingClaims, releasePendingClaim, resolvePendingJournalDir, processedKeyOf, appendRouterFooter, buildLateNoticeBlock, buildPendingListBlock, unattributedRisk, type DormantSession, type LateNotice, type PendingEntry, type SettledVerification } from "./verify/pending";
import { createDeadline } from "./verify/deterministic";
import {
  DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
  RouterTimeoutError,
  timeoutMs,
  withTimeout,
} from "./verify/timeout";
import {
  createChangedFileStore,
  parseTaskResult,
  buildDelegationDoD,
  tierModel,
  shouldVerifyTask,
  buildForcingNote,
  buildAcceptedSuffix,
} from "./verify/dispatch";
import { canonicalAuthorityPath, captureRootOf, insideWorkRoot, requestedVerificationCwd, requestedVerificationCwdSource, verificationScope, type VerificationScope } from "./routing/roles/work-root";
import { resolveCheckPlacements } from "./routing/roles/check-placement";
// Static, not `await import`: dynamic imports made a bundle split src/router/config.ts into a chunk where its tiers.json
// lookup fails (the e2e child bundle). Each module below is used only inside functions.
import { createAdmission, type AdmissionConfig, type AdmissionService } from "./routing/roles/admission";
import * as gitRoot from "./routing/roles/git-root";
import * as approvalsCommands from "./commands/approvals";
import { createRepoProbe, displaySafe, readSetEligible, readSetPredicate } from "./routing/roles/read-set";
import { newLadderState, recordAttempt, nextAction, advance, buildEscalatePolicy, formatLadderScorecard, startCostRatio } from "./escalate/ladder";
import { createCatalogLookup, planFirstAttempt, planNextAttempt } from "./escalate/resume";
import type { AttemptPlan, CatalogLookup } from "./escalate/resume";
import { classifyDelegation, createAttemptRecorder } from "./escalate/attempt-recorder";
import type { AttemptRecorder, DelegationFacts } from "./escalate/attempt-recorder";
import { createDepthTracker, DEPTH_LOOKUP_RETRY_MS } from "./router/depth";
import { createDepthGuard } from "./router/depth-guard";
import { applyEffortOverride, createEffortOverrideStore } from "./escalate/effort-override";
import { createExecutorAccess, lateRuntime, type ExecutorAccess, type CreateExecutorOptions } from "./executor/create";
import { executorPlatformSupported, warnExecutorPlatformOnce } from "./executor/platform";
import { createRouterPlanTool } from "./executor/tool";
import { createPlanCommand, parsePlanCommand } from "./executor/command";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type { RouterConfig, TierConfig, Preset, ModeConfig, FallbackConfig, EnforcementConfig } from "./router/config";
export type { Cap, SubagentState };
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory";
export type { EnforcementMode } from "./router/enforcement";
export type { GuardPolicy, GuardState, GuardCall, GuardDecision } from "./guard/guards";

/** Diagnostics must also tolerate thrown values without primitive conversion. */
function describeError(error: unknown): string {
  try {
    return scrubText(String(error));
  } catch {
    return "unprintable error";
  }
}

/**
 * Cross-repo P2b.7 (OD1=B, v2 only): a tier dispatch honours no per-check `cwd=`. The first check of the DoD that sets one (0-based
 * index) is the refusal the gate reports (`why: "tier"`, nothing runs); undefined when none does. `scope=` alone is ignored.
 */
function tierCheckCwdRefusal(dod: Parameters<typeof resolveCheckPlacements>[0]): NonNullable<Parameters<typeof accept>[0]["refusedCheck"]> | undefined {
  const index = dod.checks.findIndex((check) => check.cwd !== undefined);
  const check = index < 0 ? undefined : dod.checks[index];
  return check?.cwd === undefined ? undefined : { index, kind: check.kind, text: check.cwd, why: "tier" };
}

/**
 * #84 P2.2 (advisor `tierDispatches`): dispatch rows WITHOUT a role at or after `since` — non-annotation `dispatch` decision rows,
 * the first row per decision id (as `summarizeRoles` keeps them), whose row names no role and whose chosen key is not a role's.
 */
function tierDispatchCount(rows: readonly LogRow[], since: number): number {
  const seen = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (row.kind !== "decision" || isAnnotationRow(row) || row.step !== "dispatch" || seen.has(row.decisionID)) continue;
    seen.add(row.decisionID);
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t) || t < since) continue;
    if (typeof row.role === "string" || row.chosen?.origin === "role") continue;
    count += 1;
  }
  return count;
}

/**
 * #84 P2.1 (handoffs 22, 23): one budget observation from the guard's and the host's. A stop seen by either is a stop; without a
 * host observer (v1, or a host that does not hand one) the guard's alone; otherwise anything unobserved leaves it unobserved.
 */
function foldBudgetObservation(guard: HostBudgetObservation, host: HostBudgetObservation | undefined): HostBudgetObservation {
  if (guard === true || host === true) return true;
  if (host === undefined) return guard;
  return guard === "unobserved" || host === "unobserved" ? "unobserved" : false;
}

function saveActivePreset(presetName: string, projectDir?: string): void {
  const cfg = loadConfig(projectDir);
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  cfg.activePreset = resolved;

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });

  // Invalidate cache so next read picks up the new active preset
  invalidateConfigCache();
}

function saveActiveMode(modeName: string, projectDir?: string): void {
  const cfg = loadConfig(projectDir);
  if (!cfg.modes?.[modeName]) {
    return;
  }

  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
  invalidateConfigCache();
}

/**
 * `/router` dispatch. Decides and persists here; rendering lives in
 * src/commands/output.ts.
 */
function buildRouterOutput(cfg: RouterConfig, args: string, projectDir?: string, roles?: Iterable<RoleSpec>, approvals = false, plan = false): string {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      saveEnforcementMode(mode);
      return buildEnforceSet(mode);
    }
    return buildEnforceStatus(
      resolveEnforcementMode({ config: cfg, env: process.env }).mode,
    );
  }

  if (sub === "overrides") {
    const globalPath = overridePath();
    const foundLocal = findProjectOverride(projectDir);
    const localPath = foundLocal ?? localOverridePath(projectDir);
    return buildOverridesOutput({
      globalPath,
      globalPresent: existsSync(globalPath),
      localPath,
      localPresent: existsSync(localPath),
      localFound: foundLocal !== undefined,
      activePreset: cfg.activePreset,
    });
  }

  return buildRouterHelp(
    resolveEnforcementMode({ config: cfg, env: process.env }).mode,
    // `/router stats` is listed only for a config that has a `routing` block: without one `/router` is what it was (QA-2.4-3).
    // #84 P2.2: the role lines, only when the caller hands roles (roles mode on v2); otherwise the help is what it was.
    // Cross-repo P4.7: `/router approve|repos|revoke`, only where they run (SD-P4-10); otherwise the help is what it was.
    { stats: cfg.routing !== undefined, ...(roles === undefined ? {} : { roles }), ...(approvals ? { approvals: true } : {}), ...(plan ? { plan: true } : {}) },
  );
}

/** Cross-repo P4.7: the `/router` subcommands of `commands/approvals.ts` (checked before that module is used). */
const APPROVAL_SUBCOMMANDS: ReadonlySet<string> = new Set(["approve", "repos", "revoke"]);

/** `/budget` dispatch. Persists the switch, then renders. */
function buildBudgetOutput(cfg: RouterConfig, args: string, projectDir?: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();

  const requested = args.trim().toLowerCase();
  if (!requested) return buildBudgetList(cfg);

  const mode = modes[requested];
  if (mode) {
    saveActiveMode(requested, projectDir);
    return buildBudgetSwitched(mode, requested);
  }

  return buildUnknownMode(modes, requested);
}

/** `/preset` dispatch. Persists the switch, then renders. */
function buildPresetOutput(cfg: RouterConfig, args: string, projectDir?: string): string {
  const requestedPreset = args.trim();
  if (!requestedPreset) return buildPresetList(cfg);

  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset, projectDir);
    cfg.activePreset = resolvedPreset;
    return buildPresetSwitched(cfg, resolvedPreset);
  }

  return buildUnknownPreset(cfg, requestedPreset);
}

// Fail-closed skips in system.transform are silent by design, but a transform
// that never carries a sessionID would silently disable routing for the whole
// session. Surface it once rather than never.
let warnedMissingTransformSession = false;
function warnMissingTransformSessionOnce(): void {
  if (warnedMissingTransformSession) return;
  warnedMissingTransformSession = true;
  console.warn(
    "[model-router] chat.system.transform received no sessionID; skipping delegation-protocol injection (fail-closed)",
  );
}

let warnedSessionLookupFailed = false;
function warnSessionLookupFailedOnce(): void {
  if (warnedSessionLookupFailed) return;
  warnedSessionLookupFailed = true;
  console.warn(
    "[model-router] session lookup failed while classifying a chat.system.transform session; assuming top-level orchestrator",
  );
}

/**
 * Agents the v1 host defines itself (opencode v1.18.34 agent.ts). They are absent from the `opencodeConfig.agent`
 * record the config hook receives, so `subagentTiers` needs them listed to avoid a false `missing` skip (QA-81-4).
 */
const V1_HOST_BUILTIN_AGENTS: Record<string, { mode: string }> = {
  general: { mode: "subagent" },
  explore: { mode: "subagent" },
  build: { mode: "primary" },
  plan: { mode: "primary" },
  title: { mode: "primary" },
  summary: { mode: "primary" },
  compaction: { mode: "primary" },
};

const SESSION_ROOT_MEMO_MAX = 500;
const SESSION_LOOKUP_RETRY_MS = DEPTH_LOOKUP_RETRY_MS;

/** Phase 1.2 (v2 only): bounds of the late-notice buffer behind the `late` turn-state provider. */
const LATE_BUFFER_PER_SESSION = 50;
const LATE_BUFFER_SESSIONS = 100;

/**
 * Late notices retained per session until `router_verify` answers their handle, so a request that fails after the
 * transform read them does not lose them (the v1 path delivers them once). First-seen order; a repeated handle replaces
 * its notice in place; the oldest notice and the least recently used session go at the bounds.
 */
interface LateBuffer {
  add(sessionID: string, notices: readonly LateNotice[]): void;
  list(sessionID: string): LateNotice[];
  release(sessionID: string, handles: readonly string[]): void;
  /** Marks the session as most recently used (a render read its notices). */
  touch(sessionID: string): void;
  /** Drops the session's buffer (`session.deleted`). */
  forget(sessionID: string): void;
}

function createLateBuffer(): LateBuffer {
  const sessions = new Map<string, Map<string, LateNotice>>();
  return {
    add(sessionID, notices) {
      if (notices.length === 0) return;
      const buffer = sessions.get(sessionID) ?? new Map<string, LateNotice>();
      sessions.delete(sessionID);
      sessions.set(sessionID, buffer);
      for (const notice of notices) buffer.set(notice.handle, notice);
      while (buffer.size > LATE_BUFFER_PER_SESSION) buffer.delete(buffer.keys().next().value!);
      while (sessions.size > LATE_BUFFER_SESSIONS) sessions.delete(sessions.keys().next().value!);
    },
    list(sessionID) {
      return [...(sessions.get(sessionID)?.values() ?? [])];
    },
    release(sessionID, handles) {
      const buffer = sessions.get(sessionID);
      if (buffer === undefined) return;
      for (const handle of handles) buffer.delete(handle);
      if (buffer.size === 0) sessions.delete(sessionID);
    },
    touch(sessionID) {
      const buffer = sessions.get(sessionID);
      if (buffer === undefined) return;
      sessions.delete(sessionID);
      sessions.set(sessionID, buffer);
    },
    forget(sessionID) {
      sessions.delete(sessionID);
    },
  };
}

/**
 * The handles a router_verify report answers: a verdict, an unknown input, an expired handle. A run that outlived the call
 * ("elsewhere") and a held background result ("held", QA-2.1-9: its own gate posts the verdict) have no verdict yet.
 */
function answeredHandles(items: readonly HandleReport[]): string[] {
  const handles: string[] = [];
  for (const item of items) {
    if (item.kind === "verdict" || item.kind === "expired") handles.push(item.handle);
    else if (item.kind === "unknown") handles.push(item.input);
  }
  return handles;
}

const ModelRouterPlugin: Plugin = async (ctx: RouterPluginInput) => {
  // Project directory this plugin instance serves. Hosts that run several
  // projects in one process (OpenCode v2) may also move process.cwd() away from
  // it, so config/override lookup must use this and never the working directory.
  const projectDir: string | undefined = ctx.directory || ctx.worktree || undefined;
  let cfg = loadConfig(projectDir);
  let activeTiers = getActiveTiers(cfg);

  // Per-plugin-instance session store: owns subagentSessionIDs and subagentCapState.
  const sessionStore = createSessionStore();
  /** v1 sessionID -> plugin agent name, from chat.message (tool.execute.after has no `agent` on v1). */
  const pluginAgentSessions = new Map<string, string>();
  /** Records a plugin-agent session, bounded like the session-root memo (oldest entry evicted first). */
  const rememberPluginAgentSession = (sessionID: string, agent: string): void => {
    pluginAgentSessions.delete(sessionID);
    pluginAgentSessions.set(sessionID, agent);
    while (pluginAgentSessions.size > SESSION_ROOT_MEMO_MAX) {
      const oldest = pluginAgentSessions.keys().next().value;
      if (oldest === undefined) break;
      pluginAgentSessions.delete(oldest);
    }
  };
  /** Plugin agents the v1 config hook built on its previous run -> the host entry it merged (QA-81-8). */
  let builtPluginAgents = new Map<string, Record<string, unknown> | undefined>();
  let systemDebugLogged = false;
  let dispatchDebugLogged = false;

  // Authoritative orchestrator-vs-child classification memo, keyed by sessionID.
  // true  = proven top-level (no parentID) -> inject the delegation protocol
  // false = proven child -> never inject
  // absent = not yet resolved
  //
  // Exists because session.created is an EVENT: nothing guarantees the plugin
  // has processed it before the child's first system.transform runs. Tier-named
  // agents are also marked synchronously from chat.message, but `general`,
  // `explore`, markdown-defined agents and everything mapped through
  // `subagentTiers` (which can never be tier-named by construction) have no
  // synchronous path at all. One session.get per session closes that race
  // without depending on event ordering.
  const sessionRootMemo = new Map<string, boolean>();
  /** Recent lookup failures throttle retries without permanently memoising root. */
  const sessionLookupFailedAt = new Map<string, number>();

  /**
   * Resolve whether a session is the top-level orchestrator, authoritatively.
   *
   * Returns true only when the backend confirms the session has no parentID.
   * Returns false when it confirms a parentID (and marks the session as a child
   * so the synchronous path catches it next time).
   *
   * On lookup failure it returns true — deliberately NOT fail-closed. A transient
   * backend error must not silently strip the orchestrator of its routing rules
   * for the rest of the session; the event path and the chat.message path both
   * still cover the common cases, so the exposure is a rare, transient re-run of
   * the old behaviour rather than a permanent loss of function.
   */
  const resolveIsRootSession = async (sessionID: string): Promise<boolean> =>
    (await lookupRootSession(sessionID)) ?? true;

  /**
   * The lookup behind resolveIsRootSession: true (no parentID), false (a parentID), or undefined
   * when it is not known (the lookup failed, or failed recently and is throttled). QA-2.4-2 treats
   * undefined as NOT root (isProvenRootCaller), where the protocol injection treats it as root.
   */
  const lookupRootSession = async (sessionID: string): Promise<boolean | undefined> => {
    const memo = sessionRootMemo.get(sessionID);
    if (memo !== undefined) {
      if (!memo) sessionStore.markChildSession(sessionID);
      else depthTracker.recordRoot(sessionID);
      return memo;
    }
    const failedAt = sessionLookupFailedAt.get(sessionID);
    if (failedAt !== undefined && Date.now() - failedAt < SESSION_LOOKUP_RETRY_MS) {
      return undefined;
    }
    try {
      const res = await ctx.client.session.get({ path: { id: sessionID } });
      if (!res || (res as { error?: unknown }).error || !res.data) {
        throw new Error("session.get returned no session data");
      }
      sessionLookupFailedAt.delete(sessionID);
      const parentID = res?.data?.parentID;
      const isRoot = !(typeof parentID === "string" && parentID !== "");
      sessionRootMemo.set(sessionID, isRoot);
      while (sessionRootMemo.size > SESSION_ROOT_MEMO_MAX) {
        const oldest = sessionRootMemo.keys().next().value;
        if (oldest === undefined) break;
        sessionRootMemo.delete(oldest);
      }
      if (!isRoot) sessionStore.markChildSession(sessionID);
      if (isRoot) depthTracker.recordRoot(sessionID);
      else depthTracker.recordCreated(sessionID, parentID as string);
      return isRoot;
    } catch {
      sessionLookupFailedAt.set(sessionID, Date.now());
      while (sessionLookupFailedAt.size > SESSION_ROOT_MEMO_MAX) {
        const oldest = sessionLookupFailedAt.keys().next().value;
        if (oldest === undefined) break;
        sessionLookupFailedAt.delete(oldest);
      }
      warnSessionLookupFailedOnce();
      return undefined;
    }
  };

  // Per-plugin-instance trajectory store (Phase 0.3 scaffolding — RECORD-ONLY).
  // Observes subagent tool activity to build a per-session scorecard. It emits
  // NOTHING into any model-visible output; the only externally observable effect
  // is an opt-in debug dump gated behind MODEL_ROUTER_TRAJECTORY_DEBUG=1.
  const trajectoryStore = createTrajectoryStore();

  // Per-plugin-instance guard state (Layer 1 hard-block). Only engaged for
  // subagent sessions when enforcement mode is advisory/enforced; in "off"
  // mode no guard state is ever created, so behaviour stays byte-identical.
  const guardStore = createGuardStore();

  const changedFileStore = createChangedFileStore();

  // Idle-TTL maintenance for the four per-instance stores. No timer is
  // scheduled: the sweeper is invoked opportunistically from chat.message and
  // self-throttles, so a long-lived plugin instance cannot accumulate state for
  // sessions that went away without a teardown hook.
  const sweepIdleStores = createIdleTtlSweeper([
    () => sessionStore.sweep(),
    () => guardStore.sweep(),
    () => trajectoryStore.sweep(),
    () => changedFileStore.sweep(),
    () => depthTracker.sweep(),
    // 2.2.3: the S5 batch coordinator's defensive eviction (batch.ts B11). Declared below; the
    // sweeper only runs from chat.message, long after this factory has returned.
    () => { sweepVerification(); },
    // 2.4.2b: TTL eviction and reaping of the pending registry (pending.ts R7; no timer of its own).
    () => { pending.sweep(); },
    // 2.1.2: expired dispatch registrations and idle open outcome attempts (v2 only; `ingest` is declared below).
    () => { ingest?.sweep(); },
    // 2.3: release the ladder-attempt recorder's outcomes bundle once the engine is static again.
    () => { attemptRecorder?.sweep(); },
  ]);

  // Layer-2's impure corner: exec, fs, and the opencode client, built once and
  // read back through getConfig so a reloaded cfg (from /preset, /budget or
  // /router enforce) applies to graded work too.
  // Passive warnings go to opencode's log rather than stderr: console output
  // from a plugin paints over the TUI. Falls back to console when the server
  // has no /log endpoint. See src/router/logger.ts.
  const logger = createPluginLogger(ctx.client);
  const routerWarn = { warn: (message: string) => logger.warn(message) };

  // -------------------------------------------------------------------------
  // #84 P2.1 (T2.1.3): the role runtime of roles mode on OpenCode v2. `rolesNow()` is empty on v1 and in tiers mode, so
  // every role branch below is skipped there and both stay byte-identical (§2.7, I1, I8).
  // -------------------------------------------------------------------------
  const isV2Host = ctx.routerHost === "v2";
  // Phase 5.1 D1: the runtime is resolved at each call, after the adapter's synchronous executor factory runs.
  const executorInput = isV2Host ? ctx as RouterPluginInput & {
    routerExecutor?: ExecutorAccess;
    routerOnPlanAnnotate?: (port: NonNullable<CreateExecutorOptions["annotate"]>) => void;
  } : undefined;
  // G-16: the plan executor is Windows-only; elsewhere no executor access exists, so router_plan and /plan are not built.
  const executorPlatform = isV2Host && executorPlatformSupported();
  const absentExecutor = executorPlatform ? createExecutorAccess() : undefined;
  const executorAccess: ExecutorAccess | undefined = absentExecutor === undefined ? undefined : {
    runtime: () => (executorInput?.routerExecutor ?? absentExecutor).runtime(),
    unavailable: () => (executorInput?.routerExecutor ?? absentExecutor).unavailable(),
    set: (runtime) => (executorInput?.routerExecutor ?? absentExecutor).set(runtime),
    clear: (reason) => (executorInput?.routerExecutor ?? absentExecutor).clear(reason),
  };
  const executorRuntime = executorAccess === undefined ? undefined : lateRuntime(executorAccess);
  /**
   * Cross-repo P2e.6 (OD-P2e-2): a dispatch runs the full scope when the host is OpenCode v2 and the effective testScope is
   * "full"; the deferred finish then never treats an empty change set as nothing to run. Always false on v1. Never throws (an
   * unreadable verify block is not full).
   */
  const fullScopeOf = (cfg: Parameters<typeof resolveVerifyBudget>[0]): boolean => {
    if (!isV2Host) return false;
    try {
      return resolveVerifyBudget(cfg).testScope === "full";
    } catch {
      return false;
    }
  };
  /**
   * QA-P21-1-8 (plan R8): the role runtime exists only when the plugin STARTED in roles mode — its role tools are registered at
   * start and its role agents only then (the v2 adapter logs "restart OpenCode" when the config switches to roles at runtime).
   */
  const startedInRoles = isV2Host && cfg.routing?.delegation === "roles";
  /** QA-P21-2-4: the v2 adapter's "this role agent is registered" check (absent on v1 and before the adapter is set up). */
  const roleLiveOf = (ctx as RouterPluginInput & { routerRoleLive?: (agent: string) => boolean | undefined }).routerRoleLive;
  const NO_ROLES: ReadonlyMap<string, RoleSpec> = new Map();
  const roleTables = new WeakMap<RouterConfig, ReadonlyMap<string, RoleSpec>>();
  /** The role agents of the current config, cached per config object (hot reload builds a new one). */
  const rolesNow = (): ReadonlyMap<string, RoleSpec> => {
    if (!startedInRoles) return NO_ROLES;
    const current = cfg;
    let roles = roleTables.get(current);
    if (roles === undefined) {
      try {
        roles = resolveRoles(current, "v2");
      } catch (error) {
        roles = NO_ROLES;
        logger.warn("[router] roles: the role table could not be resolved; no role runtime for this config", { error: describeError(error) });
      }
      roleTables.set(current, roles);
    }
    // QA-P21-2-4: a role whose agent registration failed is not live (the v2 adapter's check; undefined = not known yet).
    const live = roleLiveOf === undefined ? [...roles] : [...roles].filter(([name]) => roleLiveOf(name) !== false);
    return live.length === roles.size ? roles : new Map(live);
  };
  const roleSpecOf = (agent: unknown): RoleSpec | undefined => (typeof agent === "string" ? rolesNow().get(agent) : undefined);
  /** `maxOf` of every `currentBinding` call (handoff 33). */
  const roleMaxOf = (agent: string) => roleMaxActions(rolesNow().get(agent));
  /** Role child sessions → their role agent: from the tool hooks' calling agent and `session.created` (bounded, oldest out). */
  const roleSessions = new Map<string, string>();
  const ROLE_STATE_MAX = 1000;
  const rememberRoleSession = (sessionID: unknown, agent: unknown): boolean => {
    if (typeof sessionID !== "string" || sessionID === "" || typeof agent !== "string" || roleSpecOf(agent) === undefined) return false;
    roleSessions.delete(sessionID);
    roleSessions.set(sessionID, agent);
    while (roleSessions.size > ROLE_STATE_MAX) roleSessions.delete(roleSessions.keys().next().value!);
    return true;
  };
  /** The role of a session: what its tool hooks named, else what the dispatch registry recorded for it. */
  const roleOfSession = (sessionID: unknown): RoleSpec | undefined => typeof sessionID !== "string" || sessionID === ""
    ? undefined : roleSpecOf(roleSessions.get(sessionID) ?? lookupDispatch(sessionID)?.agent);
  /**
   * Handoff 11 (P-10, P-18): the ONE work-root resolver of `router_run` and `router_git_*`, from the child's binding (bound by the
   * adapter's `execute.before` before any tool of the child runs). Not a role session → `{ role: false }` (git keeps today's
   * directory; `router_run` refuses); a role session without a binding or a work root → `{ role: true, root: null }` (I9).
   */
  const resolveWorkRoot = (sessionID: string): WorkRootAnswer => {
    if (roleOfSession(sessionID) === undefined) return { role: false };
    return { role: true, root: currentBinding(sessionID, { maxOf: roleMaxOf })?.grant.workRoot ?? null };
  };
  /**
   * #84 P2.3 (P-12, S11, I3): no `evaluate` fires for a plugin tool, so each tool's own resolver also refuses a role session whose
   * dispatch grant lacks the tool's action (`router_run`: exec; `router_git_*`: local): the answer is then "no bound work root"
   * and the tool refuses (I9). The context hook's catalog filter is the primary control; this one holds when a call gets through.
   */
  const resolveWorkRootFor = (action: "router_run" | "router_git") => (sessionID: string): WorkRootAnswer => {
    const answer = resolveWorkRoot(sessionID);
    if (!answer.role) return answer;
    const grant = currentBinding(sessionID, { maxOf: roleMaxOf })?.grant;
    if (grant === undefined || !grant.actions.has(action)) return { role: true, root: null };
    // Phase 4 QA (m2): a binding backed by an approval holds only while the approval applies (store read, no git). The tools
    // report a resolver's throw as their error, nothing runs.
    const approval = grant.location?.approval;
    if (approval !== undefined && answer.root !== null) {
      const lapsed = lapsedApprovalReason(approval, resolveRolesRouting(cfg, "v2").repoApprovalDays);
      if (lapsed !== undefined) throw new Error(`refused: ${lapsed}`);
    }
    // Cross-repo (P1.5): a binding that carries its repository makes it the repository `router_git_*` expects.
    const repository = grant.location?.repository;
    return repository !== undefined && answer.root !== null ? { ...answer, repository } : answer;
  };
  /**
   * Cross-repo (P1.9, v2 only): the provenance line of a role's `read`, `glob` or `grep` whose target (the file, or the search root)
   * canonicalises outside the session's work root but inside its read set (`routing/roles/read-set.ts`: the orchestrator's working
   * set and the repositories below `routing.repoParents`). Undefined for a non-role session, an unbound or rootless one, a target in
   * the work root, a target outside the read set, and whenever cross-repo is not in use (no parents and no working set: I9).
   */
  const repoProbe = createRepoProbe();
  /** The read set R (P1.5) of the role dispatches of `orchestrator`: its working set plus `routing.repoParents`. Undefined when R adds nothing. */
  const readSetMemberOf = (orchestrator: string | undefined): ReturnType<typeof readSetPredicate> => {
    const routing = resolveRolesRouting(cfg, "v2");
    const workingSet = orchestrator === undefined ? [] : workingSetOf(orchestrator);
    return readSetPredicate({ parents: routing.repoParents, depth: routing.repoDepth, exclude: routing.repoExclude }, workingSet, repoProbe);
  };
  /**
   * Cross-repo P2a.3 (v2 only): R as a yes/no test on a canonical absolute path, for the role dispatch `routed` (its orchestrator's
   * working set). Undefined when no R applies.
   */
  const roleReadSetFor = (routed: { readonly parentSessionID: string }): ((absPath: string) => boolean) | undefined => {
    if (ctx.routerHost !== "v2") return undefined;
    const member = readSetMemberOf(routed.parentSessionID === "" ? undefined : routed.parentSessionID);
    return member === undefined ? undefined : (absPath) => member(absPath) !== undefined;
  };
  /** F11: the orchestrator that dispatched role session `sid`: its dispatch record, else the session's parent (as the v2 adapter's readSetOf). */
  const orchestratorOf = async (sid: string): Promise<string | undefined> => {
    const recorded = lookupDispatch(sid)?.parentSessionID ?? undefined;
    if (recorded !== undefined && recorded !== "") return recorded;
    const res = await ctx.client.session.get({ path: { id: sid } });
    const parentID = res?.data?.parentID;
    return typeof parentID === "string" && parentID !== "" ? parentID : undefined;
  };
  /**
   * Cross-repo P4.7 (SD-P4-10, S1): whether `/router approve|repos|revoke` run for the session `sessionID`. All of: the v2 host,
   * roles mode (`rolesNow()` non-empty), `routing.repoParents` non-empty, and a top-level session typed in by the human: not a
   * role session, not a known child (a dispatch record), and the host reports it without a parent. A failed lookup refuses.
   */
  const approvalsCommandsAvailable = async (sessionID: unknown): Promise<boolean> => {
    if (ctx.routerHost !== "v2" || rolesNow().size === 0) return false;
    if (resolveRolesRouting(cfg, "v2").repoParents.length === 0) return false;
    if (typeof sessionID !== "string" || sessionID === "") return false;
    if (roleOfSession(sessionID) !== undefined || lookupDispatch(sessionID) !== undefined) return false;
    try {
      const res = await ctx.client.session.get({ path: { id: sessionID } });
      const data = res?.data;
      if (data === undefined || data === null || typeof data !== "object") return false;
      const parentID: unknown = Reflect.get(data, "parentID");
      return !(typeof parentID === "string" && parentID !== "");
    } catch {
      return false;
    }
  };
  /**
   * Cross-repo 3b.4 (F10): one admission per resolved `{ repoParents, repoDepth, repoExclude }` for `router_git` `root` (it caches its
   * git results for 5 s). Created on first use.
   */
  type GitRootAdmission = Pick<AdmissionService, "admit" | "find">;
  let gitRootAdmissionMemo: { readonly key: string; readonly service: GitRootAdmission } | undefined;
  const gitRootAdmissionFor = async (config: AdmissionConfig): Promise<GitRootAdmission> => {
    const key = JSON.stringify([config.parents, config.depth, config.exclude, config.approvalDays ?? null]);
    if (gitRootAdmissionMemo !== undefined && gitRootAdmissionMemo.key === key) return gitRootAdmissionMemo.service;
    const service = createAdmission(config);
    gitRootAdmissionMemo = { key, service };
    return service;
  };
  /**
   * Cross-repo 3b.4 (OpenCode v2, roles mode, `routing.repoParents` at start; SD-3b-1): the `root` resolver of `router_git_*`. Step 1
   * here, no filesystem call and no spawn: a role session (D21), an exact binding with a work root and `router_git` in the grant (I9,
   * F12), a local read action in the grant (SD-3b-5), parents still configured. Steps 2–10: `routing/roles/git-root.ts`.
   */
  const resolveGitRootFor: GitRootResolver = async (value, { sessionID, signal, deadlineAt }) => {
    if (roleOfSession(sessionID) === undefined) return { ok: false, reason: gitRoot.GIT_ROOT_ROLE_ONLY };
    const binding = currentBinding(sessionID, { maxOf: roleMaxOf });
    const grant = binding?.kind === "exact" ? binding.grant : undefined;
    const workRoot = grant?.workRoot;
    if (grant === undefined || workRoot === null || workRoot === undefined || workRoot === "" || !grant.actions.has("router_git")) {
      return { ok: false, reason: gitRoot.GIT_ROOT_NO_WORK_ROOT };
    }
    if (!grant.actions.has("read") && !grant.actions.has("glob") && !grant.actions.has("grep")) {
      return { ok: false, reason: gitRoot.gitRootNeedsRead([...grant.actions].sort()) };
    }
    const routing = resolveRolesRouting(cfg, "v2");
    if (routing.repoParents.length === 0) return { ok: false, reason: gitRoot.GIT_ROOT_NO_PARENTS };
    // Phase 4 QA (m2): a binding backed by an approval that no longer applies (revoked, expired) inspects nothing (store read, no git).
    const approval = grant.location?.approval;
    const lapsed = approval === undefined ? undefined : lapsedApprovalReason(approval, routing.repoApprovalDays);
    if (lapsed !== undefined) return { ok: false, reason: lapsed };
    // QA round 1 (Phase 3 lot 1, F5): the session lookup is bounded by the call's deadline and signal (SD-3b-8).
    const asked = await gitRoot.gitRootBounded(() => orchestratorOf(sessionID), { ...(signal === undefined ? {} : { signal }), deadlineAt });
    if ("stop" in asked && asked.stop !== "failed") return { ok: false, reason: gitRoot.gitRootStopReason(value, asked.stop) };
    // A failed lookup: no working set, R narrows to the parents (fail closed).
    const orchestrator = "value" in asked ? asked.value : undefined;
    // Phase 4 QA (M1): as for a dispatch (`crossRepoOf`), an entry whose approval lapsed is dropped before it can admit by rule 2;
    // the drop reaches every working set, so the read set below shrinks with it.
    const workingSet = (orchestrator === undefined ? [] : pruneLapsedApprovals(workingSetOf(orchestrator), routing.repoApprovalDays))
      .map((location) => location.worktree);
    const member = readSetMemberOf(orchestrator);
    const admissionConfig = {
      parents: routing.repoParents,
      depth: routing.repoDepth,
      exclude: routing.repoExclude,
      approvalDays: routing.repoApprovalDays,
    };
    const known = [ctx.directory, ...(grant.location?.repository === undefined ? [] : [grant.location.repository]), ...workingSet];
    return gitRoot.resolveGitRoot(value, { workRoot, parents: routing.repoParents, workingSet }, {
      realpath: (path) => realpathSync.native(path),
      isDirectory: (path) => statSync(path).isDirectory(),
      nearestCheckout,
      inReadSet: (path) => member !== undefined && member(path) !== undefined,
      // Created on first use only: a text refusal never creates an admission.
      admission: {
        // Phase 4 QA (M1): the session repository is named, whatever order `known` reaches admission in.
        admit: async (root, knownRepositories) => (await gitRootAdmissionFor(admissionConfig)).admit(root, knownRepositories, ctx.directory),
        // QA round 1 (Phase 3 lot 1, F4): the resolver's `eligible` (the text gate and R) reaches the lookup.
        find: async (name, opts) => (await gitRootAdmissionFor(admissionConfig)).find(name, opts),
      },
      known,
      platform: process.platform,
      ...(signal === undefined ? {} : { signal }),
      deadlineAt,
    });
  };
  const readProvenanceLine = async (input: any): Promise<string | undefined> => {
    const sid: unknown = input?.sessionID;
    if (ctx.routerHost !== "v2" || typeof sid !== "string" || !["read", "glob", "grep"].includes(input?.tool)) return undefined;
    if (roleOfSession(sid) === undefined) return undefined;
    const binding = currentBinding(sid, { maxOf: roleMaxOf });
    const workRoot = binding?.kind === "exact" ? binding.grant.workRoot : null;
    if (workRoot === null || workRoot === undefined) return undefined;
    const args: Record<string, unknown> = input?.args && typeof input.args === "object" ? input.args : {};
    const named = input.tool === "read" ? [args.filePath, args.path, args.file_path] : [args.path];
    const target = named.find((value): value is string => typeof value === "string" && value !== "");
    // No path (the session directory) or a relative one: the decision (v2-hooks `roleAuthorityDecision`) never lets it reach the
    // read set (QA-1 F1) — it ran inside the work root or was refused — so there is no line. A fully qualified path canonicalises
    // the same whatever the base, as in the decision; `.git` and below never reach R (F7).
    if (target === undefined) return undefined;
    const canonical = canonicalAuthorityPath(target, workRoot);
    if (canonical === undefined || insideWorkRoot(canonical, workRoot) || !readSetEligible(target, canonical)) return undefined;
    // The orchestrator that dispatched this role: its dispatch record, else the session's parent (as the v2 adapter's readSetOf).
    const orchestrator = await orchestratorOf(sid);
    const member = readSetMemberOf(orchestrator)?.(canonical);
    if (member === undefined) return undefined;
    // QA-1 F2: the name, branch and path come from the filesystem: display-safe.
    return `[router: read from ${displaySafe(member.name)} (${displaySafe(member.branch ?? "detached")}) at ${displaySafe(member.repository)} — read-only in this dispatch]`;
  };
  /** What a routed role dispatch decided for its child's guard (QA-G-A3-3): the dispatched tier and the route line's `budget=`. */
  interface RoutedGuardInput { readonly agent: string; readonly tier: string; readonly routeBudget: number | null }
  /**
   * QA-G-B-5 / QA-G-A3-3: each routed role dispatch this instance noted, by the parent's call — when it was dispatched (the
   * attempt's start, for the `run` signal) and its routed guard input. Bounded, oldest out.
   */
  const roleAttempts = new Map<string, RoutedGuardInput & { readonly at: number }>();
  /** QA-G-A3-3: the routed guard input of each role child — its latest routed dispatch or resume (a resume replaces it). */
  const roleChildGuards = new Map<string, RoutedGuardInput>();
  /** QA-G-A3-2-2: the largest round budget each role child's guard profile had (its cumulative limit follows it). */
  const roleBudgetPeaks = new Map<string, number>();
  const setBounded = <T>(map: Map<string, T>, key: string, value: T): void => {
    map.delete(key);
    map.set(key, value);
    while (map.size > ROLE_STATE_MAX) map.delete(map.keys().next().value!);
  };
  /**
   * QA-G-A3-3: the routed guard input of a role child. A resume set it in `noteRoleDispatch`; a fresh child takes its dispatch's
   * once it is bound EXACTLY (its binding names the parent's call). Undefined when no routed decision is known for it.
   */
  const routedGuardOf = (sessionID: string): RoutedGuardInput | undefined => {
    const known = roleChildGuards.get(sessionID);
    if (known !== undefined) return known;
    const binding = currentBinding(sessionID, { maxOf: roleMaxOf });
    const callID = binding?.kind === "exact" ? binding.candidates[0] : undefined;
    const attempt = callID === undefined ? undefined : roleAttempts.get(callID);
    if (attempt === undefined) return undefined;
    const routed: RoutedGuardInput = { agent: attempt.agent, tier: attempt.tier, routeBudget: attempt.routeBudget };
    setBounded(roleChildGuards, sessionID, routed);
    return routed;
  };
  /**
   * Handoff 27: the guard profile of a role child — the role's budget for the tier it runs on, raised by the dispatch's `budget=`.
   * QA-G-A3-3: both come from the ROUTED decision of the child's current dispatch (a resume's own tier and `budget=`); only a child
   * without one (a delegate's unbound child, another instance's) falls back to the dispatch registry's tier (else the role's floor,
   * its registered fallback model, P-1) and the bound dispatch budget.
   */
  const roleGuardProfileOf = (sessionID: unknown, agent: unknown): GuardProfile | undefined => {
    if (typeof sessionID === "string") consumeExecutorChildRound(sessionID);
    const spec = roleSpecOf(agent) ?? roleOfSession(sessionID);
    if (spec === undefined || typeof sessionID !== "string") return undefined;
    const routed = routedGuardOf(sessionID);
    let profile: GuardProfile;
    if (routed !== undefined && routed.agent === spec.agent) {
      profile = roleGuardProfile(spec, routed.tier, routed.routeBudget);
    } else {
      const record = lookupDispatch(sessionID);
      const binding = currentBinding(sessionID, { maxOf: roleMaxOf });
      const tier = binding?.plan !== undefined && binding.tier !== undefined ? binding.tier
        : record?.agent === spec.agent && typeof record.tier === "string" && record.tier !== "" ? record.tier : spec.tierRange.floor;
      profile = roleGuardProfile(spec, tier, binding?.budget ?? null);
    }
    // QA-G-A3-2-2 (§2.6): the cumulative limit spans the child's rounds, so it follows the LARGEST round budget the child had
    // (a later round with a smaller budget never shrinks it below what earlier rounds were allowed).
    const peak = Math.max(roleBudgetPeaks.get(sessionID) ?? 0, profile.budget);
    if (roleBudgetPeaks.get(sessionID) !== peak) setBounded(roleBudgetPeaks, sessionID, peak);
    return { ...profile, cumulative: Math.max(profile.cumulative, peak * GUARD_CUMULATIVE_MULTIPLIER) };
  };
  /** Handoff 13 (P1.4 `run` signal): router-observed runs and edit times of role children, bounded per child and overall. */
  const roleRuns = new Map<string, RunRecord[]>();
  const roleEdits = new Map<string, number[]>();
  /** QA-P21-1-7: role children that made a tool call while the router was bypassed (their edits were not recorded). */
  const roleBypassedCalls = new Set<string>();
  const noteBypassedRoleCall = (sessionID: unknown): void => {
    if (typeof sessionID !== "string" || roleOfSession(sessionID) === undefined) return;
    roleBypassedCalls.add(sessionID);
    while (roleBypassedCalls.size > ROLE_STATE_MAX) roleBypassedCalls.delete(roleBypassedCalls.values().next().value!);
  };
  const pushBounded = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key) ?? [];
    map.delete(key);
    list.push(value);
    while (list.length > 64) list.shift();
    map.set(key, list);
    while (map.size > ROLE_STATE_MAX) map.delete(map.keys().next().value!);
  };
  const ROLE_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
  /** Handoffs 16-18: the parent's role dispatches (by call), for the re-dispatch signal; bounded, oldest out. */
  const roleDispatchTexts = new Map<string, DispatchText>();
  /** IngestSettings.roleAgentIds from `resolveRoles` (handoff 21): the same object per base settings, so ingestion keeps its caches. */
  const roleIngestSettings = new WeakMap<IngestSettings, IngestSettings>();
  const withRoleAgents = (settings: IngestSettings | null): IngestSettings | null => {
    const roles = rolesNow();
    if (settings === null || roles.size === 0) return settings;
    let extended = roleIngestSettings.get(settings);
    if (extended === undefined) {
      extended = Object.freeze({ ...settings, roleAgentIds: new Set(roles.keys()) });
      roleIngestSettings.set(settings, extended);
    }
    return extended;
  };
  // M6 (2.1.3, QA-2.1-7): the one telemetry ingest of this plugin instance. v2 only (D1); every call is a no-op unless
  // routing.engine != static. Verdicts and false refusals come from the hooks below; the v2 adapter receives this same
  // instance through `routerOnIngest` and feeds it the step and session events, so there is a single settings source.
  const ingestAbort = new AbortController();
  const ingest: Ingest | undefined = ctx.routerHost === "v2" ? (() => {
    const core = createIngest({
      settings: () => withRoleAgents(ingestSettings(cfg, "v2")),
      logger,
      ...(ctx.routerCatalog
        ? { pricing: createCatalogPricing(ctx.routerCatalog, { logger, cacheKey: ctx.directory, signal: ingestAbort.signal }) }
        : {}),
    });
    // Disposing also releases any lookup still waiting for the catalog (QA-2.1-5): shutdown never waits for it.
    return { ...core, dispose: async () => { ingestAbort.abort(); await core.dispose(); } };
  })() : undefined;
  if (ingest) ctx.routerOnIngest?.(ingest);
  // Phase 2.3: what the delegate ladder tells the telemetry about each attempt (registry entry + decision row). v2 only (D1).
  const attemptRecorder: AttemptRecorder | undefined = ctx.routerHost === "v2"
    ? createAttemptRecorder({ host: "v2", config: () => cfg, logger })
    : undefined;
  resolveRouting(cfg, ctx.routerHost === "v2" ? "v2" : "v1", logger); // v1 + engine != static: log the notice once, at startup (QA-1.1-8)
  // #84 P2.1 (handoff 1): v1 + any roles key: the "roles delegation requires OpenCode v2" notice, once, at startup.
  resolveRolesRouting(cfg, ctx.routerHost === "v2" ? "v2" : "v1", logger);
  // QA-4.1-9: on v1 the executor validation issues are not logged; the notice below names the keys.
  setConfigNoticeHost(isV2Host ? "v2" : "v1");
  if (!isV2Host) {
    // Phase 2.1: the background and lease keys exist on v2 only; a v1 host does nothing with them. QA-2.1-12 (AGENTS.md: at most
    // one notice per process for a v2-only feature): one notice names every configured key, and no later instance logs another.
    // QA-4.1-9: the keys as written (the merged layers), so a value validation dropped is still named.
    const keys = [...configuredV2OnlyKeys(configAsWritten(cfg))];
    if (keys.length > 0 && warnedV2OnlyKeys.size === 0) {
      for (const key of keys) warnedV2OnlyKeys.add(key);
      // QA-2.1-32: the notice names the features actually configured (leases alone are not "background dispatch").
      // QA-4.1-19: a block that is not an object is named whole (`routing.executor`).
      const names = (block: string): boolean => keys.some((key) => key === `routing.${block}` || key.startsWith(`routing.${block}.`));
      const background = names("background");
      const leases = names("leases");
      const executor = names("executor");
      const orphans = names("orphans");
      const features = [background ? "background dispatch" : "", leases ? "leases" : "", executor ? "the plan executor" : "", orphans ? "orphan cleanup" : ""].filter((f) => f !== "");
      const subject = features.length === 0
        ? "background dispatch requires"
        : features.length === 1
          ? `${features[0]} ${leases && !background && !executor && !orphans ? "require" : "requires"}`
          : `${features.slice(0, -1).join(", ")} and ${features[features.length - 1]} require`;
      logger.warn(`[router] ${subject} OpenCode v2; ignored: ${keys.join(", ")}`);
    }
  }
  const depthTracker = createDepthTracker({
    async getParent(id) {
      if (sessionRootMemo.get(id) === true) return null;
      const res = await ctx.client.session.get({ path: { id } });
      if (!res || (res as { error?: unknown }).error || !res.data) {
        throw new Error("session.get returned no session data");
      }
      const parentID = res.data.parentID;
      return typeof parentID === "string" && parentID !== "" ? parentID : null;
    },
    now: () => Date.now(),
    logger: routerWarn,
  });
  const depthGuard = createDepthGuard({
    tracker: depthTracker,
    limit: () => resolveDepthLimit(cfg),
    mode: (sid) => resolveEnforcementMode({
      config: cfg,
      tier: (typeof sid === "string" ? sessionStore.getTier(sid) : null) ?? undefined,
      env: process.env,
    }).mode,
    logger: routerWarn,
  });
  // State-changing executor actions require depth 0, even for an exactly bound plan child.
  const planRootCallerAllowed = async (sessionID: unknown): Promise<boolean> => {
    if (!isV2Host || typeof sessionID !== "string" || sessionID === "") return false;
    try {
      return await depthTracker.depthOf(sessionID) === 0;
    } catch {
      return false;
    }
  };
  const planReadCallerAllowed = (sessionID: unknown, planId: unknown): boolean => {
    if (!isV2Host || typeof sessionID !== "string" || sessionID === "" || typeof planId !== "string") return false;
    try {
      const binding = currentBinding(sessionID, { maxOf: roleMaxOf });
      return binding?.kind === "exact" && binding.plan !== undefined && binding.plan.planId === planId.trim();
    } catch {
      return false;
    }
  };
  // Only this allowlist is read-only; new or unknown actions remain root-only. `/plan inbox` parses as status.
  const planActionCallerAllowed = async (sessionID: unknown, action: unknown, planId: unknown): Promise<boolean> =>
    await planRootCallerAllowed(sessionID) ||
    ((action === "status" || action === "ready" || action === "export") && planReadCallerAllowed(sessionID, planId));
  const planCallerRefusal = "refused: plan actions require a root orchestrator session; bound plan children may only read their own plan.";
  const routerPlan = executorRuntime === undefined ? undefined : createRouterPlanTool(executorRuntime, {
    approve: () => resolveRouting(loadConfig(projectDir), "v2").executor.approve,
  });
  const planCommand = executorRuntime === undefined ? undefined : createPlanCommand(executorRuntime);
  const planCommandMarker = Symbol.for("opencode-model-router.plan-command");
  let userPlanCommandDefined = false;
  let warnedPlanCommandConflict = false;
  const effortOverrides = createEffortOverrideStore({ logger: routerWarn });
  let warnedGraderParams = false;
  const depthBanners = new Map<string, string>();
  const warnedNoCallID = new Set<string>();
  const stashDepthBanner = (
    input: { sessionID?: string; callID?: string },
    output: Record<PropertyKey, unknown>,
    banner: string,
  ): void => {
    try {
      if (ctx.routerHost === "v2") {
        output[DEPTH_BANNER] = banner;
        return;
      }
      if (typeof input.callID === "string" && input.callID !== "") {
        const key = `${input.sessionID}:${input.callID}`;
        depthBanners.delete(key);
        depthBanners.set(key, banner);
        while (depthBanners.size > 1000) depthBanners.delete(depthBanners.keys().next().value!);
      } else {
        const sid = String(input.sessionID);
        if (warnedNoCallID.has(sid)) return;
        logger.warn(`[router] delegation depth: task call without callID in session ${sid}; advisory banner not delivered`);
        warnedNoCallID.add(sid);
        while (warnedNoCallID.size > 1000) warnedNoCallID.delete(warnedNoCallID.values().next().value!);
      }
    } catch (error) {
      logger.warn("[router] delegation depth: advisory banner not stored", { error: describeError(error) });
    }
  };

  // Phase 2.1 (v2 only): pending.jsonl in the durable per-user state directory, never the temp directory (QA-2.1-8).
  // On v1 there is no journal, no held state and no restore.
  const pendingDir = isV2Host
    ? resolvePendingJournalDir({ homedir: homedir(), platform: process.platform, xdgStateHome: process.env.XDG_STATE_HOME })
    : undefined;
  /**
   * QA-2.1-27: the journal compacts and reloads with the resolved `enforcement.verify.pendingTtlMs`, the TTL the pending
   * registry restores with (a longer configured TTL must not lose entries at the second restart).
   */
  const pendingJournalTtlMs = resolvePendingTtlMs(cfg);
  const pendingFile = pendingDir === undefined
    ? undefined
    : createPendingFileJournal(join(pendingDir, "pending.jsonl"), {
        ttlMs: pendingJournalTtlMs,
        // QA-2.1-22: a failed start-up compaction is told once (the journal stays as it was).
        warn: (message) => logger.warn(`[router] ${message}`),
      });
  /** Section 11.3: the exclusive per-session claim files of the journal's sessions (v2 only). */
  const pendingClaimsDir = pendingDir === undefined ? undefined : join(pendingDir, "pending.claims");
  /** DF-1-10: the beat files of the live plugin instances, which every module copy loaded into one host process can read. */
  const pendingBeatsDir = pendingDir === undefined ? undefined : join(pendingDir, PENDING_INSTANCES_DIRNAME);
  /** QA-2.1-33: the v2 adapter's live attempts and holds (`FinishApi.setAdapterSnapshot`); none before it attaches. */
  let adapterSnapshot: (() => readonly PersistedRecord[]) | undefined;
  /**
   * QA-2.1-16/-33: every record a later restore needs from this instance: the live pending entries, the sessions not
   * adopted yet, and the adapter's live attempts and holds. Registered on the journal (next to `dormantSessions`, once that
   * state exists), so a `recreate` by any instance of this process on the same path writes this instance's records too.
   */
  function journalSnapshot(): PersistedRecord[] {
    const dormant: PersistedRecord[] = [];
    for (const session of dormantSessions.values()) dormant.push(...session.holds, ...session.inflight);
    return [...pending.persistedRecords(), ...dormant, ...(adapterSnapshot?.() ?? [])];
  }
  /** QA-2.1-13: the sessions whose claim this process took at adoption; re-stamped while held, released on delete and dispose. */
  const claimedSessions = new Set<string>();
  let claimRefreshTimer: ReturnType<typeof setInterval> | undefined;
  function stopClaimRefresh(): void {
    if (claimRefreshTimer === undefined) return;
    clearInterval(claimRefreshTimer);
    claimRefreshTimer = undefined;
  }
  /**
   * QA-2.1-13/-34: a live owner re-stamps its claims every CLAIM_REFRESH_MS (unref'd timer, stopped when it holds no claim
   * and on dispose), well within CLAIM_STALE_MS, so they never read as a reused pid's; a crashed owner's claims go stale
   * within minutes, even when its pid is reused.
   */
  function trackPendingClaim(sessionID: string): void {
    claimedSessions.add(sessionID);
    if (claimRefreshTimer !== undefined || pendingClaimsDir === undefined) return;
    const claimsDir = pendingClaimsDir;
    claimRefreshTimer = setInterval(() => {
      refreshPendingClaims(claimsDir, claimedSessions, { pid: process.pid, now: Date.now(), ...(instanceClaim === undefined ? {} : { token: instanceClaim.token }) });
      // DF-1-10: the instance beat stays fresh while this instance holds a claim (a sibling module copy checks it).
      instanceClaim?.beat();
    }, CLAIM_REFRESH_MS);
    claimRefreshTimer.unref?.();
  }
  function releasePendingClaimOf(sessionID: string): void {
    if (!claimedSessions.delete(sessionID) || pendingClaimsDir === undefined) return;
    releasePendingClaim(pendingClaimsDir, sessionID, instanceClaim?.token);
    if (claimedSessions.size === 0) stopClaimRefresh();
  }
  function releaseAllPendingClaims(): void {
    stopClaimRefresh();
    if (pendingClaimsDir !== undefined) for (const sessionID of claimedSessions) releasePendingClaim(pendingClaimsDir, sessionID, instanceClaim?.token);
    claimedSessions.clear();
    // QA-2.1-19: from now on another instance of this process may take this instance's (remaining) claims.
    instanceClaim?.release();
  }
  /**
   * QA-2.1-19 (v2 only): this instance's claim token. Its claims are refused to every other live instance (of this
   * process: the token; of another process: the pid) until it disposes. DF-1-10: its beat file in `pending.instances`
   * makes the token visible to instances of this process that run another copy of the plugin modules.
   */
  const instanceClaim = pendingClaimsDir === undefined ? undefined : createInstanceClaimToken(pendingBeatsDir);
  /**
   * QA-2.1-19: takes the claim of `sessionID` for this instance (pid + token), once. The live owner claims at its first
   * `inflight`/`hold` write; `adopt` claims before handing dormant records over. False when another live instance holds
   * it (or the claim file cannot be written).
   */
  function claimSessionOnce(sessionID: string): boolean {
    if (claimedSessions.has(sessionID)) return true;
    if (pendingClaimsDir === undefined || instanceClaim === undefined) return false;
    try {
      const pidAliveNow = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      // DF-1-10: the beat is fresh before the claim lands, so a sibling copy of the module never reads it as orphaned.
      if (claimRefreshTimer === undefined) instanceClaim.beat();
      if (!claimPendingSession(pendingClaimsDir, sessionID, {
        pid: process.pid, now: Date.now(), isAlive: pidAliveNow, token: instanceClaim.token,
        ...(pendingBeatsDir === undefined ? {} : { beatsDir: pendingBeatsDir }),
      })) return false;
    } catch (error) {
      logger.warn("[router] the pending session claim could not be taken", { sessionID, error: describeError(error) });
      return false;
    }
    trackPendingClaim(sessionID);
    return true;
  }
  /** Late-bound: the lease guard exists only once the v2 adapter attaches (FinishAttach `leaseGate`); the wiring reads it per use. */
  let leaseGateRef: Pick<LeaseGuard, "waitTreeFree"> | undefined;
  /** Phase 5.1 D11 (v2 only): the plan-task gates' own holders, exempt from the lease wait in their own slot tree. */
  const planTaskLeaseExemptions = createLeaseSelfExemptions((root) => planTreeKey(root));
  const {
    graderSessions, dispatchGrader, buildGateDeps, disposeChildSession,
    prepareVerification, startReferenceGc, beginVerificationBounded,
    sweepVerification, disposeVerification,
    startDispatch, takeDispatch, isDeferred: wiringIsDeferred, directivesFor, finishDeferred, applyLineage, pending,
    verifyHandles,
    // 2.4.5: undefined unless `background: true` at plugin start (pending.ts R14).
    background,
  } = createVerificationWiring({
    client: ctx.client,
    observations: isV2Host ? ctx.routerObservations : undefined,
    childRunner: ctx.routerChildRunner,
    onChildSessionCreated: (sid, creator) => depthTracker.recordPluginChild(sid, creator),
    directory: ctx.directory,
    getConfig: () => cfg,
    logger,
    ...(pendingFile === undefined ? {} : {
      pending: { persist: pendingFile, onVerdict: (entry: PendingEntry, result: SettledVerification) => postHeldVerdict(entry, result) },
      pendingRestore: pendingFile.load(),
      // v2 only. Delegating: the guard arrives with the adapter's attach; until then (or without `leases: enforce`) nothing waits.
      leaseGate: {
        waitTreeFree: async (tree, owner, deadlineMs, signal) => {
          if (leaseGateRef === undefined) return { waitedMs: 0, holders: [], fileCount: 0 };
          // Phase 5.1 D11: a plan-task gate does not wait for its own task's holders in its own slot tree.
          const exempt = planTaskLeaseExemptions.exemptFor(tree);
          if (exempt.size === 0) return leaseGateRef.waitTreeFree(tree, owner, deadlineMs, signal);
          const gate = leaseGateRef;
          let fileCount = 0;
          const probe: Pick<LeaseGuard, "waitTreeFree"> = {
            waitTreeFree: async (...args) => { const r = await gate.waitTreeFree(...args); fileCount = r.fileCount; return r; },
          };
          const wait = await waitTreeFreeExcept(probe, tree, owner, exempt, deadlineMs, signal);
          return { waitedMs: wait.waitedMs, holders: wait.holders, fileCount: wait.holders.length === 0 ? 0 : fileCount };
        },
      },
    }),
  });
  // 2.1.5b: sweep reference dirs a crashed instance left behind. Fire-and-forget; never throws.
  // QA-2.1-11: deferred (unref'd timer), so plugin start never holds the project directory with a
  // git child; dispose cancels it.
  // DF-1-1 (v2 only): with `routing.workRoots` configured and non-empty, a location outside every entry is not the plan's:
  // the start-up reference GC is skipped (it would run git in, and write to, that repository). Unset or empty: unchanged.
  const outsideWorkRoots = isV2Host && locationOutsideWorkRoots(ctx.directory, cfg.routing?.workRoots);
  if (outsideWorkRoots) logger.info?.(`[router] ${ctx.directory} is outside routing.workRoots: the start-up reference GC is skipped`);
  const stopReferenceGc = outsideWorkRoots ? (): void => undefined : startReferenceGc();
  // Phase 5.1 D8 (v2 only): plan tasks are verified by this instance's dispatch verification engine; v2.ts hands the verifier to
  // the adapter's executor seam. Nothing is built or handed over on v1.
  if (isV2Host) {
    const planTaskVerifier = createPlanTaskVerifier({
      changedFileStore,
      beginVerificationBounded,
      prepareVerification,
      buildGateDeps,
      captureBudget: (childSessionID, capReached) => captureBudget(childSessionID, capReached),
      readCapReached: (childSessionID) => sessionStore.readCapReached(childSessionID),
      onVerdict: (childSessionID, verdict) => ingest?.onVerdict(childSessionID, verdictOf(verdict), verdictGraderOf(verdict)),
      abortSession: async (sessionID) => { await ctx.client.session.abort({ path: { id: sessionID } }); },
      getConfig: () => cfg,
      git: planTaskGit(),
      exemptions: planTaskLeaseExemptions,
      log: (message, detail) => logger.warn(`[verify] ${message}`, detail === undefined ? undefined : { error: describeError(detail) }),
    });
    (ctx as RouterPluginInput & { routerOnSlotVerifier?: (verifier: typeof planTaskVerifier) => void }).routerOnSlotVerifier?.(planTaskVerifier);
  }

  // Phase 1.2 (v2 only): the turn-state registry the adapter injects. Without it (v1, or a v2 host that injects none) nothing
  // below is registered or buffered, and the system transform keeps pushing the pending list and the late notices.
  // The registry arrives through the ROUTER_TURN_STATE_ATTACH hook the v2 adapter calls (the only channel); the hook
  // returns whether the registry was accepted.
  let turnState: TurnStateRegistry | undefined;
  const lateBuffer: LateBuffer | undefined = isV2Host ? createLateBuffer() : undefined;
  const unregisterTurnStateProviders: Array<() => void> = [];
  let warnedSecondRegistry = false;
  const attachTurnState = (registry: TurnStateRegistry): boolean => {
    if (turnState !== undefined) {
      if (turnState !== registry && !warnedSecondRegistry) {
        warnedSecondRegistry = true;
        logger.warn("[router] turn state: a second registry was ignored");
      }
      return turnState === registry;
    }
    turnState = registry;
    if (lateBuffer === undefined) return true;
    try {
      // Late notices of background runs that did not pass: buffered before the block is built (a builder throw loses
      // nothing) and kept until router_verify answers their handle.
      unregisterTurnStateProviders.push(turnState.registerTurnStateProvider({
        name: "late",
        order: 10,
        render(sid) {
          if (background === undefined) return undefined;
          lateBuffer.add(sid, background.takeNotices(sid));
          lateBuffer.touch(sid);
          return buildLateNoticeBlock(lateBuffer.list(sid));
        },
        active(sid) {
          return lateBuffer.list(sid).length > 0;
        },
      }));
      // This orchestrator's still-unverified delegations (the same arguments the v1 transform passes).
      unregisterTurnStateProviders.push(turnState.registerTurnStateProvider({
        name: "pending",
        order: 20,
        render(sid) {
          return buildPendingListBlock(pending.listPending(sid, { verifying: background !== undefined }));
        },
        active(sid) {
          return pending.listPending(sid, { verifying: background !== undefined }).length > 0;
        },
      }));
    } catch (error) {
      logger.warn("[router] turn state: late/pending providers not registered", { error: scrubText(String(error)) });
      // Nothing stays half registered: the system transform keeps delivering through the system array.
      for (const unregister of unregisterTurnStateProviders.splice(0)) {
        try {
          unregister();
        } catch (unregisterError) {
          logger.warn("[router] turn state: unregistering a provider failed", { error: scrubText(String(unregisterError)) });
        }
      }
      turnState = undefined;
      return false;
    }
    return true;
  };

  // Best-effort, secret-free delegate scorecard dump (counts only).
  const dumpDelegateScorecard = (
    sid: string,
    st: Parameters<typeof formatLadderScorecard>[0],
    accepted: boolean,
    method: string,
  ): void => {
    try {
      const line = formatLadderScorecard(st, accepted, method);
      const dir = join(tmpdir(), "opencode-model-router-trajectory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.delegate.log`), line + "\n", { flag: "a" });
    } catch {
      // best-effort only
    }
  };

  // Bypass mode: when true, the router skips all system prompt injection,
  // subagent tracking, cap enforcement, and narration detection for the
  // current plugin lifetime (i.e., until OpenCode is restarted).
  let bypassed = false;
  // #84 P2.1: the v2 adapter's role path reads the bypass state (the router gate does not run while bypassed, S10/P-9).
  (ctx as RouterPluginInput & { routerOnBypassState?: (read: () => boolean) => void }).routerOnBypassState?.(() => bypassed);
  /** QA-P21-1-3: the budget snapshot of a role child as the signals AND the adapter's budget notice read it (guard + read cap). */
  const roleBudgetSnapshot = (childSessionID: string) => {
    consumeExecutorChildRound(childSessionID);
    return captureBudget(childSessionID, sessionStore.readCapReached(childSessionID));
  };
  (ctx as RouterPluginInput & { routerOnBudgetSnapshot?: (read: typeof roleBudgetSnapshot) => void }).routerOnBudgetSnapshot?.(roleBudgetSnapshot);
  /**
   * QA-G-A3-2 (§2.9 E6, R7 REFUSAL_CAP): a role child's call refused where the guard's before-hook never sees it — the v2
   * adapter's role-authority check (thrown in its `execute.before`, before this plugin's hook) and host permission denials (its
   * `execute.after` with a permission error) — counted on the child's guard state like the guard's own refusals, so `denied_cap`
   * stops a child that keeps retrying refused actions. Returns the guard's text for the refusal (its stop, or the advisory
   * banner), or undefined. Role children only; nothing while bypassed or when enforcement is off. Never throws.
   */
  const recordRoleRefusal = (sessionID: string, agent: string | undefined, tool: string, args: unknown): string | undefined => {
    try {
      if (bypassed) return undefined;
      // A child whose first calls are all refused never reached the before-hook that marks it: as there, from its own agent.
      if (rememberRoleSession(sessionID, agent)) sessionStore.markChildSession(sessionID);
      if (roleOfSession(sessionID) === undefined || !sessionStore.isSubagent(sessionID)) return undefined;
      const profile = roleGuardProfileOf(sessionID, agent);
      return guardRefusedCall({
        cfg,
        tier: sessionStore.getTier(sessionID),
        trivial: sessionStore.isTrivial(sessionID),
        cap: sessionStore.getCap(sessionID),
        sessionID,
        tool,
        toolArgs: args,
        store: guardStore,
        env: process.env,
        ...(profile === undefined ? {} : { profile }),
      });
    } catch {
      return undefined; // never break a real session on a guard-internal error
    }
  };
  (ctx as RouterPluginInput & { routerOnRefusal?: (record: typeof recordRoleRefusal) => void }).routerOnRefusal?.(recordRoleRefusal);
  /** #84 P2.1 (handoff 22): the v2 adapter's host-side budget observation of a role child (step limit, context overflow). */
  const hostBudgetOf = (ctx as RouterPluginInput & {
    routerHostBudget?: (childSessionID: string, stepLimit: number | null) => HostBudgetObservation | undefined;
  }).routerHostBudget;

  warnConfigIssues(cfg, logger);

  // Fetch and normalize opencode's live provider/model catalog. Best-effort:
  // returns null when the client call fails, e.g. the server is not ready yet.
  // The pure analysis (validateModels) lives in src/router/catalog.ts.
  const fetchCatalogRaw = async (): Promise<{ catalog: Catalog; raw: unknown } | null> => {
    try {
      const res: any = await ctx.client.config.providers();
      return { catalog: normalizeCatalog(res?.data), raw: res?.data };
    } catch {
      return null;
    }
  };
  const fetchCatalog = async (): Promise<Catalog | null> => (await fetchCatalogRaw())?.catalog ?? null;

  // M8 (Phase 2.4): the cost doctor reads the host's agents and model catalog (v2 only, D1). Each call is bounded and failing
  // one only leaves the checks that need it silent; nothing here ever throws into a session.
  // The orchestrator's model as the last root-session turn reported it: the host's title pick depends on its provider (QA-2.4-1).
  let lastPrimary: { providerID: string; modelID: string | null } | null = null;
  const ADVISOR_HOST_TIMEOUT_MS = 3_000;
  // The catalog comes from `config.providers()` (the call `/router` already makes for the model check, enriched with cost and capabilities
  // by the v2 adapter), so the doctor does not ask the host for the model list a second time (QA-2.4-3). `prefetched` is that call's result
  // when the caller already has it.
  /** #84 P2.2: the window of the decision log the roles checks of the cost doctor read. */
  const ADVISOR_ROLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  /**
   * #84 P2.2: the extras of the cost doctor's roles checks — the host and, in roles mode with a live engine, the role × tier
   * statistics, unknown-binding counts and tier dispatch count over {@link ADVISOR_ROLE_WINDOW_MS}, plus process-lifetime orphan
   * counters. The v2 adapter uses this same gatherer. Tiers mode and v1 read nothing (`{ host }` only); a read failure leaves
   * the windowed statistics out but keeps the process counters.
   */
  const advisorExtras = async (): Promise<AdvisorExtras> => {
    const host = isV2Host ? "v2" as const : "v1" as const;
    if (rolesNow().size === 0) return { host };
    const orphanCounters = readRoleOrphans().counters;
    const live = ingestSettings(cfg, "v2");
    if (live === null) return { host, orphanCounters }; // engine static: no decision log
    try {
      const read = await createPersister(live.outcomesDir, nodePersistDeps({ warn: () => undefined })).readRows();
      const since = Date.now() - ADVISOR_ROLE_WINDOW_MS;
      const window = { since, until: null };
      return {
        host,
        roleStats: summarizeRoles(null, read.rows, window),
        tierDispatches: tierDispatchCount(read.rows, since),
        unknownBindings: countUnknownBindings(read.rows, window),
        orphanCounters,
      };
    } catch (error) {
      logger.warn("[router] cost doctor: the role statistics are unavailable", { error: describeError(error) });
      return { host, orphanCounters };
    }
  };
  const gatherAdvisorInputs = async (
    prefetched?: { raw: unknown } | null,
  ): Promise<{ host: HostConfigView | null; catalog: AdvisorCatalogModel[] | null; extras: AdvisorExtras }> => {
    const attempt = async <T>(label: string, call: (() => Promise<T>) | undefined): Promise<T | null> => {
      if (call === undefined) return null;
      try {
        return await withTimeout(call(), ADVISOR_HOST_TIMEOUT_MS, label);
      } catch (error) {
        logger.warn(`[router] cost doctor: the ${label} is unavailable`, { error: describeError(error) });
        return null;
      }
    };
    const [agents, providers, extras] = await Promise.all([
      attempt("host agent list", ctx.routerAgents),
      prefetched !== undefined ? Promise.resolve(prefetched) : attempt("model catalog", fetchCatalogRaw),
      advisorExtras(),
    ]);
    return {
      host: agents === null ? null : hostConfigFromAgents(agents, lastPrimary),
      catalog: providers === null ? null : catalogFromProviders(providers.raw),
      extras,
    };
  };
  const advisorNotifier = ctx.routerHost === "v2"
    ? createAdvisorNotifier({ settings: () => advisorSettings(cfg, "v2", { project: projectDir }), config: () => cfg, gather: gatherAdvisorInputs, logger })
    : undefined;
  // `/annotate-plan` (Phase 2.4.4): its own engine runtime (agent list, catalog, classifier backend, outcome store), created on the first use
  // and only on v2; with `routing.engine: static` its `prepare()` answers null before any host call, store or file.
  let annotateRuntime: EngineRuntime | undefined;
  const annotatePlanRuntime = (): EngineRuntime | undefined => {
    if (ctx.routerHost !== "v2" || ctx.routerAgents === undefined || ctx.routerCatalog === undefined) return undefined;
    annotateRuntime ??= createEngineRuntime({
      loadConfig: () => cfg,
      listAgents: ctx.routerAgents,
      listModels: ctx.routerCatalog,
      ...(ctx.routerGenerate === undefined ? {} : { generate: ctx.routerGenerate }),
      logger,
    });
    return annotateRuntime;
  };
  if (isV2Host) {
    executorInput?.routerOnPlanAnnotate?.(async (steps) => {
      const current = loadConfig(projectDir);
      const runtime = annotatePlanRuntime();
      const prepared = await runtime?.prepare(current);
      const routing = prepared?.routing ?? resolveRouting(current, "v2");
      const classifyDeps = prepared && runtime ? runtime.classifyDeps(prepared) : {
        cfg: current, settings: { ...routing.classifier, backend: "rules" as const },
        minClassConfidence: routing.minClassConfidence, backend: null, logger,
      };
      let agents: HostAgentInfo[] | null = null;
      if (prepared && ctx.routerAgents !== undefined) {
        try { agents = agentInfosForPlan(await ctx.routerAgents()); }
        catch (error) { logger.warn("[router] executor: the agent list is unavailable; tiers are annotated without it", { error: describeError(error) }); }
      }
      return annotateSteps(steps, {
        cfg: current, routing, agents, store: prepared?.store ?? null, logger,
        ...(prepared ? { pricing: (model) => prepared.catalog.pricing(model), session: prepared.session } : {}),
        classifyMany: (inputs) => classifyPlanSteps(inputs, { ...classifyDeps, routeLinePositions: "any" }),
      });
    });
  }
  // v1 only (A28): the host's agent list for the text-only roles line, read through `client.app.agents()` and never fetched unless
  // `routing.roles` is set explicitly. It is refreshed IN THE BACKGROUND (QA-2.4-13): a turn never waits for it. The first turn after start
  // has no list yet and gets the baseline prompt; later turns use the last list, stale while the next one is fetched (every minute). A
  // failed refresh keeps the last list and is logged; a list that was never fetched leaves the line as it is without roles.
  const V1_AGENTS_TTL_MS = 60_000;
  let v1Agents: { at: number; infos: HostAgentInfo[] | null } | null = null;
  let v1AgentsRefresh: Promise<void> | null = null;
  const refreshV1Agents = (): void => {
    if (v1AgentsRefresh !== null) return;
    const run = (async (): Promise<void> => {
      try {
        const res = await withTimeout(Promise.resolve(ctx.client.app.agents()), 2_000, "v1 agent list");
        const data: unknown = (res as { data?: unknown } | undefined)?.data;
        v1Agents = { at: Date.now(), infos: Array.isArray(data) ? v1AgentInfos(data) : (v1Agents?.infos ?? null) };
      } catch (error) {
        logger.warn("[router] routing.roles: the host's agent list is unavailable; the R: line keeps the last list, or stays without roles", { error: describeError(error) });
        v1Agents = { at: Date.now(), infos: v1Agents?.infos ?? null }; // keep serving the stale list; try again after the interval
      }
    })().finally(() => {
      if (v1AgentsRefresh === run) v1AgentsRefresh = null;
    });
    v1AgentsRefresh = run;
  };
  /** The last known v1 agent list (possibly stale, possibly `null`), starting a background refresh when it is due. Synchronous. */
  const v1AgentsNow = (): HostAgentInfo[] | null => {
    if (v1Agents === null || Date.now() - v1Agents.at >= V1_AGENTS_TTL_MS) refreshV1Agents();
    return v1Agents?.infos ?? null;
  };  /** Hand a notice to the orchestrator as a synthetic transcript entry (v2), or log it where there is no such call. Never throws, never waits. */
  const deliverAdvisorNotice = (sessionID: string, notice: string): void => {
    const synthetic = ctx.routerSynthetic;
    if (synthetic === undefined) {
      logger.warn(notice); // no synthetic-message call on this host: the log line is the whole delivery
      return;
    }
    const text = `Cost doctor notice for the user (say it once, in one short sentence, then carry on with the task):\n${notice}`;
    void Promise.resolve()
      .then(() => synthetic({ sessionID, text, description: "Model router cost doctor" }))
      .catch((error: unknown) => {
        logger.warn("[router] cost doctor: notice not delivered", { error: describeError(error) });
      });
  };
  /** The `/router` section "Cost doctor" (on demand: runs the checks now, writes nothing). */
  const buildCostDoctorLines = async (prefetched?: { raw: unknown } | null): Promise<string[]> => {
    const routing = resolveRouting(cfg, "v2");
    if (!routing.advisor.enabled) return ["Cost doctor: disabled (routing.advisor.enabled is false)."];
    const { host, catalog, extras } = await gatherAdvisorInputs(prefetched);
    const lines = formatFindings(runAdvisor(cfg, host, catalog, logger, extras), {
      hostKnown: host !== null,
      catalogKnown: catalog !== null && catalog.length > 0,
      primaryKnown: lastPrimary !== null,
    });
    // Phase 2.3 handoff (decision 16): a ladder row's confidence is not the evidence share the dispatch rows carry.
    if (routing.engine !== "static") {
      lines.push("Decision log: a ladder-attempt row's confidence is the delegation's class confidence; a dispatch row's is the class confidence scaled by the winner's evidence (n/(n+5)).");
    }
    return lines;
  };

  // Deferred passive catalog check. The first orchestrator turn only STARTS the
  // fetch (fire-and-forget, never awaited on the chat.message hot path) and
  // parks the result in a local; the warning is emitted on the first LATER turn
  // that finds the promise already settled — normally turn 2. Deliberate
  // tradeoff: a report-only diagnostic showing up one turn late costs nothing,
  // while awaiting a network round-trip in front of every session's first
  // message costs every user every session. No timers (banned in src/), and the
  // continuation writes to a local variable only — it never touches an
  // output.parts of a message the hook has already returned.
  //
  // Command handlers deliberately keep their own fresh fetchCatalog() call, so a
  // turn-1 failure (server not ready yet) is never cached into `/router models`.
  let catalogFetchStarted = false;
  /** undefined = not started or still in flight; null = the fetch failed. */
  let deferredCatalog: Catalog | null | undefined;
  // One-shot guard so the passive warnings run at most once per plugin
  // lifetime; re-validate on demand with /router.
  let catalogWarned = false;

  const startCatalogFetch = (): void => {
    if (catalogFetchStarted) return;
    catalogFetchStarted = true;
    // fetchCatalog already swallows its own errors; the .catch is belt-and-
    // braces so this fire-and-forget promise can never reject unhandled.
    void fetchCatalog()
      .then((c) => {
        deferredCatalog = c;
      })
      .catch(() => {
        deferredCatalog = null;
      });
  };

  const enableDelegateTool =
    cfg.experimental?.verifiedDelegateTool === true ||
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  // 2.4.3b (plan 2.4.3 "Registration"): `router_verify` is registered whenever verification is
  // enabled at plugin start, independent of enableDelegateTool: verify.require is not "never" and
  // a verifying path exists (the native `task` path needs an enforcement mode other than "off";
  // the delegate tool verifies in every mode). The tool map is fixed at start.
  let routerVerifyEnabled = false;
  try {
    const startMode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    routerVerifyEnabled = cfg.enforcement?.verify?.require !== "never" && (startMode !== "off" || enableDelegateTool);
  } catch (error) {
    logger.warn("[verify] router_verify not registered: the enforcement mode could not be resolved", { error: scrubText(String(error)) });
  }
  // QA-P21-2 nit 3: the role path's deferral check follows it (nothing is deferred without router_verify).
  (ctx as RouterPluginInput & { routerOnVerifyEnabled?: (read: () => boolean) => void }).routerOnVerifyEnabled?.(() => routerVerifyEnabled);
  /**
   * 2.4.2 + 2.4.3b: a delegation defers only when `router_verify` exists to verify it later. A
   * footer never names a tool this instance did not register; without it the delegation keeps the
   * synchronous gate (never weaker).
   */
  const isDeferred: typeof wiringIsDeferred = (dod, directives, trivial) => routerVerifyEnabled && wiringIsDeferred(dod, directives, trivial);
  /**
   * QA-2.4-2: a deferred entry is keyed to the dispatching session (pending.ts R6), and only a root
   * orchestrator ever sees a pending list (the system transform returns early for every child). So
   * only a PROVEN root orchestrator session may defer. A subagent dispatching `task` or `delegate`
   * (a grader, a tracked subagent, a session with a parentID) gets today's synchronous gate and
   * registers nothing, whatever its directives say; so does an unknown session (no id, or a failed
   * lookup: fail safe).
   */
  const isProvenRootCaller = async (sessionID: unknown): Promise<boolean> => {
    if (typeof sessionID !== "string" || sessionID === "") return false;
    if (graderSessions.has(sessionID) || sessionStore.isSubagent(sessionID)) return false;
    return (await lookupRootSession(sessionID)) === true;
  };

  /**
   * Phase 2.3: the host model catalog as the delegate ladder reads it (variants and limits per model). Best effort: a
   * missing, failing or slow catalog is `undefined`, and the ladder then behaves exactly as without variant info
   * (fresh sessions, tier ratios). QA-2.3-3: the answer, positive or negative, is cached for the TTL; delegations that
   * ask while a load is running share it; a call that outlived its timeout is not repeated behind itself (a late answer
   * still fills the cache); and a failure is logged once per streak, until a load succeeds. So with a hung catalog the
   * first delegation waits for the timeout and every later one answers at once.
   */
  /** How long a failed ladder attempt waits for its child's execution end before it starts fresh (QA-2.3-2). */
  const RESUME_END_WAIT_MS = 1_000;
  const RUNNER_CATALOG_TTL_MS = 15_000;
  const RUNNER_CATALOG_TIMEOUT_MS = 3_000;
  /** A catalog call still pending after this long is abandoned: a new one may start behind it. */
  const RUNNER_CATALOG_ABANDON_MS = 60_000;
  /** The last answer, valid for the TTL; `lookup` undefined = the catalog was unavailable. */
  let runnerCatalog: { at: number; lookup: CatalogLookup | undefined } | undefined;
  /** The load in progress (bounded by the timeout), shared by every delegation that asks meanwhile. */
  let runnerCatalogLoad: Promise<CatalogLookup | undefined> | undefined;
  /** When the outstanding `routerCatalog()` call started; it may outlive its timeout. */
  let runnerCatalogCallAt: number | undefined;
  /** Id of the latest call (QA-2.3-R2-6): an abandoned call that settles late must not clear the state of a newer one. */
  let runnerCatalogCallId = 0;
  let runnerCatalogFailing = false;
  const runnerCatalogFailed = (error: unknown): undefined => {
    runnerCatalog = { at: Date.now(), lookup: undefined };
    if (!runnerCatalogFailing) {
      runnerCatalogFailing = true;
      logger.warn("[router] ladder: the model catalog is unavailable; variant steps and resume are off until it answers", { error: describeError(error) });
    }
    return undefined;
  };
  const loadRunnerCatalog = (): Promise<CatalogLookup | undefined> => {
    const list = ctx.routerCatalog;
    if (!list) return Promise.resolve(undefined);
    const nowMs = Date.now();
    if (runnerCatalog !== undefined && nowMs - runnerCatalog.at < RUNNER_CATALOG_TTL_MS) return Promise.resolve(runnerCatalog.lookup);
    if (runnerCatalogLoad !== undefined) return runnerCatalogLoad;
    if (runnerCatalogCallAt !== undefined && nowMs - runnerCatalogCallAt < RUNNER_CATALOG_ABANDON_MS) {
      // An earlier call timed out and is still outstanding: no second `list()` behind it.
      runnerCatalog = { at: nowMs, lookup: undefined };
      return Promise.resolve(undefined);
    }
    runnerCatalogCallAt = nowMs;
    const callId = ++runnerCatalogCallId;
    const answer = Promise.resolve().then(() => list()).then(
      (models) => {
        // A late answer is still a catalog, whichever call it answers; only the latest call owns the marker.
        if (callId === runnerCatalogCallId) runnerCatalogCallAt = undefined;
        const lookup = createCatalogLookup(models);
        runnerCatalog = { at: Date.now(), lookup };
        runnerCatalogFailing = false;
        return lookup;
      },
      (error: unknown) => {
        // A failure of an abandoned call says nothing about the newer one: leave its marker and the cache alone.
        if (callId !== runnerCatalogCallId) return undefined;
        runnerCatalogCallAt = undefined;
        return runnerCatalogFailed(error);
      },
    );
    const load: Promise<CatalogLookup | undefined> = withTimeout(answer, RUNNER_CATALOG_TIMEOUT_MS, "model catalog")
      .catch((error: unknown) => runnerCatalogFailed(error))
      .finally(() => {
        if (runnerCatalogLoad === load) runnerCatalogLoad = undefined;
      });
    runnerCatalogLoad = load;
    return load;
  };

  // #84 P2.1 (T2.1.3): the tools of roles mode. The tool map is fixed at plugin start (like `router_verify`): in tiers mode and on
  // v1 the set is exactly the previous one (router_run and router_request_authority are not registered; router_git_* keep their
  // directory resolution). Switching to roles mode registers them on the next start.
  const rolesAtStart = rolesNow().size > 0;
  // G-16: on v2 off Windows, one notice per process, only for a config that asks for the executor (roles mode at start with
  // enforced leases and verification not disabled: the prerequisites v2.ts's executor discovery checks).
  if (isV2Host && !executorPlatform && rolesAtStart && resolveRouting(cfg, "v2").leases.mode === "enforce"
    && cfg.enforcement?.verify?.require !== "never") warnExecutorPlatformOnce(logger);
  const dynamicRolesAtStart = [...rolesNow().values()].some((spec) => spec.authority.mode === "dynamic");
  /**
   * Cross-repo 3b.4 (SD-3b-1): `router_git_*` declare `root` only on v2, in roles mode, with `routing.repoParents` non-empty at start
   * (the tool map is fixed at start). Everywhere else, v1 included, schema and description stay byte-identical; no notice.
   */
  const crossRepoAtStart = ((): boolean => {
    if (!isV2Host || !rolesAtStart) return false;
    try {
      return resolveRolesRouting(cfg, "v2").repoParents.length > 0;
    } catch {
      return false;
    }
  })();
  /** `router_request_authority` dependencies (P1.6): the role by child session; only the parent of `dispatchOf` is read. */
  const authorityDeps = {
    roleOf: (child: string) => roleOfSession(child),
    roles: () => rolesNow(),
    dispatchOf: (child: string) => {
      const parent = lookupDispatch(child)?.parentSessionID;
      // QA-P21-1-13: `callID: ""` = not attached yet. authority.ts reads only the parent (to drop the request with it);
      // `markAnnotated` attaches the request to the parent's call in the adapter's execute.after.
      return typeof parent === "string" && parent !== "" ? { parentSessionID: parent, callID: "" } : undefined;
    },
    bindingOf: (child: string) => currentBinding(child, { maxOf: roleMaxOf }),
  };
  /** The acceptance commands of a role dispatch as `routing.run` names (handoff 13); see `acceptanceScriptsOf`. */
  const acceptanceScripts = (prompt: unknown, description: unknown): string[] =>
    acceptanceScriptsOf(
      buildDelegationDoD({
        prompt: typeof prompt === "string" ? prompt : undefined,
        description: typeof description === "string" ? description : undefined,
      }),
    );
  /**
   * QA-P21-2-3: the read-only cap a role dispatch asks for itself — `CAP:N`, or `CAP:none` with a `reason:` line (an unjustified
   * `CAP:none` is no cap, as for tier dispatches); `null` when it names none (then the child gets no read-only cap).
   */
  const roleDispatchCap = (prompt: unknown): Cap | null => {
    if (typeof prompt !== "string") return null;
    // P2g.3 (OD6): the orchestrator's own text — a router role header (a work root such as `.../CAP:9`) is never read as the cap.
    const text = stripDispatchHeader(prompt);
    const parsed = parseCapDirective(text);
    return parsed === "none" && !/\breason:/i.test(text) ? null : parsed;
  };
  /** Caps of fresh role dispatches, by the parent's call, until the child binds (bounded, oldest out). */
  const pendingRoleCaps = new Map<string, { agent: string; cap: Cap }>();
  const rememberPendingRoleCap = (callID: string, agent: string, cap: Cap): void => {
    pendingRoleCaps.delete(callID);
    pendingRoleCaps.set(callID, { agent, cap });
    while (pendingRoleCaps.size > ROLE_STATE_MAX) pendingRoleCaps.delete(pendingRoleCaps.keys().next().value!);
  };
  /**
   * The role child's read-only counter with the dispatch's cap, independent of `subagentTiers` (the session store's producer
   * registration: no trivial downgrade). The cap is keyed by the role agent's name, which is never a tier.
   */
  const registerRoleCap = (child: string, agent: string, cap: Cap): void => {
    sessionStore.registerProducerSession(child, agent, { ...cfg, tierCaps: { ...(cfg.tierCaps ?? {}), [agent]: cap } } as RouterConfig);
  };
  /** A fresh role child's first call: its exact binding names the dispatch's call, whose cap is registered once. */
  const applyPendingRoleCap = (child: string): void => {
    consumeExecutorChildRound(child);
    if (pendingRoleCaps.size === 0) return;
    const binding = currentBinding(child, { maxOf: roleMaxOf });
    const callID = binding?.kind === "exact" ? binding.candidates[0] : undefined;
    const pending = callID === undefined ? undefined : pendingRoleCaps.get(callID);
    if (callID === undefined || pending === undefined) return;
    pendingRoleCaps.delete(callID);
    registerRoleCap(child, pending.agent, pending.cap);
  };
  /**
   * QA-PDF21-2-11: an executor budget resume (a launch with `req.resume`) opens a new guard round and a new read-cap round for
   * its child, exactly as a routed resume does (`noteRoleDispatch`): the per-dispatch budget and the read counter restart, the
   * cumulative ceiling stays. A cap the launch prompt names replaces the child's previous one.
   */
  const beginExecutorResumeRound = (child: string, agent: string, prompt: string): void => {
    publishExecutorChildRound(child, agent, executorLineCap(prompt), true);
    consumeExecutorChildRound(child);
  };
  /**
   * QA-PDF21-2-20: the read cap of a plan child's launch prompt is the executor's own cap line ONLY (`EXECUTOR_READ_CAP_LINE`,
   * right after the "PLAN CONTEXT" line, DF-2-9), parsed by `parseCapDirective`. A prompt without it (a non-editing task, a
   * resume) names no cap: plan text — even a `CAP` token split across lines, which the line-bound neutralization misses — never
   * sets one.
   */
  const executorLineCap = (prompt: string): Cap | null =>
    prompt.startsWith(`PLAN CONTEXT\n${EXECUTOR_READ_CAP_LINE}\n`) ? parseCapDirective(EXECUTOR_READ_CAP_LINE) : null;
  /**
   * QA-PDF21-2-20: a plan child the executor just bound gets the read cap of its launch prompt's cap line, through the state a
   * routed role dispatch uses (`registerRoleCap`). A plan child has no parent `task` call, so `applyPendingRoleCap` never
   * reaches it, and its role agent is no tier, so `registerFromChatMessage` does not either.
   */
  const applyExecutorChildCap = (child: string, agent: string, prompt: string): void => {
    publishExecutorChildRound(child, agent, executorLineCap(prompt), false);
    consumeExecutorChildRound(child);
  };
  const executorRoundsSeen = new Map<string, number>();
  const consumeExecutorChildRound = (child: string): void => {
    if (!isV2Host) return;
    const published = executorChildRound(child);
    if (published === undefined || executorRoundsSeen.get(child) === published.round) return;
    setBounded(executorRoundsSeen, child, published.round);
    rememberRoleSession(child, published.agent);
    sessionStore.markChildSession(child);
    guardStore.beginDispatch(child);
    if (!sessionStore.resumeRoleSession(child, published.cap) && published.cap !== null) registerRoleCap(child, published.agent, published.cap);
  };
  // QA-PDF21-2-11/-20: the v2 adapter's executor bookkeeping reaches the guard store and the read-cap state through these.
  (ctx as RouterPluginInput & { routerOnExecutorChildGuard?: (port: ExecutorChildGuardPort) => void }).routerOnExecutorChildGuard?.({
    beginResumeRound: beginExecutorResumeRound,
    applyCap: applyExecutorChildCap,
  });
  /**
   * #84 P3.3 DF2-F1: where the `task` call `callID` is verified. A routed role dispatch (`routedRoleOf`, kept until the adapter's
   * `execute.after` is done) in its `verifyRoot` — the grant's work root (a resume keeps the child's bound root, QA-P33F1-1-1), else
   * its canonical session directory (QA-P33F1-1-3); the requested cwd (`requestedVerificationCwd`: the call's `cwd`, else the
   * block's `cwd:`, the order the dispatch-time detection uses, nit 3) still wins inside it, by P2.3's rule (QA-P33F1-1-2); one
   * outside it is refused by the gate. Every other dispatch: the explicit cwd, as before (I1).
   */
  const verificationScopeOf = (callID: unknown, args: Record<string, unknown> | undefined, dod: { cwd?: string }, restoredWorkRoot?: string): VerificationScope =>
    verificationScope(requestedVerificationCwd(args?.cwd, dod.cwd), (typeof callID === "string" ? routedRoleFor(callID)?.verifyRoot : undefined) ?? restoredWorkRoot);
  /** The prompt as the orchestrator wrote it: without the router's role dispatch header (P2g.3, OD6) and its nonce line (handoff 18). */
  const withoutNonceLine = (prompt: string): string => stripDispatchHeader(prompt).replace(/\r?\n?OMR_NONCE=[A-Za-z0-9_-]+\s*$/, "");
  /**
   * The parent's `task` call of a routed role dispatch (before it runs): a resume opens a new guard round for the child (its
   * budget and `budgetExhausted` are per round), and the re-dispatch signal (P1.4, handoff 16) compares the dispatch with the
   * parent's earlier role dispatches: a failure lands on the previous attempt, addressed by its decision id.
   */
  const noteRoleDispatch = (callID: string, parentSessionID: string, args: Record<string, unknown>): void => {
    const routed = routedRoleOf(callID);
    if (routed === undefined || routed.parentSessionID !== parentSessionID) return;
    // QA-G-B-5: the attempt starts now. QA-G-A3-3: the routed tier and `budget=` guard its child — a resume's at once (its new
    // guard round takes them), a fresh child's once it binds to this call.
    const guard: RoutedGuardInput = { agent: routed.agent, tier: routed.tier, routeBudget: routed.routeBudget };
    setBounded(roleAttempts, callID, { ...guard, at: Date.now() });
    if (routed.resumeID !== null) {
      // QA-G-A3-2-2 (§2.6): a resume that names no `budget=` keeps the child's previous routed `budget=` (raise-only, applied to
      // the resume's own tier); one that names a `budget=` takes its own.
      const previous = routedGuardOf(routed.resumeID);
      const inherited = routed.routeBudget ?? (previous?.agent === routed.agent ? previous.routeBudget : null);
      setBounded(roleChildGuards, routed.resumeID, { ...guard, routeBudget: inherited });
      guardStore.beginDispatch(routed.resumeID);
    }
    // QA-P21-2-3: the dispatch's own read-only cap. A resume names its child: registered now; a fresh child when it binds.
    // QA-P21-3-1: every routed resume starts a new round of the child's read counter (the previous cap kept unless it names one),
    // so a "continue and finish" resume after a CAP stop does not inherit the exhausted counter.
    const cap = roleDispatchCap(args.prompt);
    if (routed.resumeID !== null) {
      if (!sessionStore.resumeRoleSession(routed.resumeID, cap) && cap !== null) registerRoleCap(routed.resumeID, routed.agent, cap);
    } else if (cap !== null) {
      rememberPendingRoleCap(callID, routed.agent, cap);
    }
    if (routed.decisionID === null) return; // engine static: no rows
    const current: DispatchText = {
      decisionID: routed.decisionID,
      parentSessionID,
      childSessionID: routed.resumeID,
      class: routed.class,
      role: routed.agent,
      prompt: withoutNonceLine(typeof args.prompt === "string" ? args.prompt : ""),
      tier: routed.tier,
      at: Date.now(),
      resume: routed.resumeID !== null,
    };
    const match = detectRedispatch(current, [...roleDispatchTexts.values()], roleTierOrder(cfg));
    if (match !== null && match.previous.childSessionID !== null) {
      ingest?.onSignal?.(match.previous.childSessionID, match.observation, { expectDecisionID: match.previous.decisionID });
    }
    roleDispatchTexts.delete(callID);
    roleDispatchTexts.set(callID, current);
    while (roleDispatchTexts.size > 200) roleDispatchTexts.delete(roleDispatchTexts.keys().next().value!);
  };
  /**
   * The parent's `task` call of a role child returned (P1.4, handoffs 15-17, 23): the return signal with the REAL guard state
   * (budget: the guard's enforced stop, or a `NEED MORE: budget` return the guard backs — QA-G-A3-1; `unobserved` when the guard
   * never tracked the child; authority: the child's recorded request for this call), the router-observed run signal of THIS
   * attempt (QA-G-B-5), and the dispatch text's end state for later re-dispatch checks.
   * Verdict rows stay with `onVerdict`.
   */
  const observeRoleReturn = (callID: string, args: Record<string, unknown>, output: unknown): void => {
    const { finalReturnText, childSessionID } = parseTaskResult(output);
    const spec = childSessionID ? roleOfSession(childSessionID) ?? roleSpecOf(args.subagent_type) : undefined;
    if (!childSessionID || spec === undefined) return;
    rememberRoleSession(childSessionID, spec.agent);
    // QA-P21-1-3: the snapshot includes the read-only CAP state. QA-P21-3-1: a reached read cap is a budget stop only when the
    // child says so (`NEED MORE`, as the gate's claim check): a `DONE` or an unrelated `ESCALATE` at the cap is not one.
    const snapshot = roleBudgetSnapshot(childSessionID);
    const capStop = snapshot.readCapReached === true && parseReturnPrefix(finalReturnText)?.prefix === "need-more";
    // QA-G-A3-1 (I7): advisory mode (the default) never enforces a stop; a `NEED MORE: budget` return of a tracked child whose
    // budget or refusals are used up is a budget stop all the same — the gate's rule for honouring the claim (claimHonoured).
    const claimStop = budgetClaimObserved(finalReturnText, snapshot);
    // Handoff 22: the guard's stop folded with the host's own (step limit, context overflow), as the v2 adapter observed them.
    const budgetObserved = foldBudgetObservation(
      capStop || claimStop ? true : snapshot.tracked ? snapshot.stopped : "unobserved",
      hostBudgetOf?.(childSessionID, roleAgentSteps(spec)),
    );
    const request = requestedAuthority(childSessionID);
    const authorityObserved = request !== undefined && (!request.annotated || request.callID === callID);
    const signal = returnSignal({ text: finalReturnText, budgetExhausted: budgetObserved, authorityRequested: authorityObserved });
    if (signal !== null) ingest?.onSignal?.(childSessionID, signal);
    const run = runSignal({
      childSessionID,
      runs: roleRuns.get(childSessionID) ?? [],
      // QA-P21-1-7: a child that made any tool call while the router was bypassed has unrecorded edits.
      editsObserved: !roleBypassedCalls.has(childSessionID),
      edits: roleEdits.get(childSessionID) ?? [],
      acceptance: acceptanceScripts(args.prompt, args.description),
      // QA-G-B-5: only this attempt's runs count (an earlier attempt's run of the same child is that attempt's evidence). An
      // attempt this instance did not note has no known start: NaN, so it gets no run signal (I6: never unscoped evidence).
      since: roleAttempts.get(callID)?.at ?? Number.NaN,
    });
    if (run !== null) ingest?.onSignal?.(childSessionID, run);
    const sent = roleDispatchTexts.get(callID);
    if (sent !== undefined) {
      roleDispatchTexts.set(callID, {
        ...sent,
        childSessionID: sent.childSessionID ?? childSessionID,
        endedAt: Date.now(),
        returnPrefix: parseReturnPrefix(finalReturnText)?.prefix ?? null,
        returned: signal?.kind === "budget" || signal?.kind === "authority" ? signal.kind : null,
        budgetExhausted: budgetObserved,
        authorityRequested: authorityObserved,
      });
    }
  };
  /** Forget a deleted session's role state (as a child, and as the parent of role dispatches). */
  const forgetRoleSession = (sessionID: string): void => {
    roleSessions.delete(sessionID);
    roleRuns.delete(sessionID);
    roleEdits.delete(sessionID);
    roleBypassedCalls.delete(sessionID);
    roleChildGuards.delete(sessionID);
    roleBudgetPeaks.delete(sessionID);
    for (const [callID, sent] of roleDispatchTexts) if (sent.parentSessionID === sessionID) roleDispatchTexts.delete(callID);
  };
  const routerHooks: Awaited<ReturnType<Plugin>> = {
    // Warnings post to /log fire-and-forget, which loses the message when the
    // process is about to exit — `opencode run` and `opencode debug` are short
    // enough for that to be the normal case. Verified against opencode 1.18.16
    // that dispose is both called and awaited, so flushing here is enough.
    dispose: async () => {
      stopReferenceGc();
      // Phase 1.2: the turn-state providers of this instance leave the (adapter-owned) registry.
      for (const unregister of unregisterTurnStateProviders.splice(0)) unregister();
      // QA-2.1-21 (v2 only): the held gates this instance started (and their verdict posts) end before the pending registry
      // and the verification wiring go; bounded, a gate still running then ends through the disposals below.
      await waitHeldGates(HELD_GATES_DISPOSE_BOUND_MS);
      // Stop new advisor work and finish state/claim writes and lock removal before teardown.
      await advisorNotifier?.dispose();
      // 2.4.5: abort a background run and drop its queue and notices before the registry goes.
      background?.dispose();
      // 2.4.2b: evict every pending delegation; in-flight router_verify runs resolve (pending.ts R5).
      pending.dispose();
      // QA-2.1-13 (v2 only): stop re-stamping and give back every session claim this process took at adoption.
      releaseAllPendingClaims();
      // 2.2.3: settle batched testsPass requests and kill running batches (never rejects).
      await disposeVerification();
      // 2.1.3: flush and release the outcome bundle held by this instance (never rejects).
      await ingest?.dispose();
      await annotateRuntime?.dispose();
      await attemptRecorder?.dispose();
      // QA-2.1-22 (v2 only): after the last append of this instance; the last journal of the path removes this process's writer mark.
      await pendingFile?.dispose();
      await logger.flush();
    },
    tool: {
      ...(rolesAtStart && routerPlan !== undefined ? { router_plan: {
        ...routerPlan,
        execute: async (args, context) => await planActionCallerAllowed(context?.sessionID, args?.action, args?.planId)
          ? routerPlan.execute(args, context)
          : `[router_plan] ${planCallerRefusal}`,
      } } : {}),
      // QA-G-A2-2: a role session's work root must belong to the repository its dispatch listed the worktrees in (this directory's).
      ...gitTools(rolesAtStart ? {
        resolveWorkRoot: resolveWorkRootFor("router_git"), ...(ctx.directory ? { dispatchRepository: ctx.directory } : {}),
        ...(crossRepoAtStart ? { resolveRoot: resolveGitRootFor } : {}),
      } : {}),
      // #84 P2.1 (handoffs 11, 13): roles mode only. `router_run` runs in the bound work root; each run feeds the `run` signal.
      ...(rolesAtStart ? {
        router_run: routerRunTool({
          config: () => resolveRolesRouting(cfg, "v2").run,
          resolveWorkRoot: resolveWorkRootFor("router_run"),
          recordRun: (run) => pushBounded(roleRuns, run.sessionID, run),
        }),
      } : {}),
      // #84 P2.1: the authority ladder (P1.6) for dynamic roles (`general`).
      ...(rolesAtStart && dynamicRolesAtStart ? { router_request_authority: authorityTool(authorityDeps) } : {}),
      ...(enableDelegateTool ? { delegate: tool({
        description: DELEGATE_TOOL_DESCRIPTION,
        args: {
          task: tool.schema
            .string()
            .describe("The task for the subagent to perform."),
          tier: tool.schema
            .string()
            .optional()
            .describe("fast | medium | heavy. Defaults to the router default tier."),
          acceptance: tool.schema
            .string()
            .optional()
            .describe(
              "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
            ),
          cwd: tool.schema
            .string()
            .optional()
            .describe(
              "Optional working directory used to VERIFY the result: relative check paths resolve against it and the grader session runs in it. It does NOT scope the producer subagent, so the task text must still tell the producer where to work.",
            ),
        },
        async execute(
          args: {
            task: string;
            tier?: string;
            acceptance?: string;
            cwd?: string;
          },
          toolCtx?: { sessionID?: string; abort?: AbortSignal },
        ): Promise<string> {
          // Every ladder iteration creates its own producer session. Tracked out
          // here (not inside the try) so the finally below can dispose any that an
          // early return or a throw skipped — otherwise each retry leaks another.
          const producerSessions: string[] = [];
          let baselineID: string | undefined;
          /** 2.4.2c: the directives and start time of this delegation, from its first attempt. */
          let dispatchStart: DispatchStart | undefined;
          /**
           * 2.4.2c: finishDeferred clears the dispatch record (baselineID) once its reference
           * settled; clearing it in the finally below would abort a capture still in flight.
           */
          let deferredOwnsBaseline = false;
          const depth = bypassed ? undefined : await depthGuard.checkDispatch(toolCtx?.sessionID);
          if (depth?.block) {
            try {
              // Known subagents are counted by the normal after-hook: delegate
              // returns a refusal rather than throwing (unlike native task).
              if (typeof toolCtx?.sessionID === "string" && !sessionStore.isSubagent(toolCtx.sessionID)) {
                trajectoryStore.recordToolEvent(toolCtx.sessionID, { tool: "delegate", readOnly: false, blocked: true });
              }
            } catch {
              // Best-effort observation must never lose the depth refusal.
            }
            return depth.message!;
          }
          const withDepthBanner = (text: string): string => {
            if (!depth?.banner) return text;
            const trimmed = text.trimEnd();
            return trimmed ? `${trimmed}\n\n${depth.banner}` : depth.banner;
          };
          try {
            let activeCfg = cfg;
            try {
              activeCfg = loadConfig(projectDir);
              warnConfigIssues(activeCfg, logger);
            } catch {
              activeCfg = cfg;
            }
            const initialTier =
              typeof args.tier === "string" && args.tier.trim()
                ? args.tier.trim()
                : activeCfg.defaultTier || "medium";
            const dod = buildDelegationDoD({
              prompt: args.task,
              acceptance: args.acceptance,
            });
            const effectiveCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : dod.cwd;
            // Cross-repo P2b.7 (OD1=B, v2 only): `delegate` is a tier dispatch; a per-check `cwd=` is unverifiable there. On v1 nothing changes.
            const tierRefusal = ctx.routerHost === "v2" ? tierCheckCwdRefusal(dod) : undefined;

            // Phase 2.3 (D10/D11): on v2 with `variantSteps: auto` (A15: only with a `routing` block) and a catalog,
            // the ladder is session-aware: variant steps on the same model first, resume of the child session
            // under the context threshold. Anything else keeps the policy exactly as before (no variants key).
            const host = ctx.routerHost === "v2" ? "v2" : "v1";
            const variantMode = resolveVariantSteps(activeCfg, host);
            const catalog = host === "v2" && ctx.routerChildRunner && variantMode === "auto" ? await loadRunnerCatalog() : undefined;
            const policy = buildEscalatePolicy(
              activeCfg,
              catalog === undefined
                ? undefined
                : {
                    host,
                    variantSteps: variantMode,
                    maxContextFraction: resolveRouting(activeCfg, host).sessionReuse.maxContextFraction,
                    catalog,
                    warn: (message) => logger.warn(message),
                  },
            );
            const sessionAware = policy.variants != null;
            let state = newLadderState(initialTier, policy);
            const tiersForCost: any = getActiveTiers(activeCfg);
            // A17 / QA-1.5-20: the first attempt runs the start tier's base rung; every later one charges its action's rung.
            let rungCost: number | undefined = startCostRatio(policy, state);
            let plan: AttemptPlan = planFirstAttempt(activeCfg, state.currentTier);
            // Registry entry + decision row per attempt: for the ladder's own resume decision (the child's last step
            // context) and for the outcome store. Without a routing block both are off and nothing is registered.
            const recording = attemptRecorder !== undefined && (sessionAware || attemptRecorder.engineLive(activeCfg));
            const delegation: DelegationFacts | null = recording
              ? await classifyDelegation(activeCfg, host, args.task, args.acceptance, logger)
              : null;

            // Independent safety net: even a policy bug cannot loop unbounded.
            const safetyMax =
              Math.max(
                policy.maxTotalAttempts,
                policy.ladder.length * (policy.maxAttemptsPerTier + 1),
              ) + 2;
            let safety = 0;

            let producerText = "";
            let forcing: string | null = null;

            /**
             * One turn of the escalation ladder: create a producer session, run
             * the task on it, put the result through the acceptance gate, then
             * tear the session down. Returns null when the backend refused to
             * create a session, the one failure the caller cannot retry.
             *
             * Split out because the loop is about when to *stop* — safety net,
             * attempt accounting, tier advancement — and a ninety-line attempt
             * in the middle of it obscured both halves.
             */
            const runProducerAttempt = async (
              attemptPlan: AttemptPlan,
              forcingNote: string | null,
            ): Promise<{
              sessionID: string;
              text: string;
              gateRes: Awaited<ReturnType<typeof accept>>;
              /** The producer errored or timed out: its context is not trusted for a resume (D11). */
              producerFailed: boolean;
              confirmProducer?: () => void;
            } | {
              sessionID: string;
              text: string;
              /** 2.4.2c: deferred; the section 1.5-16 footer to append to the result. */
              deferredFooter: string;
            } | null> => {
              const tier = attemptPlan.tier;
              const effort = attemptPlan.effort;
              const taskText = forcingNote
                ? `${scrubText(forcingNote)}\n\n${args.task}`
                : args.task;

              let producerSid: string | undefined;
              /** The child this attempt actually runs on; a resume the host refuses starts a fresh one instead. */
              let resumeTarget: string | undefined = attemptPlan.resumeSessionID;
              let confirmProducer: (() => void) | undefined;
              const registerProducer = async (sid: string) => {
                producerSid = sid;
                if (!producerSessions.includes(sid)) producerSessions.push(sid);
                depthTracker.recordPluginChild(sid, toolCtx?.sessionID ?? null);
                if (effort !== undefined) {
                  const tierCfg = getActiveTiers(activeCfg)[tier];
                  // The D10 fallback (an invalid variant) delivers the step's effort through the override on a bare
                  // model, so the override's tier carries that effort and no variant (effortCeilingFor needs both).
                  if (tierCfg) effortOverrides.set(sid, tier, attemptPlan.fresh === "invalid-variant" ? { ...tierCfg, variant: undefined, effort } : tierCfg, effort);
                }
                // Phase 2.3: a distinct attempt in the dispatch registry (with its step label) and, when the engine is
                // live, a decision row. Register before the first step; a resume's row waits for host identity confirmation.
                if (recording && delegation !== null) {
                  confirmProducer = attemptRecorder?.record({
                    childSessionID: sid,
                    parentSessionID: toolCtx?.sessionID ?? null,
                    plan: attemptPlan,
                    config: activeCfg,
                    facts: delegation.facts,
                    acceptance: delegation.acceptance,
                    resumed: sid === resumeTarget,
                  }, ctx.routerChildRunner !== undefined && sid === resumeTarget);
                }
                // Keep the ORIGINAL dispatch reference across retries/escalations:
                // recapturing after a failed attempt would excuse its regression.
                if (!baselineID) {
                  baselineID = sid;
                  // Capture before the child gets its first prompt, on either API.
                  dispatchStart = await startDispatch(changedFileStore, baselineID, effectiveCwd, dod, args.task, false);
                }
                // Compose with Layer 1: guard the plugin-created producer session.
                try {
                  sessionStore.registerProducerSession(sid, tier, activeCfg);
                } catch {
                  // non-fatal
                }
              };
              if (!ctx.routerChildRunner) {
                const created: any = await ctx.client.session.create({
                  body: {
                    ...(toolCtx?.sessionID ? { parentID: toolCtx.sessionID } : {}),
                  },
                });
                const sid: string | undefined = created?.data?.id;
                if (!sid) return null;
                await registerProducer(sid);
              }

              const model = tierModel(activeCfg, tier) ?? undefined;
              if (sessionAware && attemptPlan.step !== "dispatch") {
                // D11: the decision and both numbers are in the decision row (engine != static). The log line is for
                // anomalies (QA-2.3-4): a fresh start nobody chose (unknown context, no budget, an invalid catalog
                // variant). The routine ones are only logged with the existing opt-in debug flag: a resume, a start over
                // the threshold, and the two conservative overrides that the shipped presets hit on every escalation
                // (`effort-path`, `bare-model-after-variant`; QA-2.3-R2-2).
                const basis = attemptPlan.resumeBasis;
                const routine =
                  resumeTarget !== undefined ||
                  basis?.reason === "at-or-over-threshold" ||
                  attemptPlan.fresh === "effort-path" ||
                  attemptPlan.fresh === "bare-model-after-variant";
                if (!routine || process.env.MODEL_ROUTER_TRAJECTORY_DEBUG === "1") {
                  logger.warn(
                    `[router] ladder ${attemptPlan.step} on ${tier}: ${resumeTarget !== undefined ? "resuming the child session" : "fresh child session"}` +
                    `${basis ? ` (${basis.reason}; tokens=${basis.tokens} budget=${basis.budget} threshold=${basis.threshold})` : ""}` +
                    `${attemptPlan.fresh ? `; runner: ${attemptPlan.fresh}` : ""}`,
                  );
                }
              }
              let producerText = "";
              // Provider-failover vs quality-escalation precedence (Phase 3.3):
              // Provider-failover is advisory only — a text chain injected into the orchestrator
              // system prompt (buildFallbackInstructions). It is orthogonal to this runtime ladder.
              // A transport/API error here becomes an explicit failed attempt and is treated as
              // exactly ONE failed attempt by the quality-escalation ladder (no provider swap, no
              // double-counted attempt). API error => (advisory) provider failover; verification
              // FAIL => (runtime) quality escalation.
              //
              // The prompt is time-boxed: a model that never answers would
              // otherwise hang the delegate forever. A timeout is folded into
              // the same failed-attempt path as any other producer error — it
              // is never an empty artefact that a lenient DoD could pass.
              let producerError: string | null = null;
              const childAbort = ctx.routerChildRunner ? new AbortController() : undefined;
              try {
                const runChild = (resume: string | undefined) => ctx.routerChildRunner!.run({
                  parentSessionID: toolCtx?.sessionID,
                  agent: attemptPlan.agent,
                  model: attemptPlan.model,
                  prompt: taskText,
                  signal: childAbort!.signal,
                  ...(resume === undefined ? {} : { resumeSessionID: resume }),
                  onCreated: registerProducer,
                  ...(resume === undefined ? {} : {
                    onConfirmed: async (sid: string) => { if (sid === producerSid) confirmProducer?.(); },
                  }),
                });
                const res: any = await withTimeout<unknown>(
                  ctx.routerChildRunner ? (async () => {
                    try {
                      return await runChild(resumeTarget);
                    } catch (error) {
                      // D11 fallback: a resume the host side refuses before anything ran (the child is gone, or is not
                      // ours) is not a failed attempt: the same attempt starts on a fresh child.
                      if (resumeTarget === undefined || !(error instanceof ResumeRejectedError)) throw error;
                      logger.warn(`[router] ladder ${attemptPlan.step} on ${tier}: ${error.message}; starting a fresh child session`);
                      const refused = resumeTarget;
                      resumeTarget = undefined;
                      await disposeChildSession(refused);
                      return await runChild(undefined);
                    }
                  })() : ctx.client.session.prompt({
                    path: { id: producerSid! },
                    body: {
                      ...(model ? { model } : {}),
                      ...(tier ? { agent: tier } : {}),
                      parts: [{ type: "text", text: taskText }],
                    },
                  }),
                  timeoutMs(
                    activeCfg.enforcement?.verify?.delegateTimeoutMs,
                    DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
                  ),
                  "delegate producer prompt",
                );
                producerText = ctx.routerChildRunner ? res.text : extractAssistantText(res);
              } catch (error) {
                producerError =
                  error instanceof Error ? error.message : String(error);
                producerText = "";
              } finally {
                childAbort?.abort();
              }
              if (!producerSid || !baselineID) return null;
              // pending.ts R11: the producer's changes landed by now.
              const returnedAt = Date.now();

              // 2.4.2c, section 1.5-16: a deferred delegation runs no gate and no ladder. A producer
              // that failed outright produced nothing to verify later; it keeps today's
              // failed-attempt path, which runs no verification process either.
              const finish = dispatchStart !== undefined && producerError === null && tierRefusal === undefined && isDeferred(dod, dispatchStart.directives) &&
                await isProvenRootCaller(toolCtx?.sessionID)
                ? await finishDeferred(changedFileStore, {
                    dispatchID: baselineID,
                    orchestratorSessionID: toolCtx?.sessionID ?? "",
                    producerSessionID: producerSid,
                    producerTier: tier,
                    description: args.task,
                    cwd: effectiveCwd,
                    dod,
                    dispatchedAt: dispatchStart.dispatchedAt,
                    // Handoff 24, R7 (I1/I8 exemption: the I7 budget-incomplete rule): router_verify judges the budget at return.
                    budget: captureBudget(producerSid, sessionStore.readCapReached(producerSid)),
                    // Cross-repo P2e.6 (OD-P2e-2): the full scope on v2; a delegate dispatch has no per-check placements.
                    ...(fullScopeOf(activeCfg) ? { fullScope: true } : {}),
                  })
                : undefined;
              // QA-2.4-4 / QA-2.4-10: a finish that did not defer falls through to the required gate
              // (and its ladder) below, with the dispatch record still in the store.
              if (finish?.deferred === true) {
                deferredOwnsBaseline = true;
                if (producerSid !== baselineID) changedFileStore.clear(producerSid);
                try {
                  sessionStore.unregister(producerSid);
                  sessionRootMemo.delete(producerSid);
                } catch {
                  // non-fatal
                }
                try {
                  guardStore.clear(producerSid);
                } catch {
                  // non-fatal
                }
                effortOverrides.clear(producerSid);
                await disposeChildSession(producerSid);
                return { sessionID: producerSid, text: producerText, deferredFooter: finish.footer };
              }
              // B2: the finish saw the tree switch branch; the gate's own read below may not (it can fail), so the finish's
              // reason is carried into the artefact.
              const deferredSwitch = finish !== undefined && !finish.deferred && finish.reason === "branch-switched" ? finish.detail : undefined;
              // Once a delegation is gated, every later attempt of its ladder is gated too.
              if (finish !== undefined && dispatchStart !== undefined) {
                dispatchStart = { ...dispatchStart, directives: { ...dispatchStart.directives, mode: "required" } };
              }

              const { gateBudgetMs } = resolveVerifyBudget(activeCfg);
              // One deadline per gate invocation: every step inside the gate
              // is bounded by it, and it is aborted (killing any spawned
              // tree) when the gate's own withTimeout rejects. It exists
              // before prepareVerification (T2 P0, QA-2.1-4), so the grade
              // snapshot and the wait for a pending reference count against
              // gateBudgetMs too.
              const gateDeadline = createDeadline(gateBudgetMs);
              let verification;
              try {
                // Cross-repo P3a (D23 as amended, QA C1): the dispatch's own start, the `since` of W's ignored-module listing.
                verification = await prepareVerification(changedFileStore, baselineID, producerSid, effectiveCwd, gateDeadline, dispatchStart?.dispatchedAt, undefined, isV2Host ? toolCtx?.sessionID : undefined);
              } catch (error) {
                gateDeadline.dispose();
                throw error;
              }
              const artefact = {
                changedFiles: verification.changedFiles,
                changeBaseline: verification.changeBaseline,
                ...(verification.snapshot?.root !== undefined ? { changeRoot: verification.snapshot.root } : {}),
                ...((verification.branchSwitch ?? deferredSwitch) !== undefined ? { branchSwitch: verification.branchSwitch ?? deferredSwitch } : {}),
                ...(verification.unattributedWriters !== undefined && verification.unattributedWriters.length > 0
                  ? { unattributedWriters: verification.unattributedWriters } : {}),
                ...(verification.perimeter !== undefined ? { perimeter: verification.perimeter } : {}),
                finalReturnText: producerText,
                declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
                producerSessionID: producerSid,
                producerTier: tier,
              };

              // Grader sessions opened by THIS accept() call, and only those.
              const gateGraderSessions = new Set<string>();
              const completedFailures: string[] = [];
              const gateDeps = buildGateDeps(toolCtx?.sessionID, gateGraderSessions, verification, gateDeadline);
              gateDeps.deterministic.onFailure = reason => completedFailures.push(reason);
              let gateRes;
              try {
                gateRes = producerError
                  ? {
                      accepted: false,
                      verdict: {
                        pass: false,
                        method: "none" as const,
                        reasons: [`producer failed: ${producerError}`],
                      },
                      dodSource: dod.source,
                    }
                  : await withTimeout(
                      accept(
                        {
                          dod,
                          trivial: false,
                          mode: "modeA",
                          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
                          ...(tierRefusal !== undefined ? { refusedCheck: tierRefusal } : {}),
                        },
                        artefact,
                        gateDeps,
                      ),
                      // What preparation left of the gate budget (QA-2.1-4).
                      gateDeadline.remaining(),
                      "verification gate",
                    );
              } catch (error) {
                // Budget exhaustion is unavailable verification, not producer
                // failure. Abort any grader still in flight so the ceiling is a
                // real cancellation and not just a stopped wait.
                //
                // Scoped to THIS gate invocation's graders. The wiring-global
                // graderSessions set is shared by every concurrent delegation,
                // so aborting it here would kill a healthy grader belonging to
                // someone else's delegation — reachable with the shipped
                // config, where a deterministic check may run a command for up
                // to 120s against a 90s gate budget.
                gateDeadline.abort(
                  error instanceof RouterTimeoutError ? "verification gate timed out" : "verification gate failed",
                );
                if (error instanceof RouterTimeoutError) {
                  for (const gsid of gateGraderSessions) {
                    try {
                      await ctx.client.session.abort({ path: { id: gsid } });
                    } catch {
                      // best-effort: the gate result stands either way
                    }
                  }
                }
                gateRes = unverifiableGateResult(
                  error instanceof RouterTimeoutError
                    ? `verification gate timed out after ${gateBudgetMs}ms`
                    : `verification unavailable: ${scrubText(String(error))}`,
                  dod.source,
                  activeCfg.enforcement?.verify?.strictUnverifiable,
                  completedFailures,
                );
              } finally {
                gateDeadline.dispose();
              }
              // pending.ts R11, as on the native path. Within this ladder every attempt is judged
              // against the first attempt's reference and dispatchedAt precedes every landedAt, so
              // it only affects later delegations of the same session (a native re-dispatch of
              // rejected delegate work is the T11 case too).
              gateRes = applyLineage(gateRes, {
                orchestratorSessionID: toolCtx?.sessionID ?? "",
                root: verification.snapshot?.root,
                dispatchID: baselineID,
                dispatchedAt: dispatchStart?.dispatchedAt ?? returnedAt,
                returnedAt,
                strictUnverifiable: activeCfg.enforcement?.verify?.strictUnverifiable,
              });
              // QA-3.1-2 / QA-3.1-3: concurrent delegations in this tree; a tool that discarded the baseline.
              gateRes = applyDispatchCaveats(gateRes, verification);

              // Per-attempt cleanup (drop producer session tracking + state).
              if (producerSid !== baselineID) changedFileStore.clear(producerSid);
              try {
                sessionStore.unregister(producerSid);
                sessionRootMemo.delete(producerSid);
              } catch {
                // non-fatal
              }
              try {
                guardStore.clear(producerSid);
              } catch {
                // non-fatal
              }
              // Dispose this attempt's backend session before the next iteration
              // so a long ladder never accumulates live sessions.
              effortOverrides.clear(producerSid);
              // A session-aware ladder (2.3) may resume this child on the next attempt, so its disposal is the loop's
              // decision, taken once the ladder has said retry/escalate and whether it resumes; every exit path is
              // still covered by the `finally` below. Without a session-aware policy: as before.
              if (!sessionAware) await disposeChildSession(producerSid);

              return { sessionID: producerSid, text: producerText, gateRes, producerFailed: producerError !== null, confirmProducer };
            };

            while (true) {
              if (safety++ > safetyMax) {
                return withDepthBanner(
                  `[router status: unmet] delegation stopped by the safety net after ` +
                  `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
                );
              }
              const tier = state.currentTier;
              const attempt = await runProducerAttempt(plan, forcing);
              if (!attempt) {
                return withDepthBanner("[router] delegate failed: could not create a producer session.");
              }
              producerText = attempt.text;
              if ("deferredFooter" in attempt) {
                // Section 1.5-16: the result unchanged plus the footer, appended last. Never
                // labelled accepted or verified, and never retried or escalated.
                return appendRouterFooter(withDepthBanner(producerText), attempt.deferredFooter);
              }
              const producerSid = attempt.sessionID;
              const gateRes = attempt.gateRes;

              // A17: charge the rung this attempt ran (a candidate's own ratio), the tier's ratio when it has none.
              const costRatio =
                rungCost ??
                (typeof tiersForCost?.[tier]?.costRatio === "number"
                  ? tiersForCost[tier].costRatio
                  : 1);
              // D11: the child and its last-step context (from the registry) decide a resume. A producer that errored
              // or timed out reports no context, so the next attempt starts fresh. The context is read only once the
              // child's execution end has been seen (QA-2.3-2): that event follows every step event on the stream, so
              // the number includes the final, largest step. The gate has usually run long enough for it to be there;
              // when it is not, wait for it, at most RESUME_END_WAIT_MS and no longer than the delegation lives, and
              // otherwise start fresh (`unknown-tokens`). Nothing is awaited when no retry can follow.
              let lastStepTokens: number | null = null;
              if (sessionAware && !attempt.producerFailed) {
                // No wait when nothing can follow this attempt (QA-2.3-R2-5): accepted, unverifiable, or the ladder's
                // own limits (checks 3 and 4 of `nextAction`) are reached after it.
                const firstCost = state.firstAttemptCost ?? costRatio;
                const limitReached =
                  state.totalAttempts + 1 >= policy.maxTotalAttempts ||
                  (policy.costMultiple != null && state.cumulativeCost + costRatio > firstCost * policy.costMultiple);
                if (!gateRes.accepted && gateRes.verdict.outcome !== "unverifiable" && !limitReached) {
                  await awaitExecutionEnd(producerSid, RESUME_END_WAIT_MS, toolCtx?.abort);
                }
                lastStepTokens = lastStepContext(producerSid);
              }
              state = recordAttempt(
                state,
                costRatio,
                sessionAware ? { sessionID: producerSid, lastStepTokens } : undefined,
              );
              // The verdict of this attempt, on the attempt's own registration (variant steps feed the store separately).
              if (recording && !gateRes.verdict.skipped) {
                // R2-2: a failed/timed-out producer may never deliver host confirmation. The ladder's
                // verdict still needs its decision row; the same callback is idempotent after host progress/result.
                attempt.confirmProducer?.();
                // #84 P3.3 fix 2 (plan §2.6, I6): a grader's verdict is a grader signal of a role dispatch, never a deterministic one.
                ingest?.onVerdict(producerSid, verdictOf(gateRes.verdict), verdictGraderOf(gateRes.verdict));
              }

              const action = nextAction(
                state,
                {
                  pass: gateRes.accepted, outcome: gateRes.verdict.outcome, reasons: gateRes.verdict.reasons,
                  // Handoff 25, R7 (I1/I8 exemption: §2.9 E8, the I7 budget-incomplete rule): the structured incomplete flag; absent
                  // when false, so the action is unchanged.
                  ...(isIncompleteVerdict(gateRes.verdict) ? { incomplete: true } : {}),
                },
                policy,
                sessionAware ? { dispatchPromptChars: args.task.length } : undefined,
              );

              if (action.action === "accept") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  true,
                  gateRes.verdict.method,
                );
                return withDepthBanner(producerText) + buildAcceptedSuffix(gateRes.verdict.method, gateRes.verdict.outcome, gateRes.verdict.caveats, gateRes.verdict.notes);
              }
              if (action.action === "give_up") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  false,
                  gateRes.verdict.method,
                );
                // Handoff 25, R7 (I1/I8 exemption: the I7 budget-incomplete rule): no flag when false, so the note is unchanged.
                const note = scrubText(buildForcingNote(gateRes.verdict.reasons, isIncompleteVerdict(gateRes.verdict) ? { incomplete: true } : undefined));
                return withDepthBanner(
                  `[router status: unmet] The delegated result was not accepted after ` +
                  `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
                  `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
                  `${scrubText(producerText)}\n\n${note}`
                );
              }
              // retry or escalate
              forcing = action.forcingMessage ?? null;
              state = advance(state, action);
              plan = planNextAttempt({ action, state, previous: plan, cfg: activeCfg, policy, catalog });
              // The rung the plan actually dispatches (QA-2.3-8: not the action's when the plan fell back to the tier's model).
              rungCost = plan.costRatio;
              // The child this attempt ran on is kept only when the next attempt resumes it (D11); otherwise it is
              // discarded now, so a long ladder never accumulates live sessions.
              if (sessionAware && plan.resumeSessionID !== producerSid) await disposeChildSession(producerSid);
            }
          } catch {
            return withDepthBanner("[router] delegate failed (fail-closed): the delegation or verification could not complete.");
          } finally {
            // Safety net for every exit path an end-of-iteration dispose cannot
            // reach: accept/give-up returns, the safety-net return, and throws.
            // disposeChildSession is fail-soft, so re-disposing an already
            // disposed session is harmless.
            for (const sid of producerSessions) {
              if (!(deferredOwnsBaseline && sid === baselineID)) changedFileStore.clear(sid);
              effortOverrides.clear(sid);
              await disposeChildSession(sid);
            }
          }
        },
      }) } : {}),
      // 2.4.3b, section 1.5-18: verify deferred delegations on the orchestrator's terms.
      ...(routerVerifyEnabled ? { router_verify: tool({
        description:
          "Verify delegations that returned 'unverified' with a vrf_ handle. Runs the same checks as a required verification (affected tests, batched, under the verification slot and one gate deadline) and returns one verdict per handle: pass, fail (with the introduced failures and a suggested next tier) or unverifiable. Nothing is retried or escalated for you. Pass exactly one of `handles` or `pending: true` (every unverified delegation of this session).",
        args: {
          handles: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("The vrf_ handles from the delegations' [router] footers."),
          pending: tool.schema
            .boolean()
            .optional()
            .describe("true: verify every still-unverified delegation of this session."),
        },
        async execute(
          args: { handles?: string[]; pending?: boolean },
          toolCtx?: { sessionID?: string; abort?: AbortSignal },
        ): Promise<string> {
          // Never throws: every failure is a text answer (the tool result reaches the orchestrator).
          try {
            const target = parseRouterVerifyArgs(args);
            if ("error" in target) return target.error;
            // R6: handles are scoped by the calling session; without one, every handle is unknown.
            const sessionID = typeof toolCtx?.sessionID === "string" ? toolCtx.sessionID : "";
            const report = await verifyHandles(sessionID, target, toolCtx?.abort !== undefined ? { signal: toolCtx.abort } : {});
            // Phase 1.2 (v2 only): the late notices this report answers stop being retained for the turn-state tail.
            lateBuffer?.release(sessionID, answeredHandles(report.items));
            return report.text;
          } catch (error) {
            logger.warn("[verify] router_verify failed", { error: scrubText(String(error)) });
            return `[router] router_verify failed; nothing was verified: ${scrubText(String(error))}`;
          }
        },
      }) } : {}),
    },

    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // IMPORTANT: must be chat.message, NOT chat.params. The opencode hook
    // order is chat.message -> system.transform -> chat.params, so populating
    // the Set in chat.params is always one step too late — system.transform
    // already ran with an empty Set and leaked the "Delegate with Task(...)"
    // instructions into the subagent's system prompt. Sonnet subagents like
    // @explore silently ignore that noise, but literal-minded Haiku (@fast)
    // emits malformed XML tool calls for the nonexistent Task tool, which
    // surface in the UI as "<parameter>...</parameter>" leakage.
    //
    // chat.message fires inside SessionPrompt.createUserMessage() BEFORE the
    // loop -> LLM.stream path, so by the time system.transform runs the Set
    // is fully populated and await-safe (yield* on the plugin trigger).
    // -----------------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.sessionID && graderSessions.has(input.sessionID)) {
          const graderTemperature = cfg.enforcement?.verify?.graderTemperature;
          if (graderTemperature === null) {
            delete output.temperature;
          } else if (graderTemperature !== undefined && input?.model?.capabilities?.temperature !== false) {
            output.temperature = graderTemperature;
          }
        }
      } catch (error) {
        if (!warnedGraderParams) {
          warnedGraderParams = true;
          try {
            logger.warn("[verify] grader temperature not applied", { error: describeError(error) });
          } catch {
            // Even a failed diagnostic sink must not interrupt chat.params.
          }
        }
      }
      try {
        if (input && typeof input === "object") {
          applyEffortOverride(effortOverrides, input, ctx.routerHost === "v2" ? output : output?.options, routerWarn);
        }
      } catch (error) {
        try {
          logger.warn("[router] effort override not applied", { error: describeError(error) });
        } catch {
          // Host accessors and diagnostic sinks are both best-effort here.
        }
      }
    },

    "chat.message": async (input: any, output: any) => {
      // Recorded even while bypassed: the grep redaction in `tool.execute.after` runs regardless of bypass (QA-81-R2-2).
      if (typeof input?.sessionID === "string" && typeof input?.agent === "string" && Object.hasOwn(cfg.agents ?? {}, input.agent)) {
        rememberPluginAgentSession(input.sessionID, input.agent);
      }
      if (bypassed) return;
      // 2.4.3 (QA-2.4-R2-1): the cost doctor's notice is NEVER part of the user's message (the prompt text stays byte for byte what the user
      // typed). It is a synthetic transcript entry, through the same host call the adapter uses for the config-reload and narration notices
      // (`ctx.session.synthetic({ …, resume: false })`, exposed as `routerSynthetic`): it enters the context of the orchestrator's next
      // request without resuming or answering anything. Delivery is not awaited (the host may be admitting this very prompt); a failure is
      // logged. A host without `routerSynthetic` (OpenCode v1 has no such call and no advisor either) gets a log line instead. Only a PROVEN
      // root session takes it (never a subagent or a grader), and only when one may be waiting.
      if (advisorNotifier !== undefined && advisorNotifier.maybePending() && typeof input?.sessionID === "string") {
        const noticeSession: string = input.sessionID;
        try {
          if (!graderSessions.has(noticeSession) && !sessionStore.isSubagent(noticeSession) && (await lookupRootSession(noticeSession)) === true) {
            const notice = await advisorNotifier.take();
            if (notice !== null) deliverAdvisorNotice(noticeSession, notice);
          }
        } catch (error) {
          logger.warn("[router] cost doctor: notice not delivered", { error: describeError(error) });
        }
      }      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig(projectDir);
        warnConfigIssues(cfg, logger);
      } catch {}
      try {
        sweepIdleStores();
      } catch {
        // best-effort maintenance: never break a real turn
      }
      const tierNames = Object.keys(getActiveTiers(cfg));
      const sid = input?.sessionID;
      // v1 `tool.execute.after` carries no agent: plugin-agent sessions are recorded at the top of this hook (QA-81-2).
      try {
        const registration = sessionStore.registerFromChatMessage(
          input,
          output,
          cfg,
          tierNames,
        );
        // A same-session same-tier re-registration is a resumed dispatch
        // (how an opencode task_id resume reaches this hook): start a new
        // per-dispatch guard round and count it in telemetry.
        if (registration.resumed === true && typeof sid === "string") {
          guardStore.beginDispatch(sid);
          trajectoryStore.recordResume(sid, input?.agent ?? null);
        }
        // KNOWN RESIDUAL: a fresh registration over an EXISTING session (same
        // sessionID, different tier) resets session cap state but leaves guard
        // state alone, so the guard keeps counting from the old dispatch. The
        // desync can only make the guard stricter, never laxer, and opencode
        // assigns one agent per subagent session — so this is documented in
        // docs/CONFIG_REFERENCE.md rather than fixed by clearing guard state,
        // which would also drop deliverable and fingerprint history.
      } catch {
        // best-effort: never crash a real session during registration
      }

      // Record-only: initialise a trajectory scorecard for tracked subagents.
      if (sid && sessionStore.isSubagent(sid)) {
        trajectoryStore.ensure(sid, input?.agent ?? null);
      }

      // Once per lifetime, warn in the plugin log when the active preset points
      // at models opencode's catalog says are missing or deprecated, or when a
      // strong-model pattern matches nothing the configured providers serve.
      // This is the whole point of the catalog: both failures are otherwise
      // silent on every subagent dispatch. Orchestrator sessions only, never
      // throws, and deferred (see startCatalogFetch): turn 1 starts the fetch,
      // a later turn reports what it found.
      if (sid && !sessionStore.isSubagent(sid)) {
        try {
          if (!catalogFetchStarted) {
            // Turn 1: kick the fetch off and move on. NO await here.
            startCatalogFetch();
          } else if (!catalogWarned && deferredCatalog !== undefined) {
            // A later turn found the turn-1 fetch already settled: report now.
            catalogWarned = true;
            const catalog = deferredCatalog;
            if (catalog) {
              // User-authored strong-model patterns matching nothing any
              // configured provider serves. Shipped defaults are never reported
              // (see findOrphanedStrongPatterns), so reaching here means the
              // user wrote a claim about this environment that is false.
              // Catalog-dependent, so it rides the same deferred path — it is
              // NOT emitted on turn 1.
              for (const p of findOrphanedStrongPatterns(cfg, catalog)) {
                logger.warn(
                  `strong-model pattern '${p}' from your modelGenerations.strong matches no model your providers serve, so it decides nothing — separator style is already ignored when matching`,
                  { pattern: p },
                );
              }
              for (const it of validateModels(cfg, catalog)) {
                const hint =
                  it.suggestions.length > 0
                    ? ` — try ${it.suggestions.join(", ")}`
                    : "";
                // Fallback issues are keyed by the chain's provider, not a tier.
                const where =
                  it.scope === "fallback"
                    ? `${it.tier}[${it.providerId}]`
                    : `@${it.tier}`;
                logger.warn(`${where} ${it.ref}: ${it.kind}${hint}`, {
                  tier: it.tier,
                  ref: it.ref,
                  kind: it.kind,
                  suggestions: it.suggestions,
                });
              }
            }
          }
        } catch {
          // best-effort: never disrupt a real session
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hard-block enforcement (Layer 1). Fires before tool execution; only
    // engaged for subagent sessions when enforcement mode is advisory/enforced.
    // Throws to abort the tool call when a guard fires; never throws for
    // non-subagent sessions or when enforcement is off (GA-1 preserved).
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      if (typeof input?.sessionID === "string") consumeExecutorChildRound(input.sessionID);
      rememberTaskArgs(input, output); // phase 2.1 (v2 only; a no-op on v1)
      // #84 P2.1: a role child's own call names its role agent (the v2 adapter passes the calling agent). Remembered even while
      // bypassed (the work-root resolver and the authority tool are authority, not routing), and marked a child session: role
      // agents are subagents, so the guard engages from their first call. Never on v1 / in tiers mode (no role table).
      if (rememberRoleSession(input?.sessionID, input?.agent)) {
        sessionStore.markChildSession(input.sessionID);
        applyPendingRoleCap(input.sessionID); // QA-P21-2-3
      }
      if (bypassed) {
        noteBypassedRoleCall(input?.sessionID); // QA-P21-1-7
        return;
      }
      if (input?.tool === "task") {
        const depth = await depthGuard.checkDispatch(input.sessionID);
        if (depth.block) {
          try {
            if (typeof input.sessionID === "string") {
              trajectoryStore.recordToolEvent(input.sessionID, {
                tool: input.tool, readOnly: READ_ONLY_TOOLS.has(input.tool), blocked: true,
              });
            }
          } catch (error) {
            logger.warn("[router] delegation depth: refusal not recorded", { error: describeError(error) });
          }
          throw new Error(depth.message);
        }
        if (depth.banner) stashDepthBanner(input, output, depth.banner);
      }
      // Observe before execution too: an in-flight edit must contaminate a
      // capture even if the test finishes before the edit's after-hook fires.
      if (typeof input?.tool === "string") changedFileStore.observeEdit(input.tool,
        typeof output?.args?.cwd === "string" ? output.args.cwd : undefined);
      if (input?.tool === "task" && typeof input.callID === "string" && typeof input.sessionID === "string") {
        const mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
        if (shouldVerifyTask("task", mode, cfg.enforcement?.verify?.require)) {
          if (output && typeof output === "object") output[TASK_VERIFICATION] = true;
          const prompt = typeof output?.args?.prompt === "string" ? output.args.prompt : undefined;
          const description = typeof output?.args?.description === "string" ? output.args.description : undefined;
          const dod = buildDelegationDoD({ prompt, description });
          // 2.4.2b: the directives come from the orchestrator's own prompt, read here before the
          // dispatch header or any repair touches it, and are kept for the after hook. The capture
          // is awaited for at most VERIFY_WAIT (section 1.5-14) and continues in the background.
          // DF2-F1 / I2 (P2.3): a role dispatch's capture is taken in its work root W (never in a refused cwd or a check
          // subdirectory); a tier dispatch has no workRoot, so this is its explicit cwd, as before.
          await startDispatch(changedFileStore, `task:${input.sessionID}:${input.callID}`,
            captureRootOf(verificationScopeOf(input.callID, output?.args, dod)),
            dod,
            dispatchDirectiveText(prompt, description),
            true);
        }
      }
      // A task call with no prompt (typically a forced delegation of a bare
      // greeting) is otherwise rejected by the harness with a terse schema
      // error. Repair it from the description, or refuse it readably. The
      // refusal is computed inside the best-effort try and thrown outside it,
      // so the catch can never swallow it.
      let promptRefusal: string | null = null;
      try {
        if (input?.tool === "task" && cfg.taskPromptRepair !== false) {
          const rawArgs: unknown = output?.args;
          if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
            const args = rawArgs as Record<string, unknown>;
            // Only an absent or blank prompt is repaired; a non-string prompt of
            // some other type is a different malformation left to the harness.
            const rawPrompt = args.prompt;
            if (rawPrompt === undefined || rawPrompt === null || (typeof rawPrompt === "string" && rawPrompt.trim() === "")) {
              const description = typeof args.description === "string" ? args.description.trim() : "";
              if (description) {
                args.prompt = description;
              } else {
                promptRefusal = "[router] This task call carried no prompt, and the task tool needs a non-empty `prompt` " +
                  "stating the work for the delegate. Re-issue the call with the work restated as an instruction in " +
                  "`prompt`. If the request carries no task at all (a greeting, an acknowledgement), do not delegate: " +
                  "answer it directly instead.";
              }
            }
          }
        }
      } catch {
        // Best-effort: malformed or frozen args must never break a dispatch.
      }
      if (promptRefusal) throw new Error(promptRefusal);
      // Dispatch hygiene is independent of subagent guard enforcement below.
      // The plugin API declares generic args, not a task-specific argument shape.
      try {
        if (input?.tool === "task" && cfg.dispatchHeader !== false) {
          const rawArgs: unknown = output?.args;
          if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
            const args = rawArgs as Record<string, unknown>;
            const tier = typeof args.subagent_type === "string"
              ? args.subagent_type : args.subagentType;
            if (
              typeof tier === "string" &&
              Object.prototype.hasOwnProperty.call(getActiveTiers(cfg), tier) &&
              typeof args.prompt === "string" &&
              !args.prompt.startsWith(DISPATCH_HEADER_PREFIX)
            ) {
              // Resolve from the original dispatch, using the registration rules.
              const parsed = parseCapDirective(args.prompt);
              const override =
                parsed === "none" && !/\breason:/i.test(args.prompt) ? null : parsed;
              const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
              const cap = override ?? baseline;
              // Handoff 30, R7 (I1/I8 exemption: T1.5.3a, the header names `root=`): on v2 shadow/advise/enforce the engine stripped the
              // route line already; its `root=` comes from the router. No root → the header is byte-identical to before.
              const root = routeLineRoot(args.prompt) ?? (typeof input.callID === "string" ? strippedRouteRoot(input.callID) : undefined);
              // Cross-repo (P1.7, v2 only): the orchestrator's working set and the read parents (a tier call has no routed role,
              // hence no location). All empty unless cross-repo is in use, so the header is then byte-identical to before.
              const crossRepo = ctx.routerHost === "v2" ? resolveRolesRouting(cfg, "v2") : undefined;
              const workingSet = ctx.routerHost === "v2" && typeof input.sessionID === "string" ? workingSetOf(input.sessionID) : [];
              const prompt = buildDispatchHeader({
                tier, cap, projectDirectory: ctx.directory, root,
                ...(workingSet.length === 0 ? {} : { workingSet }),
                ...(crossRepo === undefined || crossRepo.repoParents.length === 0 ? {} : { readParents: crossRepo.repoParents }),
              }) + DISPATCH_HEADER_SEPARATOR + args.prompt;
              args.prompt = prompt;
              if (process.env.MODEL_ROUTER_DISPATCH_DEBUG === "1" && !dispatchDebugLogged) {
                dispatchDebugLogged = true;
                const dir = join(tmpdir(), "opencode-model-router-trajectory");
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, "dispatch.log"), JSON.stringify({
                  headerApplied: true, tier, promptLength: prompt.length,
                }) + "\n", { flag: "a" });
              }
            }
          }
        }
      } catch {
        // Best-effort: malformed args or debug I/O must never break a dispatch.
      }
      // #84 P2.1: a routed role dispatch of this session (roles mode on v2 only): resume round, re-dispatch signal.
      if (input?.tool === "task" && typeof input.callID === "string" && typeof input.sessionID === "string"
        && output?.args && typeof output.args === "object") {
        try {
          noteRoleDispatch(input.callID, input.sessionID, output.args as Record<string, unknown>);
        } catch (error) {
          logger.warn("[router] roles: the role dispatch could not be noted", { error: describeError(error) });
        }
      }
      const sid = input?.sessionID;
      // F1: the unattributed-writer tally is also kept before the call runs: a call that ends in error never reaches the
      // after-hook's record(). Reached only by calls the router did not refuse (a refusal throws below, before this runs).
      const noteWriter = (): void => {
        if (typeof sid === "string" && typeof input?.tool === "string") changedFileStore.noteWriter(sid, input.tool);
      };
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        noteWriter();
        return;
      }
      // Start-of-call refresh: the idle TTL must cover the tool's runtime, not
      // just the moment it finished.
      sessionStore.touchIfTracked(sid);
      let res;
      try {
        // Handoff 27: a role child is guarded with its role profile (reader/producer, role budget); tier agents get none.
        const profile = roleGuardProfileOf(sid, input?.agent);
        res = guardBeforeCall({
          cfg,
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          cap: sessionStore.getCap(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
          ...(profile === undefined ? {} : { profile }),
        });
      } catch {
        noteWriter(); // the call proceeds
        return; // never break a real session on a guard-internal error
      }
      if (res.block) {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
          blocked: true,
          selfScript: res.guard === "anti_self_script",
        });
        throw new Error(res.message);
      }
      noteWriter();
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (typeof input?.sessionID === "string") consumeExecutorChildRound(input.sessionID);
      if (input?.tool === "grep" && typeof output.output === "string") {
        const tier = input.agent ?? pluginAgentSessions.get(input.sessionID) ?? sessionStore.getTier(input.sessionID);
        const definition = tier && getActiveTiers(cfg)[tier];
        // Every plugin agent is redacted (a denied grep produces no output anyway), readOnly or explicit-permission.
        const isPlugin = typeof tier === "string" && Object.hasOwn(cfg.agents ?? {}, tier);
        if ((definition && isReadOnlyTier(tier, definition)) || isPlugin) output.output = filterSensitiveGrep(output.output);
      }
      if (bypassed) {
        noteBypassedRoleCall(input?.sessionID); // QA-P21-1-7
        return;
      }
      sessionStore.recordToolCall(input, output);

      // #84 P2.1 (handoffs 13, 15-17, 23): role children only (roles mode on v2). Edit times feed the `run` signal; the parent's
      // `task` return feeds the return/run signals, read BEFORE any router note is put in front of the child's text.
      try {
        if (typeof input?.sessionID === "string" && ROLE_EDIT_TOOLS.has(input?.tool) && roleOfSession(input.sessionID) !== undefined) {
          pushBounded(roleEdits, input.sessionID, Date.now());
        }
        if (input?.tool === "task" && typeof input.callID === "string" && rolesNow().size > 0) {
          observeRoleReturn(input.callID, input?.args && typeof input.args === "object" ? input.args : {}, output);
        }
      } catch (error) {
        logger.warn("[router] roles: the role return could not be observed", { error: describeError(error) });
      }

      // Best-effort false-refusal observation alongside the existing guard path.
      // Keep scorecards unchanged; counts live in the TTL-managed trajectory.
      try {
        if (input?.tool === "task" && cfg.falseRefusalDetection !== false) {
          const { childSessionID, text } = parseRefusalTaskResult(output);
          if (childSessionID) {
            const calls = trajectoryStore.toolCallCount(childSessionID);
            if (detectFalseRefusal({ toolCalls: calls, resultText: text }).suspected) {
              output.output = `[router] FALSE-REFUSAL SUSPECT — this delegate returned a hand-back after 0 tool calls. No tool call was observed for this child, so the capability claim in its answer is untested rather than demonstrated. Re-dispatch the same work with task_id="${childSessionID}" and an instruction to attempt it, or do it yourself; do not escalate a tier on this result.\n\n${output.output}`;
              trajectoryStore.recordFalseRefusal(childSessionID);
              ingest?.onFalseRefusal(childSessionID);
            }
          }
        }
      } catch {
        // Best-effort: malformed/frozen results must never break a dispatch.
      }

      // Record-only trajectory observation (mutates internal maps only; never
      // touches output, so emitted banners/observations stay byte-identical).
      const sid = input?.sessionID;

      // Attribute changed files to whichever session made the edit (any session).
      if (sid && typeof input?.tool === "string") {
        changedFileStore.record(sid, input.tool, input?.args);
      }

      let unbannered: { output: unknown } | undefined;
      if (input?.tool === "task") {
        const key = `${sid}:${input.callID}`;
        const banner = depthBanners.get(key);
        depthBanners.delete(key);
        if (banner !== undefined) {
          try {
            unbannered = { output: output.output };
            const text = typeof output.output === "string" ? output.output.trimEnd() : "";
            output.output = text ? `${text}\n\n${banner}` : banner;
          } catch (error) {
            logger.warn("[router] delegation depth: advisory banner not delivered", { error: describeError(error) });
          }
        }
      }

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
        });
        try {
          const profile = roleGuardProfileOf(sid, input?.agent); // handoff 27, as in the before-hook
          guardAfterCall({
            cfg,
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
            ...(profile === undefined ? {} : { profile }),
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      // Cross-repo (P1.9): a role's read from outside its work root says where it came from. Last, after every router banner.
      try {
        const provenance = await readProvenanceLine(input);
        if (provenance !== undefined && typeof output?.output === "string") {
          output.output = `${output.output}${output.output.endsWith("\n") ? "" : "\n"}${provenance}`;
        }
      } catch {
        // best-effort: a provenance line must never break a tool result
      }

      // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
      // we observe the finished task result and append a forcing note if it is not
      // accepted; we cannot retry a task call that already finished).
      await finishDispatch(input, output, unbannered);
      // QA-SYNC1-14: a foreground finish settled here; a background call's arguments stay for its finish (child end).
      if (input?.tool === "task" && typeof input.callID === "string" && !backgroundCalls.has(input.callID)) forgetTaskArgs(input.callID);
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    //
    // Fires per completed text part. Scans for narration patterns; if any
    // match, logs a warning to the plugin console and appends a visible
    // banner to the text so the user sees the detection in the UI. This is
    // telemetry, not blocking — we cannot modify mid-stream generation, only
    // post-hoc signal.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (input: any, output: any) => {
      if (bypassed || !cfg.antiNarration) return;
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found
        .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
        .join(", ");
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Session lifecycle: classify children on session.created, then write
    // enforcement scorecards on session.idle. Full trajectory debug dumps
    // remain opt-in behind MODEL_ROUTER_TRAJECTORY_DEBUG=1 (Phase 0.3, T0.3.3).
    // Dumps go under the OS temp dir for manual inspection. Best-effort;
    // never throws into the session or emits model-visible debug output.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type === "session.deleted") {
        try {
          const id = event?.properties?.info?.id;
          if (typeof id === "string") {
            sessionRootMemo.delete(id);
            sessionLookupFailedAt.delete(id);
            pluginAgentSessions.delete(id);
            sessionStore.unregister(id);
            effortOverrides.clear(id);
            depthTracker.forget(id);
            for (const key of depthBanners.keys()) {
              if (key.startsWith(`${id}:`)) depthBanners.delete(key);
            }
            warnedNoCallID.delete(id);
            lateBuffer?.forget(id);
            forgetRoleSession(id); // #84 P2.1 (the binding and authority registries are evicted by the v2 adapter)
            forgetWorkingSet(id); // cross-repo P1.4: the orchestrator's bound repository locations
            // 2.4.2b: a deleted orchestrator's handles, tombstones and lineage records go with it.
            // 2.4.5: so do its background requests and late notices; its run in flight is aborted.
            background?.forgetSession(id);
            pending.forgetSession(id);
            // QA-2.1-13 (v2 only): its held texts go, and its adoption claim is given back.
            forgetHeldTexts(id);
            // QA-SYNC1-14: its calls' arguments and routed-role copies go too.
            forgetSessionTaskArgs(id);
            releasePendingClaimOf(id);
          }
        } catch {
          // best-effort: cleanup must never crash a real session
        }
        return;
      }
      // Child-session classification. opencode reports every child session with
      // a parentID, which is the only agent-name-INDEPENDENT signal available:
      // registerFromChatMessage recognises a session only when its agent name is
      // literally an active tier, so `general`, `explore`, markdown agents,
      // every agent mapped through `subagentTiers` (which by construction can
      // never be tier-named — see resolveSubagentOverrides) and the plugin's own
      // grader sessions all went unmarked. Unmarked meant system.transform
      // injected "You are the orchestrator, delegate with Task(...)" into a
      // subagent that has no task tool, and the subagent refused the work.
      if (event?.type === "session.created") {
        const info = event?.properties?.info;
        try {
          if (typeof info?.id === "string") {
            depthTracker.recordCreated(info.id,
              typeof info.parentID === "string" && info.parentID !== "" ? info.parentID : null);
          }
        } catch (error) {
          logger.warn("[router] delegation depth: session creation not recorded", { error: describeError(error) });
        }
        if (
          typeof info?.id === "string" &&
          typeof info?.parentID === "string" &&
          info.parentID !== ""
        ) {
          try {
            sessionStore.markChildSession(info.id);
            rememberRoleSession(info.id, info.agent); // #84 P2.1: a role child is known before its first tool call (v2 carries the agent)
          } catch {
            // best-effort: classification must never crash a real session
          }
        }
        return;
      }

      if (event?.type !== "session.idle") return;
      const sid = event?.properties?.sessionID;
      if (typeof sid !== "string") return;

      // Per-delegation scorecard: only when enforcement was active (guard state exists).
      try {
        const gstate = guardStore.get(sid);
        if (gstate) {
          const line = formatScorecard(gstate, sessionStore.getTier(sid));
          const dir = join(tmpdir(), "opencode-model-router-trajectory");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${sid}.scorecard.log`), line + "\n", { flag: "a" });
        }
      } catch {
        // best-effort: a scorecard must never crash a real session
      }

      // Opt-in full trajectory dump (unchanged gating).
      if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
      const dump = trajectoryStore.dump(sid);
      if (!dump) return;
      try {
        const dir = join(tmpdir(), "opencode-model-router-trajectory");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.log`), dump + "\n", { flag: "a" });
      } catch {
        // best-effort
      }
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      // Re-read so re-running this hook (v2 refresh) yields the current preset.
      cfg = loadConfig(projectDir);
      activeTiers = getActiveTiers(cfg);

      for (const [name, tier] of Object.entries(activeTiers)) {
        // Resolve prompt: per-tier override wins; otherwise fall back to the
        // style-appropriate default (goal-oriented or global tierPrompts[name]).
        const resolvedPrompt = tier.prompt ?? selectTierPrompt(name, tier, cfg);

        // For Claude-backed tiers, prepend an adversarial opener that revokes
        // the cached "Claude Code exploratory agent" priming for this dispatch.
        // Detection is by model string, so hybrid presets get the override
        // only on their Claude-backed tiers.
        const claudePrefix = isClaudeModel(tier.model)
          ? cfg.antiNarration
            ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
            : CLAUDE_TIER_PREFIX[name]
          : undefined;
        const styledPrompt =
          claudePrefix && resolvedPrompt
            ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}`
            : resolvedPrompt;

        // The tool-authority clause is appended HERE rather than inside each
        // tier prompt, for three reasons: one copy instead of six; the
        // style-comparison contracts in test/unit/prompt-style.test.ts compare
        // goal-oriented against prescriptive length, and adding the same
        // constant to both sides erodes a ratio it is meant to protect; and a
        // user-supplied `tier.prompt` bypasses the shipped defaults entirely,
        // so a clause living in the defaults would not protect the tiers most
        // likely to be hand-written.
        const finalPrompt = styledPrompt
          ? `${styledPrompt}\n\n${TOOL_AUTHORITY_CLAUSE}`
          : TOOL_AUTHORITY_CLAUSE;

        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description ?? `@${name} tier (${tier.model})`,
          maxSteps: tier.steps,
          steps: tier.steps,
          prompt: finalPrompt,
          color: tier.color,
        };
        if (isReadOnlyTier(name, tier)) {
          const permission = mergePermissions(readOnlyPermissions(Boolean(opencodeConfig.mcp?.context7)
            && opencodeConfig.mcp.context7.enabled !== false), opencodeConfig.agent[name]?.permission);
          agentDef.permission = permission;
          agentDef.tools = { ...legacyReadOnlyTools(permission), ...opencodeConfig.agent[name]?.tools };
        } else {
          // Opt-out removes OUR policy, not restrictions the user supplied; they are kept
          // for every non-read-only tier, not just fast (#97).
          for (const key of ["permission", "tools"]) {
            if (opencodeConfig.agent[name]?.[key] !== undefined) agentDef[key] = opencodeConfig.agent[name][key];
          }
        }

        // Apply variant (thinking/reasoning mode)
        if (tier.variant) {
          agentDef.variant = tier.variant;
        }

        // Apply provider-specific options
        const opts = buildAgentOptions(tier, name, logger);
        if (Object.keys(opts).length > 0) {
          agentDef.options = opts;
        }
        if (typeof opts.effort === "string") {
          warnAgentOptionsEffortOnce(
            "anthropic-effort-dependency",
            "effort on Anthropic models requires the opencode-anthropic-fix plugin (commit 307aea9+ for fable/mythos); non-adaptive Claude models (e.g. haiku) silently strip effort at the API layer, and without the plugin a top-level effort can break Claude-Code billing fingerprinting",
            logger,
          );
        }

        opencodeConfig.agent[name] = agentDef;
      }

      // Repoint pre-existing subagents listed in `subagentTiers` at the active
      // preset's models. Opt-in: with no map, nothing here runs and the agent
      // record is left exactly as opencode built it. Runs after tier
      // registration so the tier-name collision guard sees the real tiers.
      // Plugin agents (#81): subagents defined by the router `agents` block.
      // Model/variant/steps always follow the ACTIVE preset's tier, so this
      // re-run on /preset rebuilds them. An opencode.json `agent.<name>` entry
      // wins for the fields it sets (its permission rules go after ours).
      const context7 = Boolean(opencodeConfig.mcp?.context7) && opencodeConfig.mcp.context7.enabled !== false;
      const builtNow = new Map<string, Record<string, unknown> | undefined>();
      const pluginTiers = resolveActiveTiers(cfg);
      for (const [name, entry] of Object.entries(cfg.agents ?? {})) {
        const tier = pluginTiers[entry.tier];
        if (!tier) continue;
        const existing = opencodeConfig.agent[name];
        const seed = (opencodeConfig as Record<symbol, unknown>)[HOST_SEED_AGENTS];
        const fromHostSeed = seed instanceof Set && seed.has(name);
        if (fromHostSeed && existing?.mode !== undefined && existing.mode !== "subagent") {
          warnAgentOptionsEffortOnce(`plugin-agent-host-mode:${name}`, `agent ${name} collides with a host built-in agent whose mode is '${String(existing.mode)}'; the router \`agents\` entry is skipped`, logger);
          continue;
        }
        // A definition this hook built on a previous run is not a user entry.
        const previous = pluginAgentMarker(existing);
        const hostEntry: Record<string, unknown> | undefined = previous
          ? previous.hostEntry
          : existing !== undefined && typeof existing === "object" && existing !== null && !Array.isArray(existing)
            ? existing as Record<string, unknown>
            : undefined;
        let definition = buildPluginAgentDefinition(entry, tier, { context7, host: "v1" });
        if (hostEntry !== undefined) {
          definition = mergeHostAgentEntry(definition, hostEntry);
          warnAgentOptionsEffortOnce(
            `plugin-agent-host-entry:${name}`,
            `agent ${name} is defined both in the router \`agents\` block and in ${fromHostSeed ? "a host built-in agent" : "opencode.json"}; ${fromHostSeed ? "the host definition" : "opencode.json"} wins for the fields it sets`,
            logger,
          );
        }
        opencodeConfig.agent[name] = definition;
        builtNow.set(name, hostEntry);
      }
      // QA-81-8 invariant: after this loop every plugin agent in `opencodeConfig.agent` was built THIS run, or is the host entry
      // the router replaced (restored), or is absent. Anything built on a previous run and not rebuilt now (removed or invalid) must not linger.
      // Detection is the symbol marker OR the closure set, so a cloned config (marker lost) is covered too.
      for (const name of Object.keys(opencodeConfig.agent)) {
        if (builtNow.has(name)) continue;
        const marker = pluginAgentMarker(opencodeConfig.agent[name]);
        if (marker === undefined && !builtPluginAgents.has(name)) continue;
        const restore = marker ? marker.hostEntry : builtPluginAgents.get(name);
        if (restore !== undefined) opencodeConfig.agent[name] = restore;
        else delete opencodeConfig.agent[name];
      }
      builtPluginAgents = builtNow;

      const subagentOverrides = resolveSubagentOverrides({
        subagentTiers: cfg.subagentTiers,
        tiers: activeTiers,
        // The built-in list is the v1 host's; on v2 the setup seed already carries the real host agents.
        existingAgents: ctx.routerHost === "v2" ? opencodeConfig.agent : { ...V1_HOST_BUILTIN_AGENTS, ...opencodeConfig.agent },
        pluginAgents: cfg.agents,
        onSkip: (agentName, reason) =>
          reason === "missing" && opencodeConfig[DEFER_MISSING_SUBAGENT_NOTICE] === true
            ? undefined
            : warnAgentOptionsEffortOnce(
            `subagent-tiers:${reason}:${agentName}`,
            reason === "missing"
              ? `subagentTiers: '${agentName}' is not defined in opencode.json or the router \`agents\` block; skipped (the router never creates it)`
              : `subagentTiers: '${agentName}' is defined by the router \`agents\` block, whose tier wins; entry skipped`,
            logger,
          ),
      });
      for (const [agentName, override] of Object.entries(subagentOverrides)) {
        opencodeConfig.agent[agentName] = mergeSubagentOverride(
          opencodeConfig.agent[agentName],
          override,
        );
      }

      // Register commands
      opencodeConfig.command ??= {};
      // Remember the host command the hook sees; our v2 registration is marked so reloads are not conflicts.
      userPlanCommandDefined = opencodeConfig.command.plan !== undefined && opencodeConfig.command.plan?.[planCommandMarker] !== true;
      opencodeConfig.command["tiers"] = {
        template: "",
        description: "Show model delegation tiers and rules",
      };
      opencodeConfig.command["preset"] = {
        template: "$ARGUMENTS",
        description: "Show or switch model presets (e.g., /preset openai)",
      };
      opencodeConfig.command["budget"] = {
        template: "$ARGUMENTS",
        description:
          "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
      };
      opencodeConfig.command["bypass"] = {
        template: "$ARGUMENTS",
        description:
          "Toggle model-router bypass (disables delegation protocol for this session)",
      };
      opencodeConfig.command["annotate-plan"] = {
        template: [
          "Annotate the plan with tier directives for model delegation.",
          "",
          'Plan file: "$ARGUMENTS"',
          "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
          "",
          "## Available tiers",
          "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
          "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
          "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
          "",
          "## Annotation rules",
          "1. Place `[tier:X]` at the START of each step, before the description",
          "2. Research/exploration -> `[tier:fast]` (preferred)",
          "3. Implementation/code -> `[tier:medium]` (preferred)",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
          "",
          "## Acceptance blocks (for enforcement)",
          "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
          "[acceptance]",
          "check: <testsPass | buildPasses | lintClean | fileExists path=... | run command=\"...\" expect=...>",
          "criteria: <plain-language success condition, when no deterministic check applies>",
          "deliverable: <path or short description>",
          "[/acceptance]",
          "Prefer deterministic checks (testsPass/buildPasses/fileExists). testsPass means the tests affected by the producer's changes pass (the full suite is CI's job), so prefer it over a hand-written full-suite run command. Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
        ].join("\n"),
        description:
          "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
      opencodeConfig.command["router-reload"] = {
        template: "",
        description:
          ctx.routerHost === "v2"
            ? "Reload model-router config (tiers.json, overrides, state) without restarting"
            : "Reload model-router config (tiers.json, overrides, state); subagent models apply after an opencode restart",
      };
      opencodeConfig.command["router"] = {
        template: "$ARGUMENTS",
        description:
          "Model-router controls (e.g., /router enforce off|advisory|enforced, /router overrides, /router models)",
      };
      if (rolesAtStart && planCommand !== undefined) {
        if (userPlanCommandDefined) {
          if (!warnedPlanCommandConflict) {
            warnedPlanCommandConflict = true;
            logger.warn("[router] /plan command conflict: preserving the user-defined /plan; router_plan remains available");
          }
        } else {
          opencodeConfig.command.plan = { template: "$ARGUMENTS", description: planCommand.description, [planCommandMarker]: true };
        }
      }
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // Only inject for the primary orchestrator, NOT for subagent calls.
    // Subagents get confused by delegation instructions when they should
    // just execute a task (especially smaller models like Haiku).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      if (bypassed) return;
      try {
        cfg = loadConfig(projectDir); // Returns cache unless invalidated
        warnConfigIssues(cfg, logger);
      } catch {
        // Use last known config if file read fails
      }

      // Inject ONLY when this is provably the top-level orchestrator session.
      //
      // Fail CLOSED. The old guard was `sessionID && isSubagent(sessionID)`,
      // which injected whenever the session could not be proven to be a child.
      // Both failure directions are not equal: a missed injection costs the
      // orchestrator its routing rules, while a spurious injection tells a
      // subagent it is an orchestrator that MUST delegate with a `task` tool it
      // does not have — and a literal-minded model then refuses the dispatch
      // outright instead of doing the work.
      const sessionID = _input?.sessionID;
      if (typeof sessionID !== "string" || sessionID === "") {
        warnMissingTransformSessionOnce();
        return;
      }
      // graderSessions is checked separately from isSubagent because it is
      // populated synchronously the instant client.session.create resolves,
      // whereas the session.created event that feeds markChildSession may not
      // have arrived yet. A grader told to orchestrate stalls until its budget
      // expires.
      const isChild =
        graderSessions.has(sessionID) ||
        sessionStore.isSubagent(sessionID) ||
        !(await resolveIsRootSession(sessionID));

      if (isChild) {
        if (process.env.MODEL_ROUTER_SYSTEM_DEBUG === "1" && !systemDebugLogged) {
          systemDebugLogged = true;
          try {
            const dir = join(tmpdir(), "opencode-model-router-trajectory");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "system.log"), JSON.stringify({
              length: output.system.length,
              entries: output.system.map((entry: string) => entry.slice(0, 60)),
            }) + "\n", { flag: "a" });
          } catch {
            // Best-effort opt-in diagnostics must never break a real session.
          }
        }
        stripDelegateInstructions(output, cfg, ctx.directory);
        return;
      }

      // For Claude-backed orchestrators, prepend an adversarial opener that
      // revokes the cached "Claude Code explorer" priming for the routing
      // role. Detection is by orchestrator model, not preset.
      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;
      if (providerID !== "") lastPrimary = { providerID, modelID: modelID === "" ? null : modelID };

      let enfOn = false;
      try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
      // #84 P2.1 (T2.1.3): v2 roles mode carries the roles protocol (P2.2); "" (v1, tiers mode, no enabled role) keeps today's prompt.
      const rolesPrompt = isV2Host ? assembleRolesSystemPrompt(cfg, rolesNow(), orchestratorModel, enfOn) : "";
      let systemPrompt = rolesPrompt !== "" ? rolesPrompt : assembleSystemPrompt(cfg, orchestratorModel, enfOn, isV2Host ? "v2" : "v1");
      // A28 (D1): on v1 only, and only with an explicit `routing.roles`, the `R:` line lists those agents as destinations (prose; no model
      // override). Anything else leaves `systemPrompt` the very string it is: the v1 protocol stays byte-identical.
      // Any failure leaves the baseline prompt (QA-2.4-13): the line is an extra, never a reason to lose the protocol.
      if (ctx.routerHost !== "v2") {
        const baseline = systemPrompt;
        try {
          if (hasExplicitV1Roles(cfg, logger)) systemPrompt = applyV1Roles(baseline, cfg, v1AgentsNow(), logger);
        } catch (error) {
          systemPrompt = baseline;
          logger.warn("[router] routing.roles: the R: line could not be extended; the protocol is unchanged", { error: describeError(error) });
        }
      }
      output.system.push(systemPrompt);

      // 2.4.3: the cost doctor's throttled check. `poll` is O(1) when nothing is due and never throws. In static/shadow a notice is logged
      // from here; in advise/enforce it is delivered with the user's next turn (the `chat.message` hook below), never in the system prompt:
      // a system part that changes would cost the orchestrator its prompt cache (QA-2.4-9).
      advisorNotifier?.poll();

      if (turnState !== undefined) {
        // Phase 1.2 (v2 only): the pending list, the late notices and the route hint are rendered into the turn-state tail
        // by the context hook, never into the system array (which stays byte-identical between requests). This point is
        // reached for root sessions only (every child returned above): the flag tells the hook to build the tail.
        output[TURN_STATE_ROOT] = true;
      } else {
        // 2.4.4, section 1.5-20: this orchestrator's still-unverified delegations (at most 5 shown,
        // newest first), as one short block. Nothing is pushed when the list is empty, so the prompt
        // does not grow for sessions that never defer. Orchestrator path only: every child returned
        // above. With background mode on, an entry the queue is verifying right now is still
        // unverified to the orchestrator, so it stays listed until its run settles.
        try {
          // QA-2.4-3: plus background verdicts that did not pass, until router_verify replays them.
          const open = pending.listPending(sessionID, { verifying: background !== undefined });
          const block = buildPendingListBlock(open);
          if (block !== undefined) output.system.push(block);
        } catch (error) {
          logger.warn("[verify] pending list not injected", { error: scrubText(String(error)) });
        }
        // 2.4.5, section 1.5-19 (`background: true` only): late notices of background runs that did
        // not pass, each delivered once (takeNotices marks them delivered).
        if (background !== undefined) {
          try {
            const late = buildLateNoticeBlock(background.takeNotices(sessionID));
            if (late !== undefined) output.system.push(late);
          } catch (error) {
            logger.warn("[verify] late notices not injected", { error: scrubText(String(error)) });
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "plan") {
        if (!isV2Host) {
          // Best-effort on v1 (the command is deliberately unregistered); share the configured-key notice's process guard.
          if (!userPlanCommandDefined && warnedV2OnlyKeys.size === 0) {
            warnedV2OnlyKeys.add("routing.executor");
            logger.warn("[router] the plan executor requires OpenCode v2; ignored: /plan");
          }
          return; // No model-visible part on v1.
        }
        if (!rolesAtStart || userPlanCommandDefined) return; // Leave unregistered or user-defined /plan commands alone.
        if (planCommand !== undefined) {
          const args: string = input.arguments ?? "";
          const parsed = parsePlanCommand(args);
          const allowed = parsed.kind !== "call" || await planActionCallerAllowed(
            input.sessionID, parsed.call.action, "planId" in parsed.call ? parsed.call.planId : undefined,
          );
          const text = !allowed
            ? `[router_plan] ${planCallerRefusal}`
            : executorAccess?.runtime() === null
              ? `[router_plan] ${executorAccess.unavailable()}`
              : planCommand.execute(args);
          output.parts.push({ type: "text" as const, text });
        }
        return;
      }
      if (input.command === "tiers") {
        try {
          cfg = loadConfig(projectDir);
          warnConfigIssues(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildTiersOutput(cfg),
        });
      }

      if (input.command === "annotate-plan") {
        // 2.4.4: the template (registered in the config hook) is unchanged. With a live engine on v2 this adds ONE message part: the
        // route lines the router computed for the plan's steps (one batched classification). Everything else is as before.
        try {
          cfg = loadConfig(projectDir);
          warnConfigIssues(cfg, logger);
        } catch {}
        try {
          const runtime = annotatePlanRuntime();
          if (runtime !== undefined && ctx.routerAgents !== undefined) {
            const directives = await buildAnnotateDirectives(input.arguments ?? "", {
              cfg,
              runtime,
              listAgents: ctx.routerAgents,
              dirs: [...new Set([ctx.directory, ctx.worktree].filter((dir): dir is string => typeof dir === "string" && dir !== ""))],
              logger,
            });
            if (directives !== null) output.parts.push({ type: "text" as const, text: directives });
          }
        } catch (error) {
          // No part: the command is then exactly what it was (QA-2.4-15).
          logger.warn("[router] /annotate-plan: route lines unavailable; the plan is annotated without them", { error: describeError(error) });
        }
      }

      if (input.command === "router-reload") {
        invalidateConfigCache();
        cfg = loadConfig(projectDir);
        activeTiers = getActiveTiers(cfg);
        const mapping = Object.entries(activeTiers)
          .map(([name, tier]) => `  ${name} -> ${tier.model}`)
          .join("\n");
        const reloadError = getConfigReloadError(projectDir);
        output.parts.push({
          type: "text" as const,
          text: [
            ...(reloadError
              ? [
                  `Config reload FAILED — keeping last valid config:\n${reloadError}`,
                  "Model router is still using the last valid config.",
                ]
              : ["Model router config reloaded."]),
            `Preset: ${cfg.activePreset}`,
            `Mode: ${cfg.activeMode ?? "normal"}`,
            "Tiers:",
            mapping,
            // opencode v1 builds its agent registry once at startup; only the v2
            // adapter re-runs the config hook + agent reload after /router-reload.
            ...(ctx.routerHost === "v2"
              ? []
              : [
                  "Note: opencode v1 keeps subagent (task) models from startup; restart opencode to apply tier model changes to subagents. Routing and protocol already use the new config.",
                ]),
          ].join("\n"),
        });
      }

      if (input.command === "preset") {
        try {
          cfg = loadConfig(projectDir);
          warnConfigIssues(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildPresetOutput(cfg, input.arguments ?? "", projectDir),
        });
      }

      if (input.command === "bypass") {
        const arg = (input.arguments ?? "").trim().toLowerCase();
        if (arg === "on") {
          bypassed = true;
        } else if (arg === "off") {
          bypassed = false;
        } else {
          bypassed = !bypassed;
        }
        output.parts.push({
          type: "text" as const,
          text: buildBypassMessage(bypassed),
        });
      }

      if (input.command === "budget") {
        try {
          cfg = loadConfig(projectDir);
          warnConfigIssues(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildBudgetOutput(cfg, input.arguments ?? "", projectDir),
        });
      }

      if (input.command === "router") {
        try {
          cfg = loadConfig(projectDir);
          warnConfigIssues(cfg, logger);
        } catch {}
        const args = (input.arguments ?? "").trim();
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        let text: string;
        // Cross-repo P4.7 (SD-P4-10): `approve`, `repos`, `revoke` only on v2, in roles mode, with `routing.repoParents`, typed in a
        // top-level session; otherwise they fall through to the help below, unchanged (S5). Nothing runs in tiers mode or on v1.
        // The help lists them only where they run; `approvalsCommandsAvailable` returns before any session lookup unless v2 + roles
        // + parents hold.
        const approvalsAvailable = await approvalsCommandsAvailable(input.sessionID);
        const approvalsCmd = approvalsAvailable && APPROVAL_SUBCOMMANDS.has(sub) ? approvalsCommands : undefined;
        if (approvalsCmd !== undefined && approvalsCmd.isRouterApprovalSubcommand(sub)) {
          const routing = resolveRolesRouting(cfg, "v2");
          const result = await approvalsCmd.runRouterApprovals(sub, args.slice((parts[0] ?? "").length), {
            parents: routing.repoParents,
            exclude: routing.repoExclude,
            days: routing.repoApprovalDays,
            repoDepth: routing.repoDepth,
          });
          output.parts.push({ type: "text" as const, text: result.text });
          // SD-P4-11: the v2 command adapter reloads the role agents before it sends this text on.
          if (result.change !== undefined) approvalsCmd.markApprovalsChanged(output.parts, result.change);
          return;
        }
        if (sub === "models") {
          const catalog = await fetchCatalog();
          const orphans = catalog ? findOrphanedStrongPatterns(cfg, catalog) : [];
          text = buildModelsOutput(catalog, parts.slice(1).join(" "), orphans);
        } else if (sub === "stats" && cfg.routing !== undefined) {
          // 2.4.5 (D18): the table of `npm run routing:stats`, run by the very same driver over the configured store.
          try {
            text = formatStatsReply(await runStatsCommand(parts.slice(1).join(" "), { cfg, host: ctx.routerHost === "v2" ? "v2" : "v1", logger }));
          } catch (error) {
            logger.warn("[router] /router stats failed", { error: describeError(error) });
            text = `routing-stats: ${describeError(error)}`;
          }
        } else {
          // #84 P2.2: `/router` lists the roles in roles mode on v2 (`rolesNow()` is empty in tiers mode and on v1).
          // Match registration at start and v2.ts's executor discovery prerequisites; never advertise an unregistered command.
          const planAvailable = rolesAtStart && planCommand !== undefined && !userPlanCommandDefined && resolveRolesRouting(cfg, "v2").delegation === "roles"
            && resolveRouting(cfg, "v2").leases.mode === "enforce" && cfg.enforcement?.verify?.require !== "never"
            && !locationOutsideWorkRoots(ctx.directory, cfg.routing?.workRoots);
          text = buildRouterOutput(cfg, args, projectDir, rolesNow().size > 0 ? rolesNow().values() : undefined, approvalsAvailable, planAvailable);
          // On the bare status view, surface stale or missing models inline.
          if (sub === "") {
            text += "\n" + routerStatusLines(cfg, ctx.routerHost === "v2" ? "v2" : "v1", logger, projectDir).join("\n");
            // 2.4.5: the last dogfood checkpoint recorded next to this code (omitted when there is none). Only with a `routing` block:
            // without one `/router` is exactly what it was (QA-2.4-3, §1.2).
            const optedIn = cfg.routing !== undefined;
            const checkpoint = optedIn ? checkpointLine() : null;
            if (checkpoint !== null) text += "\n" + checkpoint;
            // One `config.providers()` call serves the model check below and the cost doctor.
            const fetched = await fetchCatalogRaw();
            const catalog = fetched?.catalog ?? null;
            if (catalog) {
              const issues = validateModels(cfg, catalog);
              if (issues.length > 0) {
                text += "\n\n" + formatModelIssues(issues);
              }
            }
            // 2.4.3: the cost doctor (v2 only, and only with a `routing` block; the advisor needs the v2 agent list and catalog).
            if (ctx.routerHost === "v2" && optedIn) {
              try {
                text += "\n\n" + (await buildCostDoctorLines(fetched)).join("\n");
              } catch (error) {
                logger.warn("[router] cost doctor failed", { error: describeError(error) });
                text += `\n\nCost doctor: unavailable (${describeError(error)}).`;
              }
            }
          }
        }
        output.parts.push({ type: "text" as const, text });
      }
    },
  };
  /**
   * What the verification of a finished `task` call ended in (phase 2.1.4.a). The foreground hook ignores it.
   */
  type FinishOutcome =
    | { kind: "none" }
    | { kind: "deferred"; handle: string }
    // QA-DF1-16: `gate` is the gate's own verdict (method, outcome, reasons, caveats, notes); a held entry settles with it,
    // QA-DF1-29: with its pass/outcome set from `verdict` (the tag the gate's decision gives; see heldSettlementOf).
    | { kind: "required"; verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; detail: string; gate: HeldSettlement }
    // QA-2.1-1: the gate was not run on purpose (a read-only delegation) or failed; neither is a verdict.
    | { kind: "skipped"; reason: string }
    | { kind: "error"; reason: string };

  /**
   * Phase 2.1.4.a: the verification of a finished `task` call, extracted unchanged from the legacy
   * `tool.execute.after`. It rewrites `output.output` (footer, forcing note, accepted suffix) exactly as before;
   * the hook calls it in the foreground, and the v2 finish API (below) calls it for background completions.
   */
  async function finishDispatch(
    input: any,
    output: any,
    unbannered: { output: unknown } | undefined,
    // QA-SYNC1-2: `workRoot`, the journaled work root of a dispatch restored after a restart (its routed-role record is gone).
    // QA-SYNC1-3: `unattributedWriters`, those a restored held entry journaled (the live tally is gone after a restart).
    extra?: {
      delta?: DispatchDelta; dod?: ReturnType<typeof buildDelegationDoD>; graderParentSessionID?: string; workRoot?: string;
      unattributedWriters?: readonly string[];
      /** QA-SYNC1-3: the journaled dispatch-time head of a restored held entry; the branch check compares it as before. */
      restoredHead?: DispatchHeadState;
      /**
       * QA-SYNC1-3: never deferred. A restored held entry was held because its verification was required at dispatch (only a
       * required verification is held); it settles in place, never re-classified under the restarted process into a deferral.
       */
      noDefer?: true;
    },
  ): Promise<FinishOutcome> {
    let outcome: FinishOutcome = { kind: "none" };
    if (typeof input?.tool === "string") {
      let mode = "off";
      try {
        mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
      } catch {
        // fall through with mode "off"
      }
      const requireMode = cfg.enforcement?.verify?.require;
      if (shouldVerifyTask(input.tool, mode, requireMode)) {
        try {
          // pending.ts R11: the producer's changes landed by now.
          const returnedAt = Date.now();
          const { finalReturnText, childSessionID } = parseTaskResult(unbannered ? { ...output, output: unbannered.output } : output);
          const producerTier =
            typeof input?.args?.subagent_type === "string"
              ? input.args.subagent_type
              : "";
          // QA-2.1-17 (v2 only): a gate re-run after a restart verifies the DoD its restored pending entry persisted.
          const dod = extra?.dod ?? buildDelegationDoD({
            prompt: input?.args?.prompt,
            description: input?.args?.description,
          });
          // DF2-F1: a role dispatch is verified in its verification root (capture, change set, checks, deferral); a requested
          // cwd outside that root is refused by the gate below, never deferred to run there later.
          const scope = verificationScopeOf(input.callID, input?.args, dod, extra?.workRoot);
          const cwdSource = requestedVerificationCwdSource(input?.args?.cwd, dod.cwd);
          const effectiveCwd = scope.cwd;
          const dispatchID = `task:${input.sessionID}:${input.callID}`;
          // #84 QA-G-B-2-1: a routed role dispatch keeps its child's verification lineage; a resume that CARRIES the acceptance of an
          // earlier attempt is gated at once (never deferred) on the child's cumulative change set (roleAttemptVerification).
          // QA-SYNC1-1: a background finish runs after the adapter forgot its record; the copy taken with the call's arguments stands in.
          const routedRole = typeof input.callID === "string" ? routedRoleFor(input.callID) : undefined;
          const carriedRole = routedRole?.carried === true && childSessionID !== null && routedRole.resumeID === childSessionID;
          // Cross-repo P2a.3 (v2 only): where each check of a routed role dispatch runs. Tier dispatches resolve nothing.
          // P2e.6: valid per-check `cwd=`/`scope=` keys may be deferred (the placements travel with the handle, and router_verify
          // runs each check where it was placed); only a refusal is verified at once, below.
          const placement = routedRole === undefined ? undefined : resolveCheckPlacements(dod, scope, { inReadSet: roleReadSetFor(routedRole) });
          // P2b.7 (OD1=B, v2 only): a tier dispatch with a per-check `cwd=` is unverifiable (the gate refuses it); it is never deferred.
          const tierRefusal = routedRole === undefined && ctx.routerHost === "v2" ? tierCheckCwdRefusal(dod) : undefined;
          // P2e.6: a refused placement or the OD1 tier refusal is certain now: verified at once, never deferred.
          const placementRefused = tierRefusal !== undefined || placement?.refused !== undefined;
          const orchestratorSessionID = typeof input.sessionID === "string" ? input.sessionID : "";
          const taskPrompt = typeof input?.args?.prompt === "string" ? input.args.prompt : undefined;
          const taskDescription = typeof input?.args?.description === "string" ? input.args.description : undefined;
          // 2.4.2b: the mode the orchestrator chose at dispatch (never the subagent's text).
          const start = takeDispatch(dispatchID, dispatchDirectiveText(taskPrompt, taskDescription));
          const trivial = childSessionID
            ? sessionStore.isTrivial(childSessionID)
            : false;
          // QA-2.4-10: `trivial` as the gate sees it below; a dispatch the gate would skip is not
          // deferred (isDeferred). QA-2.4-2: only a proven root orchestrator defers.
          // B2: the reason a deferred finish refused for a branch switch, carried into the artefact below.
          let deferredSwitch: string | undefined;
          if (extra?.noDefer !== true && !scope.outside && !carriedRole && !placementRefused && isDeferred(dod, start.directives, trivial) && await isProvenRootCaller(orchestratorSessionID)) {
            // Section 1.5-16: no gate, no test process; the result goes back now with the
            // footer, which is appended last and never says accepted or verified.
            const finish = await finishDeferred(changedFileStore, {
              dispatchID,
              orchestratorSessionID,
              producerSessionID: childSessionID ?? "",
              producerTier,
              description: taskDescription?.trim() ? taskDescription : (taskPrompt ?? ""),
              cwd: effectiveCwd,
              // I2 (P2.3): the change observation stays in W; the registration's cwd above is the check base (F5).
              ...(scope.workRoot !== undefined ? { captureRoot: captureRootOf(scope) } : {}),
              // #84 P3.3 DF2-F1 (fix-1 review nit): router_verify's gate re-checks containment in the role's work root.
              ...(scope.workRoot !== undefined ? { workRoot: scope.workRoot } : {}),
              dod,
              dispatchedAt: start.dispatchedAt,
              // Handoff 24, R7 (I1/I8 exemption: the I7 budget-incomplete rule): router_verify judges the budget at return.
              budget: captureBudget(childSessionID ?? "", childSessionID ? sessionStore.readCapReached(childSessionID) : undefined),
              // Cross-repo P2e.6: the checks' placements (registered with the handle), and the full scope on v2 (OD-P2e-2).
              ...(placement?.placements !== undefined ? { placements: placement.placements } : {}),
              ...(fullScopeOf(cfg) ? { fullScope: true } : {}),
              // Phase 2.1.4.b: the change set frozen at child end (background completions only).
              ...(extra?.delta !== undefined ? { delta: extra.delta } : {}),
            });
            if (finish.deferred) {
              output.output = appendRouterFooter(typeof output.output === "string" ? output.output : "", finish.footer);
              // The dispatch record is cleared by finishDeferred once its capture settled.
              if (childSessionID) changedFileStore.clear(childSessionID);
              outcome = { kind: "deferred", handle: finish.handle };
              return outcome;
            }
            if (finish.reason === "branch-switched") deferredSwitch = finish.detail;
            // QA-2.4-4 / QA-2.4-10: not deferred after all; today's required gate runs below.
          }
          // Same bound as the delegate gate: one deadline per invocation,
          // a withTimeout ceiling, and abort-on-reject so a hung check or
          // grader cannot hold the after-hook (and its process tree) open.
          // The deadline exists before prepareVerification (T2 P0,
          // QA-2.1-4), so preparation counts against gateBudgetMs.
          const { gateBudgetMs } = resolveVerifyBudget(cfg);
          const gateDeadline = createDeadline(gateBudgetMs);
          let verification;
          try {
            // Cross-repo P3a (D23 as amended, QA C1): the dispatch's start (takeDispatch), the `since` of W's ignored-module
            // listing. A start that was never remembered reads as now (the return), which lists nothing older: never stale inputs.
            verification = await prepareVerification(changedFileStore, dispatchID, childSessionID ?? "", captureRootOf(scope), gateDeadline, start.dispatchedAt, extra?.restoredHead, isV2Host ? orchestratorSessionID : undefined);
          } catch (error) {
            gateDeadline.dispose();
            throw error;
          }
          // QA2 F4: a switch the deferred finish saw (and this gate's own read missed) is part of this attempt before the role
          // lineage records it; its change set may hold the other branch's commits, so it is unavailable.
          if (deferredSwitch !== undefined && verification.branchSwitch === undefined) {
            verification = { ...verification, branchSwitch: deferredSwitch, changeBaseline: "unavailable" as const };
          }
          // QA-SYNC1-3: a restored held entry's journaled unattributed writers count as the lineage's own.
          const restoredWriters = extra?.unattributedWriters;
          if (restoredWriters !== undefined && restoredWriters.length > 0) {
            verification = { ...verification, unattributedWriters: [...new Set([...(verification.unattributedWriters ?? []), ...restoredWriters])].sort() };
          }
          // #84 QA-G-B-2-1: the role child's lineage — this attempt starts it (its own block) or is judged on everything the child
          // changed since the attempt that introduced the carried block, against that attempt's reference.
          if (routedRole !== undefined && childSessionID) verification = roleAttemptVerification(childSessionID, verification, { carried: carriedRole });
          // #84 P2.1: a role agent follows the return contract (handoff 26; roles mode only).
          const roleProducer = roleSpecOf(producerTier) !== undefined;
          const artefact = {
            changedFiles: verification.changedFiles,
            changeBaseline: verification.changeBaseline,
            ...(verification.snapshot?.root !== undefined ? { changeRoot: verification.snapshot.root } : {}),
            ...((verification.branchSwitch ?? deferredSwitch) !== undefined ? { branchSwitch: verification.branchSwitch ?? deferredSwitch } : {}),
            ...(verification.unattributedWriters !== undefined && verification.unattributedWriters.length > 0
              ? { unattributedWriters: verification.unattributedWriters } : {}),
            ...(verification.perimeter !== undefined ? { perimeter: verification.perimeter } : {}),
            finalReturnText,
            declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
            producerSessionID: childSessionID ?? "",
            producerTier,
            ...(roleProducer ? { returnContract: true } : {}),
            // Handoff 24, R7 (I1/I8 exemption: the I7 budget-incomplete rule; every mode): the guard's budget state when the task
            // returned, not when the gate runs. Without a stop it judges like the live read it replaces.
            budget: captureBudget(childSessionID ?? "", childSessionID ? sessionStore.readCapReached(childSessionID) : undefined),
          };

          // Read-only / research delegation: an auto-inferred, criteria-only DoD on a
          // native Task() that changed no files is exploration, not implementation.
          // There is nothing concrete to verify, so skip rather than grade the
          // findings against the task's own summary, which otherwise appends false
          // "not accepted" notes to legitimate read-only research delegations.
          // Explicit [acceptance] blocks (source != "inferred") and inferred
          // deterministic checks (dod.kind === "deterministic") still verify normally.
          if (
            dod.source === "inferred" &&
            dod.kind === "checker" &&
            artefact.changedFiles.length === 0
          ) {
            gateDeadline.dispose();
            if (childSessionID) changedFileStore.clear(childSessionID);
            changedFileStore.clear(dispatchID);
            outcome = { kind: "skipped", reason: "read-only delegation: no files changed and no explicit acceptance to verify" };
            return outcome;
          }

          const gateGraderSessions = new Set<string>();
          const completedFailures: string[] = [];
          // Keep the native grader unparented on the backend; only depth tracking uses its caller. DF-1-3 (v2 finish API only,
          // absent on the v1 after-hook): a background completion names the parent whose retained context launches the grader.
          const gateDeps = buildGateDeps(extra?.graderParentSessionID, gateGraderSessions, verification, gateDeadline, false, orchestratorSessionID || null);
          gateDeps.deterministic.onFailure = reason => completedFailures.push(reason);
          // #84 QA-G-B-2-1: a carried acceptance never passes on a testsPass/lintClean that ran no process.
          if (carriedRole) gateDeps.deterministic.noAffectedUnverifiable = CARRIED_NO_PROCESS_REASON;
          let res;
          try {
            res = await withTimeout(
              accept(
                {
                  dod,
                  trivial,
                  mode: "modeA",
                  // Native task has no cwd argument; the acceptance block can supply it.
                  ...(scope.requested ? { cwd: scope.requested } : {}),
                  ...(scope.workRoot !== undefined ? { workRoot: scope.workRoot } : {}),
                  ...(scope.refused !== undefined ? { refusedCwd: scope.refused } : {}),
                  // Fix-1 review nit: a refusal names where the cwd came from (the call's `cwd`, else the block's `cwd:`).
                  ...(scope.workRoot !== undefined && cwdSource !== undefined ? { cwdSource } : {}),
                  // Cross-repo P2b.5 (v2 only): where each check of a routed role dispatch runs, or the check the router refused.
                  ...(placement?.placements !== undefined ? { checkPlacements: placement.placements } : {}),
                  ...(placement?.refused !== undefined ? { refusedCheck: placement.refused } : tierRefusal !== undefined ? { refusedCheck: tierRefusal } : {}),
                },
                artefact,
                gateDeps,
              ),
              // What preparation left of the gate budget (QA-2.1-4).
              gateDeadline.remaining(),
              "verification gate",
            );
          } catch (error) {
            gateDeadline.abort(
              error instanceof RouterTimeoutError ? "verification gate timed out" : "verification gate failed",
            );
            if (error instanceof RouterTimeoutError) {
              for (const gsid of gateGraderSessions) {
                try {
                  await ctx.client.session.abort({ path: { id: gsid } });
                } catch {
                  // best-effort: the gate result stands either way
                }
              }
            }
            res = unverifiableGateResult(
              error instanceof RouterTimeoutError
                ? `verification gate timed out after ${gateBudgetMs}ms`
                : `verification unavailable: ${scrubText(String(error))}`,
              dod.source,
              cfg.enforcement?.verify?.strictUnverifiable,
              completedFailures,
            );
          } finally {
            gateDeadline.dispose();
          }
          // pending.ts R11: a proven-introduced rejection is recorded for this session; a pass
          // on ids an earlier rejection introduced becomes unverifiable (never a new pass/fail).
          res = applyLineage(res, {
            orchestratorSessionID,
            root: verification.snapshot?.root,
            dispatchID,
            dispatchedAt: start.dispatchedAt,
            returnedAt,
            strictUnverifiable: cfg.enforcement?.verify?.strictUnverifiable,
          });
          // QA-3.1-2 / QA-3.1-3: concurrent delegations in this tree; a tool that discarded the baseline.
          res = applyDispatchCaveats(res, verification);
          // M6 (2.1.3): a real verdict of a registered child dispatch feeds the outcome store (v2, engine != static).
          // #84 P3.3 fix 2 (plan §2.6, I6): a grader's verdict is a grader signal of a role dispatch, never a deterministic one.
          if (childSessionID && !res.verdict.skipped) ingest?.onVerdict(childSessionID, verdictOf(res.verdict), verdictGraderOf(res.verdict));
          // A gated child must not stay on medium when its return gate cannot verify it, even if accepted with a caveat.
          // Strict children and incomplete returns keep their existing behaviour and text.
          if (isV2Host && routedRole?.gated === true && childSessionID && !res.verdict.skipped &&
              res.verdict.outcome === "unverifiable" && !isIncompleteVerdict(res.verdict)) {
            roleEscalationAfterFail(cfg, childSessionID, orchestratorSessionID);
          }
          if (!res.accepted && !res.verdict.skipped) {
            const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
            const li = ladder.indexOf(producerTier);
            const nextTier = res.verdict.outcome !== "unverifiable" && li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
            // Handoff 25, R7 (I1/I8 exemption: the I7 budget-incomplete rule): absent when false, so the note is unchanged.
            const incomplete = isIncompleteVerdict(res.verdict);
            let note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier, ...(incomplete ? { incomplete: true } : {}) }));
            // P-8 (handoff 39): a role agent is resumed on a higher tier of its range, never re-run on a tier agent.
            // QA-P21-1-4: only after a FAIL (an unverifiable result keeps the generic line: there is nothing to escalate on).
            // QA-P21-2-2: the hint promises the raise, and records it for this parent's next resume of the child.
            const roleHint = roleProducer && !incomplete && res.verdict.outcome === "fail" && childSessionID
              ? roleEscalationAfterFail(cfg, childSessionID, orchestratorSessionID) : null;
            const genericNext = "NEXT: address the above and re-run the delegation; do not treat the prior result as complete.";
            if (roleHint !== null && note.endsWith(genericNext)) note = note.slice(0, note.length - genericNext.length) + scrubText(roleHint);
            output.output =
              typeof output.output === "string"
                ? output.output + "\n\n" + note
                : note;
          }
          // QA-3.1-18: a clean pass also gets a line (`[router ✓ verified: …]`); a skipped
          // check stays silent unless it carries caveats or notes.
          if (res.accepted && (!res.verdict.skipped || res.verdict.caveats?.length || res.verdict.notes?.length)) {
            output.output += buildAcceptedSuffix(res.verdict.method, res.verdict.outcome, res.verdict.caveats, res.verdict.notes);
          }
          if (childSessionID) changedFileStore.clear(childSessionID);
          changedFileStore.clear(dispatchID);
          outcome = {
            kind: "required",
            // DF-1-3: the tag follows the outcome; an accepted unverifiable result (gate.ts, not strictUnverifiable) is UNVERIFIABLE.
            verdict: res.verdict.outcome === "unverifiable" ? "UNVERIFIABLE" : res.accepted ? "PASS" : "FAIL",
            detail: res.verdict.reasons.join("; "),
            // QA-DF1-16: the gate's real verdict, so router_verify on a held handle reports what the posted text says.
            gate: { verdict: res.verdict, retryable: false },
          };
        } catch (error) {
          // fail-closed: a verification error must NEVER throw out of the after-hook. QA-2.1-1: it is logged and reported as an
          // `error` outcome, so a held dispatch posts UNVERIFIABLE with this reason instead of a PASS.
          logger.warn("[router] verification failed in the after-hook", { tool: input?.tool, error: describeError(error) });
          outcome = { kind: "error", reason: `verification unavailable: ${scrubText(String(error))}` };
        }
      }
    }
    return outcome;
  }

  /**
   * Phase 2.1.4.a (v2 only): the `task` arguments of a call in flight, kept for FinishApi.verificationFor / finish. QA-SYNC1-14:
   * forgotten when the call's finish settles (foreground, held, deferred or immediate) and with its parent session.
   */
  /**
   * QA-SYNC1-14 (test seam): `routerTaskArgsBounds` overrides the two bounds below (positive integers, `hard` ≥ `max`); anything
   * else keeps the production defaults.
   */
  const taskArgsBounds = (ctx as RouterPluginInput & { routerTaskArgsBounds?: { max?: number; hard?: number } }).routerTaskArgsBounds;
  const boundOr = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  const MAX_TASK_ARGS = boundOr(taskArgsBounds?.max, 1000);
  /** QA-SYNC1-14: the bound past which even a call with a background record is evicted (= MAX_HOLDS_GLOBAL, background.ts). */
  const MAX_TASK_ARGS_HARD = Math.max(MAX_TASK_ARGS, boundOr(taskArgsBounds?.hard, 10_000));
  const taskArgsByCall = new Map<string, Record<string, unknown>>();
  /** QA-2.1-7: the parent session of a call in flight (same keys and bound), so captureDelta finds the dispatch record. */
  const taskParentByCall = new Map<string, string>();
  /**
   * QA-SYNC1-1/-2: the routed-role record of a call in flight (same keys and bound), copied when its arguments are remembered.
   * The adapter forgets its own record once a background acknowledgement returns; the finish (child end) still needs it.
   */
  const routedRoleByCall = new Map<string, RoutedRoleSnapshot>();
  /**
   * QA-SYNC1-1: the routed-role record of `callID`: the dispatch module's while it keeps it, else the copy kept until the finish.
   * QA-SYNC1-13: after a restart, the snapshot a restored held entry journaled (finishRestored puts it in `routedRoleByCall`).
   */
  function routedRoleFor(callID: string): RoutedRoleSnapshot | undefined {
    return routedRoleOf(callID) ?? routedRoleByCall.get(callID);
  }
  /**
   * QA-SYNC1-6: finishDispatch verifies this dispatch at once, never deferred: a cwd outside the role's verification root, a refused
   * check placement, or (v2) a tier dispatch's per-check `cwd=` (OD1=B). The same rules as there; a failed read counts as at once.
   * QA-SYNC1-12: a carried resume too (finishDispatch never defers it; its resumeID is known at dispatch).
   */
  function verifiedAtOnce(callID: string, args: Record<string, unknown>, dod: ReturnType<typeof buildDelegationDoD>): boolean {
    try {
      const routed = routedRoleFor(callID);
      if (routed === undefined) return ctx.routerHost === "v2" && tierCheckCwdRefusal(dod) !== undefined;
      if (routed.carried === true) return true;
      const scope = verificationScopeOf(callID, args, dod);
      if (scope.outside) return true;
      return resolveCheckPlacements(dod, scope, { inReadSet: roleReadSetFor(routed) }).refused !== undefined;
    } catch (error) {
      logger.warn("[router] the check placements of a dispatch could not be read", { callID, error: describeError(error) });
      return true;
    }
  }
  function rememberTaskArgs(input: any, output: any): void {
    if (!isV2Host || input?.tool !== "task" || typeof input.callID !== "string") return;
    const args = output?.args;
    if (typeof args !== "object" || args === null) return;
    taskArgsByCall.set(input.callID, { ...(args as Record<string, unknown>) });
    if (typeof input.sessionID === "string") taskParentByCall.set(input.callID, input.sessionID);
    // QA-SYNC1-1: route() ran before this hook (v2 adapter), so the routed-role record is current here.
    const routed = routedRoleOf(input.callID);
    if (routed === undefined) routedRoleByCall.delete(input.callID);
    else routedRoleByCall.set(input.callID, routed);
    // QA-SYNC1-14: oldest first, but never a call that still has a held or in-flight background record (its finish needs the
    // arguments and the routed copy), nor the call just remembered; those are bounded by the background bounds instead.
    while (taskArgsByCall.size > MAX_TASK_ARGS) {
      let oldest: string | undefined;
      for (const key of taskArgsByCall.keys()) {
        if (key !== input.callID && !backgroundCalls.has(key)) { oldest = key; break; }
      }
      // A hard ceiling still holds (= MAX_HOLDS_GLOBAL): past it the oldest background call goes too, as before.
      if (oldest === undefined && taskArgsByCall.size > MAX_TASK_ARGS_HARD) {
        for (const key of taskArgsByCall.keys()) {
          if (key !== input.callID) { oldest = key; break; }
        }
        if (oldest !== undefined) backgroundCalls.delete(oldest);
      }
      if (oldest === undefined) break;
      taskArgsByCall.delete(oldest);
      taskParentByCall.delete(oldest);
      routedRoleByCall.delete(oldest);
    }
  }
  /**
   * QA-SYNC1-14: the calls with a held or in-flight background record (the adapter reserved a held slot for them, or read their
   * dispatch to journal an acknowledged background attempt); the FIFO bound above skips them. Forgotten with the call's arguments.
   */
  const backgroundCalls = new Set<string>();
  function forgetTaskArgs(callID: string): void {
    taskArgsByCall.delete(callID);
    taskParentByCall.delete(callID);
    routedRoleByCall.delete(callID);
    backgroundCalls.delete(callID);
  }
  /** QA-SYNC1-14: a deleted session's calls are never finished; their arguments and routed copies go with it. */
  function forgetSessionTaskArgs(sessionID: string): void {
    for (const [callID, parent] of [...taskParentByCall]) if (parent === sessionID) forgetTaskArgs(callID);
  }

  // ---- Phase 2.1.4.a (v2 only): the finish API ------------------------------------------------------
  /**
   * The foreground-equivalent text of a held dispatch, kept from the end of its gate until onVerdict posts it. QA-2.1-13:
   * bounded (oldest first; an evicted hold posts the generic verdict line) and forgotten with its parent session.
   * QA-DF1-16: `post` is the tag and reason the held gate posts with its text (its settled verdict keeps every reason).
   */
  type HeldPost = { readonly verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; readonly reason?: string };
  const heldTexts = new Map<string, { readonly sessionID: string; readonly text: string; readonly post?: HeldPost }>();
  /** = MAX_HOLDS_GLOBAL (background.ts): there are never more live holds than this. */
  const MAX_HELD_TEXTS = 10_000;
  // Live registrations only, never journal-restored entries. Keep bounded tombstones after pending-entry eviction so a late
  // duplicate cannot gate or post again merely because its entry was forgotten. Oldest handles leave at the same global bound.
  const registeredLiveHolds = new Set<string>();
  function rememberLiveHold(handle: string): void {
    registeredLiveHolds.add(handle);
    if (registeredLiveHolds.size > MAX_HELD_TEXTS) {
      const oldest = registeredLiveHolds.values().next();
      if (!oldest.done) registeredLiveHolds.delete(oldest.value);
    }
  }
  function rememberHeldText(handle: string, sessionID: string, text: string, post?: HeldPost): void {
    heldTexts.delete(handle);
    heldTexts.set(handle, { sessionID, text, ...(post === undefined ? {} : { post }) });
    while (heldTexts.size > MAX_HELD_TEXTS) {
      const oldest = heldTexts.keys().next();
      if (oldest.done === true) break;
      heldTexts.delete(oldest.value);
    }
  }
  function forgetHeldTexts(sessionID: string): void {
    for (const [handle, held] of heldTexts) if (held.sessionID === sessionID) heldTexts.delete(handle);
  }
  let heldSink: HeldSink | undefined;
  /**
   * QA-2.1-21: the held gates `finish` starts without awaiting them, each with its verdict post. `finishApi.idle` (the
   * adapter's settled seam) and `dispose` (bounded) wait for them.
   */
  const heldGates = new Set<Promise<void>>();
  /** QA-2.1-21: how long `dispose` waits for running held gates before the registry and the wiring go. */
  const HELD_GATES_DISPOSE_BOUND_MS = 5_000;
  function trackHeldGate(gate: Promise<unknown>): void {
    const tracked = gate.then(
      () => undefined,
      (error: unknown) => logger.warn("[router] held gate failed", { error: describeError(error) }),
    );
    heldGates.add(tracked);
    void tracked.finally(() => heldGates.delete(tracked));
  }
  /** Resolves once no held gate runs (a gate started meanwhile is waited for too). Never rejects. */
  async function heldGatesIdle(): Promise<void> {
    while (heldGates.size > 0) await Promise.allSettled([...heldGates]);
  }
  async function waitHeldGates(boundMs: number): Promise<void> {
    if (heldGates.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([heldGatesIdle(), new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** pending.onVerdict: a held entry's verdict goes to the parent through the HeldSink (v2 adapter). */
  function postHeldVerdict(entry: PendingEntry, result: SettledVerification): void {
    // QA-2.1-31: settled by `settleHeldDirect` after the adapter posted the verdict itself.
    if (directlySettled.has(entry.handle)) return;
    if (entry.hold === undefined || heldSink === undefined) return;
    // QA-DF1-16: a held gate's text posts with the tag and reason it was written for (unchanged by its full settled verdict).
    const held = heldTexts.get(entry.handle);
    const verdict = held?.post?.verdict ?? heldVerdictKind(result.verdict.outcome, result.verdict.pass);
    const reason = held?.post !== undefined ? held.post.reason : result.verdict.reasons[0];
    const text = held?.text ?? `[router] ${entry.handle}: verification ended ${verdict}${reason !== undefined ? ` — ${scrubText(reason)}` : ""}`;
    heldTexts.delete(entry.handle);
    heldSink.verdict(entry.handle, { verdict, text, ...(reason !== undefined ? { reason } : {}) }).catch((error: unknown) => {
      logger.warn("[router] held verdict not posted", { handle: entry.handle, error: describeError(error) });
    });
  }

  function heldVerdictKind(outcome: string | undefined, pass: boolean): "PASS" | "FAIL" | "UNVERIFIABLE" {
    if (outcome === "unverifiable") return "UNVERIFIABLE";
    return pass ? "PASS" : "FAIL";
  }

  /**
   * QA-2.1-1: the verdict a held dispatch posts for what its gate ended in. Only a `required` outcome carries a gate verdict;
   * every other outcome is UNVERIFIABLE with its reason, and `line` is the router line appended to the posted text.
   */
  function heldOutcomeOf(outcome: FinishOutcome): { verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; reasons: string[]; line?: string } {
    if (outcome.kind === "required") return { verdict: outcome.verdict, reasons: outcome.detail !== "" ? [outcome.detail] : [] };
    const reason =
      outcome.kind === "skipped" ? `not verified: ${outcome.reason}`
        : outcome.kind === "error" ? outcome.reason
          : outcome.kind === "deferred" ? `not verified: deferred to router_verify as ${outcome.handle}`
            : "not verified: verification is not required for this dispatch";
    const scrubbed = scrubText(reason);
    return { verdict: "UNVERIFIABLE", reasons: [scrubbed], line: `[router] UNVERIFIABLE — ${scrubbed}` };
  }

  /** The `task` result the host would have handed the hook: the child's id and its final text. */
  function taskOutputText(childSessionID: string, text: string): string {
    return `task_id: ${childSessionID} (for resuming to continue this task if needed)\n\n<task_result>\n${text}\n</task_result>`;
  }

  // ONE journal (memo §11): the same `pending.jsonl` the pending store and the held results append to. Absent on v1 (accepts and forgets).
  const processedKeys = new Set<string>();
  let dormantSessions = new Map<string, DormantSession>();
  // QA-2.1-33: registered only now that `pending` and `dormantSessions` exist: another instance's recreate may call it at any time.
  pendingFile?.setSnapshotProvider(journalSnapshot);
  const sharedJournal: InflightJournal = {
    async append(record, opts) {
      if (record.kind === "processed") {
        const key = processedKeyOf(record);
        if (key !== undefined) processedKeys.add(key);
      }
      if (pendingFile === undefined) return;
      // QA-2.1-19: the live owner claims the parent session (pid + instance token) at its first `inflight`/`hold` write, so
      // no other instance or process adopts it (and posts or wakes for a child that is still running here).
      if (record.kind === "inflight" || record.kind === "hold") {
        const parent = typeof record.parentSessionID === "string" ? record.parentSessionID : typeof record.parent === "string" ? record.parent : undefined;
        if (parent !== undefined && !claimSessionOnce(parent)) {
          logger.warn("[router] background: another live instance holds the claim of this session", { sessionID: parent });
        }
      }
      // `inflight` and `hold` records are fsync'd (memo §11.2); the rest only when the caller asks.
      const fsync = opts?.fsync === true || record.kind === "inflight" || record.kind === "hold";
      // QA-2.1-23: a vanished journal (or state directory) fails the append; it is never recreated behind the reload's back
      // (QA-2.1-16: `recreateJournal` rewrites it from the in-memory state).
      await pendingFile.append(record, fsync ? { fsync: true } : undefined);
    },
    hasProcessed: (key) => processedKeys.has(key),
  };
  /** QA-2.1-17: an UNVERIFIABLE line for a finish after a restart that has nothing to verify with. */
  const RESTART_DATA_LOST = "verification data lost in restart";
  /** QA-SYNC1-3: how long a held registration waits for the dispatch-time head read (started at dispatch, normally settled). */
  const HELD_HEAD_READ_MS = 2_000;
  /** QA-2.1-31: handles whose restored pending entry the adapter settled after posting the verdict itself (no second post). */
  const directlySettled = new Set<string>();
  type HeldClaim = Extract<ReturnType<typeof pending.markVerifying>, { kind: "claimed" }>;
  type HeldSettlement = Parameters<HeldClaim["settle"]>[0];
  type HeldScratch = { output: string; title: string; metadata: Record<string, unknown> };
  /**
   * QA-DF1-16: what a held entry settles with: a gate verdict as the gate reached it (method, reasons, caveats, notes), anything
   * else as `heldVerification`. QA-DF1-29: its `pass`/`outcome` are those of the posted tag (the gate's decision, `accepted`, which
   * a trivial skip or `strictUnverifiable` sets apart from the raw verdict), so every reader that re-derives a tag from them
   * (router_verify through `gateResult`, the restart re-post and the onVerdict fallback through `heldVerdictKind`) reads the
   * posted one. Done here, once, not by each reader: a reader cannot re-derive a trivial skip's acceptance (gate.ts accepts it
   * outside `gateResult`), and `strictUnverifiable` read after a restart need not be the value the gate decided under.
   */
  function heldSettlementOf(outcome: FinishOutcome, held: { verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; reasons: string[] }): HeldSettlement {
    if (outcome.kind !== "required") return heldVerification(held.verdict, held.reasons);
    const tag = outcome.verdict;
    return {
      ...outcome.gate,
      verdict: { ...outcome.gate.verdict, pass: tag === "PASS", outcome: tag === "PASS" ? "pass" : tag === "FAIL" ? "fail" : "unverifiable" },
    };
  }
  /**
   * A deterministic, non-retryable result for a held entry whose outcome is not a gate verdict (QA-DF1-16): the held gate's
   * none/deferred/skipped/error outcomes (verification not required, a read-only skip, a deferral, a gate failure), a restart
   * that lost the verification data (`finishRestored`), and a verdict the adapter posted itself (`settleHeldDirect`: only its
   * tag and reason cross the finish API). A gate verdict settles with the gate's own verdict (see `heldSettlementOf`).
   */
  function heldVerification(verdict: "PASS" | "FAIL" | "UNVERIFIABLE", reasons: string[]): HeldSettlement {
    return {
      verdict: {
        pass: verdict === "PASS",
        outcome: verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : "unverifiable",
        method: "deterministic",
        reasons,
        caveats: [],
      },
      retryable: false,
    };
  }
  /** QA-2.1-17: the `task` arguments a journaled dispatch stands in for after a restart. */
  function restoredTaskArgs(restored: RestoredDispatch): Record<string, unknown> {
    return {
      ...(restored.prompt === undefined ? {} : { prompt: restored.prompt }),
      ...(restored.description === undefined ? {} : { description: restored.description }),
      ...(restored.subagentType === undefined ? {} : { subagent_type: restored.subagentType }),
      ...(restored.cwd === undefined || restored.cwd === ctx.directory ? {} : { cwd: restored.cwd }),
    };
  }
  /** The verification mode of a dispatch's arguments under the current config (as `verificationFor`). */
  function verificationModeOfArgs(args: Record<string, unknown>): "none" | "required" | "deferred" {
    const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
    const description = typeof args.description === "string" ? args.description : undefined;
    let mode = "off";
    try {
      mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    } catch (error) {
      logger.warn("[router] the enforcement mode could not be read; verification off", { error: describeError(error) });
    }
    if (!shouldVerifyTask("task", mode, cfg.enforcement?.verify?.require)) return "none";
    const dod = buildDelegationDoD({ prompt, description });
    return isDeferred(dod, directivesFor(dispatchDirectiveText(prompt, description)), false) ? "deferred" : "required";
  }
  /** A held verdict posted straight through the sink (no claimable pending entry carries the hold). Never rejects. */
  function postHeldDirect(handle: string, verdict: "PASS" | "FAIL" | "UNVERIFIABLE", text: string, reason: string | undefined): Promise<void> {
    if (heldSink === undefined) return Promise.resolve();
    heldTexts.delete(handle);
    return heldSink.verdict(handle, { verdict, text, ...(reason !== undefined ? { reason } : {}) }).catch((error: unknown) => {
      logger.warn("[router] held verdict not posted", { handle, error: describeError(error) });
    });
  }
  /**
   * The held gate: the same required gate the foreground path runs. `finish` does not await it; QA-2.1-21: it is tracked
   * (with its verdict post) for `idle` and `dispose`. Its verdict is posted through pending.onVerdict, or straight through
   * the sink when no claimable entry carries the hold. `preClaim`: the entry is already claimed (a restored hold).
   */
  function runHeldGate(
    fin: FinishInput,
    handle: string,
    callInput: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
    scratch: HeldScratch,
    extra: {
      delta?: DispatchDelta; dod?: ReturnType<typeof buildDelegationDoD>; workRoot?: string; unattributedWriters?: readonly string[];
      restoredHead?: DispatchHeadState; noDefer?: true;
    } | undefined,
    preClaim: HeldClaim | undefined,
  ): void {
    const settleHeld = (outcome: FinishOutcome): Promise<void> | undefined => {
      // QA-SYNC1-14: the held finish settled; its call's arguments and routed-role copy are no longer needed.
      forgetTaskArgs(fin.callID);
      const claim = preClaim ?? pending.markVerifying(fin.parentSessionID, handle);
      // QA-2.1-1: only a gate verdict is a verdict; none/deferred/skipped/error post UNVERIFIABLE with their reason.
      const held = heldOutcomeOf(outcome);
      const text = held.line === undefined ? scratch.output : `${scratch.output.trimEnd()}\n\n${held.line}`;
      const reason = held.reasons[0];
      if (claim.kind !== "claimed") return postHeldDirect(handle, held.verdict, text, reason);
      rememberHeldText(handle, fin.parentSessionID, text, { verdict: held.verdict, ...(reason !== undefined ? { reason } : {}) });
      // QA-DF1-16: a gate verdict settles as the gate reached it (method, outcome, reasons, caveats, notes).
      observeV2(isV2Host ? ctx.routerObservations : undefined, () => ({ family: "completion-effect", effect: "verification-settle", source: "held-gate", handle,
        parentSessionID: fin.parentSessionID, callID: fin.callID, childSessionID: fin.childSessionID }));
      claim.settle(heldSettlementOf(outcome, held));
      // onVerdict posts only for an entry that carries its hold.
      return claim.entry.hold === undefined ? postHeldDirect(handle, held.verdict, text, reason) : undefined;
    };
    // DF-1-3: the held gate's grader launches from the orchestrator's retained context too (C14 launcher A).
    observeV2(isV2Host ? ctx.routerObservations : undefined, () => ({ family: "completion-effect", effect: "verification-enqueue", source: "held-gate", handle,
      parentSessionID: fin.parentSessionID, callID: fin.callID, childSessionID: fin.childSessionID }));
    trackHeldGate(finishDispatch(callInput, scratch, undefined, { ...extra, graderParentSessionID: fin.parentSessionID }).then(settleHeld, (error: unknown) => {
      logger.warn("[router] held verification failed", { handle, error: describeError(error) });
      return settleHeld({ kind: "error", reason: `verification unavailable: ${scrubText(String(error))}` });
    }));
  }
  /**
   * QA-2.1-17: a finish after a restart. A verdict reached before it (the restored entry's `state` record) is posted again,
   * never recomputed; a restored held entry re-runs the gate on its persisted DoD and changed files; anything else that
   * needs verification ends UNVERIFIABLE "verification data lost in restart" (the live change set and reference are gone).
   * Undefined: no verification applies, the plain path finishes it.
   */
  function finishRestored(fin: FinishInput, args: Record<string, unknown>, scratch: HeldScratch): FinishResult | undefined {
    const lostLine = `[router] UNVERIFIABLE — ${RESTART_DATA_LOST}`;
    const lost = (): FinishResult => ({
      outputText: `${fin.outputText}\n\n${lostLine}`, suffix: `\n\n${lostLine}`,
      verification: { kind: "required", verdict: "UNVERIFIABLE" }, metadata: {},
    });
    const handle = fin.heldHandle;
    if (handle === undefined) return verificationModeOfArgs(args) === "none" ? undefined : lost();
    const heldResult: FinishResult = { outputText: fin.outputText, suffix: "", verification: { kind: "held", handle }, metadata: {} };
    const claim = pending.markVerifying(fin.parentSessionID, handle);
    if (claim.kind === "settled") {
      const verdict = heldVerdictKind(claim.result.verdict.outcome, claim.result.verdict.pass);
      const reason = claim.result.verdict.reasons[0];
      const line = `[router] ${verdict}${reason === undefined ? "" : ` — ${scrubText(reason)}`}`;
      trackHeldGate(postHeldDirect(handle, verdict, `${scratch.output.trimEnd()}\n\n${line}`, reason));
      return heldResult;
    }
    if (claim.kind === "joined") {
      // A router_verify run of this entry is under way; its settle posts the verdict through onVerdict.
      trackHeldGate(claim.run);
      return heldResult;
    }
    // No restored entry: the child ended after the restart, so its change set was never persisted.
    if (claim.kind !== "claimed") return lost();
    const entry = claim.entry;
    const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
    const description = typeof args.description === "string" ? args.description : undefined;
    const dod = entry.dod ?? (prompt === undefined ? undefined : buildDelegationDoD({ prompt, description }));
    const settleLost = (reason: string): FinishResult => {
      const text = `${scratch.output.trimEnd()}\n\n[router] UNVERIFIABLE — ${reason}`;
      rememberHeldText(handle, fin.parentSessionID, text);
      observeV2(isV2Host ? ctx.routerObservations : undefined, () => ({ family: "completion-effect", effect: "verification-settle", source: "held-lost", handle,
        parentSessionID: fin.parentSessionID, callID: fin.callID, childSessionID: fin.childSessionID }));
      claim.settle(heldVerification("UNVERIFIABLE", [reason]));
      if (entry.hold === undefined) trackHeldGate(postHeldDirect(handle, "UNVERIFIABLE", text, reason));
      return heldResult;
    };
    if (dod === undefined || entry.changedFiles === "unavailable") return settleLost(RESTART_DATA_LOST);
    // QA-SYNC1-3: the perimeter (I4) and the dispatch-time head the gate checked before the restart are not journaled, so a
    // re-run gate would PASS with fewer checks: an entry that had a perimeter, or whose head cannot be confirmed, is UNVERIFIABLE.
    if (entry.perimeterLost === true) return settleLost(PERIMETER_LOST_REASON);
    if (entry.headLost === true) return settleLost(HEAD_LOST_REASON);
    changedFileStore.seed(fin.childSessionID, entry.changedFiles.map((file) => ({ path: file.path, status: file.status ?? "modified" })));
    const gateArgs = typeof args.cwd === "string" || entry.cwd === ctx.directory ? args : { ...args, cwd: entry.cwd };
    // QA-SYNC1-2: the journaled work root stands in for the routed-role record the restart lost.
    const workRoot = fin.restored?.workRoot;
    // QA-SYNC1-13: so does the journaled routed-role snapshot (routedRoleFor reads it until the held finish settles): the gate
    // places the checks in the role's root and applies the carried-resume and lineage rules, never the tier `cwd=` refusal.
    const routedSnapshot = fin.restored?.routed;
    if (routedSnapshot !== undefined && routedRoleFor(fin.callID) === undefined) routedRoleByCall.set(fin.callID, routedSnapshot);
    const writers = entry.unattributedWriters;
    const restoredHead = entry.dispatchHead;
    runHeldGate(fin, handle, { tool: "task", sessionID: fin.parentSessionID, callID: fin.callID, args: gateArgs }, scratch, {
      dod, ...(workRoot === undefined ? {} : { workRoot }), ...(writers === undefined ? {} : { unattributedWriters: writers }),
      ...(restoredHead === undefined ? {} : { restoredHead }),
      // QA-SYNC1-3: a held entry settles in place: without a dispatch record a re-deferral would register an unattributed
      // change set (risk high) and post "deferred" instead of the held verdict, which no live held gate does.
      noDefer: true,
    }, claim);
    return heldResult;
  }
  const finishApi: FinishApi = {
    journal: sharedJournal,
    // QA-2.1-7: the change-set store keys a dispatch by `task:<parent>:<callID>` (finishDispatch), never by the bare call id.
    // The background path passes the key (it knows the parent); the foreground path maps the parent through `taskParentByCall`.
    captureDelta: async (callID, childSessionID, dispatchID) => {
      if (dispatchID !== undefined) return changedFileStore.captureDelta(callID, childSessionID, dispatchID);
      const parent = taskParentByCall.get(callID);
      return changedFileStore.captureDelta(callID, childSessionID, parent === undefined ? undefined : `task:${parent}:${callID}`);
    },
    async reload() {
      if (pendingFile === undefined) return;
      const folded = foldDormantRecords(await pendingFile.load(), { now: Date.now(), ttlMs: pendingJournalTtlMs });
      dormantSessions = folded.sessions;
      for (const key of folded.processed) processedKeys.add(key);
    },
    adopt(sessionID): AdoptedRecords | AdoptionRefused | undefined {
      const session = dormantSessions.get(sessionID);
      if (session === undefined || pendingClaimsDir === undefined) return undefined;
      // QA-2.1-19: a session another live instance (pid, token) claimed is not adopted, and its dormant records stay: they
      // are that instance's running dispatches, or they wait for a later adoption once its claim is gone.
      // QA-2.1-34: told apart from "nothing to adopt", so the adapter tries again at a later sighting.
      if (!claimSessionOnce(sessionID)) return ADOPTION_REFUSED;
      dormantSessions.delete(sessionID);
      return { holds: session.holds, inflight: session.inflight };
    },
    verificationFor(callID) {
      const args = taskArgsByCall.get(callID);
      if (args === undefined) return undefined;
      const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
      const description = typeof args.description === "string" ? args.description : undefined;
      const dod = buildDelegationDoD({ prompt, description });
      const acceptance = {
        testsPass: dod.checks.some(c => c.kind === "testsPass"),
        buildPasses: dod.checks.some(c => c.kind === "buildPasses"),
      };
      let mode = "off";
      try {
        mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
      } catch {
        mode = "off";
      }
      if (!shouldVerifyTask("task", mode, cfg.enforcement?.verify?.require)) return { mode: "none", acceptance };
      // QA-SYNC1-6: a dispatch finishDispatch verifies at once (a refused placement or cwd, the tier per-check `cwd=` refusal)
      // is never classified deferred, so it is held like any other required verification.
      if (verifiedAtOnce(callID, args, dod)) return { mode: "required", acceptance };
      const directives = directivesFor(dispatchDirectiveText(prompt, description));
      return { mode: isDeferred(dod, directives, false) ? "deferred" : "required", acceptance };
    },
    canHold(parentSessionID) {
      return pending.hasSlot(parentSessionID);
    },
    reserveHeld(parentSessionID, callID) {
      // QA-SYNC1-14: a held call keeps its arguments and routed copy until its finish settles.
      if (taskArgsByCall.has(callID)) backgroundCalls.add(callID);
      return pending.reserveHandle(parentSessionID);
    },
    // QA-2.1-14: a held dispatch that ends without a registered entry (failed, interrupted, ack failed) frees its slot at once.
    releaseHeld(handle) {
      pending.releaseHandle(handle);
    },
    async recreateJournal(records) {
      if (pendingFile === undefined) return;
      // QA-2.1-16: every record a later restore needs: the live pending entries, the sessions not adopted yet, and the
      // adapter's live attempts and holds. `recreate` resets the vanished state once the file is back.
      // QA-2.1-33: `recreate` adds the snapshot of every other instance of this process on the same journal
      // (`journalSnapshot`, registered below), so their records survive this instance's rewrite.
      await pendingFile.recreate([...journalSnapshot(), ...records]);
    },
    setAdapterSnapshot(provider) {
      adapterSnapshot = provider;
    },
    idle: () => heldGatesIdle(),
    settleHeldDirect(parentSessionID, handle, v) {
      const claim = pending.markVerifying(parentSessionID, handle);
      if (claim.kind !== "claimed") return;
      // QA-2.1-31: the verdict already reached the parent; settling must not post it a second time (onVerdict is synchronous).
      directlySettled.add(handle);
      try {
        observeV2(isV2Host ? ctx.routerObservations : undefined, () => ({ family: "completion-effect", effect: "verification-settle", source: "held-direct", handle,
          ...completionIdentity(parentSessionID, claim.entry.dispatchID, claim.entry.producerSessionID) }));
        claim.settle(heldVerification(v.verdict, v.reason === undefined ? [] : [scrubText(v.reason)]));
      } finally {
        directlySettled.delete(handle);
      }
    },
    dispatchOf(callID) {
      const args = taskArgsByCall.get(callID);
      if (args === undefined) return undefined;
      // QA-SYNC1-14: the adapter reads the dispatch of an acknowledged background attempt; it keeps its arguments until its finish.
      backgroundCalls.add(callID);
      const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
      const prompt = text(args.prompt);
      const description = text(args.description);
      const subagentType = text(args.subagent_type);
      let workRoot: string | undefined;
      try {
        workRoot = verificationScopeOf(callID, args, buildDelegationDoD({ prompt, description })).workRoot;
      } catch (error) {
        logger.warn("[router] the work root of a dispatch could not be read", { callID, error: describeError(error) });
      }
      // QA-SYNC1-13: the routed-role facts the gate reads, journaled so a restored held gate verifies it as a role dispatch.
      const routedRole = routedRoleFor(callID);
      const routed: RoutedRoleSnapshot | undefined = routedRole === undefined ? undefined : {
        verifyRoot: routedRole.verifyRoot, parentSessionID: routedRole.parentSessionID, resumeID: routedRole.resumeID,
        ...(routedRole.carried === true ? { carried: true as const } : {}),
        ...(routedRole.gated === true ? { gated: true as const } : {}),
      };
      return {
        ...(prompt === undefined ? {} : { prompt }),
        ...(description === undefined ? {} : { description }),
        ...(subagentType === undefined ? {} : { subagentType }),
        cwd: text(args.cwd) ?? ctx.directory,
        ...(workRoot === undefined ? {} : { workRoot }),
        ...(routed === undefined ? {} : { routed }),
      };
    },
    async finish(fin: FinishInput): Promise<FinishResult> {
      // QA-2.1-17: after a restart the in-memory call arguments are gone; the journaled dispatch stands in for them.
      const args: Record<string, unknown> = taskArgsByCall.get(fin.callID) ?? (fin.restored === undefined ? {} : restoredTaskArgs(fin.restored));
      const callInput = { tool: "task", sessionID: fin.parentSessionID, callID: fin.callID, args };
      const delta = fin.delta as DispatchDelta | undefined;
      const scratch = { output: taskOutputText(fin.childSessionID, fin.outputText), title: "", metadata: { sessionId: fin.childSessionID } as Record<string, unknown> };
      const base = scratch.output.trimEnd();
      const suffixOf = (): string => (scratch.output.startsWith(base) ? scratch.output.slice(base.length) : "");
      if (fin.status !== "succeeded") {
        // QA-2.1-5: a failed, interrupted or unknown child produced no result to verify; the gate never runs on it. The
        // change-set records of the dispatch are dropped here, as finishDispatch would have.
        changedFileStore.clear(`task:${fin.parentSessionID}:${fin.callID}`);
        changedFileStore.clear(fin.childSessionID);
        forgetTaskArgs(fin.callID);
        return { outputText: fin.outputText, suffix: "", verification: { kind: "none" }, metadata: {} };
      }
      const priorHold = fin.heldHandle === undefined ? undefined : pending.get(fin.parentSessionID, fin.heldHandle);
      // A journal-restored held entry can lack its optional dispatch. It is not a live registration of this instance and
      // must settle through recovery, rather than silently joining a gate that this process never started.
      const restoredWithoutDispatch = fin.heldHandle !== undefined && !registeredLiveHolds.has(fin.heldHandle)
        && !taskArgsByCall.has(fin.callID) && priorHold?.kind === "found"
        && priorHold.entry.dispatchID === fin.callID && priorHold.entry.producerSessionID === fin.childSessionID
        && priorHold.entry.hold?.callID === fin.callID && priorHold.entry.hold.childSessionID === fin.childSessionID;
      if (fin.restored !== undefined || restoredWithoutDispatch) {
        const restored = finishRestored(fin, args, scratch);
        if (restored !== undefined) return restored;
      }
      // A repeated live completion must not re-gate an already registered hold: its first gate owns the verdict, even while
      // running. In particular, that gate may already have consumed the call's arguments and change-set records.
      const existingLiveHold = (): FinishResult | undefined => {
        if (fin.restored !== undefined || fin.heldHandle === undefined || !registeredLiveHolds.has(fin.heldHandle)) return undefined;
        return { outputText: fin.outputText, suffix: "", verification: { kind: "held", handle: fin.heldHandle }, metadata: {} };
      };
      const existing = existingLiveHold();
      if (existing !== undefined) return existing;
      // No dispatch inputs is not evidence of a read-only delegation. Never infer acceptance (or a pass) from the empty
      // fallback above when a live call's inputs were consumed or evicted. Restored calls retain their own fail-closed path.
      if (fin.restored === undefined && !taskArgsByCall.has(fin.callID) && verificationModeOfArgs(args) !== "none") {
        changedFileStore.clear(`task:${fin.parentSessionID}:${fin.callID}`);
        changedFileStore.clear(fin.childSessionID);
        const reason = "dispatch inputs were lost; acceptance and changes could not be evaluated";
        const suffix = `\n\n[router] UNVERIFIABLE — ${reason}`;
        if (fin.heldHandle !== undefined) {
          trackHeldGate(postHeldDirect(fin.heldHandle, "UNVERIFIABLE", fin.outputText + suffix, reason));
          pending.releaseHandle(fin.heldHandle);
          return { outputText: fin.outputText, suffix: "", verification: { kind: "held", handle: fin.heldHandle }, metadata: {} };
        }
        return { outputText: fin.outputText + suffix, suffix, verification: { kind: "required", verdict: "UNVERIFIABLE" }, metadata: {} };
      }
      if (fin.heldHandle !== undefined) {
        const handle = fin.heldHandle;
        const dod = buildDelegationDoD({
          prompt: typeof args.prompt === "string" ? args.prompt : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
        });
        // QA-SYNC1-3: what the held gate checks that a restart loses (the perimeter, the dispatch-time head) is journaled as a
        // fact, and the unattributed writers as they are, so a restored entry is never re-gated with fewer checks.
        const dispatchKey = `task:${fin.parentSessionID}:${fin.callID}`;
        const writers = changedFileStore.unattributedWritersOf(dispatchKey, fin.childSessionID);
        const headRead = changedFileStore.baselineHead(dispatchKey);
        const startHead = headRead === undefined ? undefined
          : await withTimeout(headRead, HELD_HEAD_READ_MS, "dispatch head").catch(() => undefined);
        // Another finish may have registered this hold while the head read yielded. Registration and gate launch below are
        // synchronous, so only the first finish after this check owns them.
        const registered = existingLiveHold();
        if (registered !== undefined) return registered;
        // The head the gate compares the tree with (as prepareVerification: the head read, else the dispatch snapshot's head and
        // branch) is journaled as plain data, so the gate re-run after a restart runs the same branch check. A head reader whose
        // read gave nothing (the gate fails closed on it too) is journaled as the fact alone (`hadHead`, restored as headLost).
        const baseline = changedFileStore.baselineSnapshot(dispatchKey);
        const dispatchHead: DispatchHeadState | undefined = startHead !== undefined && startHead !== "none"
          ? { root: startHead.root, head: startHead.head, branch: startHead.branch, ...(startHead.reflog !== undefined ? { reflog: startHead.reflog } : {}) }
          : startHead === undefined && baseline !== undefined && baseline.branch !== undefined && typeof baseline.head === "string" && baseline.head !== ""
            ? { root: baseline.root ?? baseline.cwd, head: baseline.head, branch: baseline.branch }
            : undefined;
        const heldHead = dispatchHead === undefined && startHead === undefined && headRead !== undefined;
        observeV2(isV2Host ? ctx.routerObservations : undefined, () => ({ family: "completion-effect", effect: "deferred-register", source: "held-register", handle,
          parentSessionID: fin.parentSessionID, callID: fin.callID, childSessionID: fin.childSessionID }));
        const reg = pending.register({
          orchestratorSessionID: fin.parentSessionID,
          dispatchID: fin.callID,
          producerSessionID: fin.childSessionID,
          producerTier: typeof args.subagent_type === "string" ? args.subagent_type : "",
          description: typeof args.description === "string" ? args.description : "",
          cwd: typeof args.cwd === "string" ? args.cwd : ctx.directory,
          root: undefined,
          dispatchedAt: fin.endedAt,
          dod,
          reference: Promise.resolve({ kind: "none", reason: "held dispatch: the required gate captures its own reference" }),
          changedFiles: delta === undefined || delta.files === "unavailable" ? "unavailable" : delta.files.map(f => ({ path: f.path, status: f.status })),
          risk: unattributedRisk(),
          handle,
          hold: { childSessionID: fin.childSessionID, callID: fin.callID },
          ...(writers.length > 0 ? { unattributedWriters: writers } : {}),
          ...(changedFileStore.perimeterOf(dispatchKey) !== undefined ? { heldPerimeter: true as const } : {}),
          ...(heldHead ? { heldHead: true as const } : {}),
          ...(dispatchHead !== undefined ? { dispatchHead } : {}),
        });
        if (!reg.ok) logger.warn("[router] held dispatch not registered", { code: reg.code, detail: reg.detail });
        else rememberLiveHold(handle);
        runHeldGate(fin, handle, callInput, scratch, delta === undefined ? undefined : { delta }, undefined);
        return { outputText: fin.outputText, suffix: "", verification: { kind: "held", handle }, metadata: {} };
      }
      // DF-1-3: a background completion has no tool context of the orchestrator; its grader launches from the retained context of
      // the parent (C14 launcher A), never from whatever context is current (a role child's denies `subagent`).
      const restoredWorkRoot = taskArgsByCall.has(fin.callID) ? undefined : fin.restored?.workRoot;
      const outcome = await finishDispatch(callInput, scratch, undefined, {
        ...(delta === undefined ? {} : { delta }), graderParentSessionID: fin.parentSessionID,
        ...(restoredWorkRoot === undefined ? {} : { workRoot: restoredWorkRoot }),
      });
      const suffix = suffixOf();
      const verification: FinishResult["verification"] =
        outcome.kind === "deferred" ? { kind: "deferred", handle: outcome.handle }
          : outcome.kind === "required" ? { kind: "required", verdict: outcome.verdict }
            : { kind: "none" };
      forgetTaskArgs(fin.callID);
      return { outputText: fin.outputText + suffix, suffix, verification, metadata: {} };
    },
  };
  const attachFinish: FinishAttach = ({ held, leaseGate }) => {
    heldSink = held;
    leaseGateRef = leaseGate;
    return finishApi;
  };

  if (isV2Host) {
    // Phase 1.2 (v2 only): non-enumerable, so spreading or enumerating the hooks never sees it.
    Object.defineProperty(routerHooks, ROUTER_TURN_STATE_ATTACH, { value: attachTurnState, enumerable: false });
    // Phase 2.1.4.a (v2 only): the finish API the v2 adapter attaches to; absent on v1.
    Object.defineProperty(routerHooks, ROUTER_FINISH_ATTACH, { value: attachFinish, enumerable: false });
  }
  return routerHooks;
};

export default ModelRouterPlugin;
