import type { Plugin } from "@opencode-ai/plugin";
import type { RouterPluginInput } from "./compat/child-session";
import { TASK_VERIFICATION } from "./compat/child-session";

// Imports for internal use within this module
import {
  loadConfig,
  resolvePresetName,
  writeState,
  invalidateConfigCache,
  overridePath,
  localOverridePath,
  findProjectOverride,
  resolveVerifyBudget,
  warnDeprecatedVerifyKeys,
} from "./router/config";
import type { RouterConfig, TierConfig, Preset, ModeConfig } from "./router/config";
import { buildAgentOptions, warnAgentOptionsEffortOnce } from "./router/agent-options";
import { selectTierPrompt, TOOL_AUTHORITY_CLAUSE } from "./router/prompts";
import { stripDelegateInstructions } from "./router/instructions";
import { buildDispatchHeader } from "./router/dispatch-header";
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
  DELEGATE_TOOL_DESCRIPTION,
} from "./router/protocol";
import { resolveEnforcementMode } from "./router/enforcement";
import { createPluginLogger } from "./router/logger";
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
} from "./router/sessions";
import type { Cap, SubagentState } from "./router/sessions";
import { createTrajectoryStore } from "./telemetry/trajectory";
import { createGuardStore } from "./guard/store";
import { createIdleTtlSweeper } from "./router/idle-sweep";
import { guardBeforeCall, guardAfterCall, formatScorecard } from "./guard/enforce";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { scrubText } from "./guard/scrub";
import { accept, unverifiableGateResult } from "./verify/gate";
import { applyDispatchCaveats, createVerificationWiring, dispatchDirectiveText, extractAssistantText, parseRouterVerifyArgs, type DispatchStart } from "./verify/wiring";
import { appendRouterFooter, buildLateNoticeBlock, buildPendingListBlock } from "./verify/pending";
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
import { newLadderState, recordAttempt, nextAction, advance, buildEscalatePolicy, formatLadderScorecard } from "./escalate/ladder";

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

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
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

function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
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
function buildRouterOutput(cfg: RouterConfig, args: string): string {
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
    const foundLocal = findProjectOverride();
    const localPath = foundLocal ?? localOverridePath();
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
  );
}

/** `/budget` dispatch. Persists the switch, then renders. */
function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();

  const requested = args.trim().toLowerCase();
  if (!requested) return buildBudgetList(cfg);

  const mode = modes[requested];
  if (mode) {
    saveActiveMode(requested);
    return buildBudgetSwitched(mode, requested);
  }

  return buildUnknownMode(modes, requested);
}

/** `/preset` dispatch. Persists the switch, then renders. */
function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();
  if (!requestedPreset) return buildPresetList(cfg);

  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset);
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

const SESSION_ROOT_MEMO_MAX = 500;
const SESSION_LOOKUP_RETRY_MS = 30_000;

const ModelRouterPlugin: Plugin = async (ctx: RouterPluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  // Per-plugin-instance session store: owns subagentSessionIDs and subagentCapState.
  const sessionStore = createSessionStore();
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
    // 2.2.3: the S5 batch coordinator's defensive eviction (batch.ts B11). Declared below; the
    // sweeper only runs from chat.message, long after this factory has returned.
    () => { sweepVerification(); },
    // 2.4.2b: TTL eviction and reaping of the pending registry (pending.ts R7; no timer of its own).
    () => { pending.sweep(); },
  ]);

  // Layer-2's impure corner: exec, fs, and the opencode client, built once and
  // read back through getConfig so a reloaded cfg (from /preset, /budget or
  // /router enforce) applies to graded work too.
  // Passive warnings go to opencode's log rather than stderr: console output
  // from a plugin paints over the TUI. Falls back to console when the server
  // has no /log endpoint. See src/router/logger.ts.
  const logger = createPluginLogger(ctx.client);

  const {
    graderSessions, dispatchGrader, buildGateDeps, disposeChildSession,
    prepareVerification, startReferenceGc,
    sweepVerification, disposeVerification,
    startDispatch, takeDispatch, isDeferred: wiringIsDeferred, finishDeferred, applyLineage, pending,
    verifyHandles,
    // 2.4.5: undefined unless `background: true` at plugin start (pending.ts R14).
    background,
  } = createVerificationWiring({
    client: ctx.client,
    childRunner: ctx.routerChildRunner,
    directory: ctx.directory,
    getConfig: () => cfg,
    logger,
  });
  // 2.1.5b: sweep reference dirs a crashed instance left behind. Fire-and-forget; never throws.
  // QA-2.1-11: deferred (unref'd timer), so plugin start never holds the project directory with a
  // git child; dispose cancels it.
  const stopReferenceGc = startReferenceGc();

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

  warnDeprecatedVerifyKeys(cfg, logger);

  // Fetch and normalize opencode's live provider/model catalog. Best-effort:
  // returns null when the client call fails, e.g. the server is not ready yet.
  // The pure analysis (validateModels) lives in src/router/catalog.ts.
  const fetchCatalog = async (): Promise<Catalog | null> => {
    try {
      const res: any = await ctx.client.config.providers();
      return normalizeCatalog(res?.data);
    } catch {
      return null;
    }
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

  return {
    // Warnings post to /log fire-and-forget, which loses the message when the
    // process is about to exit — `opencode run` and `opencode debug` are short
    // enough for that to be the normal case. Verified against opencode 1.18.16
    // that dispose is both called and awaited, so flushing here is enough.
    dispose: async () => {
      stopReferenceGc();
      // 2.4.5: abort a background run and drop its queue and notices before the registry goes.
      background?.dispose();
      // 2.4.2b: evict every pending delegation; in-flight router_verify runs resolve (pending.ts R5).
      pending.dispose();
      // 2.2.3: settle batched testsPass requests and kill running batches (never rejects).
      await disposeVerification();
      await logger.flush();
    },
    tool: {
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
          toolCtx?: { sessionID?: string },
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
          try {
            let activeCfg = cfg;
            try {
              activeCfg = loadConfig();
              warnDeprecatedVerifyKeys(activeCfg, logger);
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

            const policy = buildEscalatePolicy(activeCfg);
            let state = newLadderState(initialTier, policy);
            const tiersForCost: any = getActiveTiers(activeCfg);

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
              tier: string,
              forcingNote: string | null,
            ): Promise<{
              sessionID: string;
              text: string;
              gateRes: Awaited<ReturnType<typeof accept>>;
            } | {
              sessionID: string;
              text: string;
              /** 2.4.2c: deferred; the section 1.5-16 footer to append to the result. */
              deferredFooter: string;
            } | null> => {
              const taskText = forcingNote
                ? `${scrubText(forcingNote)}\n\n${args.task}`
                : args.task;

              let producerSid: string | undefined;
              const registerProducer = async (sid: string) => {
                producerSid = sid;
                producerSessions.push(sid);
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
                const res: any = await withTimeout<unknown>(
                  ctx.routerChildRunner ? ctx.routerChildRunner.run({
                    parentSessionID: toolCtx?.sessionID,
                    agent: tier,
                    model: model ? { ...model, variant: getActiveTiers(activeCfg)[tier]?.variant } : undefined,
                    prompt: taskText,
                    signal: childAbort!.signal,
                    onCreated: registerProducer,
                  }) : ctx.client.session.prompt({
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
              const finish = dispatchStart !== undefined && producerError === null && isDeferred(dod, dispatchStart.directives) &&
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
                await disposeChildSession(producerSid);
                return { sessionID: producerSid, text: producerText, deferredFooter: finish.footer };
              }
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
                verification = await prepareVerification(changedFileStore, baselineID, producerSid, effectiveCwd, gateDeadline);
              } catch (error) {
                gateDeadline.dispose();
                throw error;
              }
              const artefact = {
                changedFiles: verification.changedFiles,
                changeBaseline: verification.changeBaseline,
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
              await disposeChildSession(producerSid);

              return { sessionID: producerSid, text: producerText, gateRes };
            };

            while (true) {
              if (safety++ > safetyMax) {
                return (
                  `[router status: unmet] delegation stopped by the safety net after ` +
                  `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
                );
              }
              const tier = state.currentTier;
              const attempt = await runProducerAttempt(tier, forcing);
              if (!attempt) {
                return "[router] delegate failed: could not create a producer session.";
              }
              producerText = attempt.text;
              if ("deferredFooter" in attempt) {
                // Section 1.5-16: the result unchanged plus the footer, appended last. Never
                // labelled accepted or verified, and never retried or escalated.
                return appendRouterFooter(producerText, attempt.deferredFooter);
              }
              const producerSid = attempt.sessionID;
              const gateRes = attempt.gateRes;

              const costRatio =
                typeof tiersForCost?.[tier]?.costRatio === "number"
                  ? tiersForCost[tier].costRatio
                  : 1;
              state = recordAttempt(state, costRatio);

              const action = nextAction(
                state,
                { pass: gateRes.accepted, outcome: gateRes.verdict.outcome, reasons: gateRes.verdict.reasons },
                policy,
              );

              if (action.action === "accept") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  true,
                  gateRes.verdict.method,
                );
                return producerText + buildAcceptedSuffix(gateRes.verdict.method, gateRes.verdict.outcome, gateRes.verdict.caveats, gateRes.verdict.notes);
              }
              if (action.action === "give_up") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  false,
                  gateRes.verdict.method,
                );
                const note = scrubText(buildForcingNote(gateRes.verdict.reasons));
                return (
                  `[router status: unmet] The delegated result was not accepted after ` +
                  `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
                  `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
                  `${scrubText(producerText)}\n\n${note}`
                );
              }
              // retry or escalate
              forcing = action.forcingMessage ?? null;
              state = advance(state, action);
            }
          } catch {
            return "[router] delegate failed (fail-closed): the delegation or verification could not complete.";
          } finally {
            // Safety net for every exit path an end-of-iteration dispose cannot
            // reach: accept/give-up returns, the safety-net return, and throws.
            // disposeChildSession is fail-soft, so re-disposing an already
            // disposed session is harmless.
            for (const sid of producerSessions) {
              if (!(deferredOwnsBaseline && sid === baselineID)) changedFileStore.clear(sid);
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
      } catch {
        // best-effort: never crash a real session
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (bypassed) return;
      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig();
        warnDeprecatedVerifyKeys(cfg, logger);
      } catch {}
      try {
        sweepIdleStores();
      } catch {
        // best-effort maintenance: never break a real turn
      }
      const tierNames = Object.keys(getActiveTiers(cfg));
      const sid = input?.sessionID;
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
      if (bypassed) return;
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
          const effectiveCwd = typeof output?.args?.cwd === "string" && output.args.cwd.trim() ? output.args.cwd : dod.cwd;
          // 2.4.2b: the directives come from the orchestrator's own prompt, read here before the
          // dispatch header or any repair touches it, and are kept for the after hook. The capture
          // is awaited for at most VERIFY_WAIT (section 1.5-14) and continues in the background.
          await startDispatch(changedFileStore, `task:${input.sessionID}:${input.callID}`,
            effectiveCwd,
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
              !args.prompt.startsWith("[router] You are @")
            ) {
              // Resolve from the original dispatch, using the registration rules.
              const parsed = parseCapDirective(args.prompt);
              const override =
                parsed === "none" && !/\breason:/i.test(args.prompt) ? null : parsed;
              const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
              const cap = override ?? baseline;
              const prompt = buildDispatchHeader({ tier, cap, projectDirectory: ctx.directory }) +
                "\n\n---\n\n" + args.prompt;
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
      const sid = input?.sessionID;
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        return;
      }
      // Start-of-call refresh: the idle TTL must cover the tool's runtime, not
      // just the moment it finished.
      sessionStore.touchIfTracked(sid);
      let res;
      try {
        res = guardBeforeCall({
          cfg,
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
        });
      } catch {
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
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (bypassed) return;
      sessionStore.recordToolCall(input, output);

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

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
        });
        try {
          guardAfterCall({
            cfg,
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
      // we observe the finished task result and append a forcing note if it is not
      // accepted; we cannot retry a task call that already finished).
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
            const { finalReturnText, childSessionID } = parseTaskResult(output);
            const producerTier =
              typeof input?.args?.subagent_type === "string"
                ? input.args.subagent_type
                : "";
            const dod = buildDelegationDoD({
              prompt: input?.args?.prompt,
              description: input?.args?.description,
            });
            const effectiveCwd = typeof input?.args?.cwd === "string" && input.args.cwd.trim() ? input.args.cwd : dod.cwd;
            const dispatchID = `task:${input.sessionID}:${input.callID}`;
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
            if (isDeferred(dod, start.directives, trivial) && await isProvenRootCaller(orchestratorSessionID)) {
              // Section 1.5-16: no gate, no test process; the result goes back now with the
              // footer, which is appended last and never says accepted or verified.
              const finish = await finishDeferred(changedFileStore, {
                dispatchID,
                orchestratorSessionID,
                producerSessionID: childSessionID ?? "",
                producerTier,
                description: taskDescription?.trim() ? taskDescription : (taskPrompt ?? ""),
                cwd: effectiveCwd,
                dod,
                dispatchedAt: start.dispatchedAt,
              });
              if (finish.deferred) {
                output.output = appendRouterFooter(typeof output.output === "string" ? output.output : "", finish.footer);
                // The dispatch record is cleared by finishDeferred once its capture settled.
                if (childSessionID) changedFileStore.clear(childSessionID);
                return;
              }
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
              verification = await prepareVerification(changedFileStore, dispatchID, childSessionID ?? "", effectiveCwd, gateDeadline);
            } catch (error) {
              gateDeadline.dispose();
              throw error;
            }
            const artefact = {
              changedFiles: verification.changedFiles,
              changeBaseline: verification.changeBaseline,
              finalReturnText,
              declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
              producerSessionID: childSessionID ?? "",
              producerTier,
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
              return;
            }

            const gateGraderSessions = new Set<string>();
            const completedFailures: string[] = [];
            const gateDeps = buildGateDeps(undefined, gateGraderSessions, verification, gateDeadline);
            gateDeps.deterministic.onFailure = reason => completedFailures.push(reason);
            let res;
            try {
              res = await withTimeout(
                accept(
                  {
                    dod,
                    trivial,
                    mode: "modeA",
                    // Native task has no cwd argument; the acceptance block can supply it.
                    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
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
            if (!res.accepted && !res.verdict.skipped) {
              const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
              const li = ladder.indexOf(producerTier);
              const nextTier = res.verdict.outcome !== "unverifiable" && li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
              const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
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
          } catch {
            // fail-closed: a verification error must NEVER throw out of the after-hook
          }
        }
      }
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
            sessionStore.unregister(id);
            // 2.4.2b: a deleted orchestrator's handles, tombstones and lineage records go with it.
            // 2.4.5: so do its background requests and late notices; its run in flight is aborted.
            background?.forgetSession(id);
            pending.forgetSession(id);
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
        if (
          typeof info?.id === "string" &&
          typeof info?.parentID === "string" &&
          info.parentID !== ""
        ) {
          try {
            sessionStore.markChildSession(info.id);
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
      const subagentOverrides = resolveSubagentOverrides({
        subagentTiers: cfg.subagentTiers,
        tiers: activeTiers,
        existingAgents: opencodeConfig.agent,
      });
      for (const [agentName, override] of Object.entries(subagentOverrides)) {
        opencodeConfig.agent[agentName] = mergeSubagentOverride(
          opencodeConfig.agent[agentName],
          override,
        );
      }

      // Register commands
      opencodeConfig.command ??= {};
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
      opencodeConfig.command["router"] = {
        template: "$ARGUMENTS",
        description:
          "Model-router controls (e.g., /router enforce off|advisory|enforced, /router overrides, /router models)",
      };
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
        cfg = loadConfig(); // Returns cache unless invalidated
        warnDeprecatedVerifyKeys(cfg, logger);
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

      let enfOn = false;
      try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
      output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));

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
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "tiers") {
        try {
          cfg = loadConfig();
          warnDeprecatedVerifyKeys(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildTiersOutput(cfg),
        });
      }

      if (input.command === "preset") {
        try {
          cfg = loadConfig();
          warnDeprecatedVerifyKeys(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildPresetOutput(cfg, input.arguments ?? ""),
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
          cfg = loadConfig();
          warnDeprecatedVerifyKeys(cfg, logger);
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildBudgetOutput(cfg, input.arguments ?? ""),
        });
      }

      if (input.command === "router") {
        try {
          cfg = loadConfig();
          warnDeprecatedVerifyKeys(cfg, logger);
        } catch {}
        const args = (input.arguments ?? "").trim();
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        let text: string;
        if (sub === "models") {
          const catalog = await fetchCatalog();
          const orphans = catalog ? findOrphanedStrongPatterns(cfg, catalog) : [];
          text = buildModelsOutput(catalog, parts.slice(1).join(" "), orphans);
        } else {
          text = buildRouterOutput(cfg, args);
          // On the bare status view, surface stale or missing models inline.
          if (sub === "") {
            const catalog = await fetchCatalog();
            if (catalog) {
              const issues = validateModels(cfg, catalog);
              if (issues.length > 0) {
                text += "\n\n" + formatModelIssues(issues);
              }
            }
          }
        }
        output.parts.push({ type: "text" as const, text });
      }
    },
  };
};

export default ModelRouterPlugin;
