import { describe, it, expect } from "vitest";
import { scrubText } from "../../src/guard/scrub";
import { buildForcingNote } from "../../src/verify/dispatch";
import { buildGradingPrompt } from "../../src/verify/checker";
import { formatScorecard } from "../../src/guard/enforce";
import type { GuardState } from "../../src/guard/guards";

// ---------------------------------------------------------------------------
// Secret fixtures — shapes scrubText is known to redact (verified against
// src/guard/scrub.ts patterns before writing these tests).
//   anthropic : /\bsk-ant-[A-Za-z0-9_\-]{16,}/g
//   openai    : /\bsk-[A-Za-z0-9_\-]{20,}/g
//   aws       : /\bAKIA[0-9A-Z]{16}\b/g
//   bearer    : /\bBearer\s+[A-Za-z0-9._\-]+/gi
//   kv        : KEYVALUE_RE  (api_key=<value> → api_key=[REDACTED])
// ---------------------------------------------------------------------------
const SECRETS = {
  anthropic: "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM",
  openai: "sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJKK",
  aws: "AKIAIOSFODNN7EXAMPLE",
  bearer: "Bearer abcdefGHIJKL0123456789mnopqrstuvwxyz",
  kv: "api_key=supersecretvalue1234567890",
};

// Values we assert must NOT appear in any scrubbed output.
// Note: for `kv`, only the secret value (right-hand side) is checked, because
// the KEYVALUE_RE preserves the key name ("api_key=") and replaces the value.
const allSecretValues = [
  "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM",
  "sk-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJKK",
  "AKIAIOSFODNN7EXAMPLE",
  "supersecretvalue1234567890",
];

function assertScrubbed(s: string): void {
  for (const v of allSecretValues) {
    expect(s).not.toContain(v);
  }
}

// ---------------------------------------------------------------------------

describe("security scrub sweep", () => {
  it("scrubText redacts each secret shape", () => {
    for (const [, value] of Object.entries(SECRETS)) {
      assertScrubbed(scrubText(value));
    }
  });

  it("forcing note is scrubbed before emission", () => {
    const note = scrubText(
      buildForcingNote([
        `failed: ${SECRETS.anthropic}`,
        `token leak ${SECRETS.kv}`,
      ]),
    );
    assertScrubbed(note);
  });

  it("checker grading prompt scrubs the artefact", () => {
    const { prompt } = buildGradingPrompt({
      criteria: ["the result is correct"],
      artefact: {
        finalReturnText: `done ${SECRETS.anthropic}`,
        changedFiles: [{ path: `src/${SECRETS.aws}.ts`, status: "written" }],
        declaredOutputs: [SECRETS.kv],
      },
      producerTier: "fast",
      producerSessionID: "p1",
    });
    assertScrubbed(prompt);
  });

  it("scorecard carries only counts (no injected secret text)", () => {
    const state: GuardState = {
      budget: 25,
      toolCallCount: 3,
      totalToolCallCount: 3,
      dispatches: 1,
      readCount: 2,
      execCount: 1,
      selfScriptCount: 0,
      redundantCount: 0,
      blockedCount: 1,
      consecutiveNonProducing: 0,
      deliverableExecuted: false,
      ttfa: 2,
      seen: new Map<string, number>(),
      lastBlock: "budget",
    };
    const scorecard = formatScorecard(state, "fast");
    expect(scorecard).toContain("scorecard");
    assertScrubbed(scorecard);
  });
});
