/**
 * test/integration/failover-compose.test.ts
 *
 * Phase 3.3: Documents and proves orthogonality of provider-failover advisory
 * (prompt-level) and quality-escalation ladder (runtime).
 *
 * No live models, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, validateConfig } from "../../src/router/config";
import { assembleSystemPrompt } from "../../src/router/protocol";

// ---------------------------------------------------------------------------
// Globally unique session counter (offset to avoid colliding with ladder-wiring).
// ---------------------------------------------------------------------------

let sessionCounter = 2000;

// ---------------------------------------------------------------------------
// Fake ctx builder — mirrors ladder-wiring.test.ts harness pattern exactly.
// ---------------------------------------------------------------------------

function makeCtxCustom(
  dir: string,
  promptHandler: (opts: any) => Promise<any>,
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
        prompt: promptHandler,
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Phase 3.3 — provider-failover / quality-escalation orthogonality", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pfo-"));
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
  // CASE A: API error folds into exactly one ladder attempt (no double-count)
  // -------------------------------------------------------------------------

  it("CASE A: an API error in a producer attempt folds into exactly one ladder attempt (no double-count, no provider swap)", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    let producerCallCount = 0;

    const promptHandler = async (opts: any): Promise<any> => {
      if (opts?.body?.system !== undefined) {
        // GRADER call (dispatchGrader always sets body.system)
        const promptText: string = opts?.body?.parts?.[0]?.text ?? "";
        if (promptText.includes("GOOD_RESULT")) {
          return {
            data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
          };
        }
        return {
          data: {
            parts: [
              {
                type: "text",
                text: '{"pass":false,"reasons":["missing GOOD_RESULT"]}',
              },
            ],
          },
        };
      }
      // PRODUCER call
      const callIndex = producerCallCount++;
      producerCalls.push({
        tier: opts?.body?.agent ?? "",
        text: opts?.body?.parts?.[0]?.text ?? "",
      });
      if (callIndex === 0) {
        throw new Error("simulated API/network error");
      }
      return {
        data: { parts: [{ type: "text", text: "GOOD_RESULT done" }] },
      };
    };

    process.env.MODEL_ROUTER_ENFORCE = "1";
    const hooks: any = await ModelRouterPlugin(
      makeCtxCustom(dir, promptHandler) as any,
    );

    // Note: acceptance criteria must NOT mention "GOOD_RESULT" directly.
    // If the criteria text contains the grader check-string, the grader prompt
    // will always contain it (even for empty output) and always return pass.
    // We decouple them: criteria is neutral; GOOD_RESULT appears only in the
    // producer output, which the grader prompt embeds verbatim.
    const acceptance =
      "[acceptance]\ncriteria: the task output is satisfactory\n[/acceptance]";
    const result: string = await hooks.tool.delegate.execute({
      task: "produce something good",
      acceptance,
      tier: "fast",
    });

    // Eventually accepted on attempt 2.
    expect(result).toContain("[router ✓ accepted:");
    expect(result).not.toContain("status: unmet");
    // Exactly 2 producer calls: the throwing attempt (counted as one failed ladder
    // attempt) plus one successful attempt. The API error did NOT spawn an extra
    // provider-retry call — it was folded into a single ladder attempt.
    expect(producerCalls.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // CASE B: Provider-failover advisory present regardless of enforcement
  // -------------------------------------------------------------------------

  it("CASE B: provider-failover advisory is present regardless of enforcement (orthogonal)", () => {
    const cfg = validateConfig(
      JSON.parse(readFileSync("tiers.json", "utf-8")),
    );

    const withoutEnf = assembleSystemPrompt(
      cfg,
      "anthropic/claude-haiku-4-5",
      false,
    );
    const withEnf = assembleSystemPrompt(
      cfg,
      "anthropic/claude-haiku-4-5",
      true,
    );

    // Provider-failover chain is present without enforcement.
    expect(withoutEnf).toContain("Chain:");
    // Provider-failover chain is ALSO present when enforcement is enabled.
    // Enabling enforcement must not strip the advisory — the two mechanisms
    // live in orthogonal layers and must coexist.
    expect(withEnf).toContain("Chain:");
  });

  // -------------------------------------------------------------------------
  // CASE C: Verification FAIL drives quality escalation, not provider retry
  // -------------------------------------------------------------------------

  it("CASE C: a genuine verification FAIL drives quality escalation, not a provider retry", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    let producerCallCount = 0;

    const promptHandler = async (opts: any): Promise<any> => {
      if (opts?.body?.system !== undefined) {
        // GRADER call
        const promptText: string = opts?.body?.parts?.[0]?.text ?? "";
        if (promptText.includes("GOOD_RESULT")) {
          return {
            data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
          };
        }
        return {
          data: {
            parts: [
              {
                type: "text",
                text: '{"pass":false,"reasons":["missing GOOD_RESULT"]}',
              },
            ],
          },
        };
      }
      // PRODUCER call
      const callIndex = producerCallCount++;
      producerCalls.push({
        tier: opts?.body?.agent ?? "",
        text: opts?.body?.parts?.[0]?.text ?? "",
      });
      // First two attempts yield wrong answer; third attempt yields the expected result.
      if (callIndex < 2) {
        return { data: { parts: [{ type: "text", text: "wrong answer" }] } };
      }
      return {
        data: { parts: [{ type: "text", text: "GOOD_RESULT done" }] },
      };
    };

    process.env.MODEL_ROUTER_ENFORCE = "1";
    const hooks: any = await ModelRouterPlugin(
      makeCtxCustom(dir, promptHandler) as any,
    );

    // Same decoupling as Case A: criteria text must not contain the grader
    // check-string, otherwise the grader prompt always matches regardless of
    // what the producer actually returned.
    const acceptance =
      "[acceptance]\ncriteria: the task output is satisfactory\n[/acceptance]";
    const result: string = await hooks.tool.delegate.execute({
      task: "produce something",
      acceptance,
      tier: "fast",
    });

    // Escalation must have engaged: at least 2 producer calls happened.
    expect(producerCalls.length).toBeGreaterThanOrEqual(2);
    // At least one call escalated to "medium" (quality escalation, not provider-retry
    // — a provider-retry would keep re-running on the same tier).
    expect(producerCalls.some((c) => c.tier === "medium")).toBe(true);
    // Tier sequence follows the ladder (fast → fast → medium): attempt 1 and 2 are
    // fast (retry-same-tier), attempt 3 escalates to medium (no intra-attempt duplicate).
    expect(producerCalls[0]!.tier).toBe("fast");
    expect(producerCalls[1]!.tier).toBe("fast");
    expect(producerCalls[2]!.tier).toBe("medium");
    // The result is either accepted (third attempt passed before cost ceiling) or
    // unmet (cost ceiling fired after recording medium cost). Either is valid —
    // what matters is no duplicate producer call was spawned per attempt.
    const isAccepted = result.includes("[router ✓ accepted:");
    const isUnmet = result.includes("[router status: unmet]");
    expect(isAccepted || isUnmet).toBe(true);
  });
});
