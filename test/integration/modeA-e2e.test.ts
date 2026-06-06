/**
 * test/integration/modeA-e2e.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove the Mode-A
 * on-the-fly enforcement loop (auto-inferred DoD, escalation, proportional
 * verify-gate skipping).
 *
 * No live models, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Globally unique session counter (prevents duplicate IDs across all tests).
// ---------------------------------------------------------------------------

let sessionCounter = 0;

// ---------------------------------------------------------------------------
// Fake ctx builder
// ---------------------------------------------------------------------------

function makeCtxWithQueues(
  dir: string,
  producerCalls: Array<{ tier: string; text: string }>,
  graderQueue: string[],
  counters?: { grader: number },
  producerText: string = "producer output",
) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({
          data: { id: `sess_${sessionCounter++}` },
        }),
        prompt: async (opts: any) => {
          if (opts?.body?.system !== undefined) {
            // GRADER call (dispatchGrader always sets body.system)
            if (counters) counters.grader++;
            const text =
              graderQueue.shift() ?? '{"pass":true,"reasons":[]}';
            return { data: { parts: [{ type: "text", text }] } };
          }
          // PRODUCER call
          producerCalls.push({
            tier: opts?.body?.agent ?? "",
            text: opts?.body?.parts?.[0]?.text ?? "",
          });
          return {
            data: { parts: [{ type: "text", text: producerText }] },
          };
        },
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Mode A end-to-end enforcement loop", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml3-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
  });

  afterEach(() => {
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
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // T1: auto-inferred DoD; false-finish then escalate fast->fast->medium
  // -------------------------------------------------------------------------

  it("Mode A: auto-inferred DoD; false-finish then escalate fast->fast->medium => accepted", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["nope"]}',
      '{"pass":false,"reasons":["still"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "implement the feature",
      tier: "fast",
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(3);
    expect(producerCalls[2]!.tier).toBe("medium");
    expect(producerCalls[1]!.text).toContain("[router escalation]");
    expect(producerCalls[2]!.text).toContain("[router escalation]");
  });

  // -------------------------------------------------------------------------
  // T2: first-try success => single attempt, no escalation
  // -------------------------------------------------------------------------

  it("Mode A: first-try success => single attempt, no escalation", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = ['{"pass":true,"reasons":[]}'];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "implement the feature",
      tier: "fast",
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(producerCalls.length).toBe(1);
    expect(producerCalls[0]!.text).not.toContain("[router escalation]");
  });

  // -------------------------------------------------------------------------
  // T3: producer never produces + grader all-FAIL => honest give_up
  // -------------------------------------------------------------------------

  it("Mode A: producer never produces + grader all-FAIL => honest give_up", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = Array(6).fill('{"pass":false,"reasons":["bad"]}');

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue, undefined, "") as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "implement the feature",
      tier: "fast",
    });

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("attempt(s)");
    expect(result).not.toContain("[router ✓ accepted:");
    expect(producerCalls.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // T4: proportional GA-6 trivial fast Option(i) task NOT verified
  // -------------------------------------------------------------------------

  it("Mode A proportional GA-6: trivial fast Option(i) task NOT verified (grader uncalled, output unchanged)", async () => {
    const counters = { grader: 0 };
    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, [], [], counters) as any,
    );

    process.env.MODEL_ROUTER_ENFORCE = "1";
    invalidateConfigCache();

    await hooks["chat.message"](
      { sessionID: "CHILD_T4", agent: "fast" },
      { parts: [{ type: "text", text: "grep for the thing" }] },
    );

    const out: any = {
      output: "<task_result>found it</task_result>",
      metadata: { sessionId: "CHILD_T4" },
    };

    await hooks["tool.execute.after"](
      {
        tool: "task",
        sessionID: "ORCH_T4",
        args: { subagent_type: "fast", prompt: "grep for the thing" },
      },
      out,
    );

    expect(out.output).toBe("<task_result>found it</task_result>");
    expect(counters.grader).toBe(0);
  });
});
