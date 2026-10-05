import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
// Keep this hook test independent of Git processes and background suite runs.
vi.mock("../../src/verify/tree", () => ({ snapshotTree: async () => undefined }));

async function captureGraderParams(
  params: Record<string, unknown> = {},
  temperatureCapability?: boolean,
): Promise<Record<string, unknown>> {
  let hooks: any;
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
            await hooks["chat.params"]({ sessionID: graderSessionID, model: { capabilities: { temperature: temperatureCapability } } }, params);
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

  it("preserves a pre-existing temperature when graderTemperature is undefined", async () => {
    const cfg = loadConfig();
    delete cfg.enforcement?.verify?.graderTemperature;

    await expect(captureGraderParams({ temperature: 0.8 })).resolves.toHaveProperty(
      "temperature",
      0.8,
    );
  });

  it("omits temperature when graderTemperature is null", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = null;

    await expect(captureGraderParams()).resolves.not.toHaveProperty("temperature");
  });

  it.each([false, true, undefined])("removes a pre-existing temperature when graderTemperature is null with capability %s", async (capability) => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = null;

    await expect(
      captureGraderParams({ temperature: 0.8 }, capability),
    ).resolves.not.toHaveProperty("temperature");
  });

  it("keeps an explicitly configured zero grader temperature", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    await expect(captureGraderParams({ temperature: 0.8 })).resolves.toHaveProperty(
      "temperature",
      0,
    );
  });

  it.each([false, true, undefined])("respects the host temperature capability %s", async (capability) => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0.65;

    const params = await captureGraderParams({}, capability);
    if (capability === false) expect(params).not.toHaveProperty("temperature");
    else expect(params).toHaveProperty("temperature", 0.65);
  });
});
