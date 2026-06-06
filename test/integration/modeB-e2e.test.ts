/**
 * test/integration/modeB-e2e.test.ts
 *
 * Proves Mode-B (plan-annotation-driven) delegation reuses the SAME
 * gate/ladder path as Mode A (GA-5 single path), plus a convergence
 * unit test confirming parseDoDFromAnnotation and parseDoDFromDispatch
 * produce identical DoD shapes (source field only differs).
 *
 * No live models, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { parseDoDFromAnnotation, parseDoDFromDispatch } from "../../src/verify/dod";

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

describe("Mode B end-to-end (plan-annotation)", () => {
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
  // B1: plan task with [acceptance] block; grader passes first try
  // -------------------------------------------------------------------------

  it("Mode B: a plan task with an [acceptance] block is verified and accepted first try", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = ['{"pass":true,"reasons":[]}'];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const acceptance =
      "[acceptance]\ncriteria: task A is correct\n[/acceptance]";

    const result: string = await hooks.tool.delegate.execute({
      task: "task A from the plan",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // B2: plan task escalates fast->medium through the same ladder, then accepted
  // -------------------------------------------------------------------------

  it("Mode B: a plan task escalates fast->medium through the same ladder, then accepted", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["no"]}',
      '{"pass":false,"reasons":["still no"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const acceptance =
      "[acceptance]\ncriteria: task B is correct\n[/acceptance]";

    const result: string = await hooks.tool.delegate.execute({
      task: "task B from the plan",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ accepted:");
    expect(producerCalls.length).toBe(3);
    expect(producerCalls[2]!.tier).toBe("medium");
    expect(producerCalls[1]!.text).toContain("[router escalation]");
  });

  // -------------------------------------------------------------------------
  // B3: convergence — annotation-sourced and dispatch-sourced DoD are identical
  //     except source field (GA-5 single path)
  // -------------------------------------------------------------------------

  it("Mode B convergence: annotation-sourced and dispatch-sourced DoD are identical except source (GA-5 single path)", () => {
    const block =
      "[acceptance]\ncriteria: the thing works\ncheck: fileExists path=out.txt\n[/acceptance]";

    const a = parseDoDFromAnnotation(block);
    const d = parseDoDFromDispatch(block);

    expect(a).not.toBeNull();
    expect(d).not.toBeNull();

    expect(a!.kind).toBe(d!.kind);
    expect(JSON.stringify(a!.checks)).toBe(JSON.stringify(d!.checks));
    expect(JSON.stringify(a!.criteria)).toBe(JSON.stringify(d!.criteria));
    expect(a!.deliverable).toBe(d!.deliverable);
    expect(a!.source).toBe("annotation");
    expect(d!.source).toBe("explicit");
  });
});
