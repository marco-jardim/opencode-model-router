import { describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";

describe("experimental.chat.system.transform", () => {
  it("adds a named system-prompt section for OpenCode 1.18+", async () => {
    const hooks = await ModelRouterPlugin({
      client: {},
      directory: process.cwd(),
    } as never);
    const output = { system: [] as Array<{ name: string; content: string }> };

    const input = { sessionID: "test-session", model: { providerID: "openai", modelID: "gpt-5" } };

    await Reflect.apply(hooks["experimental.chat.system.transform"]!, undefined, [input, output]);

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toMatchObject({
      name: "model-router",
      content: expect.any(String),
    });
  });
});
