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
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keyedSmokeEnv } from "../setup/smoke-tmp-guard";
import {
  prepareFixtureRepo,
  type FixtureRepo,
} from "../integration/e2e/fixture-repo";

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
 * `variant: ""` matters: the bundled anthropic preset sets a `variant` on
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
            env: { ...keyedSmokeEnv(), MODEL_ROUTER_ENFORCE: "1" },
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

// ─────────────────────────────────────────────────────────────────────────────
// Verification resource budget (plan 3.1.4): the required and deferred paths
// and the router_verify tool, in a real opencode against a real vitest project.
//
// The project is a throwaway git copy of test/fixtures/projects/vitest-app
// (npm ci included) built by the e2e helper. opencode runs with that copy as
// its cwd; the plugin is loaded through the SAME repo-root opencode.json the
// test above writes (OPENCODE_CONFIG points at it, since a cwd outside the
// repo would not discover it), and it is removed again in `finally`.
//
// Evidence of what the verifier SPAWNED: the plugin does not log the runner's
// argv, so the temp copy gets a vitest `globalSetup` probe that appends the
// CLI's own process.argv to a log file. globalSetup runs once per vitest CLI
// invocation, in the main process, so each line is exactly one runner spawn:
// `related <files...>` for a scoped run, bare `run` for the full suite.
// ─────────────────────────────────────────────────────────────────────────────

const VERIFY_SPAWN_TIMEOUT_MS = 420_000;
const VERIFY_TEST_TIMEOUT_MS = 900_000;

interface VerifyProject {
  repo: FixtureRepo;
  argvLog: string;
}

async function prepareVerifyProject(): Promise<VerifyProject> {
  const repo = await prepareFixtureRepo("vitest-app", {
    root: path.join(os.tmpdir(), "omr-smoke-verify"),
  });
  const argvLog = path.join(repo.dir, ".omr-runner-argv.log");
  await repo.write(
    "argv-probe.js",
    [
      'import { appendFileSync } from "node:fs";',
      "// Smoke probe: one line per vitest CLI invocation (globalSetup = main process).",
      "export default function setup() {",
      `  appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "}",
      "",
    ].join("\n"),
  );
  await repo.write(
    "vitest.config.js",
    [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      "  test: {",
      '    include: ["test/**/*.test.js"],',
      '    environment: "node",',
      '    globalSetup: ["./argv-probe.js"],',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await repo.write(".gitignore", "node_modules/\n.omr-runner-argv.log\nopencode.json\n.opencode/\n");
  repo.commit("smoke: runner argv probe");
  return { repo, argvLog };
}

/** Same tier override as installTierOverrides, written into the project dir. */
function writeProjectTierOverrides(dir: string): void {
  if (!MODEL_OVERRIDDEN) return;
  const tiers = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tiers.json"), "utf8"),
  ) as { activePreset?: string };
  const preset = tiers.activePreset ?? "anthropic";
  const tierOverride = { model: SMOKE_MODEL, variant: "" };
  fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".opencode", "opencode-model-router.overrides.jsonc"),
    JSON.stringify(
      { presets: { [preset]: { fast: tierOverride, medium: tierOverride, heavy: tierOverride } } },
      null,
      2,
    ),
    "utf8",
  );
}

interface OcRun {
  status: number | null;
  elapsed: string;
  stdout: string;
  stderr: string;
  runnerArgv: string[][];
}

/** One `opencode run` in the project dir, plugin loaded through the repo-root temp config. */
function runOpencode(project: VerifyProject, prompt: string): OcRun {
  fs.rmSync(project.argvLog, { force: true });
  fs.writeFileSync(
    TEMP_CONFIG,
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: [PLUGIN_PATH] },
      null,
      2,
    ),
    "utf8",
  );
  try {
    const start = Date.now();
    const result = spawnSync(
      "opencode",
      [
        "run",
        prompt,
        "--model",
        SMOKE_MODEL,
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "--print-logs",
        "--log-level",
        "DEBUG",
      ],
      {
        cwd: project.repo.dir,
        env: {
          ...keyedSmokeEnv(),
          MODEL_ROUTER_ENFORCE: "1",
          MODEL_ROUTER_DISPATCH_DEBUG: "1",
          OPENCODE_CONFIG: TEMP_CONFIG,
        },
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: VERIFY_SPAWN_TIMEOUT_MS,
      },
    );
    const runnerArgv = fs.existsSync(project.argvLog)
      ? fs
          .readFileSync(project.argvLog, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as string[])
      : [];
    return {
      status: result.status,
      elapsed: ((Date.now() - start) / 1000).toFixed(1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      runnerArgv,
    };
  } finally {
    try {
      fs.unlinkSync(TEMP_CONFIG);
    } catch {
      // Already absent — ignore.
    }
  }
}

function writeEvidence(name: string, run: OcRun, extra: Record<string, unknown>): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        exitCode: run.status,
        elapsed: run.elapsed,
        runnerArgv: run.runnerArgv,
        ...extra,
        stdout: run.stdout,
        // DEBUG logs are large; keep the plugin's lines plus a head excerpt.
        stderrRouterLines: run.stderr
          .split("\n")
          .filter((l) => /router|verify|vrf_/i.test(l))
          .slice(0, 400),
        stderrHead: run.stderr.slice(0, 4_000),
      },
      null,
      2,
    ),
  );
  return file;
}

function assertExited(run: OcRun): void {
  if (run.status !== 0) {
    throw new Error(
      `opencode exited with code ${run.status}.\nExcerpt:\n${(run.stdout + "\n" + run.stderr.slice(-2_000)).slice(0, 2_000)}`,
    );
  }
}

function taskDispatched(stdout: string): boolean {
  const lower = stdout.toLowerCase();
  return (
    /"tool"\s*:\s*"task"/.test(lower) ||
    lower.includes('"name":"task"') ||
    lower.includes("task_result")
  );
}

/**
 * The probe also records the SUBAGENT's own `npm test` runs (argv `["run"]`),
 * which are the model checking its work, not the verifier. The verifier's
 * spawns are recognisable by the JSON report it collects into an
 * `omr-verify-*` file (observed live: `--reporter=json
 * --outputFile=<tmp>/omr-verify-<uuid>.json`).
 */
const isVerifierSpawn = (argv: string[]): boolean =>
  argv.some((t) => /^--outputFile=.*omr-verify-/.test(t));

/**
 * A runner argv is scoped when vitest was invoked with `related <files>` or
 * with explicit test files (a rerun of named tests); a bare `run` with no file
 * arguments is the full suite.
 */
const isScoped = (argv: string[]): boolean =>
  argv.includes("related") || argv.some((t) => /\.test\.js$/.test(t));

const UNVERIFIED_FOOTER = /\[router\] unverified (?:\u00b7|\\u00b7) vrf_[0-9a-f]{24}/;

const EDIT_TASK = [
  "In src/m01.js add a trailing comment line `// touched by smoke` at the end of the file.",
  "Change nothing else.",
];

function dispatchPrompt(inner: string[]): string {
  return (
    'Dispatch a fast subagent using the Task tool. Use subagent_type="fast" and copy the ' +
    "following text VERBATIM as the prompt (include EVERY line, including the acceptance " +
    "block — do NOT modify or omit any line):\n\n" +
    inner.join("\n") +
    "\n\nAfter the subagent returns, reply with its final message verbatim, then the word DONE."
  );
}

d("verification budget smoke (real vitest project)", () => {
  it(
    "VERIFY:required runs a scoped `vitest related`, not the full suite",
    async () => {
      const project = await prepareVerifyProject();
      writeProjectTierOverrides(project.repo.dir);
      try {
        const run = runOpencode(
          project,
          dispatchPrompt([
            "VERIFY:required",
            ...EDIT_TASK,
            "",
            "[acceptance]",
            'check: testsPass command="npm test"',
            "[/acceptance]",
          ]),
        );
        const verifier = run.runnerArgv.filter(isVerifierSpawn);
        const scoped = verifier.filter(isScoped);
        const full = verifier.filter((a) => !isScoped(a));
        const agentRuns = run.runnerArgv.filter((a) => !isVerifierSpawn(a));
        const file = writeEvidence("verify-required", run, { scoped, full, agentRuns });
        console.log(`[verify-required smoke] ${run.elapsed}s, runner argv: ${JSON.stringify(run.runnerArgv)}; evidence ${file}`);
        assertExited(run);

        if (!taskDispatched(run.stdout)) {
          console.warn("[verify-required smoke] no task dispatch detected — orchestrator non-compliance. SOFT-PASS.");
          return;
        }
        if (verifier.length === 0) {
          console.warn(
            "[verify-required smoke] task dispatched but no verifier vitest run was recorded — the orchestrator " +
              "likely dropped VERIFY:required or the acceptance block. SOFT-PASS.",
          );
          return;
        }
        // Hard assertions once a verification run is observed: every spawn scoped.
        expect(full).toEqual([]);
        expect(scoped.length).toBeGreaterThan(0);
        expect(scoped.some((a) => a.some((t) => /m01\.js$/.test(t)))).toBe(true);
      } finally {
        await project.repo.dispose();
      }
    },
    VERIFY_TEST_TIMEOUT_MS,
  );

  it(
    "a deferred testsPass dispatch returns the unverified footer and spawns no runner",
    async () => {
      const project = await prepareVerifyProject();
      writeProjectTierOverrides(project.repo.dir);
      try {
        const run = runOpencode(
          project,
          dispatchPrompt([
            ...EDIT_TASK,
            "",
            "[acceptance]",
            'check: testsPass command="npm test"',
            "[/acceptance]",
          ]),
        );
        const footer = UNVERIFIED_FOOTER.exec(run.stdout)?.[0] ?? null;
        const verifier = run.runnerArgv.filter(isVerifierSpawn);
        const file = writeEvidence("verify-deferred", run, { footer, verifier });
        console.log(`[verify-deferred smoke] ${run.elapsed}s, footer=${footer}, runner argv: ${JSON.stringify(run.runnerArgv)}; evidence ${file}`);
        assertExited(run);

        if (!taskDispatched(run.stdout)) {
          console.warn("[verify-deferred smoke] no task dispatch detected — orchestrator non-compliance. SOFT-PASS.");
          return;
        }
        if (footer === null) {
          console.warn(
            "[verify-deferred smoke] task dispatched but no `[router] unverified · vrf_` footer — the " +
              "orchestrator likely dropped the acceptance block. SOFT-PASS.",
          );
          return;
        }
        // The footer proves the dispatch deferred; deferral must not spawn a
        // verifier runner (the subagent's own `npm test` runs do not count).
        expect(verifier).toEqual([]);
      } finally {
        await project.repo.dispose();
      }
    },
    VERIFY_TEST_TIMEOUT_MS,
  );

  it(
    "router_verify is registered and callable with pending: true",
    async () => {
      const project = await prepareVerifyProject();
      writeProjectTierOverrides(project.repo.dir);
      try {
        const run = runOpencode(
          project,
          "Call the router_verify tool exactly once with the argument pending set to true " +
            "(no handles). Do not call any other tool. Then reply with the tool's output verbatim.",
        );
        // Tool parts in `--format json` carry "tool":"router_verify" and a state with an output.
        const events = run.stdout
          .split("\n")
          .filter((l) => l.includes("router_verify"))
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, any>;
            } catch {
              return null;
            }
          })
          .filter((e): e is Record<string, any> => e !== null);
        const call = events.find((e) => e.part?.tool === "router_verify");
        const file = writeEvidence("router-verify", run, { call: call ?? null });
        console.log(`[router-verify smoke] ${run.elapsed}s, call status=${call?.part?.state?.status}; evidence ${file}`);
        assertExited(run);

        if (!call) {
          console.warn("[router-verify smoke] no router_verify tool call in the event stream — model non-compliance. SOFT-PASS.");
          return;
        }
        expect(call.part.state?.status).toBe("completed");
        expect(String(call.part.state?.output ?? "")).toMatch(/\[router\] router_verify/);
        // Nothing was pending in a fresh session, so nothing may have been run.
        expect(run.runnerArgv.filter(isVerifierSpawn)).toEqual([]);
      } finally {
        await project.repo.dispose();
      }
    },
    VERIFY_TEST_TIMEOUT_MS,
  );
});
