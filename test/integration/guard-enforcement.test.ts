import { describe, it, expect } from "vitest";
import { createGuardStore } from "../../src/guard/store";
import {
  guardBeforeCall,
  guardAfterCall,
  DEFAULT_GUARD_BUDGET,
} from "../../src/guard/enforce";
import type { RouterConfig } from "../../src/router/config";

describe("guard-enforcement integration", () => {
  // 1: OFF mode — state never created, output unchanged [GA-1]
  it("1: OFF mode — state never created, output unchanged [GA-1]", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "off" } } as unknown as RouterConfig;
    const sid = "s1";
    const env: Record<string, string | undefined> = {};
    const readArgs = { file_path: "a.ts" };

    // First read
    const r1 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: readArgs, store, env });
    expect(r1.block).toBe(false);
    const out1 = { output: "original" };
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: readArgs, output: out1, store });
    expect(out1.output).toBe("original");

    // Second read (would trigger redundant_read in enforced mode)
    const r2 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: readArgs, store, env });
    expect(r2.block).toBe(false);
    const out2 = { output: "original2" };
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: readArgs, output: out2, store });
    expect(out2.output).toBe("original2");

    // Guard state was never created in off mode
    expect(store.get(sid)).toBeUndefined();
  });

  // 2: OFF via env override
  it("2: OFF via env='0' wins over enforced config", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced" } } as unknown as RouterConfig;
    const env = { MODEL_ROUTER_ENFORCE: "0" };
    const r = guardBeforeCall({
      cfg,
      tier: null,
      sessionID: "s2",
      tool: "bash",
      toolArgs: { command: 'node -e "console.log(1)"' },
      store,
      env,
    });
    expect(r.block).toBe(false);
    expect(r.mode).toBe("off");
  });

  // 3: ENFORCED via env override + self-script bash
  it("3: ENFORCED via env='1' + self-script bash => block with anti_self_script", () => {
    const store = createGuardStore();
    const cfg = {} as unknown as RouterConfig;
    const env = { MODEL_ROUTER_ENFORCE: "1" };
    const r = guardBeforeCall({
      cfg,
      tier: null,
      sessionID: "s3",
      tool: "bash",
      toolArgs: { command: 'node -e "console.log(1)"' },
      store,
      env,
    });
    expect(r.block).toBe(true);
    expect(r.guard).toBe("anti_self_script");
    expect(r.message).toContain("throwaway script");
    expect(r.message).toContain("NEXT:");
  });

  // 4: ENFORCED budget counter increments on blocked self-script calls
  it("4: ENFORCED blocked calls increment budget counter in message", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced" } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const callParams = {
      cfg,
      tier: null,
      sessionID: "s4",
      tool: "bash",
      toolArgs: { command: 'node -e "console.log(1)"' },
      store,
      env,
    };

    const r1 = guardBeforeCall(callParams);
    expect(r1.block).toBe(true);
    expect(r1.message).toContain(`budget 1/${DEFAULT_GUARD_BUDGET}`);

    const r2 = guardBeforeCall(callParams);
    expect(r2.block).toBe(true);
    expect(r2.message).toContain(`budget 2/${DEFAULT_GUARD_BUDGET}`);
  });

  // 5: ENFORCED duplicate read blocks on second attempt
  it("5: ENFORCED duplicate read => redundant_read block", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced" } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const sid = "s5";
    const args = { file_path: "a.ts" };

    // First read: allowed + after
    const r1 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, store, env });
    expect(r1.block).toBe(false);
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, output: { output: "contents" }, store });

    // Second identical read: blocked
    const r2 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, store, env });
    expect(r2.block).toBe(true);
    expect(r2.guard).toBe("redundant_read");
  });

  // 6: ENFORCED read budget exhausted after 3 consecutive reads
  it("6: ENFORCED read budget exhausted — 4th distinct read blocked", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced" } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const sid = "s6";

    for (const f of ["a.ts", "b.ts", "c.ts"]) {
      const a = { file_path: f };
      const r = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: a, store, env });
      expect(r.block).toBe(false);
      guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: a, output: { output: "ok" }, store });
    }

    // 4th distinct read hits the read_budget clause
    const r4 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: { file_path: "d.ts" }, store, env });
    expect(r4.block).toBe(true);
    expect(r4.guard).toBe("read_budget");
  });

  // 7: ENFORCED budget ceiling: budget=2, two writes then third call blocked
  it("7: ENFORCED budget ceiling (budget=2) — 3rd call blocked with iteration_cap", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced", guard: { budget: 2 } } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const sid = "s7";

    for (const f of ["out.json", "out2.json"]) {
      const a = { filePath: f };
      const r = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: a, store, env });
      expect(r.block).toBe(false);
      guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: a, output: { output: "ok" }, store });
    }

    const r3 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out3.json" }, store, env });
    expect(r3.block).toBe(true);
    expect(r3.guard).toBe("iteration_cap");
  });

  // 8: ADVISORY duplicate read — no block, advisory banner appended to output
  it("8: ADVISORY duplicate read — not blocked, banner appended to output", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "advisory" } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const sid = "s8";
    const args = { file_path: "a.ts" };

    // First read: allowed + after
    const r1 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, store, env });
    expect(r1.block).toBe(false);
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, output: { output: "first contents" }, store });

    // Second identical read: advisory never blocks
    const r2 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, store, env });
    expect(r2.block).toBe(false);
    expect(r2.guard).toBe("redundant_read");

    // Simulate execution, then after-hook appends banner
    const out2 = { output: "second contents" };
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "read", toolArgs: args, output: out2, store });
    expect(String(out2.output)).toContain("GUARD:redundant_read");
  });

  // 9: ENFORCED write to .ts source file is NOT self-script (regression guard)
  it("9: ENFORCED write to source .ts file is never blocked", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced" } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const r = guardBeforeCall({
      cfg,
      tier: null,
      sessionID: "s9",
      tool: "write",
      toolArgs: { filePath: "src/foo.ts" },
      store,
      env,
    });
    expect(r.block).toBe(false);
  });

  // 10: guardAfterCall ok=false when output starts with "Error"; toolCallCount still advances
  it("10: guardAfterCall ok=false on error output; budget still advances", () => {
    const store = createGuardStore();
    const cfg = { enforcement: { mode: "enforced", guard: { budget: 3 } } } as unknown as RouterConfig;
    const env: Record<string, string | undefined> = {};
    const sid = "s10";

    // Write 1: error output => ok:false, but toolCallCount still increments to 1
    const r1 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out.json" }, store, env });
    expect(r1.block).toBe(false);
    const out1 = { output: "Error: boom" };
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out.json" }, output: out1, store });
    // No pending note in enforced mode; output is unchanged
    expect(out1.output).toBe("Error: boom");

    // Write 2: toolCallCount=1 < 3 => allowed
    const r2 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out2.json" }, store, env });
    expect(r2.block).toBe(false);
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out2.json" }, output: { output: "ok" }, store });

    // Write 3: toolCallCount=2 < 3 => allowed
    const r3 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out3.json" }, store, env });
    expect(r3.block).toBe(false);
    guardAfterCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out3.json" }, output: { output: "ok" }, store });

    // Write 4: toolCallCount=3 >= budget=3 => iteration_cap (proves write 1 was counted)
    const r4 = guardBeforeCall({ cfg, tier: null, sessionID: sid, tool: "write", toolArgs: { filePath: "out4.json" }, store, env });
    expect(r4.block).toBe(true);
    expect(r4.guard).toBe("iteration_cap");
  });
});
