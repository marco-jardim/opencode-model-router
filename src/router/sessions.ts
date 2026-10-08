import { createHash, randomBytes } from "node:crypto";
import type { RouterConfig } from "./config";
import { fingerprintToolCall } from "../guard/fingerprint";
import { DEFAULT_IDLE_TTL_MS } from "./idle-sweep";
import type { DecisionFacts, LadderStepKind } from "../routing/outcomes/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cap = number | "none";

export interface SubagentState {
  tierName: string;
  cap: Cap;
  /** Read-only tool calls in the CURRENT dispatch round (reset on resume). */
  calls: number;
  /** Number of dispatch rounds registered for this session (1 on first dispatch). */
  dispatches: number;
  /** Cumulative read-only tool calls across all dispatch rounds (never reset). */
  totalCalls: number;
  /** Fingerprint → call index where this fingerprint was first seen. */
  seen: Map<string, number>;
  trivial: boolean;
}

/** Outcome of a chat.message registration attempt. */
export interface RegisterResult {
  /** True when the message was directed at a tracked tier agent. */
  registered: boolean;
  /** True when this was a same-session, same-tier re-registration (a resume). */
  resumed: boolean;
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

/**
 * Cumulative read-only ceiling across resumed dispatches, expressed as a
 * multiple of the CURRENT dispatch cap. A subagent that keeps getting resumed
 * gets a fresh per-dispatch budget every round; without a ceiling derived from
 * the configured budget, repeated resumes are an unbounded read loop.
 * A `CAP:none` dispatch has no per-dispatch budget to derive from, so it has
 * no cumulative ceiling either.
 */
export const CUMULATIVE_CAP_MULTIPLIER = 3;

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

    // Cumulative ceiling across resumed dispatches. Intentionally follows the
    // CURRENT dispatch cap: a tighter resumed cap makes the ceiling stricter,
    // so a resume can never buy more total budget than it declares.
    //
    // Gated on dispatches > 1: this ceiling exists to bound RESUMES. A single
    // dispatch that blows past 3x its cap is already covered by CAP REACHED
    // above, and firing here would both contradict "never-resumed sessions see
    // no new banner text" and read absurdly ("across 1 dispatches").
    //
    // Threshold asymmetry with the guard layer is deliberate: this runs AFTER
    // the call was counted (post-increment, so `>` = "the call that overran"),
    // while guards.ts CLAUSE 3b runs BEFORE a call executes (pre-increment,
    // so `>=` = "this call would overrun").
    const cumulativeCeiling = state.cap * CUMULATIVE_CAP_MULTIPLIER;
    if (state.dispatches > 1 && state.totalCalls > cumulativeCeiling) {
      lines.push(
        `[⚠ CUMULATIVE BUDGET EXCEEDED: ${state.totalCalls}/${cumulativeCeiling} across ${state.dispatches} dispatches — return now]`,
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
export function normTaskKw(kw: string): string {
  return kw.toLowerCase().split("(")[0]!.split("/")[0]!.trim();
}

/**
 * A dispatch is "multi-step" when its text describes a sequence rather than one
 * lookup: an ordered/bulleted/step list item, an explicit sequencing or
 * distributive word, or shell-style command chaining (`;`, `&&`). These are the
 * cheapest reliable signals that the subagent is expected to make several tool
 * calls, which is exactly the case proportional bypass must NOT exempt from
 * enforcement.
 *
 * List markers accept `1.`, `1)` and `1:` because "Step 1: ... Step 2: ..." is a
 * common phrasing; `step N` is also matched inline, since it frequently appears
 * mid-line rather than at the start of one.
 */
export const MULTI_STEP_RE =
  /(?:^\s*(?:[-*+]|\d+[.):])\s)|\bstep\s*\d+\s*[.):]|\bthen\b|\bone at a time\b|\bone-at-a-time\b|\bsequentially\b|\bin order\b|\bin this exact order\b|\beach\b|\bafter that\b|\bfor every\b|;|&&/im;

/**
 * An enumeration of three or more named subjects ("router, guard and verify")
 * describes breadth even when no file is named and no sequencing word appears.
 * Two items are deliberately NOT enough: "read a.json, b.json" is already caught
 * by the path count, and a two-item phrase is common in single-shot requests.
 */
export const ENUMERATION_RE =
  /[\w./-]+\s*,\s*[\w./-]+\s*(?:,\s*[\w./-]+|\b(?:and|or)\s+[\w./-]+)/i;

/**
 * Bare distributive phrasing — "summarize every config file", "list all guard
 * modules" — describes breadth over a whole class of targets with none of the
 * other breadth signals: no comma enumeration, no connector, no second
 * imperative line, no named path, and well under the length backstop. It is
 * still a fan-out, so it must not be trivial.
 *
 * `each` and `for every` are handled by `MULTI_STEP_RE`; this gate covers the
 * remaining bare `every`/`all` forms. The quantifier only counts when it scopes
 * a plural or collective TARGET class ("all guard modules", "every config
 * file"), which is what keeps depth phrasing over ONE file trivial: in "read
 * every line of package.json" and "read all of src/index.ts" the quantifier is
 * partitive, so the intervening-word class refuses to cross `of`, and the head
 * noun may not be followed by a file extension — otherwise `package` in
 * `package.json` reads as a collective, since `.` is a word boundary. The
 * generic plural branch carries a stop-list because English has many singular
 * words ending in `s` — "what does all this mean in tiers.json" must stay a
 * single-file lookup.
 */
export const DISTRIBUTIVE_RE =
  /\b(?:every|all)\s+(?:(?:the|these|those|other|remaining)\s+)?(?:(?!of\b)[a-z][a-z-]*\s+){0,2}(?:files?|modules?|tests?|configs?|dirs?|directory|directories|components?|routes?|stores?|handlers?|guards?|helpers?|scripts?|packages?|classes?|functions?|endpoints?|entries?|(?!(?:this|its|his|hers|thus|was|has|does|less|plus|yes|gas|bus|css|js|status|focus|process|access|address|business|class|success)\b)[a-z][a-z-]{2,}s)\b(?!\.[a-z])/i;

/**
 * Lines that open with an imperative verb. Two or more of them is a task list
 * written as prose. Matched per line so the `Working directory:` / `Platform:` /
 * `Shell:` footer described below cannot inflate the count.
 */
export const IMPERATIVE_LINE_RE =
  /^\s*(?:read|search|grep|list|find|check|report|summari[sz]e|open|inspect|show|tell|explain|analy[sz]e|compare|verify|count|locate|trace)\b/i;

/**
 * File-path-like tokens, counted to detect multi-file recon. Deliberately
 * requires a known file EXTENSION rather than accepting any slashed path.
 *
 * Dispatch prompts commonly arrive with a `Working directory: <cwd>` footer.
 * That footer is NOT emitted by this plugin — nothing in this repo writes it; it
 * comes from the host/orchestrator's own prompt conventions. Requiring an
 * extension is what keeps a POSIX cwd (`/home/u/proj`) from being miscounted as
 * a target file.
 */
export const PATH_TOKEN_RE =
  /[\w./\\-]*[\w-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|ya?ml|toml|txt|css|scss|html|py|rs|go|rb|java|sh|ps1|sql|lock)\b/gi;

/**
 * Well-known extensionless files, which `PATH_TOKEN_RE` cannot see. Matched
 * case-SENSITIVELY against the raw text so the conventional capitalisation is
 * required: "read Makefile and LICENSE" names two files, while "read the license
 * field in package.json" names one. The lookahead prevents double-counting
 * `README.md`, which `PATH_TOKEN_RE` already matches.
 */
export const BARE_FILENAME_RE =
  /\b(?:Makefile|Dockerfile|LICENSE|README|CHANGELOG|Gemfile|Rakefile|Procfile|NOTICE|CODEOWNERS)\b(?!\.\w)/g;

/**
 * At most this many distinct target files still counts as a single-shot lookup.
 *
 * Zero paths is deliberately still eligible: "search the codebase for X" and
 * "grep for the handler" name no file yet are the canonical cheap lookups, and
 * requiring exactly one path would reclassify them. Breadth that names no file
 * is caught by `ENUMERATION_RE` and `IMPERATIVE_LINE_RE` instead.
 */
export const MAX_TRIVIAL_PATHS = 1;

/**
 * Backstop for multi-step dispatches that use none of the marker words above:
 * a genuine single-shot lookup is short. Sized well above the real single-shot
 * prompts ("read package.json and tell me the version") and well below a real
 * recon brief, and measured AFTER the cwd/platform footer so that footer can
 * never by itself push a dispatch over the line.
 */
export const MAX_TRIVIAL_CHARS = 240;

/**
 * Classify a dispatch as "trivial" AT DISPATCH TIME (m2): conservative,
 * tier-gated. Trivial means the GA-6 proportionality case — a SINGLE-SHOT
 * lookup — not merely "read-only". A dispatch is trivial only when ALL hold:
 *
 *   1. tier is `fast` (medium/heavy is never trivial), and
 *   2. the text is non-empty, and
 *   3. it carries NO medium/heavy taskPattern signal, and
 *   4. it matches a fast taskPattern stem, and
 *   5. it names at most `MAX_TRIVIAL_PATHS` distinct file paths, counting both
 *      extensioned paths and well-known extensionless files, and
 *   6. it carries no multi-step marker (`MULTI_STEP_RE`), no 3+ item
 *      enumeration (`ENUMERATION_RE`), no distributive breadth quantifier
 *      (`DISTRIBUTIVE_RE`), and no second imperative line, and
 *   7. it is at most `MAX_TRIVIAL_CHARS` long.
 *
 * Clauses 5-7 are the narrowing. Without them ANY `fast` dispatch containing a
 * stem like "read" or "search" was trivial, which silently exempted multi-file
 * recon from enforced-mode hard blocks — the read_budget guard could therefore
 * never fire on a `@fast` subagent, defeating the guard it exists to apply.
 * Real work is still NEVER trivial, so bypass still cannot disable enforcement
 * on implementation.
 */
export function classifyTrivial(
  dispatchText: string,
  tier: string | null,
  cfg: RouterConfig,
): boolean {
  if (tier !== "fast") return false;
  const raw = dispatchText || "";
  const text = raw.toLowerCase();
  if (!text.trim()) return false;
  const disqualifiers = [
    ...(cfg.taskPatterns?.medium ?? []),
    ...(cfg.taskPatterns?.heavy ?? []),
  ];
  for (const kw of disqualifiers) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return false;
  }

  // Shape gates: a single-shot lookup is short, names at most one file, and
  // does not enumerate steps or subjects. Checked before the fast-stem match so
  // that a multi-file recon prompt can never be rescued by containing "read".
  if (raw.length > MAX_TRIVIAL_CHARS) return false;
  if (MULTI_STEP_RE.test(raw)) return false;
  if (ENUMERATION_RE.test(raw)) return false;
  if (DISTRIBUTIVE_RE.test(raw)) return false;

  const imperativeLines = raw
    .split(/\r?\n/)
    .filter((line) => IMPERATIVE_LINE_RE.test(line)).length;
  if (imperativeLines > 1) return false;

  const paths = new Set<string>(
    (text.match(PATH_TOKEN_RE) ?? []).map((p) => p.trim()),
  );
  for (const bare of raw.match(BARE_FILENAME_RE) ?? []) {
    paths.add(bare.toLowerCase());
  }
  if (paths.size > MAX_TRIVIAL_PATHS) return false;

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

export interface SessionStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Creates a per-plugin-instance session store that owns the subagent tracking
 * state (session IDs + cap state). Returns methods the hooks delegate to.
 * Concurrency: Set/Map are per-store-instance, NOT module-level singletons.
 *
 * Idle-TTL: registration and tool-call activity refresh a per-session lastTouch
 * stamp; `sweep()` evicts sessions idle for at least ttlMs. No timers.
 */
export function createSessionStore(options: SessionStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const subagentSessionIDs = new Set<string>();
  const subagentCapState = new Map<string, SubagentState>();
  const lastTouch = new Map<string, number>();

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evict(sessionID: string): void {
    subagentSessionIDs.delete(sessionID);
    subagentCapState.delete(sessionID);
    lastTouch.delete(sessionID);
  }

  return {
    /** Returns true when sessionID belongs to a tracked subagent session. */
    isSubagent(sessionID: string): boolean {
      return subagentSessionIDs.has(sessionID);
    },

    /** Returns the tier name for a tracked subagent session, or null. */
    getTier(sessionID: string): string | null {
      return subagentCapState.get(sessionID)?.tierName ?? null;
    },

    /**
     * The current dispatch round's honoured cap: "none" only for CAP:none with a
     * reason: line, else a number; null for an untracked session. A resume
     * re-registers and replaces it (QA-P15-1-3: the guard's reader signal).
     */
    getCap(sessionID: string): Cap | null {
      return subagentCapState.get(sessionID)?.cap ?? null;
    },

    /**
     * The current round's read-only counter reached its cap (calls >= a numeric
     * cap). Captured when a task returns, it validates a `NEED MORE: budget`
     * claim (QA-P15-2-2); false for CAP:none and untracked sessions.
     */
    readCapReached(sessionID: string): boolean {
      const state = subagentCapState.get(sessionID);
      return state !== undefined && state.cap !== "none" && state.calls >= state.cap;
    },

    /** Returns true when the session was classified as trivial at dispatch time. */
    isTrivial(sessionID: string): boolean {
      return subagentCapState.get(sessionID)?.trivial === true;
    },

    /**
     * Register a plugin-created producer session (from the delegate tool) so that
     * Layer-1 (tool.execute.before) guards it like any other subagent. trivial:false
     * ensures the producer is always fully enforced (never downgraded to advisory).
     */
    registerProducerSession(sessionID: string, tier: string, cfg: RouterConfig): void {
      subagentSessionIDs.add(sessionID);
      const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
      subagentCapState.set(sessionID, {
        tierName: tier,
        cap: baseline,
        calls: 0,
        dispatches: 1,
        totalCalls: 0,
        seen: new Map(),
        trivial: false,
      });
      touch(sessionID);
    },

    /**
     * Mark a session as a child (subagent) session without assigning a tier or
     * cap state. This is the agent-name-INDEPENDENT classifier: opencode reports
     * every child session — a `general`/`explore` dispatch, a markdown-defined
     * agent, an agent repointed through `subagentTiers`, or a plugin-created
     * grader — with a `parentID`, whereas `registerFromChatMessage` only ever
     * recognises a name that is literally an active tier.
     *
     * Deliberately sets NO cap state. Cap/redundancy banners are a tier-scoped
     * feature and `recordToolCall` early-returns without it, so an untiered
     * child keeps byte-identical tool output. The only thing this changes is
     * `isSubagent`, which is what suppresses the orchestrator delegation
     * protocol in the system.transform hook.
     */
    markChildSession(sessionID: string): void {
      if (!sessionID) return;
      subagentSessionIDs.add(sessionID);
      touch(sessionID);
    },

    /** Remove a session from tracking (used to clean up delegate producer sessions). */
    unregister(sessionID: string): void {
      evict(sessionID);
    },

    /**
     * Refresh a tracked session's idle stamp. Called when a tool call STARTS,
     * so that a session whose single tool call outlives the TTL is not evicted
     * mid-call by some other session's sweep — an eviction that would silently
     * drop cap enforcement for the rest of that session, because recordToolCall
     * returns early when the state is gone.
     *
     * Only touches sessions that are actually tracked. Touching unconditionally
     * is what created orphan lastTouch entries in the first place.
     */
    touchIfTracked(sessionID: string): boolean {
      if (!subagentCapState.has(sessionID)) return false;
      touch(sessionID);
      return true;
    },

    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
    },

    /**
     * Called from the chat.message hook. If the incoming message is directed
     * at a registered tier agent, records the session and initialises its cap state.
     * Accepts `tierNames` (from getActiveTiers) so this module doesn't need to
     * import protocol.ts.
     *
     * Resume detection: a re-registration of a session already tracked at the
     * SAME tier is a resumed dispatch (this is how an opencode task_id resume
     * manifests at the chat.message hook). A resume resets the per-dispatch
     * budget but preserves cumulative usage and read fingerprints.
     */
    registerFromChatMessage(
      input: { agent?: string; sessionID: string },
      output: unknown,
      cfg: RouterConfig,
      tierNames: string[],
    ): RegisterResult {
      if (!input.agent) return { registered: false, resumed: false };
      // Tier names map to themselves; pre-existing agents use subagentTiers.
      // resolveSubagentOverrides skips tier-name collisions, keeping these disjoint.
      const tierName = tierNames.includes(input.agent)
        ? input.agent
        : cfg.subagentTiers?.[input.agent];
      if (!tierName || !tierNames.includes(tierName)) {
        return { registered: false, resumed: false };
      }

      subagentSessionIDs.add(input.sessionID);

      const dispatchText = extractDispatchText(output);
      // CAP:none is honored only when the dispatch carries a justification
      // (a `reason:` line). An unjustified CAP:none falls back to the tier
      // baseline — prompt rules alone are advisory; this is the deterministic
      // enforcer of "uncapped requires a stated reason". Numeric CAP:N is
      // unaffected.
      //
      // The regex matches `reason:` ANYWHERE in the dispatch text, not only on
      // its own line. That is deliberate: this is a deterministic but
      // advisory-grade gate whose job is to make an unjustified CAP:none the
      // inconvenient path, not to adjudicate the quality of a justification.
      // An orchestrator that wants to defeat it can, and that is fine — the
      // config-derived guard budget, which never reads dispatch text, is the
      // real backstop.
      const parsed = parseCapDirective(dispatchText);
      const override =
        parsed === "none" && !/\breason:/i.test(dispatchText) ? null : parsed;
      const baseline =
        cfg.tierCaps?.[tierName] ?? DEFAULT_TIER_CAPS[tierName] ?? 5;
      const cap: Cap = override ?? baseline;
      const trivial = classifyTrivial(dispatchText, tierName, cfg);
      const existing = subagentCapState.get(input.sessionID);

      // Same-tier re-registration = resumed dispatch. Reset only the
      // per-dispatch budget; `seen` is PRESERVED so redundancy detection
      // carries across dispatches, and totalCalls keeps feeding the
      // cumulative ceiling.
      if (existing?.tierName === tierName) {
        existing.cap = cap;
        existing.calls = 0;
        existing.dispatches += 1;
        existing.trivial = trivial;
        touch(input.sessionID);
        return { registered: true, resumed: true };
      }

      // No prior state (first dispatch, or an idle-TTL sweep evicted it) or a
      // different tier on the same sessionID: fresh session, fresh counters.
      subagentCapState.set(input.sessionID, {
        tierName,
        cap,
        calls: 0,
        dispatches: 1,
        totalCalls: 0,
        seen: new Map(),
        trivial,
      });
      touch(input.sessionID);
      return { registered: true, resumed: false };
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
      // Touch AFTER the early return: touching first created a lastTouch entry
      // for every untracked session that ever ran a tool, and nothing else ever
      // removed it. Tracked sessions still refresh here, because the read-only
      // filter below runs later.
      touch(input.sessionID);
      if (!READ_ONLY_TOOLS.has(input.tool)) return;

      const fp = fingerprintToolCall(input.tool, input.args);
      const previousCall = state.seen.get(fp);
      const isRedundant = previousCall !== undefined;

      state.calls += 1;
      state.totalCalls += 1;
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

// ---------------------------------------------------------------------------
// Dispatch-facts registry (M6, plan 2.1.1, amendment A3)
//
// Remembers, per child session, what the router knew when it dispatched it: the typed
// facts, the agent and model that were actually dispatched, and the attempt id that
// outcome signals are scored under. Telemetry ingestion (src/routing/outcomes/ingest.ts)
// reads it to attribute `session.step.ended`, verdicts and false refusals; a child that is
// not registered here is never recorded.
//
// MODULE (process) scope, deliberately unlike the per-instance session store above: the host
// delivers the same event to the plugin instance of every live location (S3b), so every
// instance must see the same registry. Entries are TTL-swept with the existing store sweeper
// (index.ts calls `sweepDispatches` from the same idle sweep) and bounded in size.
// ---------------------------------------------------------------------------

/** `routing.detection` keys: how strongly the dispatch's acceptance checks detect a failure (D8). */
export type DetectionDepth = "deterministic" | "grader" | "none";

export interface DispatchInput {
  /** Typed task facts of the dispatch (1.2 `TaskFacts` is assignable). */
  facts: DecisionFacts;
  /** Agent id the child runs under (router tier or host agent). */
  agent: string;
  /** `provider/model` the child runs on, or null when it could not be resolved (nothing is recorded then). */
  model: string | null;
  /** Variant of that model; null/absent = `default` (A9). */
  variant?: string | null;
  /** Router tier that owns the dispatch, when there is one. */
  tier?: string | null;
  /** The dispatch's verification depth (`routing.detection` key, D8), carried for the engine; ingestion does not read it. */
  acceptance?: DetectionDepth | null;
  /** The orchestrator session that dispatched the child. */
  parentSessionID?: string | null;
  /** Attempt id outcomes are scored under. Default: `${childSessionID}:${attemptIndex}:${nonce}-${seq}`, unique across restarts. */
  attemptId?: string;
  /** Id of the decision row of this dispatch (2.2), so verdict/refusal rows can reference it. */
  decisionID?: string | null;
  /**
   * The agent the orchestrator NAMED for this dispatch before the router changed anything (a floor lift, an evidence switch): what a
   * later resume of the child that repeats it must not be allowed to move back (the host switches a resumed child to the agent the
   * resume names; QA-2.4-R3-1). Absent for a registration that is not an orchestrator dispatch (the runner's, a ladder step).
   */
  picked?: string | null;
  /** Kind of attempt (default `dispatch`; 2.3 ladder attempts pass `variant | retry | escalate`). */
  step?: LadderStepKind;
  /**
   * `false`: the instance that registered the child had outcome ingestion off (`routing.engine: static`), so no
   * instance may score this attempt (QA-2.3-6). The registry is process-wide and every plugin instance (one per
   * location) sees the child's events, so an instance in `shadow` would otherwise record the outcomes of a dispatch
   * whose own configuration said not to. Default `true`.
   */
  outcomes?: boolean;
  /**
   * QA-2.3-1a (integration 2.2 + 2.3): this registration corrects or completes the SAME execution of an already registered
   * child (the 2.2 router fixing a heuristic claim, or registering a child under its result), so the step context and the
   * execution-end state the registry has seen are kept, and whoever waits for the end keeps waiting. Default `false`: a
   * resume or a ladder attempt is a new execution and starts from nothing.
   */
  keepExecution?: boolean;
}

export interface DispatchRecord {
  readonly childSessionID: string;
  readonly facts: DecisionFacts;
  readonly agent: string;
  readonly model: string | null;
  readonly variant: string | null;
  readonly tier: string | null;
  readonly acceptance: DetectionDepth | null;
  readonly parentSessionID: string | null;
  readonly attemptId: string;
  /** 0 for the first registration of the child; +1 for each re-registration. Display only: it restarts at 0 after an eviction, `attemptId` never repeats. */
  readonly attemptIndex: number;
  readonly decisionID: string | null;
  /** See `DispatchInput.picked`. */
  readonly picked: string | null;
  readonly step: LadderStepKind;
  /** See `DispatchInput.outcomes`: false = ingestion was off where this child was registered. */
  readonly outcomes: boolean;
  readonly registeredAt: number;
}

interface DispatchSlot {
  record: DispatchRecord;
  lastTouch: number;
  /** Context size of the child's largest step of this registration (D11), or null until a step is observed. */
  stepTokens: number | null;
  /** The child's execution ended after this registration (`noteExecutionEnded`): every step event of it was seen. */
  ended: boolean;
  /** Callers of `awaitExecutionEnd` still waiting; settled with `true` at the end, `false` when the slot goes away. */
  waiters: Set<(ended: boolean) => void>;
}

/** Hard bound on remembered children; the oldest registration is dropped first. */
export const MAX_DISPATCH_RECORDS = 2000;
/** Execution-end event ids already applied (`noteExecutionEnded`), bounded, oldest first. */
const SEEN_END_CAP = 2048;
const seenEnds = new Set<string>();

const dispatchRegistry = new Map<string, DispatchSlot>();
/**
 * Process-wide attempt counter (QA-2.1-1). `attemptIndex` restarts at 0 whenever a child is re-registered after
 * an eviction (TTL, bound, session deletion), so `${child}:${index}` alone can name two different attempts, and
 * the store, which remembers scored attempt ids, would then drop the second attempt's outcome. The sequence
 * number makes every default attempt id unique within the process, and a random per-process component makes it unique
 * across restarts too (QA-2.1-R2-2): the outcome log outlives the process, and ids that repeat after a restart would
 * let `routing:stats` join a refusal to the wrong pass.
 */
let attemptSeq = 0;
const attemptNonce = randomBytes(4).toString("hex");

/** Remove a registration and release whoever waits for its execution end (the wait ends `false`); true when it existed. */
function dropDispatch(childSessionID: string): boolean {
  const slot = dispatchRegistry.get(childSessionID);
  if (slot === undefined) return false;
  dispatchRegistry.delete(childSessionID);
  for (const settle of [...slot.waiters]) settle(false);
  slot.waiters.clear();
  return true;
}

/**
 * Register (or re-register) the dispatch facts of a child session. Re-registering an existing child
 * (a resume, or a ladder attempt) starts a new attempt: the index moves on unless the caller supplies
 * `attemptId`, so one attempt is never scored twice. Returns the stored record.
 */
export function rememberDispatch(
  childSessionID: string,
  input: DispatchInput,
  nowMs: number = Date.now(),
): DispatchRecord {
  const previous = dispatchRegistry.get(childSessionID);
  const attemptIndex = previous === undefined ? 0 : previous.record.attemptIndex + 1;
  const record: DispatchRecord = Object.freeze({
    childSessionID,
    facts: input.facts,
    agent: input.agent,
    model: input.model,
    variant: input.variant ?? null,
    tier: input.tier ?? null,
    acceptance: input.acceptance ?? null,
    parentSessionID: input.parentSessionID ?? null,
    attemptId: input.attemptId ?? `${childSessionID}:${attemptIndex}:${attemptNonce}-${++attemptSeq}`,
    attemptIndex,
    decisionID: input.decisionID ?? null,
    picked: input.picked ?? null,
    step: input.step ?? "dispatch",
    outcomes: input.outcomes ?? true,
    registeredAt: nowMs,
  });
  // Delete first so a re-registration moves to the young end of the insertion order.
  // QA-2.3-1a: a registration of the same execution keeps what was observed of it (see `DispatchInput.keepExecution`).
  const carried = input.keepExecution === true ? previous : undefined;
  if (carried !== undefined) dispatchRegistry.delete(childSessionID);
  else dropDispatch(childSessionID);
  dispatchRegistry.set(childSessionID, {
    record, lastTouch: nowMs,
    stepTokens: carried?.stepTokens ?? null, ended: carried?.ended ?? false, waiters: carried?.waiters ?? new Set(),
  });
  while (dispatchRegistry.size > MAX_DISPATCH_RECORDS) {
    const oldest = dispatchRegistry.keys().next();
    if (oldest.done === true) break;
    dropDispatch(oldest.value);
  }
  return record;
}

/** The registered dispatch of a child session, or undefined (unknown, forgotten or swept). */
export function lookupDispatch(childSessionID: string): DispatchRecord | undefined {
  return dispatchRegistry.get(childSessionID)?.record;
}

/** Refresh a child's idle stamp (called on every recorded step so a long-running child is not swept). */
export function touchDispatch(childSessionID: string, nowMs: number = Date.now()): void {
  const slot = dispatchRegistry.get(childSessionID);
  if (slot !== undefined) slot.lastTouch = nowMs;
}

/**
 * Note the context size (D11: `input + cache.read + cache.write + output`) of a finished step of a registered
 * child. Phase 2.3: the delegate ladder reads it to decide resume vs fresh, whatever the engine mode, so it is
 * kept in memory here and never touches the disk. The largest value of the current registration wins: the
 * context only grows within a child, a duplicate delivery of an older step cannot lower it, and after a
 * compaction the larger number errs towards a fresh start. A re-registration (a resume, a ladder attempt)
 * starts from null. An unregistered child, or a value that is not a finite number >= 0, is ignored.
 */
export function noteStepContext(childSessionID: string, tokens: number, nowMs: number = Date.now()): void {
  const slot = dispatchRegistry.get(childSessionID);
  if (slot === undefined || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return;
  slot.stepTokens = slot.stepTokens === null ? tokens : Math.max(slot.stepTokens, tokens);
  slot.lastTouch = nowMs;
}

/**
 * The child execution ended (`session.execution.*`): the events are delivered in order, so every step event of the
 * registration has been noted. Marks the current registration and wakes the callers of `awaitExecutionEnd`. A child
 * that is not registered is ignored. Only a registration made after an earlier end can be marked by a later one,
 * because a re-registration starts with `ended: false`.
 */
export function noteExecutionEnded(childSessionID: string, nowMs: number = Date.now(), eventId?: string): void {
  // QA-2.3-R2-1: the host delivers the same event to the plugin instance of every live location (A3), and a lagging
  // instance can deliver it after the child was registered again; that stale copy must not mark the new registration
  // as ended. An event id is applied once per process; an event without an id cannot be told apart and is applied.
  if (typeof eventId === "string" && eventId !== "") {
    if (seenEnds.has(eventId)) return;
    seenEnds.add(eventId);
    while (seenEnds.size > SEEN_END_CAP) {
      const oldest = seenEnds.values().next();
      if (oldest.done === true) break;
      seenEnds.delete(oldest.value);
    }
  }
  const slot = dispatchRegistry.get(childSessionID);
  if (slot === undefined) return;
  slot.ended = true;
  slot.lastTouch = nowMs;
  for (const settle of [...slot.waiters]) settle(true);
  slot.waiters.clear();
}

/**
 * The context size of the **largest** step of the child's current registration (D11), or null: unknown, not
 * registered, or the execution end has not been seen since the registration (QA-2.3-2). The end event follows
 * every step event on the stream, so a number read before it may miss the final, largest step, which would make a
 * resume look safe when it is not; null leads the ladder to a fresh start (`unknown-tokens`).
 */
export function lastStepContext(childSessionID: string): number | null {
  const slot = dispatchRegistry.get(childSessionID);
  return slot !== undefined && slot.ended ? slot.stepTokens : null;
}

/**
 * Wait, at most `timeoutMs` and until `signal` aborts, for the child's execution end since its current
 * registration. Resolves `true` when it was seen (now or meanwhile), `false` on timeout, abort, or when the
 * registration is replaced or removed. Never rejects. The wait is the runner's only barrier against an end event
 * that is still queued behind the stream's earlier events.
 */
export function awaitExecutionEnd(childSessionID: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const slot = dispatchRegistry.get(childSessionID);
  if (slot === undefined) return Promise.resolve(false);
  if (slot.ended) return Promise.resolve(true);
  if (signal?.aborted === true || !(timeoutMs > 0)) return Promise.resolve(false);
  const waiters = slot.waiters;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    // A pending wait must never keep the process alive.
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    const onAbort = (): void => finish(false);
    function finish(ended: boolean): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiters.delete(finish);
      resolve(ended);
    }
    waiters.add(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Remove one child; true when it was registered. */
export function forgetDispatch(childSessionID: string): boolean {
  return dropDispatch(childSessionID);
}

/** Remove every child dispatched by `parentSessionID` (the orchestrator went away); returns what was removed. */
export function forgetDispatchesOf(parentSessionID: string): DispatchRecord[] {
  const removed: DispatchRecord[] = [];
  for (const [id, slot] of [...dispatchRegistry]) {
    if (slot.record.parentSessionID === parentSessionID && dropDispatch(id)) removed.push(slot.record);
  }
  return removed;
}

/** Evict every dispatch idle for >= ttlMs (future stamps are never evicted); returns how many. */
export function sweepDispatches(nowMs: number = Date.now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): number {
  let removed = 0;
  for (const [id, slot] of [...dispatchRegistry]) {
    if (nowMs - slot.lastTouch >= ttlMs && dropDispatch(id)) removed += 1;
  }
  return removed;
}

/** Number of registered children (tests, diagnostics). */
export function dispatchCount(): number {
  return dispatchRegistry.size;
}

/** Test-only: drop every registration. */
export function resetDispatchRegistry(): void {
  seenEnds.clear();
  for (const id of [...dispatchRegistry.keys()]) dropDispatch(id);
}

// ===========================================================================================================
// Phase 2.2 / 2.3 integration — the single-writer runner token (QA-2.2-1, QA-2.3-1). Self-contained block.
//
// The delegate runner (2.3) dispatches producer and grader children through the host's native `subagent` tool, and the
// host does NOT run `tool.execute.before` for those calls on measured versions 2.0.22 and 2.0.24. The mark is defensive
// for hosts that do: the dispatch router must not touch them, since the runner has already decided the agent and model#variant, writes
// the attempt's decision row and registers the child itself (one writer). The runner announces each native call here, just
// before it makes it, keyed by the calling session, the agent and a hash of the prompt; the router consumes the mark when
// the hook arrives and leaves the call alone. The router only looks at a call that carries the runner's own `description`
// (`runnerDescription`), so an orchestrator dispatch with the same agent and prompt can never spend the runner's mark
// (QA-INT-1); if another plugin rewrote the prompt on the way, a runner-titled call still finds its mark by (session, agent).
// Marks expire and are bounded, each has its own id for withdrawal (QA-INT-3), and the runner withdraws its own mark when
// the call returns, so a hook that never fires cannot leave a mark that would later swallow an orchestrator dispatch.
// ===========================================================================================================

/** A runner mark is honoured for at most this long. */
export const RUNNER_TOKEN_TTL_MS = 120_000;
/** Bound on live mark keys (oldest key dropped first). */
export const MAX_RUNNER_TOKENS = 256;
/** The `description` of a runner verification (grader) call. */
export const RUNNER_VERIFICATION_DESCRIPTION = "Router result verification";

/** The `description` the runner sends with a native call: `Router <agent> delegation`, or the verification text (no agent). */
export function runnerDescription(agent: string | undefined): string {
  return agent ? `Router ${agent} delegation` : RUNNER_VERIFICATION_DESCRIPTION;
}

interface RunnerMark {
  /** Unique per announcement: a withdrawal removes exactly its own mark (QA-INT-3). */
  readonly id: number;
  readonly expiresAt: number;
}

/** Marks per `parent \0 agent \0 sha1(prompt)`. */
const runnerTokens = new Map<string, RunnerMark[]>();
let runnerMarkSeq = 0;

export interface RunnerDispatchKey {
  /** The session whose tool context the runner dispatches under (`ToolContext.sessionID`, `event.sessionID` in the hook). */
  readonly parentSessionID: string;
  /** The agent the call names (the grader agent for a verification). */
  readonly agent: string;
  /** The exact prompt string of the call. */
  readonly prompt: string;
}

function runnerTokenPrefix(parentSessionID: string, agent: string): string {
  return `${parentSessionID}\u0000${agent}\u0000`;
}

function runnerTokenKey(key: RunnerDispatchKey): string {
  return `${runnerTokenPrefix(key.parentSessionID, key.agent)}${createHash("sha1").update(key.prompt).digest("hex")}`;
}

function liveMarks(marks: readonly RunnerMark[], nowMs: number): RunnerMark[] {
  return marks.filter((mark) => mark.expiresAt > nowMs);
}

/**
 * The runner is about to make a native `subagent` call: announce it. Returns a function that withdraws this announcement
 * (call it when the native call has returned); withdrawing a mark that was consumed or expired is a no-op, and it never
 * removes another announcement's mark.
 */
export function markRunnerDispatch(key: RunnerDispatchKey, nowMs: number = Date.now()): () => void {
  const id = runnerTokenKey(key);
  const mark: RunnerMark = { id: ++runnerMarkSeq, expiresAt: nowMs + RUNNER_TOKEN_TTL_MS };
  const marks = liveMarks(runnerTokens.get(id) ?? [], nowMs);
  marks.push(mark);
  runnerTokens.delete(id);
  runnerTokens.set(id, marks);
  while (runnerTokens.size > MAX_RUNNER_TOKENS) {
    const oldest = runnerTokens.keys().next();
    if (oldest.done === true) break;
    runnerTokens.delete(oldest.value);
  }
  return () => {
    const current = runnerTokens.get(id);
    if (current === undefined) return;
    const at = current.findIndex((candidate) => candidate.id === mark.id);
    if (at >= 0) current.splice(at, 1);
    if (current.length === 0) runnerTokens.delete(id);
  };
}

/** The hook for a native call arrived: true (and the mark is spent) when the runner announced exactly this call, else false. */
export function consumeRunnerDispatch(key: RunnerDispatchKey, nowMs: number = Date.now()): boolean {
  const id = runnerTokenKey(key);
  const marks = runnerTokens.get(id);
  if (marks === undefined) return false;
  const live = liveMarks(marks, nowMs);
  if (live.length === 0) {
    runnerTokens.delete(id);
    return false;
  }
  live.shift();
  if (live.length === 0) runnerTokens.delete(id);
  else runnerTokens.set(id, live);
  return true;
}

/**
 * QA-INT-1: the call carries the runner's title but its prompt is not the announced one (another plugin rewrote it). Spend the
 * oldest live mark of this session and agent, whatever its prompt; false when there is none.
 */
export function consumeRunnerDispatchLoose(key: { readonly parentSessionID: string; readonly agent: string }, nowMs: number = Date.now()): boolean {
  const prefix = runnerTokenPrefix(key.parentSessionID, key.agent);
  let bestKey: string | null = null;
  let best: RunnerMark | null = null;
  for (const [id, marks] of runnerTokens) {
    if (!id.startsWith(prefix)) continue;
    for (const mark of liveMarks(marks, nowMs)) {
      if (best === null || mark.expiresAt < best.expiresAt) {
        best = mark;
        bestKey = id;
      }
    }
  }
  if (best === null || bestKey === null) return false;
  const remaining = (runnerTokens.get(bestKey) ?? []).filter((mark) => mark.id !== best!.id);
  if (remaining.length === 0) runnerTokens.delete(bestKey);
  else runnerTokens.set(bestKey, remaining);
  return true;
}

/** Number of live runner marks (diagnostics, tests). */
export function runnerTokenCount(nowMs: number = Date.now()): number {
  let count = 0;
  for (const marks of runnerTokens.values()) count += liveMarks(marks, nowMs).length;
  return count;
}

/** Test-only: forget every mark. */
export function resetRunnerTokens(): void {
  runnerTokens.clear();
}
// ===== end of the 2.2 / 2.3 runner token block ===============================================================
