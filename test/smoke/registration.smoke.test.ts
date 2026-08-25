/**
 * Smoke test: keyless plugin registration.
 *
 * `opencode debug agent <name>` loads the plugin, runs the `config` hook,
 * resolves overrides and registers agents, all WITHOUT any API key and
 * without a network call. That makes it the cheapest possible end-to-end
 * check that the plugin loads and behaves, and it is the check that would
 * have caught two real defects that shipped past a fully green unit suite:
 * a logger whose SDK receiver was detached so every warning fell back to
 * stderr, and a warning call site that was never routed through the logger
 * at all.
 *
 * Determinism: opencode is spawned with HOME pointed at a temp dir so the
 * developer's global `~/.config/opencode/opencode.json` (which registers this
 * same plugin) and their `opencode-model-router.state.json` (which overlays
 * activePreset and outranks the override file) cannot bleed into the fixture.
 *
 * GATED: runs in the keyless lane (RUN_OC_SMOKE_KEYLESS=1) and in the full
 * lane (RUN_OC_SMOKE=1), invoked with the smoke config:
 *   RUN_OC_SMOKE_KEYLESS=1 npx vitest run --config vitest.smoke.config.ts \
 *     test/smoke/registration.smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUN =
  process.env.RUN_OC_SMOKE_KEYLESS === "1" || process.env.RUN_OC_SMOKE === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");

// Distinct from subagent-tiers.smoke.test.ts's agent so the two fixtures
// cannot collide if they are ever run in the same lane.
const AGENT = "SmokeRegistrar";
const PRESET = "smoke-keyless";

// An OpenAI model asked for `xhigh`, which the options builder must downgrade
// to `high`. Seeing that downgrade in the returned agent proves the config
// hook, override resolution and agent-options building all ran for real.
const OPENAI_MODEL = { providerID: "openai", modelID: "gpt-5.6-luna-fast" };

// Each case shells out to a real opencode. The first one also pays process
// cold-start, which exceeds vitest's 5s default on slower hosts (Windows CI
// measured ~10s), so every case carries the spawn ceiling plus a margin.
const SMOKE_TIMEOUT_MS = 125_000;

let projectDir = "";
let homeDir = "";

interface DebugAgentResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `opencode debug agent <name>` in the fixture, returning raw streams. */
function debugAgent(name: string): DebugAgentResult {
  const result = spawnSync("opencode", ["debug", "agent", name], {
    cwd: projectDir,
    env: { ...process.env, HOME: homeDir },
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

beforeAll(() => {
  if (!RUN) return;
  // Distinct temp dir prefix from the subagent-tiers fixture.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-registration-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-keyless-home-"));
  fs.mkdirSync(path.join(projectDir, ".opencode", "agents"), {
    recursive: true,
  });

  // A subagent that declares no model — so the router's tier assignment is
  // the only thing that can put a model on it.
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "agents", "smoke-registrar.md"),
    [
      "---",
      `name: ${AGENT}`,
      "description: keyless smoke fixture — declares no model of its own",
      "mode: subagent",
      "---",
      "",
      "You are a keyless smoke-test fixture.",
      "",
    ].join("\n"),
  );

  // A preset whose `fast` tier is an OpenAI model asking for `xhigh`, made
  // active, with the fixture agent pinned to that tier.
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "opencode-model-router.overrides.jsonc"),
    JSON.stringify(
      {
        activePreset: PRESET,
        presets: {
          [PRESET]: {
            fast: {
              model: `${OPENAI_MODEL.providerID}/${OPENAI_MODEL.modelID}`,
              effort: "xhigh",
            },
          },
        },
        subagentTiers: { [AGENT]: "fast" },
      },
      null,
      2,
    ),
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

d("keyless registration smoke", () => {
  it(
    "loads the plugin, resolves overrides and registers agents with no API key",
    () => {
      // The plugin's own `fast` tier agent is the one that carries built
      // agent options; `subagentTiers` only repoints model/variant.
      const result = debugAgent("fast");

      expect(result.status).toBe(0);

      const agent = JSON.parse(result.stdout) as Record<string, any>;
      expect(agent.model).toEqual(OPENAI_MODEL);
      // xhigh -> high downgrade: OpenAI has no `xhigh` reasoning effort, so
      // the options builder must clamp it. Seeing `high` here proves the
      // config hook and override resolution ran inside a real opencode.
      expect(agent.options?.reasoning_effort).toBe("high");

      // REGRESSION GUARD — this assertion is the point of this file.
      // A passive warning reaching stderr is the exact bug #35 fixed:
      // opencode renders a TUI, so anything the plugin writes to stderr
      // paints over it. All plugin diagnostics must go through the logger's
      // SDK receiver, never stderr.
      expect(result.stderr).toBe("");
    },
    SMOKE_TIMEOUT_MS,
  );
});
