/**
 * test/integration/ladder-wiring.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove Layer-3 escalation
 * ladder wiring (retry-same-tier, escalate, give_up paths).
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
            data: { parts: [{ type: "text", text: "producer output" }] },
          };
        },
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Layer-3 escalation ladder wiring", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  const acceptance =
    "[acceptance]\ncriteria: the result is correct\n[/acceptance]";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml3-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
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
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // CASE A: retry within the same tier, then pass
  // -------------------------------------------------------------------------

  it("CASE A: retry-same-tier -> PASS", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["nope"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(2);
    expect(producerCalls[1]!.tier).toBe("fast");
    expect(producerCalls[1]!.text).toContain("[router escalation]");
  });

  // -------------------------------------------------------------------------
  // CASE B: exhaust fast retries, escalate to medium, then pass
  // -------------------------------------------------------------------------

  it("CASE B: escalate -> PASS", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["a"]}',
      '{"pass":false,"reasons":["b"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do y",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(3);
    expect(producerCalls[2]!.tier).toBe("medium");
  });

  // -------------------------------------------------------------------------
  // CASE C: exhaust all attempts, give_up
  // -------------------------------------------------------------------------

  it("CASE C: give_up after maxTotalAttempts", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    // Provide more than enough failures to ensure the queue never runs dry.
    const graderQueue = Array<string>(6).fill(
      '{"pass":false,"reasons":["bad"]}',
    );

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do z",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("attempt(s)");
    expect(result).not.toContain("[router ✓ accepted:");
    // fast(1)+fast(1)+medium(5)=7 > firstAttemptCost(1)*costMultiple(4)=4 → cost ceiling
    // fires after 3 attempts, not 4.
    expect(producerCalls.length).toBe(3);
  });
});
