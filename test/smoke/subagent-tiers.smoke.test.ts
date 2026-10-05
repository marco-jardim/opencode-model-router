/**
 * Smoke test: verify `subagentTiers` actually repoints a pre-existing agent
 * inside a real opencode, by reading back the resolved agent config with
 * `opencode debug agent <name>`.
 *
 * This is the only coverage of the `config` hook wiring in src/index.ts —
 * unit tests cover the pure resolution in src/router/subagents.ts, but the
 * hook itself is only exercised by a real plugin load.
 *
 * Determinism: opencode is spawned with HOME/USERPROFILE pointed at a temp dir so the
 * developer's `opencode-model-router.state.json` (which overlays activePreset
 * and outranks the override file) cannot change which preset is active.
 *
 * GATED: runs only when RUN_OC_SMOKE=1 AND invoked with the smoke config:
 *   RUN_OC_SMOKE=1 npx vitest run --config vitest.smoke.config.ts \
 *     test/smoke/subagent-tiers.smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `opencode debug agent` needs no API key, so this file also runs in the
// keyless lane (`npm run smoke:keyless`) alongside registration.smoke.test.ts.
const RUN =
  process.env.RUN_OC_SMOKE === "1" ||
  process.env.RUN_OC_SMOKE_KEYLESS === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");
const AGENT = "SmokeScout";

// From the bundled `anthropic` preset in tiers.json. Pinned here on purpose:
// if a preset refresh changes these, this test should fail and be updated,
// because it is asserting the end-to-end mapping, not re-deriving it.
//
// Repaired three times now, which is the cost of pinning: first from
// `claude-haiku-4-5` / `claude-opus-4-8`, then from `claude-fable-5` when the
// heavy tier moved to `claude-fable-5-1`, then from `claude-fable-5-1` "max"
// when it moved to `claude-opus-5-5` "xhigh", then when fast moved to
// `claude-sonnet-5-5` "low". Re-derive from tiers.json only if this keeps gating
// CI on a preset bump. Current `anthropic` preset: fast is claude-sonnet-5-5 with
// variant "low", heavy is claude-opus-5-5 with variant "xhigh".
const FAST_MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };
const HEAVY_MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const HEAVY_VARIANT = "xhigh";
// Every `anthropic` tier now sets a variant, so the variant-clearing case uses
// the `openai` preset: heavy is gpt-6-astra-fast "max", fast gpt-6-luna-fast has none.
const OPENAI_FAST_MODEL = { providerID: "openai", modelID: "gpt-6-luna-fast" };
const OPENAI_HEAVY_VARIANT = "max";

// Each case shells out to a real opencode. The first one also pays process
// cold-start, which exceeds vitest's 5s default on slower hosts (Windows CI
// measured ~10s), so every case carries the spawn ceiling plus a margin —
// same shape as guard-hardblock.smoke.ts.
const SMOKE_TIMEOUT_MS = 125_000;

let projectDir = "";
let homeDir = "";

/** Writes the project's router overrides file. */
function writeOverrides(body: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "opencode-model-router.overrides.jsonc"),
    JSON.stringify({ activePreset: "anthropic", ...body }, null, 2),
  );
}

/** Runs `opencode debug agent <name>` in the fixture and parses the JSON. */
function debugAgent(name: string): Record<string, any> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^OPENCODE_/i.test(name)) delete env[name];
  }
  for (const [name, dir] of Object.entries({
    XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
  })) {
    env[name] = path.join(homeDir, dir);
    fs.mkdirSync(env[name], { recursive: true });
  }
  const result = spawnSync("opencode", ["debug", "agent", name], {
    cwd: projectDir,
    env: {
      ...env, HOME: homeDir, USERPROFILE: homeDir,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `opencode debug agent ${name} failed (${result.status}):\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

beforeAll(() => {
  if (!RUN) return;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-subagent-tiers-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-smoke-home-"));
  fs.mkdirSync(path.join(projectDir, ".opencode", "agents"), {
    recursive: true,
  });

  // A subagent that declares no model — the case the feature exists for.
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "agents", "smoke-scout.md"),
    [
      "---",
      `name: ${AGENT}`,
      "description: smoke fixture — declares no model of its own",
      "mode: subagent",
      "---",
      "",
      "You are a smoke-test fixture.",
      "",
    ].join("\n"),
  );

  // Load the working copy as a file plugin.
  fs.writeFileSync(
    path.join(projectDir, "opencode.json"),
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: [REPO_ROOT] },
      null,
      2,
    ),
  );
});

afterAll(() => {
  for (const dir of [projectDir, homeDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

d("subagentTiers smoke", () => {
  it("leaves an unlisted agent untouched (opt-in)", () => {
    writeOverrides({});
    expect(debugAgent(AGENT).model ?? null).toBeNull();
  }, SMOKE_TIMEOUT_MS);

  it("repoints a listed agent at the active preset's tier model", () => {
    writeOverrides({ subagentTiers: { [AGENT]: "fast" } });
    expect(debugAgent(AGENT).model).toEqual(FAST_MODEL);
  }, SMOKE_TIMEOUT_MS);

  it("carries the tier's variant through", () => {
    writeOverrides({ subagentTiers: { [AGENT]: "heavy" } });
    const agent = debugAgent(AGENT);
    expect(agent.model).toEqual(HEAVY_MODEL);
    expect(agent.variant).toBe(HEAVY_VARIANT);
  }, SMOKE_TIMEOUT_MS);

  it("clears a variant when moving to a tier that has none", () => {
    writeOverrides({ activePreset: "openai", subagentTiers: { [AGENT]: "heavy" } });
    expect(debugAgent(AGENT).variant).toBe(OPENAI_HEAVY_VARIANT);

    writeOverrides({ activePreset: "openai", subagentTiers: { [AGENT]: "fast" } });
    const agent = debugAgent(AGENT);
    expect(agent.model).toEqual(OPENAI_FAST_MODEL);
    expect(agent.variant ?? null).toBeNull();
  }, SMOKE_TIMEOUT_MS);

  it("ignores an unknown tier name rather than failing startup", () => {
    writeOverrides({ subagentTiers: { [AGENT]: "no-such-tier" } });
    expect(debugAgent(AGENT).model ?? null).toBeNull();
  }, SMOKE_TIMEOUT_MS);

  it("never clobbers the plugin's own tier agents", () => {
    writeOverrides({ subagentTiers: { fast: "heavy" } });
    expect(debugAgent("fast").model).toEqual(FAST_MODEL);
  }, SMOKE_TIMEOUT_MS);
});
