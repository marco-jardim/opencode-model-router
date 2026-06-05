import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { loadConfig, invalidateConfigCache } from "../../src/router/config";

describe("router-command integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = join(tmpdir(), `oc-mr-router-cmd-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    invalidateConfigCache();
  });

  it("enforce enforced persists + reload", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, out);
    expect(out.parts[0].text).toContain("enforced");
    expect(out.parts[0].text).toContain("persisted");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("enforced");
  });

  it("enforce off persists", async () => {
    // Prime to enforced first so "off" is a meaningful state transition.
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, { parts: [] as any[] });
    invalidateConfigCache();

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce off" }, out);
    expect(out.parts[0].text).toContain("off");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("off");
  });

  it("enforce with no mode shows current + usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce" }, out);
    expect(out.parts[0].text).toContain("Usage:");
    expect(out.parts[0].text).toContain("Current enforcement mode");
  });

  it("invalid mode shows usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce loud" }, out);
    expect(out.parts[0].text).toContain("Usage:");
  });

  it("bare /router shows status", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    expect(out.parts[0].text).toContain("Enforcement:");
  });
});
