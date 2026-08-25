/**
 * src/verify/dispatch.ts — PURE helpers shared by both Layer-2 wirings
 * (Option (i) verify-dispatch around the built-in `task` tool, and Option (ii)
 * the plugin-owned `delegate` tool). No fs/network/SDK here; the live adapters
 * (exec/fs/grader) are built in index.ts from PluginInput and injected.
 */
import type { RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { parseDoDFromDispatch, inferDoD } from "./dod";
import type { DoD, InferHints } from "./dod";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";

export interface ChangedFileStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Tools that mutate the workspace (mirrors the guard taxonomy). */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

export interface ChangedFile {
  path: string;
  status: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export function extractChangedFile(tool: string, args: unknown): ChangedFile | null {
  if (!WRITE_TOOLS.has(tool)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const path =
    typeof a.filePath === "string"
      ? a.filePath
      : typeof a.path === "string"
        ? a.path
        : typeof a.file === "string"
          ? a.file
          : "";
  if (!path) return null;
  const status = tool === "write" ? "written" : "modified";
  return { path, status };
}

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export function createChangedFileStore(options: ChangedFileStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const bySession = new Map<string, Map<string, string>>();
  const lastTouch = new Map<string, number>();

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evict(sessionID: string): void {
    bySession.delete(sessionID);
    lastTouch.delete(sessionID);
  }

  return {
    record(sessionID: string, tool: string, args: unknown): void {
      touch(sessionID);
      const cf = extractChangedFile(tool, args);
      if (!cf) return;
      let m = bySession.get(sessionID);
      if (!m) {
        m = new Map();
        bySession.set(sessionID, m);
      }
      // "written" (created) is stickier than a later "modified".
      const prev = m.get(cf.path);
      m.set(cf.path, prev === "written" ? "written" : cf.status);
    },
    get(sessionID: string): ChangedFile[] {
      const m = bySession.get(sessionID);
      if (!m) return [];
      return [...m.entries()].map(([path, status]) => ({ path, status }));
    },
    clear(sessionID: string): void {
      evict(sessionID);
    },
    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
    },
  };
}

const TASK_RESULT_OPEN = "<task_result>";
const TASK_RESULT_CLOSE = "</task_result>";

/**
 * Linear-time extraction of the <task_result> body. Any regex scan here, even a
 * lazy one, backtracks polynomially on repeated open tags with no close
 * (CodeQL js/polynomial-redos), so this walks the string with indexOf instead.
 * Case-insensitive, like the regex it replaced: first open tag, then the first
 * close tag after it. Returns null when either tag is missing.
 */
function extractTaskResult(raw: string): string | null {
  const lower = raw.toLowerCase();
  const start = lower.indexOf(TASK_RESULT_OPEN);
  if (start === -1) return null;
  const end = lower.indexOf(TASK_RESULT_CLOSE, start + TASK_RESULT_OPEN.length);
  if (end === -1) return null;
  return raw.slice(start + TASK_RESULT_OPEN.length, end);
}

/**
 * Parse the built-in `task` tool's after-hook output: the child's final return
 * is wrapped in <task_result>...</task_result> and the child session id lives in
 * output.metadata.sessionId (spike capability C).
 */
export function parseTaskResult(output: unknown): {
  finalReturnText: string;
  childSessionID: string | null;
} {
  const o = (output ?? {}) as Record<string, unknown>;
  const raw = typeof o.output === "string" ? o.output : "";
  const inner = extractTaskResult(raw);
  const finalReturnText = (inner ?? raw).trim();
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const childSessionID =
    typeof meta.sessionId === "string"
      ? meta.sessionId
      : typeof meta.sessionID === "string"
        ? meta.sessionID
        : null;
  return { finalReturnText, childSessionID };
}

/**
 * Build the DoD for a delegation from its dispatch text: an explicit
 * [acceptance] block wins; otherwise auto-infer a minimal, non-vacuous DoD
 * (M2 default). `acceptance` (if provided) is parsed for the block first.
 */
export function buildDelegationDoD(
  args: { prompt?: string; description?: string; acceptance?: string },
  hints: InferHints = {},
): DoD {
  const blockSource = args.acceptance ?? args.prompt ?? args.description ?? "";
  const explicit = parseDoDFromDispatch(blockSource);
  if (explicit) return explicit;
  const dispatch = args.prompt ?? args.description ?? "";
  return inferDoD(dispatch, "", hints);
}

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export function tierModel(
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null {
  const tiers = getActiveTiers(cfg);
  const t = tiers[tierName];
  if (!t || typeof t.model !== "string") return null;
  const slash = t.model.indexOf("/");
  if (slash <= 0 || slash >= t.model.length - 1) return null;
  return {
    providerID: t.model.slice(0, slash),
    modelID: t.model.slice(slash + 1),
  };
}

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export function shouldVerifyTask(
  tool: string,
  mode: string,
  require: string | undefined,
): boolean {
  if (tool !== "task") return false;
  if (mode === "off") return false;
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
}

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export function buildForcingNote(
  reasons: string[],
  escalation?: { producerTier?: string; nextTier?: string | null },
): string {
  const body =
    reasons.length > 0
      ? reasons.map((r) => `- ${r}`).join("\n")
      : "- (no reasons provided)";
  const next =
    escalation?.nextTier
      ? `NEXT: address the above, then re-run via \`Task(subagent_type="${escalation.nextTier}")\`` +
        `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
        `do not treat the prior result as complete.`
      : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n` +
    `${body}\n` +
    next
  );
}

/** Suffix appended to an accepted delegate-tool result. */
export function buildAcceptedSuffix(method: string): string {
  return `\n\n[router \u2713 accepted: ${method}]`;
}
