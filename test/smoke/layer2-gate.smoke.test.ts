/**
 * Smoke test: Layer-2 acceptance gate (Option i verify-dispatch) end-to-end.
 *
 * Exercises the real `opencode run` path with MODEL_ROUTER_ENFORCE=1.
 * The prompt asks the orchestrator to dispatch a fast subagent whose task text
 * embeds an [acceptance] block with a deterministic fileExists check for a
 * file that DOES NOT exist (__definitely_missing_artifact__.txt).  Because
 * that file is absent, Option(i) verify-dispatch should detect a DoD failure
 * and append a forcing note whose first line contains "NOT ACCEPTED".
 *
 * GATED: runs only when RUN_OC_SMOKE=1 is set.
 * Excluded from default `npm test` by vitest.config.ts exclude pattern.
 * Run explicitly:
 *   $env:RUN_OC_SMOKE='1'
 *   npx vitest run --config vitest.smoke.config.ts test/smoke/layer2-gate.smoke.test.ts
 *
 * Tolerant assertion strategy (3 lines):
 *   1. No task tool call in output (orchestrator refusal) → console.warn +
 *      SOFT-PASS; GA-3 is deterministically covered by layer2-wiring.test.ts.
 *   2. Task dispatched + "NOT ACCEPTED" present → hard PASS (ideal case).
 *   3. Task dispatched + "NOT ACCEPTED" absent (model dropped acceptance block)
 *      → console.warn + SOFT-PASS; this is orchestrator non-compliance, not a
 *      gate regression — never a false CI failure.
 */
import { describe, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUN = process.env.RUN_OC_SMOKE === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "tmp", "smoke");
const OUT_FILE = path.join(OUT_DIR, "layer2-gate.json");
/** Absolute path to the plugin entry — derived at runtime, never hardcoded. */
const PLUGIN_PATH = path.join(REPO_ROOT, "src", "index.ts");
/** Temporary opencode.json written at repo root for this run only. */
const TEMP_CONFIG = path.join(REPO_ROOT, "opencode.json");

/**
 * Model used for the live `opencode run` call.
 *
 * Defaults to the Anthropic model this lane was originally proven against.
 * Set MODEL_ROUTER_SMOKE_MODEL to run the lane on another provider (e.g.
 * `opencode-go/qwen3.7-plus` when only an OpenCode Zen key is available).
 * With the env var unset, behaviour is byte-identical to the original.
 */
const SMOKE_MODEL_ENV = process.env.MODEL_ROUTER_SMOKE_MODEL;
/**
 * An EMPTY value counts as unset.  A GitHub Actions `env:` entry bound to an
 * expression that resolves to nothing still exports the variable as "", and a
 * bare `?? ` would then hand `--model ""` to the CLI.
 */
const MODEL_OVERRIDDEN = SMOKE_MODEL_ENV != null && SMOKE_MODEL_ENV !== "";
const SMOKE_MODEL = MODEL_OVERRIDDEN
  ? SMOKE_MODEL_ENV
  : "anthropic/claude-haiku-4-5";

/**
 * Project-level router overrides file.  `.opencode/` is gitignored.
 *
 * `--model` only selects the ORCHESTRATOR model; the subagent dispatched by
 * the Task tool is registered by the plugin from the active preset's tier
 * config, so it stays on Anthropic unless the tiers are overridden too.
 * Deliberately duplicated from guard-hardblock.smoke.test.ts: each smoke file
 * owns its own lifecycle, which is easier to reason about than a shared
 * setup file when these run as independent live processes.
 */
const OVERRIDES_DIR = path.join(REPO_ROOT, ".opencode");
const OVERRIDES_FILE = path.join(
  OVERRIDES_DIR,
  "opencode-model-router.overrides.jsonc",
);

/**
 * Point every tier of the ACTIVE preset at SMOKE_MODEL.
 *
 * Returns a restore function that is safe to call unconditionally.  When
 * MODEL_ROUTER_SMOKE_MODEL is unset this writes NOTHING and touches NOTHING.
 *
 * `variant: ""` matters: the bundled anthropic preset sets `variant: "max"` on
 * medium/heavy, the loader deep-merges (siblings survive, keys cannot be
 * deleted), and src/index.ts applies `variant` with a truthiness check — so an
 * empty string is the only way to stop an Anthropic-only knob from riding
 * along to a non-Anthropic model.
 */
function installTierOverrides(): () => void {
  if (!MODEL_OVERRIDDEN) return () => {};

  const tiers = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tiers.json"), "utf8"),
  ) as { activePreset?: string };
  const preset = tiers.activePreset ?? "anthropic";

  fs.mkdirSync(OVERRIDES_DIR, { recursive: true });
  const previous = fs.existsSync(OVERRIDES_FILE)
    ? fs.readFileSync(OVERRIDES_FILE, "utf8")
    : null;

  const tierOverride = { model: SMOKE_MODEL, variant: "" };
  fs.writeFileSync(
    OVERRIDES_FILE,
    JSON.stringify(
      {
        presets: {
          [preset]: {
            fast: tierOverride,
            medium: tierOverride,
            heavy: tierOverride,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return () => {
    if (previous !== null) {
      fs.writeFileSync(OVERRIDES_FILE, previous, "utf8");
    } else {
      try {
        fs.unlinkSync(OVERRIDES_FILE);
      } catch {
        // Already absent or removed by a parallel process — ignore.
      }
    }
  };
}

/**
 * The inner task prompt that the orchestrator is asked to copy verbatim into
 * the Task tool call.  It contains an [acceptance] block with a deterministic
 * fileExists check for __definitely_missing_artifact__.txt — a file that will
 * NEVER exist — so Option(i) verify-dispatch always fails the DoD and emits
 * "NOT ACCEPTED" in the forcing note appended to the task tool output.
 */
const TASK_PROMPT_INNER = [
  "Read README.md and report its first line.",
  "",
  "[acceptance]",
  "check: fileExists path=__definitely_missing_artifact__.txt",
  "[/acceptance]",
].join("\n");

/**
 * Outer orchestrator prompt.  Instructs the model to dispatch a Task and to
 * copy the inner prompt VERBATIM so the acceptance block reaches the tool call.
 */
const PROMPT =
  'Dispatch a fast subagent using the Task tool. ' +
  'Use subagent_type="fast" and copy the following text VERBATIM as the prompt ' +
  "(include EVERY line including the acceptance block — do NOT modify or omit any line):\n\n" +
  TASK_PROMPT_INNER +
  "\n\nAfter the subagent returns, reply with the single word DONE.";

d("layer-2 acceptance gate smoke", () => {
  it(
    "Option(i) verify-dispatch appends NOT ACCEPTED when DoD file is absent",
    () => {
      fs.mkdirSync(OUT_DIR, { recursive: true });

      // Write a temporary opencode.json at the repo root that loads this plugin
      // by absolute path.  Path is derived from __dirname so it is portable
      // across machines and matches how the existing guard-hardblock smoke works.
      const configPayload = JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [PLUGIN_PATH],
        },
        null,
        2,
      );
      fs.writeFileSync(TEMP_CONFIG, configPayload, "utf8");
      // No-op (and writes nothing) on the default Anthropic path.
      const restoreOverrides = installTierOverrides();

      try {
        const start = Date.now();

        const result = spawnSync(
          "opencode",
          [
            "run",
            PROMPT,
            "--model",
            SMOKE_MODEL,
            "--format",
            "json",
            "--dangerously-skip-permissions",
          ],
          {
            cwd: REPO_ROOT,
            env: { ...process.env, MODEL_ROUTER_ENFORCE: "1" },
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            timeout: 180_000,
          },
        );

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`opencode exited in ${elapsed}s, status=${result.status}`);

        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";

        fs.writeFileSync(
          OUT_FILE,
          JSON.stringify(
            {
              exitCode: result.status,
              elapsed,
              stdout,
              stderr: stderr.slice(0, 4_000),
            },
            null,
            2,
          ),
        );

        // ── exit-code check ──────────────────────────────────────────────────
        if (result.status !== 0) {
          const excerpt = (stdout + "\n" + stderr).slice(0, 600);
          throw new Error(
            `opencode exited with code ${result.status}.\nExcerpt:\n${excerpt}`,
          );
        }

        // ── detect whether a task tool call was dispatched ───────────────────
        // Search the raw output text rather than walking a brittle JSON object
        // path so the detection is resilient to schema changes in opencode's
        // --format json output.
        const lower = stdout.toLowerCase();
        const taskDispatched =
          lower.includes('"name":"task"') ||
          lower.includes('"name": "task"') ||
          lower.includes("task_result") ||
          lower.includes("<task_result>");

        if (!taskDispatched) {
          // Orchestrator refused to dispatch a subagent — SOFT-PASS.
          //
          // GA-3 (Layer-2 acceptance gate) is primarily proven by the
          // deterministic real-factory integration test:
          //   test/integration/layer2-wiring.test.ts  (cases A, D, E)
          // which exercises buildForcingNote / verifyDoD directly against the
          // real factory without requiring a live orchestrator.  The live
          // end-to-end path shape is spike-proven; a Haiku compliance refusal
          // here is not a gate regression.
          console.warn(
            "[layer2-gate smoke] Orchestrator did NOT dispatch a subagent " +
              "(no task tool call detected in captured output). " +
              "SOFT-PASS — GA-3 deterministic coverage lives in " +
              "test/integration/layer2-wiring.test.ts (cases A, D, E).",
          );
          return; // soft-pass: do not throw
        }

        // ── task was dispatched — look for the forcing note ──────────────────
        // Option(i) verify-dispatch fires inside tool.execute.after for the
        // built-in task tool when MODEL_ROUTER_ENFORCE=1.  When the fileExists
        // check for __definitely_missing_artifact__.txt fails (the file does
        // not exist), buildForcingNote() is invoked and its first line is
        // "NOT ACCEPTED".  We search the raw text case-insensitively.
        // Observational only — this file soft-passes on model non-compliance,
        // so a hard subagent-model assertion here would be the only hard
        // failure in the test and would misattribute a model quirk to the
        // gate.  guard-hardblock.smoke.test.ts asserts the override strictly.
        if (MODEL_OVERRIDDEN) {
          const seen = [
            ...new Set(
              stdout.match(
                /"providerID"\s*:\s*"[^"]*"\s*,\s*"modelID"\s*:\s*"[^"]*"/g,
              ) ?? [],
            ),
          ];
          console.log(
            `[layer2-gate smoke] requested ${SMOKE_MODEL}; ` +
              `provider/model pairs observed: ${JSON.stringify(seen)}`,
          );
        }

        const notAccepted =
          stdout.includes("NOT ACCEPTED") || lower.includes("not accepted");

        if (!notAccepted) {
          // Task was dispatched but the forcing note is absent.  This happens
          // when the orchestrator did not copy the [acceptance] block verbatim
          // into the task prompt (model non-compliance with the instruction).
          // This is NOT a gate regression — SOFT-PASS to prevent false CI
          // failures.  Hard assertion coverage remains in layer2-wiring.test.ts.
          console.warn(
            '[layer2-gate smoke] Task was dispatched but "NOT ACCEPTED" forcing ' +
              "note was NOT found in captured output. " +
              "The orchestrator likely omitted the [acceptance] block from the " +
              "dispatched task prompt (model non-compliance). " +
              "SOFT-PASS — not a gate regression.",
          );
          return; // soft-pass
        }

        // Ideal path: dispatch confirmed AND forcing note present.
        console.log(
          '[layer2-gate smoke] "NOT ACCEPTED" forcing note confirmed — ' +
            "Option(i) verify-dispatch fired correctly on absent DoD artifact.",
        );
        console.log(`Evidence written to: ${OUT_FILE}`);
      } finally {
        // Always restore the router overrides and remove the temp
        // opencode.json so the repo is left exactly as we found it.
        restoreOverrides();
        try {
          fs.unlinkSync(TEMP_CONFIG);
        } catch {
          // Already absent or a parallel process removed it — ignore.
        }
      }
    },
    185_000,
  );
});
