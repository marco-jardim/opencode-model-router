import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";

async function captureGraderParams(): Promise<Record<string, unknown>> {
  let hooks: any;
  const params: Record<string, unknown> = {};
  const graderSessionID = "grader-session";

  const ctx = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({ data: { id: graderSessionID } }),
        prompt: async (request: any) => {
          if (request.body.system !== undefined) {
            await hooks["chat.params"]({ sessionID: graderSessionID }, params);
            return {
              data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
            };
          }

          return { data: { parts: [{ type: "text", text: "producer output" }] } };
        },
      },
    } as any,
  };

  hooks = await ModelRouterPlugin(ctx as any);
  await hooks.tool.delegate.execute({
    task: "complete the task",
    tier: "fast",
    acceptance: "[acceptance]\ncriteria: result is correct\n[/acceptance]",
  });

  return params;
}

describe("grader temperature hook", () => {
  beforeEach(() => {
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  });

  afterEach(() => {
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
  });

  it("omits temperature when graderTemperature is undefined", async () => {
    const cfg = loadConfig();
    delete cfg.enforcement?.verify?.graderTemperature;

    await expect(captureGraderParams()).resolves.not.toHaveProperty("temperature");
  });

  it("keeps an explicitly configured zero grader temperature", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    await expect(captureGraderParams()).resolves.toHaveProperty("temperature", 0);
  });
});
