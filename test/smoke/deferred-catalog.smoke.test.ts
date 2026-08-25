/**
 * Smoke test: the DEFERRED catalog warning reaches opencode's own log.
 *
 * Why this file exists: the deferred two-turn branch of the `chat.message`
 * hook (src/index.ts, the `catalogWarned` one-shot) is the only logger call
 * site in the plugin with no live coverage. The unit suite exercises the
 * pure functions around it, and registration.smoke.test.ts only reaches the
 * `config` hook — neither ever drives a real session far enough for the
 * deferred report to fire. This file does, inside a real `opencode serve`.
 *
 * No credential is needed. `POST /session/<id>/message` returns HTTP 200 even
 * with no provider auth configured: the request is accepted and the chat
 * hooks run, which is all this test cares about. The model reply failing for
 * lack of a key is irrelevant to the assertion.
 *
 * `ghost-model-9` is the deliberate bait: a USER-AUTHORED
 * `modelGenerations.strong` pattern that matches nothing any provider serves.
 * Orphaned user patterns are the one case that is ALWAYS reported (shipped
 * defaults are deliberately never reported), so it guarantees exactly one
 * predictable warning.
 *
 * Two turns are required, not one. Turn 1 only calls `startCatalogFetch()`
 * fire-and-forget and reports nothing; only a LATER turn, once the fetch has
 * settled, flips `catalogWarned` and emits the warnings. A single message
 * would prove nothing.
 *
 * Determinism: HOME/USERPROFILE are repointed at a temp dir so the
 * developer's global opencode config and state cannot bleed in — which also
 * puts opencode's log under <homeDir>/.local/share/opencode/log, where this
 * test reads it.
 *
 * GATED: runs in the keyless lane (RUN_OC_SMOKE_KEYLESS=1) and in the full
 * lane (RUN_OC_SMOKE=1), invoked with the smoke config:
 *   RUN_OC_SMOKE_KEYLESS=1 npx vitest run --config vitest.smoke.config.ts \
 *     test/smoke/deferred-catalog.smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const RUN =
  process.env.RUN_OC_SMOKE_KEYLESS === "1" || process.env.RUN_OC_SMOKE === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");

// The orphaned strong-model pattern. Nothing any provider serves matches it,
// and it is user-authored, so the plugin must report it.
const GHOST = "ghost-model-9";
const PRESET = "deferlab";

// Spawning a server, driving two chat turns and waiting on an asynchronous
// log write costs far more than vitest's 5s default; match the ceiling used
// by the other keyless smoke files.
const SMOKE_TIMEOUT_MS = 125_000;

let projectDir = "";
let homeDir = "";
let server: ChildProcess | undefined;
let stdout = "";
let stderr = "";
let port = 0;

/** Asks the OS for a free port by binding :0, then releases it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("no port from probe socket")));
        return;
      }
      const found = address.port;
      probe.close(() => resolve(found));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns true or `timeoutMs` elapses. */
async function waitFor(
  probe: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await delay(stepMs);
  }
}

/** Concatenates every file opencode wrote under the isolated HOME's log dir. */
function readLog(): string {
  const dir = path.join(homeDir, ".local", "share", "opencode", "log");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  let out = "";
  for (const name of names) {
    try {
      // Read contents, never statSync().size — the reported size can still be
      // 0 while the file already holds the line we are waiting for.
      out += fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      // a log file can be rotated out from under us mid-read; ignore it
    }
  }
  return out;
}

/** Drives one chat turn; returns the HTTP status. */
async function sendMessage(sessionId: string): Promise<number> {
  const res = await fetch(
    `http://127.0.0.1:${port}/session/${sessionId}/message`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "oi" }],
        // The model is deliberately NONEXISTENT. This test needs the
        // `chat.message` hook to fire twice; it does not need a model to
        // answer. The hook runs inside SessionPrompt.createUserMessage(),
        // before the provider is called, so a turn that cannot possibly
        // succeed still drives the path under test.
        //
        // Naming a real model instead would make the test depend on a
        // resolvable provider, which on a credentialless runner is exactly
        // what does not exist — and it would hide that dependency behind a
        // plausible-looking model id. Failing fast also cuts this file from
        // ~78s to ~25s, because no turn waits on inference.
        model: { providerID: "no-such-provider", modelID: "no-such-model" },
      }),
    },
  );
  return res.status;
}

beforeAll(async () => {
  if (!RUN) return;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-deferred-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-deferred-home-"));
  fs.mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });

  // Load the working copy as a file plugin. JSON wants forward slashes even
  // on Windows.
  fs.writeFileSync(
    path.join(projectDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [REPO_ROOT.replace(/\\/g, "/")],
      },
      null,
      2,
    ),
  );

  // An active preset that is itself valid, plus the orphaned strong pattern
  // that is the whole point of the fixture.
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "opencode-model-router.overrides.jsonc"),
    JSON.stringify(
      {
        activePreset: PRESET,
        presets: {
          [PRESET]: {
            fast: { model: "anthropic/claude-haiku-4-5" },
            medium: { model: "anthropic/claude-haiku-4-5" },
            heavy: { model: "anthropic/claude-haiku-4-5" },
          },
        },
        modelGenerations: { strong: [GHOST] },
      },
      null,
      2,
    ),
  );

  port = await freePort();
  server = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: projectDir,
    // NO --print-logs: it redirects the log to stderr, which would destroy
    // the stderr assertion below.
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.setEncoding("utf8");
  server.stderr?.setEncoding("utf8");
  server.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  server.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
}, SMOKE_TIMEOUT_MS);

afterAll(async () => {
  const child = server;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      child.kill();
    } catch {
      // the process may already be gone; teardown must not throw
    }
    // Windows keeps handles on the server's files until it is really gone,
    // so wait for the exit before trying to delete the fixture.
    await Promise.race([exited, delay(10_000)]);
  }
  for (const dir of [projectDir, homeDir]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      });
    } catch {
      // a leftover temp dir is not worth failing the run over
    }
  }
}, SMOKE_TIMEOUT_MS);

d("deferred catalog warning smoke", () => {
  it(
    "reports the orphaned strong pattern to opencode's log, not the terminal",
    async () => {
      // Readiness: opencode prints "opencode server listening on http://..."
      // to STDOUT. Poll for it rather than sleeping a fixed time.
      const up = await waitFor(() => stdout.includes("listening on"), 60_000);
      expect(
        up,
        `opencode serve never reported readiness.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
      ).toBe(true);

      const sessionRes = await fetch(`http://127.0.0.1:${port}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(sessionRes.status).toBe(200);
      const session = (await sessionRes.json()) as { id?: string };
      expect(typeof session.id).toBe("string");
      const sessionId = session.id as string;

      // TWO turns in the SAME non-subagent session. Turn 1 only starts the
      // catalog fetch; the report can only come from a later turn.
      //
      // The HTTP STATUS OF THESE TURNS IS DELIBERATELY NOT ASSERTED. These
      // turns are expected to FAIL — see sendMessage, the model does not
      // exist — because all this test needs from them is that the hook ran.
      //
      // It asserted 200 originally and passed locally, on a false premise: on
      // Windows opencode caches provider metadata under AppData\Roaming,
      // OUTSIDE the HOME this test repoints, so the dev host still had a
      // resolvable provider and the isolation was weaker than it looked. The
      // first cold-container run came back 500 and failed. The lane caught a
      // bad assumption inside its own test on its first real outing, which is
      // the argument for having the lane.
      //
      // Nothing is lost by not asserting it: the substantive assertion is that
      // the warning reaches the log. If the hook never ran, that one fails —
      // loudly, and for the right reason. The statuses are still captured and
      // reported in that failure message, so a future regression here is
      // diagnosable without a re-run.
      const firstStatus = await sendMessage(sessionId);
      await delay(2_000);
      const secondStatus = await sendMessage(sessionId);
      const turns = `turn statuses: ${firstStatus}, ${secondStatus}`;

      // The log write is asynchronous relative to the HTTP response, so poll.
      // If the turn-1 fetch had not settled by turn 2, the one-shot simply
      // has not fired yet — extra turns re-enter the hook and let it.
      let nextNudge = Date.now() + 5_000;
      const found = await waitFor(async () => {
        if (readLog().includes(GHOST)) return true;
        if (Date.now() >= nextNudge) {
          nextNudge = Date.now() + 5_000;
          await sendMessage(sessionId);
        }
        return false;
      }, 40_000);

      const log = readLog();
      expect(
        found,
        `'${GHOST}' never appeared in the opencode log.\n${turns}\nLOG:\n${log}\nSTDERR:\n${stderr}`,
      ).toBe(true);

      const warnLine = log
        .split(/\r?\n/)
        .find((line) => line.includes(GHOST));
      expect(warnLine).toBeDefined();
      expect(warnLine).toContain("level=WARN");

      // REGRESSION GUARD — this assertion is the point of this file, and it
      // is the PR #35 class of defect: a plugin warning leaking to the
      // process's stderr instead of opencode's log. opencode renders a TUI,
      // so anything written to stderr paints over it. Every plugin
      // diagnostic must travel through the logger's SDK receiver.
      expect(stderr).toBe("");
    },
    SMOKE_TIMEOUT_MS,
  );
});
