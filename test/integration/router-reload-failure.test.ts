import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ModelRouterPlugin from "../../src/index";
import {
  invalidateConfigCache,
  overridePath,
  getConfigReloadError,
} from "../../src/router/config";

interface ReloadInput {
  command: string;
  arguments: string;
}
interface ReloadOutput {
  parts: Array<{ text: string }>;
}

describe("router-reload — failed reload keeps the last valid config", () => {
  let hooks: Record<string, (input: ReloadInput, output: ReloadOutput) => Promise<void>>;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real overrides/state files are never touched.
    testHomeDir = join(
      tmpdir(),
      `oc-mr-reload-fail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
    hooks = (await ModelRouterPlugin({} as Parameters<typeof ModelRouterPlugin>[0])) as unknown as typeof hooks;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(testHomeDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  it("prefixes the summary with a FAILED line naming the file, then recovers", async () => {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ presets: { anthropic: { heavy: { model: "x/one" } } } }),
      "utf-8",
    );

    const ok = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router-reload", arguments: "" }, ok);
    expect(ok.parts[0].text.startsWith("Model router config reloaded.")).toBe(true);
    expect(getConfigReloadError()).toBeNull();

    // Half-saved override.
    writeFileSync(p, '{ "presets": { anthropic: ', "utf-8");
    const later = new Date(Date.now() + 60_000);
    utimesSync(p, later, later);

    const failed = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router-reload", arguments: "" }, failed);
    const text: string = failed.parts[0].text;
    expect(text.startsWith("Config reload FAILED — keeping last valid config:\n")).toBe(true);
    expect(text).toContain(p);
    // The last good summary still follows (the "x/one" heavy model is retained).
    expect(text).toContain("Tiers:");
    expect(text).toContain("x/one");

    // Fix the file: the next reload is clean again.
    writeFileSync(
      p,
      JSON.stringify({ presets: { anthropic: { heavy: { model: "x/two" } } } }),
      "utf-8",
    );
    const later2 = new Date(Date.now() + 120_000);
    utimesSync(p, later2, later2);

    const fixed = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router-reload", arguments: "" }, fixed);
    expect(fixed.parts[0].text.startsWith("Model router config reloaded.")).toBe(true);
    expect(fixed.parts[0].text).not.toContain("FAILED");
    expect(getConfigReloadError()).toBeNull();
  });

  it("on opencode v1 tells the user subagent models need a restart", async () => {
    const out = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router-reload", arguments: "" }, out);
    const text: string = out.parts[0].text;
    expect(text.startsWith("Model router config reloaded.")).toBe(true);
    expect(text).toContain(
      "Note: opencode v1 keeps subagent (task) models from startup; restart opencode to apply tier model changes to subagents.",
    );
    expect(text).toContain("Routing and protocol already use the new config.");
  });
});
