/**
 * test/integration/resume-flow.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove subagent resume state
 * across two dispatch rounds (no live models, no network).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Fake ctx builder
// ---------------------------------------------------------------------------

type PluginContext = Parameters<typeof ModelRouterPlugin>[0];
type PluginHooks = Awaited<ReturnType<typeof ModelRouterPlugin>>;
type ChatMessageHook = NonNullable<PluginHooks["chat.message"]>;
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

function makeCtx(dir: string): PluginContext {
  return {
    directory: dir,
    worktree: dir,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => {},
    client: {
      session: {
        create: async () => ({
          data: { id: "sess_" + Math.random().toString(36).slice(2) },
        }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: "producer reply" }] },
        }),
      },
    },
  } as unknown as PluginContext;
}

function chatOutput(text: string): ChatMessageOutput {
  return {
    message: { content: text },
    parts: [{ type: "text", text }],
  } as unknown as ChatMessageOutput;
}

function toolOutput(output: string) {
  return { title: "read", output, metadata: {} };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resume flow", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-flow-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    // Redirect homedir so loadConfig never reads the real user state file.
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // Ensure MODEL_ROUTER_ENFORCE is clean.
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
  });

  afterEach(() => {
    // Restore HOME / USERPROFILE.
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedUserProfile !== undefined) {
      process.env.USERPROFILE = savedUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("resets per-dispatch read counts while preserving redundant fingerprints on resume", async () => {
    const hooks = await ModelRouterPlugin(makeCtx(dir));
    const chatMessage = hooks["chat.message"];
    const toolExecuteAfter = hooks["tool.execute.after"];
    expect(chatMessage).toBeTypeOf("function");
    expect(toolExecuteAfter).toBeTypeOf("function");
    if (!chatMessage || !toolExecuteAfter) {
      throw new Error("required plugin hooks were not registered");
    }

    const sessionID = "resume-e2e";
    const input = {
      tool: "read",
      sessionID,
      callID: "read-x-ts",
      args: { filePath: "x.ts" },
    };

    await chatMessage({ agent: "fast", sessionID }, chatOutput("lookup x.ts"));

    const firstOutput = toolOutput("data");
    await toolExecuteAfter(input, firstOutput);
    expect(firstOutput.output).toContain("[cap: 1/8]");
    expect(firstOutput.output).not.toContain("[⚠ REDUNDANT:");

    const redundantOutput = toolOutput("data");
    await toolExecuteAfter(input, redundantOutput);
    expect(redundantOutput.output).toContain("[cap: 2/8]");
    expect(redundantOutput.output).toContain("[⚠ REDUNDANT:");

    await chatMessage({ agent: "fast", sessionID }, chatOutput("lookup x.ts"));

    const resumedOutput = toolOutput("data");
    await toolExecuteAfter(input, resumedOutput);
    expect(resumedOutput.output).toContain("[cap: 1/8]");
    expect(resumedOutput.output).toContain("[⚠ REDUNDANT:");
  });

  it("leaves a never-resumed session's banners byte-identical", async () => {
    const hooks = await ModelRouterPlugin(makeCtx(dir));
    const chatMessage = hooks["chat.message"];
    const toolExecuteAfter = hooks["tool.execute.after"];
    if (!chatMessage || !toolExecuteAfter) {
      throw new Error("required plugin hooks were not registered");
    }

    const sessionID = "no-resume-e2e";
    await chatMessage({ agent: "fast", sessionID }, chatOutput("lookup things"));

    for (let i = 1; i <= 8; i += 1) {
      const out = toolOutput("data");
      await toolExecuteAfter(
        { tool: "read", sessionID, callID: `c${i}`, args: { filePath: `f${i}.ts` } },
        out,
      );
      expect(out.output).toContain(`[cap: ${i}/8]`);
      expect(out.output).not.toContain("CUMULATIVE BUDGET EXCEEDED");
    }
  });

  it("enforces the cumulative ceiling across repeated resumes", async () => {
    const hooks = await ModelRouterPlugin(makeCtx(dir));
    const chatMessage = hooks["chat.message"];
    const toolExecuteAfter = hooks["tool.execute.after"];
    if (!chatMessage || !toolExecuteAfter) {
      throw new Error("required plugin hooks were not registered");
    }

    const sessionID = "resume-ceiling-e2e";
    let last = "";
    let total = 0;
    // 5 dispatches x 2 reads: cap 3 per dispatch (never reached), ceiling 9.
    for (let round = 1; round <= 5; round += 1) {
      await chatMessage(
        { agent: "fast", sessionID },
        chatOutput(`round ${round} CAP:3`),
      );
      for (let call = 1; call <= 2; call += 1) {
        total += 1;
        const out = toolOutput("data");
        await toolExecuteAfter(
          {
            tool: "read",
            sessionID,
            callID: `r${round}c${call}`,
            args: { filePath: `r${round}c${call}.ts` },
          },
          out,
        );
        last = String(out.output);
        expect(last).not.toContain("CAP REACHED");
      }
    }
    expect(total).toBe(10);
    expect(last).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 10/9 across 5 dispatches");
  });

  it("re-runs acceptance gates on resumed-session task results", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const hooks = await ModelRouterPlugin(makeCtx(dir));
    const chatMessage = hooks["chat.message"];
    const toolExecuteAfter = hooks["tool.execute.after"];
    expect(chatMessage).toBeTypeOf("function");
    expect(toolExecuteAfter).toBeTypeOf("function");
    if (!chatMessage || !toolExecuteAfter) {
      throw new Error("required plugin hooks were not registered");
    }

    await chatMessage({ agent: "fast", sessionID: "child-resume" }, chatOutput("Create report."));
    await chatMessage({ agent: "fast", sessionID: "child-resume" }, chatOutput("Create report."));

    const output = {
      title: "resumed task result",
      output: "<task_result>\nDONE: done.\n</task_result>",
      metadata: { sessionId: "child-resume" },
    };

    await toolExecuteAfter(
      {
        tool: "task",
        sessionID: "orch",
        callID: "call-resume-gate",
        args: {
          subagent_type: "fast",
          prompt:
            "Create report.\n[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]",
        },
      },
      output,
    );

    expect(output.output).toContain("NOT ACCEPTED");
  });
});
