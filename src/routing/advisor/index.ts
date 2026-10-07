/**
 * Cost doctor (M8, Phase 2.4.2): `runAdvisor`, the `/router` rendering and the throttled notice.
 *
 * The notice is the only part with state, and only when it goes to the orchestrator's context (advise/enforce): then a small JSON
 * file next to the outcome store (D15 directory, `advisor-notice.<project hash>.json`: one per project) holds the throttle, the findings
 * the user was last told about and a notice that is waiting for delivery, and a lock file (`advisor-notice.<project hash>.lock`,
 * exclusive create, a stale one taken over by rename) makes two processes agree on who delivers it. A notice goes out only when the
 * notice-worthy findings contain one the user was not told about yet (a reminder after 7 days; a set that only shrank is not news), a
 * check runs at most once per `routing.advisor.noticeIntervalHours` (never more often than hourly), and a notice produced by one
 * process is delivered by the next one if the first never got to, once that process's own check has confirmed that the findings it
 * was about are still the current ones (otherwise it is dropped). In log mode (static/shadow) the throttle
 * is in memory and NO file is read or written. Nothing runs on OpenCode v1, with `routing.advisor.enabled: false` or `notify: false`,
 * or when the config has no `routing` block at all (§1.2: today's behaviour, no new files, no new log lines). `/router` runs
 * `runAdvisor` on demand and writes nothing.
 *
 * Failure policy (§0.10.10): everything here is best effort. A failing host call, a throwing check, an unreadable or
 * unwritable state file is logged and swallowed; the notifier backs off for ten minutes after an error so a broken host
 * is not asked again on every turn.
 */

import { createHash } from "node:crypto";
import { withLock as withFileLock } from "../file-lock";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRouting, type RouterConfig } from "../../router/config";
import { nodePersistFs, renameWithRetry, resolveOutcomesDir } from "../outcomes/persist";
import type { PersistFs } from "../outcomes/types";
import { agentModelRef } from "../wire/host-info";
import { runChecks } from "./findings";
import type { AdvisorCatalogModel, Finding, FindingTarget, HostAgentView, HostConfigView } from "./findings";

export { FINDING_IDS, FINDING_TARGET, HOST_SMALL_MODEL_FAMILIES, SUBSCRIPTION_PROVIDERS, cheapestTitleModel, hostSmallModel, splitModelRef } from "./findings";
export type { AdvisorCatalogModel, Finding, FindingId, FindingSeverity, FindingTarget, HostAgentView, HostConfigView } from "./findings";

export interface AdvisorLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// runAdvisor
// ---------------------------------------------------------------------------

/**
 * The findings for `cfg` against what the host reports. `hostConfig` = `null` and `catalog` = `null` mean "unknown": the checks
 * that need them stay silent. Never throws: a throwing check is logged and skipped.
 */
export function runAdvisor(
  cfg: RouterConfig,
  hostConfig: HostConfigView | null,
  catalog: readonly AdvisorCatalogModel[] | null,
  logger?: AdvisorLogger,
): Finding[] {
  try {
    return runChecks(cfg, hostConfig, catalog, (check, error) => {
      logger?.warn(`[router] cost doctor: check ${check} failed`, { error: describeError(error) });
    });
  } catch (error) {
    logger?.warn("[router] cost doctor: the advisor failed", { error: describeError(error) });
    return [];
  }
}

/**
 * The view of `ctx.agent.list().data` the advisor reads (entries without a string id are skipped), plus the session's own model when the
 * caller knows it (the host's title pick depends on its provider).
 */
export function hostConfigFromAgents(raw: readonly unknown[], primary: HostConfigView["primary"] = null): HostConfigView {
  const agents: HostAgentView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
    agents.push({
      id: entry.id,
      model: agentModelRef(entry.model),
      mode: entry.mode === "subagent" || entry.mode === "primary" || entry.mode === "all" ? entry.mode : null,
      hidden: entry.hidden === true,
    });
  }
  return { agents, primary };
}

/**
 * The advisor's view of `ctx.model.list().data` (host `Model.Info` records). Read defensively, field by field: a record without a
 * string `providerID`/`id` is skipped, and a missing field stays missing (the checks treat an unknown `enabled`/`tools` as "not
 * usable", never as usable).
 */
export function catalogFromModels(raw: readonly unknown[]): AdvisorCatalogModel[] {
  const models: AdvisorCatalogModel[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.providerID !== "string" || typeof entry.id !== "string" || entry.providerID === "" || entry.id === "") continue;
    const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
    const capabilities = isRecord(entry.capabilities)
      ? {
          tools: typeof entry.capabilities.tools === "boolean" ? entry.capabilities.tools : undefined,
          input: strings(entry.capabilities.input),
          output: strings(entry.capabilities.output),
        }
      : null;
    const limit = isRecord(entry.limit) ? { context: entry.limit.context, input: entry.limit.input, output: entry.limit.output } : null;
    models.push({
      providerID: entry.providerID,
      id: entry.id,
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(typeof entry.status === "string" ? { status: entry.status } : {}),
      ...(typeof entry.family === "string" ? { family: entry.family } : {}),
      capabilities,
      variants: Array.isArray(entry.variants) ? (entry.variants as ReadonlyArray<{ readonly id?: unknown } | null | undefined>) : null,
      cost: entry.cost,
      limit,
    });
  }
  return models;
}

/**
 * The advisor's catalog from a `config.providers()` payload (`{ providers: [{ id, models: { <id>: Model.Info-like } }] }`, which the v2
 * adapter fills with `enabled`, `status`, `family`, `capabilities`, `cost`, `variants` and `limit`). The host lists only enabled models
 * there, so a model of the router's ladder that is missing is "not in the catalog".
 */
export function catalogFromProviders(raw: unknown): AdvisorCatalogModel[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.providers)) return null;
  const records: unknown[] = [];
  for (const provider of raw.providers) {
    if (!isRecord(provider) || typeof provider.id !== "string" || !isRecord(provider.models)) continue;
    for (const [key, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      records.push({ ...model, providerID: provider.id, id: typeof model.id === "string" ? model.id : key });
    }
  }
  return catalogFromModels(records);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface DoctorContext {
  readonly hostKnown: boolean;
  readonly catalogKnown: boolean;
  /** The session's model is known (the title check needs its provider); absent = not asked about. */
  readonly primaryKnown?: boolean;
}

/** The file each finding target's snippet belongs in. */
const FIX_FILE: Readonly<Record<FindingTarget, string>> = {
  host: "opencode.json",
  router: "opencode-model-router.overrides.jsonc",
};

/** The `/router` section "Cost doctor": a header, then one block per finding with its optional fix snippet. */
export function formatFindings(findings: readonly Finding[], context: DoctorContext = { hostKnown: true, catalogKnown: true }): string[] {
  const base =
    !context.hostKnown && !context.catalogKnown
      ? "the host's agent list and model catalog were unavailable, so those checks were skipped"
      : !context.hostKnown
        ? "the host's agent list was unavailable, so those checks were skipped"
        : !context.catalogKnown
          ? "the host's model catalog was unavailable, so those checks were skipped"
          : null;
  const skipped =
    context.hostKnown && context.catalogKnown && context.primaryKnown === false
      ? "the session's model is not known yet, so the title-model check was skipped (ask again after the first turn)"
      : base;
  if (findings.length === 0) return [`Cost doctor: no findings${skipped === null ? "" : ` (${skipped})`}.`];
  const count = (severity: Finding["severity"]): number => findings.filter((f) => f.severity === severity).length;
  const header = `Cost doctor: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${count("warning")} warning, ${count("saving")} saving, ${count("info")} info)${skipped === null ? "" : `; ${skipped}`}`;
  const lines = [header];
  for (const finding of findings) {
    const quiet = finding.bundledTier && finding.severity !== "info" ? " (a tier of the bundled preset you have not modified: listed here, never in a notice)" : "";
    lines.push(`  [${finding.severity}] ${finding.id}${finding.subject === "" ? "" : ` (${finding.subject})`}: ${finding.message}${quiet}`);
    // QA-2.4-2: say whose file the fix belongs to; a host fix also has a v1 spelling.
    if (finding.snippet !== null) lines.push(`      fix (${FIX_FILE[finding.target]}): ${finding.snippet}`);
    if (finding.snippet !== null && finding.snippetV1 !== null) lines.push(`      v1 form (opencode.json): ${finding.snippetV1}`);
  }
  return lines;
}

/**
 * A finding the user should hear about unprompted: a misconfiguration or a concrete saving; plain explanations stay in `/router`, and so
 * do findings on unmodified tiers of a bundled preset (QA-2.4-5: the user did not write those).
 */
export function noticeWorthy(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.notify);
}

const NOTICE_EXCERPT_CHARS = 140;

/** One line for the orchestrator's context or the log. `null` when nothing is worth a notice. */
export function formatNotice(findings: readonly Finding[]): string | null {
  const worth = findings.filter((f) => f.notify);
  const first = worth[0];
  if (first === undefined) return null;
  const warnings = worth.filter((f) => f.severity === "warning").length;
  const savings = worth.length - warnings;
  const excerpt = first.message.length > NOTICE_EXCERPT_CHARS ? `${first.message.slice(0, NOTICE_EXCERPT_CHARS - 1).trimEnd()}…` : first.message;
  return `[model-router] Cost doctor: ${worth.length} finding${worth.length === 1 ? "" : "s"} worth a look (${warnings} warning, ${savings} saving). First: ${excerpt} Run /router for details and config snippets.`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The state and lock file names of one project: the project directory is part of the name (QA-2.4-R2-5), so projects never share a notice. */
export function noticeFiles(project: string): { readonly state: string; readonly lock: string } {
  const normalized = process.platform === "win32" ? resolve(project).toLowerCase() : resolve(project);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return { state: `advisor-notice.${id}.json`, lock: `advisor-notice.${id}.lock` };
}

const STATE_VERSION = 3;
/** A check never runs more often than this, whatever the configuration says (QA-2.4-7). */
export const MIN_INTERVAL_MS = 3_600_000;
/** An unchanged set of findings is mentioned again after this long at the earliest (QA-2.4-5). */
export const REMINDER_MS = 7 * 24 * 3_600_000;
/** Wait before checking again when another process holds the notice lock. */
const BUSY_BACKOFF_MS = 30_000;
const BACKOFF_AFTER_ERROR_MS = 10 * 60_000;

export interface AdvisorSettings {
  /** The D15 directory (`routing.outcomes.path` or the default): the state and lock files live here (context delivery only). */
  readonly dir: string;
  /** The project directory the notice belongs to: it names the state and lock files, so a notice is never delivered into another project. */
  readonly project: string;
  /** Time between checks, at least {@link MIN_INTERVAL_MS}. */
  readonly intervalMs: number;
  /** `context`: handed to the orchestrator's next user turn (advise/enforce; persisted); `log`: written to the log (static/shadow; memory only). */
  readonly deliver: "context" | "log";
}

/**
 * `null` = the advisor never notifies: v1, `routing.advisor.enabled: false`, `routing.advisor.notify: false`, or no `routing` block at all
 * (today's behaviour, byte for byte: no file, no log line, no host call).
 */
export function advisorSettings(
  cfg: RouterConfig,
  host: "v1" | "v2",
  env: { tmpdir?: string; homedir?: string; project?: string } = {},
): AdvisorSettings | null {
  if (host !== "v2" || cfg.routing === undefined) return null;
  const routing = resolveRouting(cfg, "v2");
  if (!routing.advisor.enabled || !routing.advisor.notify) return null;
  const hours = routing.advisor.noticeIntervalHours;
  return {
    dir: resolveOutcomesDir(routing.outcomes.path, { tmpdir: env.tmpdir ?? tmpdir(), homedir: env.homedir ?? homedir() }),
    project: env.project ?? "",
    intervalMs: Math.max(MIN_INTERVAL_MS, Number.isFinite(hours) ? hours * 3_600_000 : 24 * 3_600_000),
    deliver: routing.engine === "advise" || routing.engine === "enforce" ? "context" : "log",
  };
}

// ---------------------------------------------------------------------------
// The persisted state (context delivery only)
// ---------------------------------------------------------------------------

export interface NoticeState {
  readonly version: 3;
  /** The project directory this state is for (also in the file name). */
  readonly project: string;
  /** ISO time of the last completed check. */
  readonly lastRunAt: string;
  /** ISO time the last notice was delivered, or `null`. */
  readonly lastNoticeAt: string | null;
  /** The notice-worthy findings (`id:subject`) the user was last told about, narrowed to those still found at the last check. */
  readonly noticedKeys: readonly string[];
  /** A notice produced and not yet delivered: the next process to take it delivers it, once a check has confirmed it is still current. */
  readonly pendingText: string | null;
  /** The findings that notice was about. */
  readonly pendingKeys: readonly string[] | null;
}

function parseState(text: string): NoticeState | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.version !== STATE_VERSION || typeof raw.project !== "string") return null;
    if (typeof raw.lastRunAt !== "string" || !Number.isFinite(Date.parse(raw.lastRunAt))) return null;
    const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const keys = (value: unknown): string[] | null => (Array.isArray(value) && value.every((key) => typeof key === "string") ? (value as string[]) : null);
    return {
      version: STATE_VERSION,
      project: raw.project,
      lastRunAt: raw.lastRunAt,
      lastNoticeAt: str(raw.lastNoticeAt),
      noticedKeys: keys(raw.noticedKeys) ?? [],
      pendingText: str(raw.pendingText),
      pendingKeys: keys(raw.pendingKeys),
    };
  } catch {
    return null; // not JSON: the caller reports the file as unreadable
  }
}

/** The notice-worthy findings, as a stable list: the same set always gives the same keys, in any order. */
function keysOf(findings: readonly Finding[]): string[] {
  return [...new Set(findings.filter((f) => f.notify).map((f) => `${f.id}:${f.subject}`))].sort();
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key, i) => key === b[i]);

/** What the notifier needs of a file system: `PersistFs` plus an exclusive create (the lock). */
export interface AdvisorFs extends PersistFs {
  /** Create `path` with `data` only if it does not exist yet; `false` when it does. Any other failure rejects. */
  createExclusive(path: string, data: string): Promise<boolean>;
}

export function nodeAdvisorFs(): AdvisorFs {
  return nodePersistFs();
}

export interface AdvisorNotifierDeps {
  /** Re-read on every poll (hot reload): `null` = inactive. */
  readonly settings: () => AdvisorSettings | null;
  readonly config: () => RouterConfig;
  /** The host's agents and catalog; either may be `null` (unknown). May reject. */
  readonly gather: () => Promise<{ readonly host: HostConfigView | null; readonly catalog: readonly AdvisorCatalogModel[] | null }>;
  readonly logger: AdvisorLogger;
  readonly now?: () => number;
  readonly fs?: AdvisorFs;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Back-off after an error (default 10 minutes). */
  readonly backoffMs?: number;
}

export interface AdvisorNotifier {
  /**
   * Cheap and synchronous (call it on every orchestrator turn). Starts a background check when one is due (or when a notice a previous
   * process left has still to be confirmed); in log mode the check logs its notice. Never throws.
   */
  poll(): void;
  /** A context notice may be waiting: one is in memory, or the persisted state has not been read yet. Synchronous, no I/O. */
  maybePending(): boolean;
  /**
   * Hand over the pending context notice, once: across processes the one that claims it (under the lock) delivers it, the others get
   * `null`. Reads the persisted state on its first call. A notice a previous process left is delivered only after a check of this
   * process has confirmed that the findings it was about are still the current ones (otherwise it is dropped). `null` in log mode.
   * Never throws.
   */
  take(): Promise<string | null>;
  /** Resolves when the check in flight (if any) has finished. */
  settled(): Promise<void>;
}

export function createAdvisorNotifier(deps: AdvisorNotifierDeps): AdvisorNotifier {
  const now = deps.now ?? (() => Date.now());
  const fs = deps.fs ?? nodeAdvisorFs();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const backoffMs = deps.backoffMs ?? BACKOFF_AFTER_ERROR_MS;
  /** `null` = not decided yet (context: the state is not read; log: no check has run). */
  let nextDueAt: number | null = null;
  let blockedUntil = 0;
  let inFlight: Promise<void> | null = null;
  let loaded: Promise<void> | null = null;
  /** `verified`: produced by a check of this process, or confirmed by one; a notice read from the state file is not, until then. */
  let pending: { readonly text: string; readonly keys: readonly string[]; readonly verified: boolean } | null = null;
  /** The pending notice is in the state file (so claiming it under the lock is meaningful). */
  let pendingPersisted = false;
  /** Log mode, memory only: what was last logged and when. */
  let loggedKeys: ReadonlySet<string> = new Set();
  let loggedAt = 0;

  const pathsOf = (settings: AdvisorSettings): { readonly dir: string; readonly project: string; readonly state: string; readonly lock: string } => {
    const names = noticeFiles(settings.project);
    return { dir: settings.dir, project: settings.project, state: join(settings.dir, names.state), lock: join(settings.dir, names.lock) };
  };

  const readState = async (settings: AdvisorSettings): Promise<{ state: NoticeState | null; failed: boolean }> => {
    try {
      const text = await fs.readText(pathsOf(settings).state);
      if (text === null) return { state: null, failed: false };
      const state = parseState(text);
      if (state === null) deps.logger.warn("[router] cost doctor: the notice state file is unreadable or of another version; it is rewritten at the next check");
      else if (state.project !== settings.project) {
        deps.logger.warn("[router] cost doctor: the notice state file belongs to another project; it is ignored and rewritten at the next check");
        return { state: null, failed: false };
      }
      return { state, failed: false };
    } catch (error) {
      deps.logger.warn("[router] cost doctor: could not read the notice state", { error: describeError(error) });
      return { state: null, failed: true };
    }
  };

  const writeState = async (settings: AdvisorSettings, state: NoticeState): Promise<boolean> => {
    try {
      const { dir, state: target } = pathsOf(settings);
      await fs.mkdirp(dir);
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeDurable(temp, `${JSON.stringify(state)}\n`);
      await renameWithRetry(fs, temp, target, sleep);
      return true;
    } catch (error) {
      deps.logger.warn("[router] cost doctor: could not save the notice state; the notice may repeat after a restart", { error: describeError(error) });
      return false;
    }
  };

  /** Advisor alone may fall back unlocked: a duplicate notice beats a lost one. */
  const withLock = async <T>(settings: AdvisorSettings, run: () => Promise<T>): Promise<{ status: "ran"; value: T } | { status: "busy" }> => {
    const { dir, lock: lockPath } = pathsOf(settings);
    let started = false;
    try {
      return await withFileLock(fs, dir, lockPath, now, deps.logger, async () => {
        started = true;
        return run();
      });
    } catch (error) {
      if (started) throw error;
      deps.logger.warn("[router] cost doctor: could not lock the notice state; going on without the lock", { error: describeError(error) });
    }
    return { status: "ran", value: await run() };
  };

  /** Context mode: read the persisted state once per process; a notice a previous process left becomes pending, unverified. */
  const ensureLoaded = (settings: AdvisorSettings): Promise<void> => {
    loaded ??= (async () => {
      const { state } = await readState(settings);
      nextDueAt = state === null ? 0 : Date.parse(state.lastRunAt) + settings.intervalMs;
      if (state?.pendingText != null) {
        pending = { text: state.pendingText, keys: state.pendingKeys ?? [], verified: false };
        pendingPersisted = true;
      }
    })();
    return loaded;
  };

  const produce = async (): Promise<{ text: string | null; keys: string[] }> => {
    const { host, catalog } = await deps.gather();
    const findings = runAdvisor(deps.config(), host, catalog, deps.logger);
    return { text: noticeWorthy(findings) ? formatNotice(findings) : null, keys: keysOf(findings) };
  };

  const checkContext = async (settings: AdvisorSettings): Promise<void> => {
    await ensureLoaded(settings);
    if (pending?.verified === true) return; // a notice waits for delivery: no host call
    if (pending === null && now() < (nextDueAt ?? 0)) return;
    // With a notice left by a previous process this check is not throttled: it is what confirms (or drops) it.
    const { text, keys } = await produce();
    const outcome = await withLock(settings, async () => {
      // Decide on the state as it is NOW: another process may have checked or produced a notice meanwhile.
      const { state: fresh } = await readState(settings);
      const t = now();
      const stored = fresh !== null && fresh.pendingText !== null ? fresh : null;
      if (stored !== null && stored.pendingText !== null && sameKeys(stored.pendingKeys ?? [], keys)) {
        // A notice about exactly the findings found now (another process's, or the one a previous process left): current, deliverable.
        pending = { text: stored.pendingText, keys, verified: true };
        pendingPersisted = true;
        nextDueAt = Date.parse(stored.lastRunAt) + settings.intervalMs;
        return;
      }
      if (stored === null && fresh !== null && t < Date.parse(fresh.lastRunAt) + settings.intervalMs) {
        pending = null; // whoever held it has delivered it
        nextDueAt = Date.parse(fresh.lastRunAt) + settings.intervalMs;
        return;
      }
      // A stored notice about findings that are not the current ones is dropped here (QA-2.4-R2-5): what follows decides afresh.
      const lastNotice = fresh?.lastNoticeAt == null ? null : Date.parse(fresh.lastNoticeAt);
      const noticed = new Set(fresh?.noticedKeys ?? []);
      const hasNew = keys.some((key) => !noticed.has(key));
      const reminder = lastNotice !== null && t - lastNotice >= REMINDER_MS;
      // QA-2.4-R2-6: only a finding not told about yet, or the weekly reminder, is news; a set that merely shrank is not.
      const notify = text !== null && (hasNew || reminder);
      const next: NoticeState = {
        version: STATE_VERSION,
        project: settings.project,
        lastRunAt: new Date(t).toISOString(),
        lastNoticeAt: fresh?.lastNoticeAt ?? null,
        noticedKeys: keys.filter((key) => noticed.has(key)), // what went away and comes back is news again
        pendingText: notify ? text : null,
        pendingKeys: notify ? keys : null,
      };
      const saved = await writeState(settings, next);
      nextDueAt = t + settings.intervalMs;
      pending = notify && text !== null ? { text, keys, verified: true } : null;
      pendingPersisted = notify && saved;
    });
    if (outcome.status === "busy") {
      loaded = null; // read the state again next time: the other process is writing it
      pending = null;
      blockedUntil = now() + BUSY_BACKOFF_MS;
    }
  };

  /** Log mode: the throttle lives in memory only and no file is read or written. */
  const checkLog = async (settings: AdvisorSettings): Promise<void> => {
    const { text, keys } = await produce();
    const t = now();
    nextDueAt = t + settings.intervalMs;
    if (text === null) {
      loggedKeys = new Set();
      return;
    }
    if (keys.some((key) => !loggedKeys.has(key)) || t - loggedAt >= REMINDER_MS) {
      deps.logger.warn(text);
      loggedAt = t;
    }
    loggedKeys = new Set(keys);
  };

  const start = (settings: AdvisorSettings): void => {
    if (inFlight !== null) return;
    const run = (settings.deliver === "context" ? checkContext(settings) : checkLog(settings))
      .catch((error: unknown) => {
        blockedUntil = now() + backoffMs;
        deps.logger.warn("[router] cost doctor: the check failed; trying again later", { error: describeError(error) });
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
  };

  return {
    poll(): void {
      try {
        const settings = deps.settings();
        if (settings === null || inFlight !== null || now() < blockedUntil) return;
        if (settings.deliver === "context" && pending?.verified === true) return;
        const confirming = settings.deliver === "context" && pending !== null; // a notice from a previous process, not yet confirmed
        if (!confirming && nextDueAt !== null && now() < nextDueAt) return;
        start(settings);
      } catch (error) {
        deps.logger.warn("[router] cost doctor: poll failed", { error: describeError(error) });
      }
    },

    maybePending(): boolean {
      try {
        const settings = deps.settings();
        return settings !== null && settings.deliver === "context" && (pending !== null || loaded === null);
      } catch {
        return false; // a throwing settings reader means nothing is deliverable now; poll reports it
      }
    },

    async take(): Promise<string | null> {
      try {
        const settings = deps.settings();
        if (settings === null || settings.deliver !== "context") return null;
        await ensureLoaded(settings);
        const mine = pending;
        if (mine === null || !mine.verified) return null;
        if (!pendingPersisted) {
          pending = null; // it never reached the state file (no coordination possible): deliver it
          return mine.text;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const claim = await withLock(settings, async (): Promise<string | null> => {
            const { state: fresh, failed } = await readState(settings);
            if (failed) return mine.text; // the state cannot be read: no coordination, deliver
            if (fresh === null || fresh.pendingText === null) return null; // another process delivered it
            await writeState(settings, {
              ...fresh,
              lastNoticeAt: new Date(now()).toISOString(),
              noticedKeys: fresh.pendingKeys ?? fresh.noticedKeys,
              pendingText: null,
              pendingKeys: null,
            });
            return fresh.pendingText;
          });
          if (claim.status === "ran") {
            pending = null;
            return claim.value;
          }
          await sleep(25); // another process holds the lock for a few milliseconds
        }
        return null; // still busy: the notice stays pending for the next turn
      } catch (error) {
        deps.logger.warn("[router] cost doctor: could not take the notice", { error: describeError(error) });
        return null;
      }
    },

    async settled(): Promise<void> {
      while (inFlight !== null) await inFlight;
    },
  };
}
