import { describe, it, expect, beforeEach, afterEach } from "vitest";
import ModelRouterPlugin from "../../src/index";

describe("proportional-downgrade integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedEnforce: string | undefined;

  beforeEach(async () => {
    savedEnforce = process.env.MODEL_ROUTER_ENFORCE;
    // Force enforced via env gate so guard fires when not trivial.
    process.env.MODEL_ROUTER_ENFORCE = "1";
    hooks = await ModelRouterPlugin({} as any);
  });

  afterEach(() => {
    if (savedEnforce === undefined) {
      delete process.env.MODEL_ROUTER_ENFORCE;
    } else {
      process.env.MODEL_ROUTER_ENFORCE = savedEnforce;
    }
  });

  it("trivial dispatch: self-script not hard-blocked (downgraded to advisory)", async () => {
    // Trivial text → isTrivial returns true → guard downgrades to advisory → no throw.
    await hooks["chat.message"](
      { sessionID: "TRIV", agent: "fast" },
      { parts: [{ type: "text", text: "grep for the handler function" }] },
    );
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "TRIV", tool: "bash", callID: "c1" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).resolves.toBeUndefined();
  });

  // Regression: multi-file @fast recon used to classify TRIVIAL, which silently
  // downgraded enforced -> advisory and made the read_budget guard unfireable on
  // any @fast subagent. The dispatch text below is verbatim from
  // test/smoke/guard-hardblock.smoke.test.ts, which is the real-session proof of
  // the same behaviour; this is its deterministic in-process counterpart.
  it("multi-file recon dispatch: self-script is hard-blocked (not trivial)", async () => {
    await hooks["chat.message"](
      { sessionID: "RECON", agent: "fast" },
      {
        parts: [
          {
            type: "text",
            text:
              "Read these files ONE AT A TIME using the read tool, in this exact order, " +
              "and after each give a one-line summary: README.md, then package.json, then " +
              "tsconfig.json, then tiers.json, then LICENSE, then src/index.ts. Use the " +
              "read tool separately for each file; do not skip any.",
          },
        ],
      },
    );
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "RECON", tool: "bash", callID: "c3" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).rejects.toThrow();
  });

  // Opposite arm: the narrowing must not over-correct. A genuine single-shot
  // lookup stays trivial and stays exempt (GA-6 proportionality).
  it("single-shot one-file lookup: still trivial, not hard-blocked", async () => {
    await hooks["chat.message"](
      { sessionID: "LOOKUP", agent: "fast" },
      {
        parts: [
          { type: "text", text: "read package.json and report the version field" },
        ],
      },
    );
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "LOOKUP", tool: "bash", callID: "c4" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).resolves.toBeUndefined();
  });

  it("non-trivial dispatch: self-script is hard-blocked", async () => {
    // Non-trivial text → isTrivial returns false → enforcement stays enforced → throws.
    await hooks["chat.message"](
      { sessionID: "REAL", agent: "fast" },
      { parts: [{ type: "text", text: "implement the api-endpoint and write-tests" }] },
    );
    await expect(
      hooks["tool.execute.before"](
        { sessionID: "REAL", tool: "bash", callID: "c2" },
        { args: { command: 'node -e "console.log(1)"' } },
      ),
    ).rejects.toThrow();
  });
});
