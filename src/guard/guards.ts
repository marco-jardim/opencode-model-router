import { fingerprintToolCall } from "./fingerprint";
import { READ_ONLY_TOOLS } from "../router/sessions";
import { REFUSAL_CAP } from "../router/guard-profile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardPolicy {
  budget: number;
  /** Cumulative tool-call ceiling across resumed dispatches. Unset = no ceiling. */
  cumulativeBudget?: number;
  readDraftCap: number;
  sameOpRetryCap: number;
  blockSelfScript: boolean;
  deliverableFirst: boolean;
  deliverableSignal?: string | null;
  deliverablePath?: string | null;
  deliverableIsScript?: boolean;
  /** opt-in; default false. When true, WRITE/EDIT/PATCH/MULTIEDIT to a script-extension path is treated as self_script. Off by default because writing source files is the normal coding deliverable. */
  blockScriptWrites?: boolean;
  /**
   * Reader profile (§2.9 E6): reading is the work, so there is no read/draft
   * (consecutive-non-producing) denial and the forcing message never asks for a
   * write. Absent/false = producer profile (unchanged).
   */
  reader?: boolean;
  /** Role budget (§2.6): on exhaustion the child is told to return `NEED MORE: budget` with a progress summary. */
  needMoreOnExhaustion?: boolean;
}

export interface GuardCall {
  tool: string;
  args?: Record<string, unknown>;
}

export type GuardKind = "finish" | "read" | "mutation" | "self_script" | "other";

export interface GuardDecision {
  allow: boolean;
  guard: string | null;
  observation: string | null;
}

export interface GuardState {
  budget: number;
  /** Tool calls in the CURRENT dispatch (reset by guardStore.beginDispatch). */
  toolCallCount: number;
  /** Tool calls across all dispatches of this session (never reset). */
  totalToolCallCount: number;
  /** Dispatch rounds seen for this session (1 on first dispatch). */
  dispatches: number;
  readCount: number;
  execCount: number;
  selfScriptCount: number;
  redundantCount: number;
  blockedCount: number;
  consecutiveNonProducing: number;
  deliverableExecuted: boolean;
  ttfa: number | null;
  seen: Map<string, number>;
  lastBlock: string | null;
  /**
   * Enforced denials in dispatch round `round` (§2.9 E6). A denied call is not
   * charged to the budget, so this separate count bounds a loop of refused calls.
   * Set lazily; absent = none.
   */
  denied?: { round: number; count: number };
  /** Dispatch round whose policy last set `budget` (QA-P15-1-9: a resume takes its own budget). Set lazily. */
  budgetRound?: number;
}

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

const SCRIPT_EXT_RE = /\.(mjs|sh|py|js|ts|cjs|bash)\b/i;
const HEREDOC_RE = /<<-?\s*['"]?[A-Za-z_]/;
const REDIRECT_SCRIPT_RE = />\s*\S+\.(mjs|sh|py|js|ts|cjs|bash)\b/i;
const INLINE_SCRIPT_RE = /\b(node|python3?|deno|bun)\s+-(e|c)\b/i;
const CAT_WRITE_RE = /\bcat\s+>\s*\S/i;
const BASH_C_RE = /\bbash\s+-c\b/i;

// Upper bound on the command length we are willing to scan with the regexes
// above. Several of them are polynomial on adversarial input (CodeQL
// js/polynomial-redos), and a shell command this long is itself a signal.
// Truncating instead would let padding push a redirect past the scan window, so
// an over-length command is flagged, not waved through.
const MAX_GUARD_SCAN_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Write tools set (module-level)
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

// ---------------------------------------------------------------------------
// newGuardState
// ---------------------------------------------------------------------------

export function newGuardState(policy: GuardPolicy): GuardState {
  return {
    budget: policy.budget,
    toolCallCount: 0,
    totalToolCallCount: 0,
    dispatches: 1,
    readCount: 0,
    execCount: 0,
    selfScriptCount: 0,
    redundantCount: 0,
    blockedCount: 0,
    consecutiveNonProducing: 0,
    deliverableExecuted: false,
    ttfa: null,
    seen: new Map(),
    lastBlock: null,
  };
}

// ---------------------------------------------------------------------------
// isSelfScript
// ---------------------------------------------------------------------------

export function isSelfScript(call: GuardCall, policy: GuardPolicy): boolean {
  const args = call.args ?? {};
  const target = String(args.filePath ?? args.path ?? args.file ?? "");

  // Intent exemption: deliverableIsScript === true => never self-script
  if (policy.deliverableIsScript === true) return false;

  // deliverablePath exemption
  if (policy.deliverablePath != null && policy.deliverablePath !== "") {
    if (target === policy.deliverablePath) return false;
  }

  // bash/shell ad-hoc execution (DEFAULT signal, always evaluated)
  if (call.tool === "bash" || call.tool === "shell") {
    const cmd = String(args.command ?? args.cmd ?? "");
    if (!cmd) return false;
    // Fail closed: too long to scan safely, so treat it as suspicious.
    if (cmd.length > MAX_GUARD_SCAN_CHARS) return true;
    return (
      HEREDOC_RE.test(cmd) ||
      REDIRECT_SCRIPT_RE.test(cmd) ||
      INLINE_SCRIPT_RE.test(cmd) ||
      CAT_WRITE_RE.test(cmd) ||
      BASH_C_RE.test(cmd)
    );
  }

  // WRITE-to-script (OPT-IN): only when blockScriptWrites === true
  if (WRITE_TOOLS.has(call.tool)) {
    if (policy.blockScriptWrites !== true) return false;
    return SCRIPT_EXT_RE.test(target);
  }

  return false;
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

const FINISH_TOOLS = new Set(["finish", "return", "task_complete"]);
const MUTATION_TOOLS = new Set(["write", "edit", "patch", "bash", "multiedit"]);

export function classify(call: GuardCall, policy: GuardPolicy): GuardKind {
  if (FINISH_TOOLS.has(call.tool)) return "finish";
  if (isSelfScript(call, policy)) return "self_script";
  if (READ_ONLY_TOOLS.has(call.tool)) return "read";
  if (MUTATION_TOOLS.has(call.tool)) return "mutation";
  return "other";
}

// ---------------------------------------------------------------------------
// evaluateGuards
// ---------------------------------------------------------------------------

export function evaluateGuards(
  state: GuardState,
  call: GuardCall,
  policy: GuardPolicy,
): GuardDecision {
  const fp = fingerprintToolCall(call.tool, call.args);
  let kind = classify(call, policy);

  // If blockSelfScript is false, treat self_script as mutation
  if (kind === "self_script" && policy.blockSelfScript === false) {
    kind = "mutation";
  }

  // CLAUSE 1: finish
  if (kind === "finish") {
    return { allow: true, guard: null, observation: null };
  }

  // CLAUSE 2: self_script
  if (kind === "self_script") {
    return {
      allow: false,
      guard: "anti_self_script",
      observation:
        "DENIED: do not author or run a throwaway script. Do the task directly — write/edit the real target file, or run the actual build/test command.",
    };
  }

  // CLAUSE 3: budget
  if (state.toolCallCount >= state.budget) {
    return {
      allow: false,
      guard: "iteration_cap",
      observation: `DENIED: tool-call budget ${state.budget} exhausted. ${stopInstruction(policy)}`,
    };
  }

  // CLAUSE 3b: cumulative budget across resumed dispatches. Without this, a
  // session that keeps getting resumed gets a fresh per-dispatch budget every
  // round — an unbounded loop that CLAUSE 3 alone cannot see.
  if (
    policy.cumulativeBudget !== undefined &&
    state.totalToolCallCount >= policy.cumulativeBudget
  ) {
    return {
      allow: false,
      guard: "cumulative_iteration_cap",
      observation: `DENIED: cumulative tool-call budget ${policy.cumulativeBudget} exhausted across ${state.dispatches} dispatches. ${stopInstruction(policy)}`,
    };
  }

  // CLAUSE 3c: refused calls. A denied call is not charged to the budget
  // (§2.9 E6), so a model that keeps repeating refused calls would never reach
  // CLAUSE 3; after min(budget, REFUSAL_CAP) refusals in this dispatch every
  // call is refused (QA-P15-1-4).
  if (refusalsSpent(state)) {
    return {
      allow: false,
      guard: "denied_cap",
      observation: `DENIED: ${deniedThisDispatch(state)} refused tool calls in this dispatch (limit ${refusalCap(state)}). ${stopInstruction(policy)}`,
    };
  }

  // CLAUSE 4: redundancy
  if (kind === "read" && (state.seen.get(fp) ?? 0) >= policy.sameOpRetryCap) {
    const next = policy.reader === true
      ? "continue with a different call or finish"
      : "take a producing action or finish";
    return {
      allow: false,
      guard: "redundant_read",
      observation: `DENIED: you already ran this exact read (${fp}). Reuse the result you already have; ${next}.`,
    };
  }

  // CLAUSE 5: read_budget — producer profile only (§2.9 E6: a reader's reads are its work)
  if (
    kind === "read" &&
    policy.reader !== true &&
    state.consecutiveNonProducing >= policy.readDraftCap
  ) {
    return {
      allow: false,
      guard: "read_budget",
      observation: `DENIED: read/draft budget exhausted (${policy.readDraftCap} consecutive non-producing actions). Take a producing action now (write/edit) or finish.`,
    };
  }

  // CLAUSE 6: deliverable_first
  if (
    policy.deliverableFirst !== false &&
    policy.deliverableSignal != null &&
    state.deliverableExecuted === false &&
    (kind === "read" || kind === "other")
  ) {
    return {
      allow: false,
      guard: "deliverable_first",
      observation: `DENIED: you have not produced the deliverable yet. Your next action must be the deliverable (${policy.deliverableSignal}) before further exploration.`,
    };
  }

  // CLAUSE 7: allow
  return { allow: true, guard: null, observation: null };
}

// ---------------------------------------------------------------------------
// updateState
// ---------------------------------------------------------------------------

export function updateState(
  state: GuardState,
  call: GuardCall,
  opts: { ok: boolean },
  policy: GuardPolicy,
): GuardState {
  const kind = classify(call, policy);

  // finish: no count
  if (kind === "finish") return state;

  state.toolCallCount += 1;
  state.totalToolCallCount += 1;

  const fp = fingerprintToolCall(call.tool, call.args);

  if (kind === "self_script") {
    state.selfScriptCount += 1;
    state.consecutiveNonProducing += 1;
    return state;
  }

  if (kind === "mutation") {
    state.execCount += 1;
    state.consecutiveNonProducing = 0;
    if (opts.ok && !state.deliverableExecuted) {
      state.deliverableExecuted = true;
      state.ttfa = state.toolCallCount;
    }
    return state;
  }

  if (kind === "read") {
    state.readCount += 1;
    state.consecutiveNonProducing += 1;
    state.seen.set(fp, (state.seen.get(fp) ?? 0) + 1);
    return state;
  }

  // other
  state.consecutiveNonProducing += 1;
  return state;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

/** What a budget denial tells the child to do. */
function stopInstruction(policy: GuardPolicy): string {
  return policy.needMoreOnExhaustion === true
    ? "Stop now and return `NEED MORE: budget` with a progress summary: what is done, what remains, and the evidence so far."
    : "Stop now and emit your final answer with what you have.";
}

/** Enforced denials counted in the current dispatch round. */
function deniedThisDispatch(state: GuardState): number {
  return state.denied?.round === state.dispatches ? state.denied.count : 0;
}

/** Refusals allowed in one dispatch round: min(budget, REFUSAL_CAP). */
export function refusalCap(state: GuardState): number {
  return Math.min(state.budget, REFUSAL_CAP);
}

/** True when this dispatch round reached its refusal cap (CLAUSE 3c). */
export function refusalsSpent(state: GuardState): boolean {
  return deniedThisDispatch(state) >= refusalCap(state);
}

/** The guard stops the child: its budget is spent or its refusals are (budgetExhausted reports this). */
export function guardStopped(
  state: GuardState,
  policy: Pick<GuardPolicy, "cumulativeBudget">,
): boolean {
  return budgetSpent(state, policy) || refusalsSpent(state);
}

/** True when no further call fits the per-dispatch or the cumulative budget. */
export function budgetSpent(
  state: GuardState,
  policy: Pick<GuardPolicy, "cumulativeBudget">,
): boolean {
  return (
    state.toolCallCount >= state.budget ||
    (policy.cumulativeBudget !== undefined &&
      state.totalToolCallCount >= policy.cumulativeBudget)
  );
}

// ---------------------------------------------------------------------------
// recordDenied
// ---------------------------------------------------------------------------

/**
 * Record a call the guard REFUSED (§2.9 E6). It did not run, so it is not
 * charged: the tool-call counts, the read/draft streak, the repeat-check
 * fingerprints and the deliverable state stay as they were. Only the attempt
 * metrics move: the per-dispatch denial count (CLAUSE 3c) and, for a refused
 * throwaway script, the self-script count the scorecard reports.
 */
export function recordDenied(
  state: GuardState,
  call: GuardCall,
  policy: GuardPolicy,
): GuardState {
  if (classify(call, policy) === "self_script") state.selfScriptCount += 1;
  state.denied = { round: state.dispatches, count: deniedThisDispatch(state) + 1 };
  return state;
}

// ---------------------------------------------------------------------------
// recordBlock
// ---------------------------------------------------------------------------

export function recordBlock(
  state: GuardState,
  decision: GuardDecision,
): GuardState {
  state.lastBlock = decision.guard;
  state.blockedCount += 1;
  if (decision.guard === "redundant_read") state.redundantCount += 1;
  return state;
}

// ---------------------------------------------------------------------------
// forcingMessage
// ---------------------------------------------------------------------------

export function forcingMessage(state: GuardState, policy: GuardPolicy): string {
  const deliverable =
    policy.deliverableSignal == null
      ? "n/a"
      : state.deliverableExecuted
        ? "ran"
        : "NOT RUN";

  const next =
    policy.deliverableSignal != null && !state.deliverableExecuted
      ? `run the deliverable (${policy.deliverableSignal})`
      : refusalsSpent(state) || (policy.needMoreOnExhaustion === true && budgetSpent(state, policy))
        ? policy.needMoreOnExhaustion === true
          ? "return `NEED MORE: budget` with a progress summary"
          : "emit your final answer"
        : policy.reader === true
          ? "emit your final answer"
          : "take a producing action (write/edit) or emit your final answer";

  return `[budget ${state.toolCallCount}/${state.budget} | deliverable=${deliverable} | reads_since_produce=${state.consecutiveNonProducing}] NEXT: ${next}`;
}

// ---------------------------------------------------------------------------
// trajectoryMetrics
// ---------------------------------------------------------------------------

export function trajectoryMetrics(state: GuardState): Record<string, unknown> {
  return {
    ttfa: state.ttfa,
    read_exec_ratio:
      state.execCount === 0 ? state.readCount : state.readCount / state.execCount,
    self_script_count: state.selfScriptCount,
    tool_call_count: state.toolCallCount,
    total_tool_call_count: state.totalToolCallCount,
    dispatches: state.dispatches,
    deliverable_executed: state.deliverableExecuted,
    blocked_count: state.blockedCount,
    redundant_count: state.redundantCount,
    consecutive_non_producing: state.consecutiveNonProducing,
  };
}

// ---------------------------------------------------------------------------
// observationOk
// ---------------------------------------------------------------------------

const ERROR_PREFIXES = [
  "DENIED",
  "BLOCKED",
  "Error",
  "error:",
  "ERROR",
  "Exception",
  "Traceback",
  "FAIL",
  "failed:",
];

/**
 * Heuristic: did a tool result indicate success? Used by the after-hook to set
 * `ok` for updateState so a FAILED mutation does not mark the deliverable as
 * executed. Mirrors the reference observationOk: empty/non-string => ok (no
 * evidence of failure); otherwise false only when the (left-trimmed) text
 * starts with a known error prefix.
 */
export function observationOk(output: unknown): boolean {
  const s = typeof output === "string" ? output.trimStart() : "";
  if (s.length === 0) return true;
  return !ERROR_PREFIXES.some((p) => s.startsWith(p));
}
