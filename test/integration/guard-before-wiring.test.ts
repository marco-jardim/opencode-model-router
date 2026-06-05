import { describe, it, expect, beforeEach, afterEach } from "vitest";
import ModelRouterPlugin from "../../src/index";

describe("guard-before-wiring integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedEnforce: string | undefined;

  beforeEach(async () => {
    savedEnforce = process.env.MODEL_ROUTER_ENFORCE;
    hooks = await ModelRouterPlugin({} as any);
    // Register "SUB" as a subagent session by passing agent:"fast"
    // which matches the "fast" tier key in the default anthropic preset.
    await hooks["chat.message"]({ sessionID: "SUB", agent: "fast" }, { parts: [] });
  });

  afterEach(() => {
    if (savedEnforce === undefined) {
      delete process.env.MODEL_ROUTER_ENFORCE;
    } else {
      process.env.MODEL_ROUTER_ENFORCE = savedEnforce;
    }
  });

  // (a) ENFORCED: self-script is hard-blocked for a registered subagent.
  it("(a) ENFORCED: self-script bash command is hard-blocked", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "SUB", tool: "bash", callID: "c1" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).rejects.toThrow(/NEXT:/);
  });

  // (b) ENFORCED: unregistered (orchestrator) session is never guarded.
  it("(b) ENFORCED: orchestrator session is not guarded", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "ORCH", tool: "bash", callID: "c2" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).resolves.toBeUndefined();
  });

  // (c) GA-1: enforcement off — byte-identical behaviour (no guard activity).
  it("(c) GA-1: enforcement off — no throw and no GUARD: text injected", async () => {
    delete process.env.MODEL_ROUTER_ENFORCE;

    // before-hook must not throw even for a self-script
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "SUB", tool: "bash", callID: "c3" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).resolves.toBeUndefined();

    // after-hook must not inject "GUARD:" advisory text
    const out = { output: "ORIGINAL" };
    await hooks["tool.execute.after"](
      { sessionID: "SUB", tool: "read", args: { file_path: "a.ts" }, callID: "c4" },
      out,
    );
    expect(out.output).toContain("ORIGINAL");
    expect(out.output).not.toMatch(/GUARD:/);
  });

  // (d) ENFORCED: redundant read is blocked on the second attempt.
  it("(d) ENFORCED: second identical read is blocked as redundant", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";

    // First read — must be allowed
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "SUB", tool: "read", callID: "r1" },
        { args: { file_path: "a.ts" } },
      ),
    ).resolves.toBeUndefined();

    // Simulate execution: after-hook records the read into guard state
    await hooks["tool.execute.after"](
      { sessionID: "SUB", tool: "read", args: { file_path: "a.ts" }, callID: "r1" },
      { output: "file contents" },
    );

    // Second identical read — must be blocked
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "SUB", tool: "read", callID: "r2" },
        { args: { file_path: "a.ts" } },
      ),
    ).rejects.toThrow();
  });
});
