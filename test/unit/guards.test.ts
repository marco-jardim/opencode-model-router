import { describe, it, expect } from "vitest";
import {
  newGuardState,
  isSelfScript,
  classify,
  evaluateGuards,
  updateState,
  recordBlock,
  forcingMessage,
  trajectoryMetrics,
  observationOk,
  type GuardPolicy,
  type GuardCall,
  type GuardState,
} from "../../src/guard/guards";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<GuardPolicy> = {}): GuardPolicy {
  return {
    budget: 8,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    blockSelfScript: true,
    deliverableFirst: true,
    deliverableSignal: null,
    ...overrides,
  };
}

function makeState(policy: GuardPolicy, overrides: Partial<GuardState> = {}): GuardState {
  return { ...newGuardState(policy), ...overrides };
}

// ---------------------------------------------------------------------------
// A) classify table
// ---------------------------------------------------------------------------

describe("classify", () => {
  const policy = makePolicy();

  it.each([
    ["finish", "finish"],
    ["return", "finish"],
    ["task_complete", "finish"],
  ])("tool=%s => finish", (tool, expected) => {
    expect(classify({ tool }, policy)).toBe(expected);
  });

  it.each([
    ["grep"],
    ["read"],
    ["glob"],
    ["ls"],
  ])("tool=%s => read", (tool) => {
    expect(classify({ tool }, policy)).toBe("read");
  });

  it.each([
    ["write"],
    ["edit"],
    ["patch"],
    ["bash"],
    ["multiedit"],
  ])("tool=%s (non-self-script) => mutation", (tool) => {
    // Use args that won't trigger self-script detection
    const call: GuardCall = { tool, args: { filePath: "src/foo.txt" } };
    expect(classify(call, policy)).toBe("mutation");
  });

  it("unknown tool 'foo' => other", () => {
    expect(classify({ tool: "foo" }, policy)).toBe("other");
  });

  it("write to x.sh (blockScriptWrites:true) => self_script", () => {
    const p = makePolicy({ blockScriptWrites: true });
    expect(classify({ tool: "write", args: { filePath: "x.sh" } }, p)).toBe("self_script");
  });

  it("write to x.sh DEFAULT (no blockScriptWrites) => mutation", () => {
    expect(classify({ tool: "write", args: { filePath: "x.sh" } }, policy)).toBe("mutation");
  });

  it("bash with node -e '...' => self_script", () => {
    expect(
      classify({ tool: "bash", args: { command: "node -e 'console.log(1)'" } }, policy),
    ).toBe("self_script");
  });
});

// ---------------------------------------------------------------------------
// B) isSelfScript
// ---------------------------------------------------------------------------

describe("isSelfScript", () => {
  const policy = makePolicy();

  it("write x.sh (blockScriptWrites:true opt-in) => true", () => {
    const p = makePolicy({ blockScriptWrites: true });
    expect(isSelfScript({ tool: "write", args: { filePath: "x.sh" } }, p)).toBe(true);
  });

  it("write x.sh DEFAULT (no blockScriptWrites) => false", () => {
    expect(isSelfScript({ tool: "write", args: { filePath: "x.sh" } }, policy)).toBe(false);
  });

  it("write x.txt => false", () => {
    expect(isSelfScript({ tool: "write", args: { filePath: "x.txt" } }, policy)).toBe(false);
  });

  it("bash 'npm test' => false", () => {
    expect(isSelfScript({ tool: "bash", args: { command: "npm test" } }, policy)).toBe(false);
  });

  it("bash 'tsc --noEmit' => false", () => {
    expect(isSelfScript({ tool: "bash", args: { command: "tsc --noEmit" } }, policy)).toBe(false);
  });

  it("bash 'cat > foo.mjs' => true (CAT_WRITE_RE)", () => {
    expect(isSelfScript({ tool: "bash", args: { command: "cat > foo.mjs" } }, policy)).toBe(true);
  });

  it("bash 'bash -c 'rm'' => true (BASH_C_RE)", () => {
    expect(isSelfScript({ tool: "bash", args: { command: "bash -c 'rm -rf /tmp/x'" } }, policy)).toBe(true);
  });

  it("heredoc => true (HEREDOC_RE)", () => {
    expect(
      isSelfScript({ tool: "bash", args: { command: "cat <<EOF\nhello\nEOF" } }, policy),
    ).toBe(true);
  });

  it("redirect to script => true (REDIRECT_SCRIPT_RE)", () => {
    expect(
      isSelfScript({ tool: "bash", args: { command: "echo hello > foo.sh" } }, policy),
    ).toBe(true);
  });

  it("inline node -c => true (INLINE_SCRIPT_RE)", () => {
    expect(
      isSelfScript({ tool: "bash", args: { command: "node -c script.js" } }, policy),
    ).toBe(true);
  });

  it("bash with empty command => false", () => {
    expect(isSelfScript({ tool: "bash", args: { command: "" } }, policy)).toBe(false);
  });

  it("bash with no args => false", () => {
    expect(isSelfScript({ tool: "bash" }, policy)).toBe(false);
  });

  it("non-bash/write tool => false", () => {
    expect(isSelfScript({ tool: "grep", args: { pattern: "foo" } }, policy)).toBe(false);
  });

  it("intent exemption: deliverableIsScript:true + write x.sh => false", () => {
    const p = makePolicy({ deliverableIsScript: true });
    expect(isSelfScript({ tool: "write", args: { filePath: "x.sh" } }, p)).toBe(false);
  });

  it("intent exemption: deliverablePath='build.sh' + write build.sh => false", () => {
    const p = makePolicy({ deliverablePath: "build.sh" });
    expect(isSelfScript({ tool: "write", args: { filePath: "build.sh" } }, p)).toBe(false);
  });

  it("deliverablePath='build.sh' + write other.sh (blockScriptWrites:true) => still true", () => {
    const p = makePolicy({ deliverablePath: "build.sh", blockScriptWrites: true });
    expect(isSelfScript({ tool: "write", args: { filePath: "other.sh" } }, p)).toBe(true);
  });

  it("bash 'bash   -c echo hi' with multiple spaces => true (BASH_C_RE uses \\s+)", () => {
    // BASH_C_RE = /\bbash\s+-c\b/i — note: this requires exactly one space but \s+ in test
    // The spec says "bash   -c" (multi-space) — but BASH_C_RE is /\bbash\s+-c\b/i
    // \s+ matches one or more whitespace, so "bash   -c" won't match /\bbash\s+-c\b/i (only one \s)
    // Actually the spec says \bbash\s+-c\b which has a single \s, not \s+.
    // The spec says test "bash   -c" (multi-space) still matches via \s+.
    // But the provided BASH_C_RE constant is /\bbash\s+-c\b/i which has \s+ (one or more).
    // Let me recheck: /\bbash\s+-c\b/i — yes, \s+ = one or more spaces. So multi-space works.
    expect(isSelfScript({ tool: "bash", args: { command: "bash   -c 'echo hi'" } }, policy)).toBe(true);
  });

  it("args via 'cmd' key (alternate key)", () => {
    expect(isSelfScript({ tool: "bash", args: { cmd: "bash -c 'x'" } }, policy)).toBe(true);
  });

  it("write using 'path' key (blockScriptWrites:true)", () => {
    const p = makePolicy({ blockScriptWrites: true });
    expect(isSelfScript({ tool: "write", args: { path: "run.py" } }, p)).toBe(true);
  });

  it("write using 'file' key (blockScriptWrites:true)", () => {
    const p = makePolicy({ blockScriptWrites: true });
    expect(isSelfScript({ tool: "edit", args: { file: "run.ts" } }, p)).toBe(true);
  });

  it("does not block writing source files by default", () => {
    expect(isSelfScript({ tool: "write", args: { filePath: "app.ts" } }, policy)).toBe(false);
    expect(isSelfScript({ tool: "write", args: { filePath: "src/index.js" } }, policy)).toBe(false);
    expect(isSelfScript({ tool: "edit", args: { filePath: "foo.py" } }, policy)).toBe(false);
  });

  it("blockScriptWrites:true + deliverableIsScript:true => false (intent exemption wins)", () => {
    const p = makePolicy({ blockScriptWrites: true, deliverableIsScript: true });
    expect(isSelfScript({ tool: "write", args: { filePath: "x.sh" } }, p)).toBe(false);
  });

  it("blockScriptWrites:true + deliverablePath:'build.sh' + write build.sh => false", () => {
    const p = makePolicy({ blockScriptWrites: true, deliverablePath: "build.sh" });
    expect(isSelfScript({ tool: "write", args: { filePath: "build.sh" } }, p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C) evaluateGuards clause table
// ---------------------------------------------------------------------------

describe("evaluateGuards", () => {
  const defaultPolicy = makePolicy({ deliverableSignal: "write:output.txt" });

  it("finish always allowed even when budget exhausted", () => {
    const state = makeState(defaultPolicy, { toolCallCount: 8, budget: 8 });
    const d = evaluateGuards(state, { tool: "finish" }, defaultPolicy);
    expect(d.allow).toBe(true);
    expect(d.guard).toBeNull();
  });

  it("finish allowed even when deliverableSignal set + not executed", () => {
    const state = makeState(defaultPolicy, { deliverableExecuted: false });
    const d = evaluateGuards(state, { tool: "return" }, defaultPolicy);
    expect(d.allow).toBe(true);
  });

  it("self_script denied (guard anti_self_script)", () => {
    const p = makePolicy({ deliverableSignal: "write:output.txt", blockScriptWrites: true });
    const state = makeState(p);
    const d = evaluateGuards(
      state,
      { tool: "write", args: { filePath: "run.sh" } },
      p,
    );
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("anti_self_script");
  });

  it("self_script with blockSelfScript:false => NOT denied by clause 2 (treated as mutation)", () => {
    const p = makePolicy({ blockSelfScript: false, blockScriptWrites: true, deliverableSignal: null });
    const state = makeState(p);
    const d = evaluateGuards(state, { tool: "write", args: { filePath: "run.sh" } }, p);
    expect(d.allow).toBe(true);
    expect(d.guard).toBeNull();
  });

  it("budget: toolCallCount=8, budget=8 => iteration_cap", () => {
    const p = makePolicy({ deliverableSignal: null });
    const state = makeState(p, { toolCallCount: 8, budget: 8 });
    const d = evaluateGuards(state, { tool: "grep", args: { pattern: "x" } }, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("iteration_cap");
  });

  it("budget: toolCallCount=7, budget=8 => not budget-denied", () => {
    const p = makePolicy({ deliverableSignal: null });
    const state = makeState(p, { toolCallCount: 7, budget: 8 });
    const d = evaluateGuards(state, { tool: "grep", args: { pattern: "x" } }, p);
    expect(d.guard).not.toBe("iteration_cap");
  });

  it("redundancy: seen has fp count=1, sameOpRetryCap=1, identical read => redundant_read", () => {
    const p = makePolicy({ sameOpRetryCap: 1, deliverableSignal: null });
    const state = makeState(p);
    // Prime the seen map with fingerprint count 1
    const call: GuardCall = { tool: "grep", args: { pattern: "foo", path: "src" } };
    // updateState once to register read
    updateState(state, call, { ok: false }, p);
    // Now evaluate same call again
    const d = evaluateGuards(state, call, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("redundant_read");
  });

  it("redundancy: different file => allow", () => {
    const p = makePolicy({ sameOpRetryCap: 1, deliverableSignal: null });
    const state = makeState(p);
    const call1: GuardCall = { tool: "grep", args: { pattern: "foo", path: "src" } };
    updateState(state, call1, { ok: false }, p);
    const call2: GuardCall = { tool: "grep", args: { pattern: "foo", path: "lib" } };
    const d = evaluateGuards(state, call2, p);
    expect(d.allow).toBe(true);
    expect(d.guard).not.toBe("redundant_read");
  });

  it("read_budget: consecutiveNonProducing=3, readDraftCap=3 => read_budget", () => {
    const p = makePolicy({ readDraftCap: 3, deliverableSignal: null });
    const state = makeState(p, { consecutiveNonProducing: 3 });
    const d = evaluateGuards(state, { tool: "read", args: { filePath: "x.ts" } }, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("read_budget");
  });

  it("read_budget: consecutiveNonProducing=2, readDraftCap=3 => allow", () => {
    const p = makePolicy({ readDraftCap: 3, deliverableSignal: null });
    const state = makeState(p, { consecutiveNonProducing: 2 });
    const d = evaluateGuards(state, { tool: "read", args: { filePath: "x.ts" } }, p);
    expect(d.guard).not.toBe("read_budget");
  });

  it("deliverable_first: signal set, not executed, read => deny", () => {
    const p = makePolicy({ deliverableSignal: "write:out.ts", deliverableFirst: true });
    const state = makeState(p, { deliverableExecuted: false });
    const d = evaluateGuards(state, { tool: "read", args: { filePath: "x.ts" } }, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("deliverable_first");
  });

  it("deliverable_first: deliverableSignal=null => allow", () => {
    const p = makePolicy({ deliverableSignal: null, deliverableFirst: true });
    const state = makeState(p, { deliverableExecuted: false });
    const d = evaluateGuards(state, { tool: "read", args: { filePath: "x.ts" } }, p);
    expect(d.allow).toBe(true);
    expect(d.guard).not.toBe("deliverable_first");
  });

  it("deliverable_first: deliverableExecuted=true => allow", () => {
    const p = makePolicy({ deliverableSignal: "write:out.ts", deliverableFirst: true });
    const state = makeState(p, { deliverableExecuted: true });
    const d = evaluateGuards(state, { tool: "read", args: { filePath: "x.ts" } }, p);
    expect(d.allow).toBe(true);
  });

  it("deliverable_first: mutation call is allowed (not blocked by clause 6)", () => {
    const p = makePolicy({ deliverableSignal: "write:output.json", deliverableFirst: true });
    const state = makeState(p, { deliverableExecuted: false });
    // .json is not a script extension so classify => mutation, not self_script
    const d = evaluateGuards(state, { tool: "write", args: { filePath: "output.json" } }, p);
    expect(d.allow).toBe(true);
  });

  it("clause precedence: self_script + toolCallCount>=budget => anti_self_script (clause 2 before 3)", () => {
    const p = makePolicy({ budget: 5, blockSelfScript: true, blockScriptWrites: true, deliverableSignal: null });
    const state = makeState(p, { toolCallCount: 5, budget: 5 });
    const d = evaluateGuards(
      state,
      { tool: "write", args: { filePath: "run.sh" } },
      p,
    );
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("anti_self_script");
  });

  it("does not block writing source files by default (critical regression)", () => {
    const p = makePolicy({ deliverableSignal: null });
    const state = makeState(p);
    for (const [tool, filePath] of [
      ["write", "app.ts"],
      ["write", "src/index.js"],
      ["edit", "foo.py"],
    ] as [string, string][]) {
      const call: GuardCall = { tool, args: { filePath } };
      expect(classify(call, p)).toBe("mutation");
      const d = evaluateGuards(state, call, p);
      expect(d.allow).toBe(true);
      expect(d.guard).toBeNull();
    }
  });

  it("blockScriptWrites:true write x.sh => evaluateGuards deny anti_self_script", () => {
    const p = makePolicy({ blockSelfScript: true, blockScriptWrites: true, deliverableSignal: null });
    const state = makeState(p);
    const d = evaluateGuards(state, { tool: "write", args: { filePath: "x.sh" } }, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("anti_self_script");
  });

  it("DEFAULT policy write x.sh => evaluateGuards allow (guard null)", () => {
    const p = makePolicy({ deliverableSignal: null });
    const state = makeState(p);
    const d = evaluateGuards(state, { tool: "write", args: { filePath: "x.sh" } }, p);
    expect(d.allow).toBe(true);
    expect(d.guard).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D) updateState transitions
// ---------------------------------------------------------------------------

describe("updateState", () => {
  it("read increments readCount, consecutiveNonProducing, seen", () => {
    const p = makePolicy();
    const s = makeState(p);
    const call: GuardCall = { tool: "grep", args: { pattern: "x", path: "src" } };
    updateState(s, call, { ok: false }, p);
    expect(s.readCount).toBe(1);
    expect(s.consecutiveNonProducing).toBe(1);
    expect(s.toolCallCount).toBe(1);
    // seen should have the fingerprint at count 1
    expect(s.seen.size).toBeGreaterThan(0);
  });

  it("mutation resets consecutiveNonProducing, sets deliverableExecuted+ttfa on first ok", () => {
    const p = makePolicy();
    const s = makeState(p, { consecutiveNonProducing: 2 });
    const call: GuardCall = { tool: "write", args: { filePath: "src/foo.txt" } };
    updateState(s, call, { ok: true }, p);
    expect(s.consecutiveNonProducing).toBe(0);
    expect(s.deliverableExecuted).toBe(true);
    expect(s.ttfa).toBe(1); // toolCallCount became 1 after increment
    expect(s.execCount).toBe(1);
  });

  it("mutation with ok:false does NOT set deliverableExecuted", () => {
    const p = makePolicy();
    const s = makeState(p);
    const call: GuardCall = { tool: "write", args: { filePath: "src/foo.txt" } };
    updateState(s, call, { ok: false }, p);
    expect(s.deliverableExecuted).toBe(false);
    expect(s.ttfa).toBeNull();
  });

  it("self_script increments selfScriptCount and consecutiveNonProducing", () => {
    const p = makePolicy({ blockScriptWrites: true });
    const s = makeState(p);
    updateState(s, { tool: "write", args: { filePath: "run.sh" } }, { ok: false }, p);
    expect(s.selfScriptCount).toBe(1);
    expect(s.consecutiveNonProducing).toBe(1);
    expect(s.toolCallCount).toBe(1);
  });

  it("finish no-ops (toolCallCount unchanged)", () => {
    const p = makePolicy();
    const s = makeState(p, { toolCallCount: 3 });
    updateState(s, { tool: "finish" }, { ok: true }, p);
    expect(s.toolCallCount).toBe(3);
    expect(s.readCount).toBe(0);
    expect(s.execCount).toBe(0);
  });

  it("read->read->mutation resets consecutiveNonProducing to 0", () => {
    const p = makePolicy();
    const s = makeState(p);
    updateState(s, { tool: "grep", args: { pattern: "a", path: "." } }, { ok: false }, p);
    updateState(s, { tool: "grep", args: { pattern: "b", path: "." } }, { ok: false }, p);
    expect(s.consecutiveNonProducing).toBe(2);
    updateState(s, { tool: "write", args: { filePath: "out.txt" } }, { ok: true }, p);
    expect(s.consecutiveNonProducing).toBe(0);
  });

  it("ttfa set once (second ok mutation doesn't change it)", () => {
    const p = makePolicy();
    const s = makeState(p);
    updateState(s, { tool: "write", args: { filePath: "a.txt" } }, { ok: true }, p);
    const firstTtfa = s.ttfa;
    updateState(s, { tool: "write", args: { filePath: "b.txt" } }, { ok: true }, p);
    expect(s.ttfa).toBe(firstTtfa);
  });

  it("'other' tool increments consecutiveNonProducing", () => {
    const p = makePolicy();
    const s = makeState(p);
    updateState(s, { tool: "foo" }, { ok: false }, p);
    expect(s.consecutiveNonProducing).toBe(1);
    expect(s.toolCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordBlock
// ---------------------------------------------------------------------------

describe("recordBlock", () => {
  it("increments blockedCount and sets lastBlock", () => {
    const p = makePolicy();
    const s = makeState(p);
    recordBlock(s, { allow: false, guard: "iteration_cap", observation: "denied" });
    expect(s.blockedCount).toBe(1);
    expect(s.lastBlock).toBe("iteration_cap");
    expect(s.redundantCount).toBe(0);
  });

  it("increments redundantCount for redundant_read", () => {
    const p = makePolicy();
    const s = makeState(p);
    recordBlock(s, { allow: false, guard: "redundant_read", observation: "denied" });
    expect(s.redundantCount).toBe(1);
    expect(s.blockedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E) forcingMessage formatting
// ---------------------------------------------------------------------------

describe("forcingMessage", () => {
  it("with signal not executed => contains 'deliverable=NOT RUN' and 'run the deliverable'", () => {
    const p = makePolicy({ deliverableSignal: "write:output.ts" });
    const s = makeState(p, { deliverableExecuted: false, toolCallCount: 3, consecutiveNonProducing: 2 });
    const msg = forcingMessage(s, p);
    expect(msg).toContain("deliverable=NOT RUN");
    expect(msg).toContain("run the deliverable");
    expect(msg).toContain("write:output.ts");
    expect(msg).toContain("budget 3/8");
    expect(msg).toContain("reads_since_produce=2");
  });

  it("signal null => 'deliverable=n/a' and 'take a producing action'", () => {
    const p = makePolicy({ deliverableSignal: null });
    const s = makeState(p);
    const msg = forcingMessage(s, p);
    expect(msg).toContain("deliverable=n/a");
    expect(msg).toContain("take a producing action");
  });

  it("executed => 'deliverable=ran'", () => {
    const p = makePolicy({ deliverableSignal: "write:output.ts" });
    const s = makeState(p, { deliverableExecuted: true });
    const msg = forcingMessage(s, p);
    expect(msg).toContain("deliverable=ran");
    expect(msg).toContain("take a producing action");
  });
});

// ---------------------------------------------------------------------------
// trajectoryMetrics
// ---------------------------------------------------------------------------

describe("trajectoryMetrics", () => {
  it("returns correct snake_case keys", () => {
    const p = makePolicy();
    const s = makeState(p, { readCount: 4, execCount: 2, ttfa: 3, toolCallCount: 6 });
    const m = trajectoryMetrics(s);
    expect(m.ttfa).toBe(3);
    expect(m.read_exec_ratio).toBe(2);
    expect(m.tool_call_count).toBe(6);
    expect(m.deliverable_executed).toBe(false);
    expect(m.blocked_count).toBe(0);
    expect(m.redundant_count).toBe(0);
    expect(m.consecutive_non_producing).toBe(0);
    expect(m.self_script_count).toBe(0);
  });

  it("read_exec_ratio when execCount=0 => readCount", () => {
    const p = makePolicy();
    const s = makeState(p, { readCount: 5, execCount: 0 });
    expect(trajectoryMetrics(s).read_exec_ratio).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// F) Property-based tests
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property-based: invariants over random sequences", () => {
  const tools = ["read", "grep", "write", "edit", "bash", "ls", "foo", "glob"];
  const fileOptions = ["src/a.ts", "src/b.ts", "lib/c.ts", "x.sh", "y.py"];

  function randomCall(rng: () => number): GuardCall {
    const tool = tools[Math.floor(rng() * tools.length)]!;
    const fileIdx = Math.floor(rng() * fileOptions.length);
    const file = fileOptions[fileIdx]!;
    switch (tool) {
      case "read":
        return { tool, args: { filePath: file } };
      case "grep":
        return { tool, args: { pattern: `pat${Math.floor(rng() * 3)}`, path: `dir${Math.floor(rng() * 2)}` } };
      case "glob":
        return { tool, args: { pattern: `**/*.ts`, path: `dir${Math.floor(rng() * 2)}` } };
      case "ls":
        return { tool, args: { path: `dir${Math.floor(rng() * 2)}` } };
      case "write":
        return { tool, args: { filePath: file } };
      case "edit":
        return { tool, args: { filePath: file } };
      case "bash":
        return { tool, args: { command: `npm test ${Math.floor(rng() * 5)}` } };
      default:
        return { tool };
    }
  }

  for (let seed = 1; seed <= 50; seed++) {
    it(`seed=${seed}: invariants hold over 200 calls`, () => {
      const rng = mulberry32(seed);
      const policy = makePolicy({
        budget: 20,
        readDraftCap: 4,
        sameOpRetryCap: 2,
        deliverableSignal: null,
        deliverableFirst: false,
      });
      const state = newGuardState(policy);
      let prevToolCallCount = 0;
      let consecutiveAllowedReads = 0;

      for (let i = 0; i < 200; i++) {
        // Inject a finish call every ~17 steps
        if (i > 0 && i % 17 === 0) {
          const fd = evaluateGuards(state, { tool: "finish" }, policy);
          expect(fd.allow).toBe(true);
        }

        const call = randomCall(rng);
        const d = evaluateGuards(state, call, policy);

        // invariant: never throws (already guaranteed by reaching here)

        // Track consecutive allowed reads
        if (d.allow) {
          const k = classify(call, policy);
          if (k === "read") {
            consecutiveAllowedReads += 1;
            // Should never exceed readDraftCap (clause 5 kicks in at =readDraftCap)
            expect(consecutiveAllowedReads).toBeLessThanOrEqual(policy.readDraftCap);
          } else if (k === "mutation" || k === "other") {
            consecutiveAllowedReads = 0;
          }
        }

        if (!d.allow) {
          recordBlock(state, d);
        }
        updateState(state, call, { ok: rng() > 0.3 }, policy);

        // toolCallCount is monotonic non-decreasing
        expect(state.toolCallCount).toBeGreaterThanOrEqual(prevToolCallCount);
        prevToolCallCount = state.toolCallCount;
      }
    });
  }
});

describe("property-based: termination", () => {
  it("model that only tries SAME read is blocked by clause 4 on 2nd call", () => {
    const p = makePolicy({
      budget: 20,
      readDraftCap: 10,
      sameOpRetryCap: 1,
      deliverableSignal: null,
    });
    const s = newGuardState(p);
    const call: GuardCall = { tool: "grep", args: { pattern: "x", path: "src" } };

    // First call should be allowed
    const d1 = evaluateGuards(s, call, p);
    expect(d1.allow).toBe(true);
    updateState(s, call, { ok: false }, p);

    // Second identical call => redundant_read
    const d2 = evaluateGuards(s, call, p);
    expect(d2.allow).toBe(false);
    expect(d2.guard).toBe("redundant_read");

    // All subsequent calls also denied
    for (let i = 0; i < 10; i++) {
      const d = evaluateGuards(s, call, p);
      expect(d.allow).toBe(false);
    }
  });

  it("model that only tries DIFFERENT reads is blocked by clause 5 at readDraftCap", () => {
    const p = makePolicy({
      budget: 30,
      readDraftCap: 3,
      sameOpRetryCap: 10,
      deliverableSignal: null,
    });
    const s = newGuardState(p);

    for (let i = 0; i < p.readDraftCap; i++) {
      const call: GuardCall = { tool: "grep", args: { pattern: `unique${i}`, path: "src" } };
      const d = evaluateGuards(s, call, p);
      expect(d.allow).toBe(true);
      updateState(s, call, { ok: false }, p);
    }

    // Now consecutive = readDraftCap, next read must be denied
    const after: GuardCall = { tool: "grep", args: { pattern: "new", path: "src" } };
    const d = evaluateGuards(s, after, p);
    expect(d.allow).toBe(false);
    expect(d.guard).toBe("read_budget");

    // Ensure every subsequent read attempt is also denied
    const totalSteps = p.budget + p.readDraftCap;
    for (let i = 0; i < totalSteps; i++) {
      const c: GuardCall = { tool: "grep", args: { pattern: `extra${i}`, path: "src" } };
      const dNext = evaluateGuards(s, c, p);
      expect(dNext.allow).toBe(false);
    }
  });
});

describe("observationOk", () => {
  it("empty string => true", () => {
    expect(observationOk("")).toBe(true);
  });
  it('"OK done" => true', () => {
    expect(observationOk("OK done")).toBe(true);
  });
  it('"DENIED: ..." => false', () => {
    expect(observationOk("DENIED: not allowed")).toBe(false);
  });
  it('"  Error: x" with leading whitespace => false', () => {
    expect(observationOk("  Error: something went wrong")).toBe(false);
  });
  it('"Traceback ..." => false', () => {
    expect(observationOk("Traceback (most recent call last)")).toBe(false);
  });
  it("non-string (number) => true", () => {
    expect(observationOk(123)).toBe(true);
  });
  it("undefined => true", () => {
    expect(observationOk(undefined)).toBe(true);
  });
  it("null => true", () => {
    expect(observationOk(null)).toBe(true);
  });
});