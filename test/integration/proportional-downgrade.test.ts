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
