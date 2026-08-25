import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, test } from "vitest";
import { buildAgentOptions } from "../../src/router/agent-options";
import { validateConfig } from "../../src/router/config";

describe("fable-effort preset", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const preset = validateConfig(raw).presets["fable-effort"];

  it("uses the same Fable 5 model across all tiers", () => {
    expect(preset.fast.model).toBe("anthropic/claude-fable-5");
    expect(preset.medium.model).toBe("anthropic/claude-fable-5");
    expect(preset.heavy.model).toBe("anthropic/claude-fable-5");
  });

  it("maps each tier to a distinct Anthropic effort", () => {
    expect(buildAgentOptions(preset.fast, "fast")).toEqual({ effort: "low" });
    expect(buildAgentOptions(preset.medium, "medium")).toEqual({ effort: "high" });
    expect(buildAgentOptions(preset.heavy, "heavy")).toEqual({ effort: "xhigh" });
  });

  it("leaves activePreset alone", () => {
    expect(validateConfig(raw).activePreset).toBe("anthropic");
  });
});

test("applies fable-effort preset options through config hook", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "model-router-fable-effort-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevEnforce = process.env.MODEL_ROUTER_ENFORCE;
  const prevVerifiedDelegate = process.env.MODEL_ROUTER_VERIFIED_DELEGATE;

  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";

    const { default: ModelRouterPlugin } = await import("../../src/index");
    const { invalidateConfigCache, writeState } = await import("../../src/router/config");
    invalidateConfigCache();
    writeState({ activePreset: "fable-effort" });

    const hooks: any = await ModelRouterPlugin(makeFableEffortCtx(dir) as any);
    const ocCfg: any = {};
    await hooks.config(ocCfg);

    expect(ocCfg.agent.fast.model).toBe("anthropic/claude-fable-5");
    expect(ocCfg.agent.fast.options.effort).toBe("low");
    expect(ocCfg.agent.medium.model).toBe("anthropic/claude-fable-5");
    expect(ocCfg.agent.medium.options.effort).toBe("high");
    expect(ocCfg.agent.heavy.model).toBe("anthropic/claude-fable-5");
    expect(ocCfg.agent.heavy.options.effort).toBe("xhigh");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevEnforce === undefined) delete process.env.MODEL_ROUTER_ENFORCE;
    else process.env.MODEL_ROUTER_ENFORCE = prevEnforce;
    if (prevVerifiedDelegate === undefined) delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    else process.env.MODEL_ROUTER_VERIFIED_DELEGATE = prevVerifiedDelegate;

    const { invalidateConfigCache } = await import("../../src/router/config");
    invalidateConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
});

test("registers an effort key only for the tiers that set one", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "model-router-no-effort-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevEnforce = process.env.MODEL_ROUTER_ENFORCE;
  const prevVerifiedDelegate = process.env.MODEL_ROUTER_VERIFIED_DELEGATE;

  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";

    const { default: ModelRouterPlugin } = await import("../../src/index");
    const { invalidateConfigCache, writeState } = await import("../../src/router/config");
    invalidateConfigCache();
    writeState({ activePreset: "anthropic" });

    const hooks: any = await ModelRouterPlugin(makeFableEffortCtx(dir) as any);
    const ocCfg: any = {};
    await hooks.config(ocCfg);

    // The bundled anthropic preset sets `effort: "high"` on medium only, and
    // medium is an Anthropic model, so it maps onto `effort` (not
    // `reasoning_effort`). fast and heavy set no effort and so carry no key.
    for (const name of ["fast", "heavy"]) {
      const options = ocCfg.agent[name].options;
      if (options !== undefined) {
        expect(options).not.toHaveProperty("effort");
        expect(options).not.toHaveProperty("reasoning_effort");
      }
    }

    const mediumOptions = ocCfg.agent.medium.options;
    expect(mediumOptions.effort).toBe("high");
    expect(mediumOptions).not.toHaveProperty("reasoning_effort");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevEnforce === undefined) delete process.env.MODEL_ROUTER_ENFORCE;
    else process.env.MODEL_ROUTER_ENFORCE = prevEnforce;
    if (prevVerifiedDelegate === undefined) delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    else process.env.MODEL_ROUTER_VERIFIED_DELEGATE = prevVerifiedDelegate;

    const { invalidateConfigCache } = await import("../../src/router/config");
    invalidateConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
});

function makeFableEffortCtx(dir: string) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: { create: async () => ({ data: { id: "s" } }) },
      prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
    } as any,
  };
}
