import { fingerprintToolCall } from "./fingerprint";
import { READ_ONLY_TOOLS } from "../router/sessions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardPolicy {
  budget: number;
  readDraftCap: number;
  sameOpRetryCap: number;
  blockSelfScript: boolean;
  deliverableFirst: boolean;
  deliverableSignal?: string | null;
  deliverablePath?: string | null;
  deliverableIsScript?: boolean;
  /** opt-in; default false. When true, WRITE/EDIT/PATCH/MULTIEDIT to a script-extension path is treated as self_script. Off by default because writing source files is the normal coding deliverable. */
  blockScriptWrites?: boolean;
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
  toolCallCount: number;
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
      observation: `DENIED: tool-call budget ${state.budget} exhausted. Stop now and emit your final answer with what you have.`,
    };
  }

  // CLAUSE 4: redundancy
  if (kind === "read" && (state.seen.get(fp) ?? 0) >= policy.sameOpRetryCap) {
    return {
      allow: false,
      guard: "redundant_read",
      observation: `DENIED: you already ran this exact read (${fp}). Reuse the result you already have; take a producing action or finish.`,
    };
  }

  // CLAUSE 5: read_budget
  if (kind === "read" && state.consecutiveNonProducing >= policy.readDraftCap) {
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
