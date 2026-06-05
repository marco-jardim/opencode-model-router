import type { RouterConfig } from "./config";
import { fingerprintToolCall } from "../guard/fingerprint";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cap = number | "none";

export interface SubagentState {
  tierName: string;
  cap: Cap;
  calls: number;
  /** Fingerprint → call index where this fingerprint was first seen. */
  seen: Map<string, number>;
  trivial: boolean;
}

// ---------------------------------------------------------------------------
// Fallback caps when tiers.json has no tierCaps block.
// ---------------------------------------------------------------------------

/** Fallback caps when tiers.json has no tierCaps block. */
export const DEFAULT_TIER_CAPS: Record<string, number> = {
  fast: 8,
  medium: 5,
  heavy: 3,
};

// ---------------------------------------------------------------------------
// Cap directive parser
// ---------------------------------------------------------------------------

/** Extract the first `CAP:N` or `CAP:none` directive from a dispatch prompt. */
export function parseCapDirective(text: string): Cap | null {
  const m = text.match(/\bCAP\s*:\s*(none|\d+)\b/i);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw === "none") return "none";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Dispatch text extractor (internal)
// ---------------------------------------------------------------------------

/** Best-effort extraction of textual content from a chat.message output payload. */
function extractDispatchText(output: unknown): string {
  const o = output as Record<string, unknown> | undefined;
  const parts = (o?.parts as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      chunks.push(p);
    } else if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      if (typeof rec.text === "string") chunks.push(rec.text);
      else if (typeof rec.content === "string") chunks.push(rec.content);
    }
  }
  if (chunks.length === 0) {
    const msg = o?.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") chunks.push(content);
  }
  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Cap banner builder
// ---------------------------------------------------------------------------

/** Build the banner appended to every read-only tool result in a subagent session. */
export function buildCapBanner(
  state: SubagentState,
  isRedundant: boolean,
  previousCall: number | undefined,
  tool: string,
): string {
  const lines: string[] = [];
  const capDisplay = state.cap === "none" ? "∞" : String(state.cap);
  lines.push(`[cap: ${state.calls}/${capDisplay}]`);

  if (isRedundant && previousCall !== undefined) {
    lines.push(
      `[⚠ REDUNDANT: this is the same ${tool} you ran at call #${previousCall}. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]`,
    );
  }

  if (state.cap !== "none") {
    const remaining = state.cap - state.calls;
    if (remaining <= 0) {
      lines.push(
        `[⚠ CAP REACHED (${state.calls}/${state.cap}): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]`,
      );
    } else if (remaining <= 2) {
      lines.push(
        `[⚠ CAP WARNING: ${remaining} read-only call(s) remaining before forced return]`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Read-only tools set (used by the session store)
// ---------------------------------------------------------------------------

/** Tools that count against the read-only cap. Keep narrow — editing tools should never count. */
export const READ_ONLY_TOOLS = new Set(["grep", "read", "glob", "ls"]);

// ---------------------------------------------------------------------------
// Trivial classifier
// ---------------------------------------------------------------------------

/** Normalise a taskPattern keyword to a lowercase stem for substring matching. */
function normTaskKw(kw: string): string {
  return kw.toLowerCase().split("(")[0]!.split("/")[0]!.trim();
}

/**
 * Classify a dispatch as "trivial" AT DISPATCH TIME (m2): conservative,
 * tier-gated. Only a `fast`-tier dispatch whose text matches a fast taskPattern
 * and contains NO medium/heavy signal is trivial. Real work (medium/heavy tier,
 * or implementation keywords) is NEVER trivial — so proportional bypass can
 * never silently disable enforcement on real work.
 */
export function classifyTrivial(
  dispatchText: string,
  tier: string | null,
  cfg: RouterConfig,
): boolean {
  if (tier !== "fast") return false;
  const text = (dispatchText || "").toLowerCase();
  if (!text.trim()) return false;
  const disqualifiers = [
    ...(cfg.taskPatterns?.medium ?? []),
    ...(cfg.taskPatterns?.heavy ?? []),
  ];
  for (const kw of disqualifiers) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return false;
  }
  const fast = cfg.taskPatterns?.fast ?? [];
  for (const kw of fast) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Session store factory
// ---------------------------------------------------------------------------

/**
 * Creates a per-plugin-instance session store that owns the subagent tracking
 * state (session IDs + cap state). Returns methods the hooks delegate to.
 * Concurrency: Set/Map are per-store-instance, NOT module-level singletons.
 */
export function createSessionStore() {
  const subagentSessionIDs = new Set<string>();
  const subagentCapState = new Map<string, SubagentState>();

  return {
    /** Returns true when sessionID belongs to a tracked subagent session. */
    isSubagent(sessionID: string): boolean {
      return subagentSessionIDs.has(sessionID);
    },

    /** Returns the tier name for a tracked subagent session, or null. */
    getTier(sessionID: string): string | null {
      return subagentCapState.get(sessionID)?.tierName ?? null;
    },

    /** Returns true when the session was classified as trivial at dispatch time. */
    isTrivial(sessionID: string): boolean {
      return subagentCapState.get(sessionID)?.trivial === true;
    },

    /**
     * Called from the chat.message hook. If the incoming message is directed
     * at a registered tier agent, records the session and initialises its cap state.
     * Accepts `tierNames` (from getActiveTiers) so this module doesn't need to
     * import protocol.ts.
     */
    registerFromChatMessage(
      input: { agent?: string; sessionID: string },
      output: unknown,
      cfg: RouterConfig,
      tierNames: string[],
    ): void {
      if (input.agent && tierNames.includes(input.agent)) {
        subagentSessionIDs.add(input.sessionID);

        // Initialize cap state on first dispatch; reset on subsequent rounds to the same
        // subagent session (rare but supported — treats each round as a fresh budget).
        const tierName = input.agent;
        const dispatchText = extractDispatchText(output);
        const override = parseCapDirective(dispatchText);
        const baseline =
          cfg.tierCaps?.[tierName] ?? DEFAULT_TIER_CAPS[tierName] ?? 5;
        const cap: Cap = override ?? baseline;
        subagentCapState.set(input.sessionID, {
          tierName,
          cap,
          calls: 0,
          seen: new Map(),
          trivial: classifyTrivial(dispatchText, tierName, cfg),
        });
      }
    },

    /**
     * Called from the tool.execute.after hook. Appends a cap/redundancy banner
     * to the tool output for tracked subagent sessions running read-only tools.
     * Mutates outputRef.output in place (same as the inlined hook logic).
     */
    recordToolCall(
      input: { sessionID: string; tool: string; args: unknown },
      outputRef: Record<string, unknown>,
    ): void {
      const state = subagentCapState.get(input.sessionID);
      if (!state) return; // not a tracked subagent session
      if (!READ_ONLY_TOOLS.has(input.tool)) return;

      const fp = fingerprintToolCall(input.tool, input.args);
      const previousCall = state.seen.get(fp);
      const isRedundant = previousCall !== undefined;

      state.calls += 1;
      if (!isRedundant) {
        state.seen.set(fp, state.calls);
      }

      const banner = buildCapBanner(state, isRedundant, previousCall, input.tool);

      const existing =
        typeof outputRef.output === "string" ? outputRef.output : "";
      outputRef.output = existing ? `${existing}\n\n${banner}` : banner;
    },
  };
}
