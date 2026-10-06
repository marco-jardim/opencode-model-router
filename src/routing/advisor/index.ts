/**
 * Cost doctor (M8, Phase 2.4.2): `runAdvisor`, the `/router` rendering and the throttled notice.
 *
 * The notice is the only part with state. It is throttled by a small JSON file next to the outcome store (D15 directory,
 * `advisor-notice.json`), so a restart does not repeat it: at most one check per `routing.advisor.noticeIntervalHours`,
 * across processes and restarts. Nothing runs, and nothing is written, on OpenCode v1, with `routing.advisor.enabled: false`,
 * or when the config has no `routing` block at all (§1.2: today's behaviour, no new files, no new log lines). `/router`
 * runs `runAdvisor` on demand and writes nothing.
 *
 * Failure policy (§0.10.10): everything here is best effort. A failing host call, a throwing check, an unreadable or
 * unwritable state file is logged and swallowed; the notifier backs off for ten minutes after an error so a broken host
 * is not asked again on every turn.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
      mode: typeof entry.mode === "string" ? entry.mode : "primary",
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
    lines.push(`  [${finding.severity}] ${finding.id}${finding.subject === "" ? "" : ` (${finding.subject})`}: ${finding.message}`);
    // QA-2.4-2: say whose file the fix belongs to; a host fix also has a v1 spelling.
    if (finding.snippet !== null) lines.push(`      fix (${FIX_FILE[finding.target]}): ${finding.snippet}`);
    if (finding.snippet !== null && finding.snippetV1 !== null) lines.push(`      v1 form (opencode.json): ${finding.snippetV1}`);
  }
  return lines;
}

/** A finding the user should hear about unprompted: a misconfiguration or a concrete saving; plain explanations stay in `/router`. */
export function noticeWorthy(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "warning" || f.severity === "saving");
}

const NOTICE_EXCERPT_CHARS = 140;

/** One line for the orchestrator's context or the log. `null` when nothing is worth a notice. */
export function formatNotice(findings: readonly Finding[]): string | null {
  const worth = findings.filter((f) => f.severity !== "info");
  const first = worth[0];
  if (first === undefined) return null;
  const warnings = worth.filter((f) => f.severity === "warning").length;
  const savings = worth.length - warnings;
  const excerpt = first.message.length > NOTICE_EXCERPT_CHARS ? `${first.message.slice(0, NOTICE_EXCERPT_CHARS - 1).trimEnd()}…` : first.message;
  return `[model-router] Cost doctor: ${worth.length} finding${worth.length === 1 ? "" : "s"} worth a look (${warnings} warning, ${savings} saving). First: ${excerpt} Run /router for details and config snippets.`;
}

// ---------------------------------------------------------------------------
// Settings and the persisted throttle
// ---------------------------------------------------------------------------

export const NOTICE_FILE = "advisor-notice.json";
const STATE_VERSION = 1;

export interface AdvisorSettings {
  /** The D15 directory (`routing.outcomes.path` or the default): the state file lives here. */
  readonly dir: string;
  readonly intervalMs: number;
  /** `context`: appended to the orchestrator's context (advise/enforce); `log`: written to the log (static/shadow). */
  readonly deliver: "context" | "log";
}

/**
 * `null` = the advisor is inactive: v1, `routing.advisor.enabled: false`, or no `routing` block at all (today's behaviour,
 * byte for byte: no file, no log line, no host call).
 */
export function advisorSettings(cfg: RouterConfig, host: "v1" | "v2", env: { tmpdir: string; homedir: string } = { tmpdir: tmpdir(), homedir: homedir() }): AdvisorSettings | null {
  if (host !== "v2" || cfg.routing === undefined) return null;
  const routing = resolveRouting(cfg, "v2");
  if (!routing.advisor.enabled) return null;
  const hours = routing.advisor.noticeIntervalHours;
  return {
    dir: resolveOutcomesDir(routing.outcomes.path, env),
    intervalMs: Math.max(0, hours) * 3_600_000,
    deliver: routing.engine === "advise" || routing.engine === "enforce" ? "context" : "log",
  };
}

export interface NoticeState {
  readonly version: 1;
  /** ISO time of the last completed check (with or without a notice). */
  readonly lastRunAt: string;
  /** ISO time of the last notice, or `null`. */
  readonly lastNoticeAt: string | null;
  /** Ids and subjects of the findings of the last check, joined (diagnostics only). */
  readonly fingerprint: string;
}

function parseState(text: string): NoticeState | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.version !== STATE_VERSION || typeof raw.lastRunAt !== "string" || !Number.isFinite(Date.parse(raw.lastRunAt))) return null;
    return {
      version: STATE_VERSION,
      lastRunAt: raw.lastRunAt,
      lastNoticeAt: typeof raw.lastNoticeAt === "string" ? raw.lastNoticeAt : null,
      fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : "",
    };
  } catch {
    return null;
  }
}

function fingerprintOf(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.id}:${f.subject}`).join(",");
}

const BACKOFF_AFTER_ERROR_MS = 10 * 60_000;

export interface AdvisorNotifierDeps {
  /** Re-read on every poll (hot reload): `null` = inactive. */
  readonly settings: () => AdvisorSettings | null;
  readonly config: () => RouterConfig;
  /** The host's agents and catalog; either may be `null` (unknown). May reject. */
  readonly gather: () => Promise<{ readonly host: HostConfigView | null; readonly catalog: readonly AdvisorCatalogModel[] | null }>;
  readonly logger: AdvisorLogger;
  readonly now?: () => number;
  readonly fs?: PersistFs;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Back-off after an error (default 10 minutes). */
  readonly backoffMs?: number;
}

export interface AdvisorNotifier {
  /**
   * Cheap and synchronous (call it on every orchestrator turn). Starts a background check when one is due. Returns the notice
   * text exactly once, on the first poll after a check produced one, when notices go to the context; in log mode it logs and
   * returns `null`. Never throws.
   */
  poll(): string | null;
  /** Resolves when the check in flight (if any) and its state write have finished. */
  settled(): Promise<void>;
}

export function createAdvisorNotifier(deps: AdvisorNotifierDeps): AdvisorNotifier {
  const now = deps.now ?? (() => Date.now());
  const fs = deps.fs ?? nodePersistFs();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const backoffMs = deps.backoffMs ?? BACKOFF_AFTER_ERROR_MS;
  /** `null` = the persisted state has not been read yet in this process. */
  let nextDueAt: number | null = null;
  let blockedUntil = 0;
  let inFlight: Promise<void> | null = null;
  let pending: { readonly text: string; readonly fingerprint: string } | null = null;
  let lastNoticeAt: string | null = null;
  /** State writes started by `poll`, so `settled()` can wait for them. */
  const writes = new Set<Promise<void>>();
  const track = (job: Promise<void>): void => {
    writes.add(job);
    void job.finally(() => writes.delete(job));
  };

  const write = async (dir: string, state: NoticeState): Promise<void> => {
    try {
      await fs.mkdirp(dir);
      const target = join(dir, NOTICE_FILE);
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeDurable(temp, `${JSON.stringify(state)}\n`);
      await renameWithRetry(fs, temp, target, sleep);
    } catch (error) {
      deps.logger.warn("[router] cost doctor: could not save the notice state; the notice may repeat after a restart", { error: describeError(error) });
    }
  };

  const read = async (dir: string): Promise<NoticeState | null> => {
    try {
      const text = await fs.readText(join(dir, NOTICE_FILE));
      if (text === null) return null;
      const state = parseState(text);
      if (state === null) deps.logger.warn("[router] cost doctor: the notice state file is unreadable; it is rewritten at the next check");
      return state;
    } catch (error) {
      deps.logger.warn("[router] cost doctor: could not read the notice state", { error: describeError(error) });
      return null;
    }
  };

  const persist = async (settings: AdvisorSettings, ranAt: number, notified: boolean, fingerprint: string): Promise<void> => {
    if (notified) lastNoticeAt = new Date(ranAt).toISOString();
    nextDueAt = ranAt + settings.intervalMs;
    await write(settings.dir, { version: STATE_VERSION, lastRunAt: new Date(ranAt).toISOString(), lastNoticeAt, fingerprint });
  };

  const check = async (): Promise<void> => {
    const settings = deps.settings();
    if (settings === null) return;
    if (nextDueAt === null) {
      const state = await read(settings.dir);
      lastNoticeAt = state?.lastNoticeAt ?? null;
      nextDueAt = state === null ? 0 : Date.parse(state.lastRunAt) + settings.intervalMs;
    }
    if (now() < nextDueAt) return;
    const { host, catalog } = await deps.gather();
    const findings = runAdvisor(deps.config(), host, catalog, deps.logger);
    const text = noticeWorthy(findings) ? formatNotice(findings) : null;
    const fingerprint = fingerprintOf(findings);
    if (text === null) {
      await persist(settings, now(), false, fingerprint);
      return;
    }
    if (settings.deliver === "log") {
      deps.logger.warn(text);
      await persist(settings, now(), true, fingerprint);
      return;
    }
    // Context delivery is persisted when the text is handed over, so a process that dies in between repeats it.
    pending = { text, fingerprint };
  };

  const start = (): void => {
    if (inFlight !== null) return;
    const run = check()
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
    poll(): string | null {
      try {
        const settings = deps.settings();
        if (settings === null) {
          pending = null;
          return null;
        }
        if (pending !== null) {
          const ready = pending;
          pending = null;
          track(persist(settings, now(), true, ready.fingerprint));
          if (settings.deliver === "context") return ready.text;
          deps.logger.warn(ready.text); // the mode went back to static/shadow while the notice waited
          return null;
        }
        if (inFlight !== null || now() < blockedUntil || (nextDueAt !== null && now() < nextDueAt)) return null;
        start();
        return null;
      } catch (error) {
        deps.logger.warn("[router] cost doctor: poll failed", { error: describeError(error) });
        return null;
      }
    },
    async settled(): Promise<void> {
      while (inFlight !== null || writes.size > 0) await Promise.all([inFlight, ...writes]);
    },
  };
}
