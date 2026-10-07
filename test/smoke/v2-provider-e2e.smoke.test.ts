/**
 * Provider-backed OpenCode v2 compatibility smoke tests.
 * Adapted from ChronosWS (Cliff Hudson).
 *
 * Runs `opencode run --standalone` with an isolated home and a deterministic
 * local OpenAI-compatible provider, without user config, credentials, or data.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const RUN = process.env.RUN_OC_SMOKE_V2_E2E === "1";
const d = RUN ? describe : describe.skip;
const fixtures: Array<{ root: string; child?: ChildProcess; server?: Server }> = [];

type ChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; [key: string]: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
  temperature?: number;
  stream?: boolean;
};

type CapturedRequest = ChatRequest & { url: string; text: string; system: string; toolNames: string[] };

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child?.exitCode === null) fixture.child.kill("SIGKILL");
    if (fixture.server) await new Promise<void>((resolve) => fixture.server!.close(() => resolve()));
    const parent = path.resolve(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir());
    if (path.dirname(fixture.root) !== parent || !path.basename(fixture.root).startsWith("omr-v2-e2e-")) {
      throw new Error(`Unexpected v2 e2e fixture path: ${fixture.root}`);
    }
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 30_000);

function textOf(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function completion(content: string) {
  return {
    id: "chatcmpl-router-e2e",
    object: "chat.completion",
    created: 1,
    model: "router-e2e",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCompletion(name: string, args: Record<string, unknown>) {
  return {
    id: "chatcmpl-router-e2e",
    object: "chat.completion",
    created: 1,
    model: "router-e2e",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function sendCompletion(response: import("node:http").ServerResponse, body: ChatRequest, payload: ReturnType<typeof completion> | ReturnType<typeof toolCompletion>) {
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const message = payload.choices[0]!.message;
  response.write(`data: ${JSON.stringify({
    ...payload,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: message, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...payload,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0]!.finish_reason }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startProvider(allowGraderTemperature: boolean) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: ["orchestrator", "fast", "medium", "heavy"].map(id => ({ id, object: "model", owned_by: "router-e2e" })) }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    const text = textOf(body.messages);
    const system = textOf(body.messages?.filter(message => message?.role === "system"));
    const toolNames = body.tools?.map(tool => tool.function?.name).filter((name): name is string => typeof name === "string") ?? [];
    requests.push({ ...body, url: request.url, text, system, toolNames });

    const hasToolResult = body.messages?.some(message => message?.role === "tool") === true;
    const isGrader = system.includes("independent, skeptical verification grader");
    const isFastChild = body.model === "fast" && system.includes("ROLE: You are @fast");
    let payload: ReturnType<typeof completion> | ReturnType<typeof toolCompletion>;
    if (isGrader) {
      if (!allowGraderTemperature && Object.hasOwn(body, "temperature")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Grader model does not support temperature", type: "invalid_request_error", param: "temperature" } }));
        return;
      }
      payload = completion('{"pass":true,"reasons":["producer returned the required evidence"]}');
    } else if (isFastChild && text.includes("NATIVE_CHILD")) {
      payload = hasToolResult
        ? completion("DONE: NATIVE_CHILD read completed")
        : toolCompletion("read", { path: "README.md", offset: 1, limit: 1 });
    } else if (isFastChild && text.includes("DELEGATE_CHILD")) {
      payload = completion("DONE: DELEGATE_CHILD produced required evidence");
    } else if (text.includes("SCENARIO_NATIVE") && toolNames.includes("subagent")) {
      payload = hasToolResult
        ? completion("NATIVE_E2E_OK")
        : toolCompletion("subagent", { agent: "fast", description: "Native v2 route", prompt: "NATIVE_CHILD read README.md", background: true });
    } else if (text.includes("SCENARIO_DELEGATE") && toolNames.includes("delegate")) {
      payload = hasToolResult
        ? completion("DELEGATE_E2E_OK")
        : toolCompletion("delegate", {
          task: "DELEGATE_CHILD return the required evidence",
          tier: "fast",
          acceptance: "[acceptance]\ncriteria: producer returned the required evidence\n[/acceptance]",
        });
    } else {
      payload = completion("router e2e title");
    }
    sendCompletion(response, body, payload);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port");
  return { server, requests, baseURL: `http://127.0.0.1:${address.port}/v1` };
}

async function runStandalone(scenario: "native" | "delegate", allowGraderTemperature = false, graderTemperature = 0) {
  const executable = process.env.OPENCODE_V2_BIN
    ?? spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0]
    ?? "";
  if (!path.isAbsolute(executable)) throw new Error("Set OPENCODE_V2_BIN to an absolute OpenCode v2 executable path");
  const tempParent = path.resolve(process.env.OPENCODE_TEST_TMPDIR ?? tmpdir());
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(path.join(tempParent, "omr-v2-e2e-"));
  const fixture: typeof fixtures[number] = { root };
  fixtures.push(fixture);
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "README.md"), "# Isolated router fixture\n");

  const provider = await startProvider(allowGraderTemperature);
  fixture.server = provider.server;
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const name of Object.keys(env)) {
    if (/^(OPENCODE_|MODEL_ROUTER_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) delete env[name];
  }
  for (const [name, dir] of Object.entries({
    HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata",
    LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp",
  })) {
    env[name] = path.join(root, dir);
    await mkdir(env[name]!, { recursive: true });
  }
  const configDir = path.join(env.XDG_CONFIG_HOME!, "opencode");
  const routerConfigDir = path.join(env.HOME!, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  await mkdir(routerConfigDir, { recursive: true });
  const models = Object.fromEntries(["orchestrator", "fast", "medium", "heavy"].map(id => [id, {
    name: `Router E2E ${id}`,
  }]));
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [ROOT],
    model: "router-e2e/orchestrator",
    providers: {
      "router-e2e": {
        name: "Router E2E",
        env: ["ROUTER_E2E_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: provider.baseURL },
        models,
      },
    },
  }));
  await writeFile(path.join(routerConfigDir, "opencode-model-router.overrides.jsonc"), JSON.stringify({
    activePreset: "router-e2e",
    defaultTier: "fast",
    presets: {
      "router-e2e": {
        fast: { model: "router-e2e/fast", description: "test fast", whenToUse: ["test"] },
        medium: { model: "router-e2e/medium", description: "test medium", whenToUse: ["test"] },
        heavy: { model: "router-e2e/heavy", description: "test heavy", whenToUse: ["test"] },
      },
    },
    experimental: { verifiedDelegateTool: true },
    enforcement: {
      mode: "enforced",
      verify: {
        require: "always", defaultVerify: "required", graderTemperature, background: false,
        ...(allowGraderTemperature ? { graderTemperatureModels: ["router-e2e/fast"] } : {}),
      },
    },
  }));
  Object.assign(env, {
    PWD: project,
    ROUTER_E2E_API_KEY: "isolated-test-key",
    MODEL_ROUTER_ENFORCE: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_FILEWATCHER_DISABLE: "true",
  });

  const prompt = scenario === "native"
    ? "SCENARIO_NATIVE: call the fast subagent exactly once and then report its result."
    : "SCENARIO_DELEGATE: call the delegate tool exactly once and then report its verified result.";
  const child = spawn(executable, ["run", "--standalone", "--print-logs", "--auto", "--format", "json", "--model", "router-e2e/orchestrator", prompt], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  fixture.child = child;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`OpenCode v2 e2e timed out\n${stderr}`)); }, 90_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); resolve(code); });
  });
  fixture.child = undefined;
  if (exitCode !== 0) throw new Error(`OpenCode exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return { stdout, stderr, requests: provider.requests, project, readme: await readFile(path.join(project, "README.md"), "utf8") };
}

d("OpenCode v2 provider-backed standalone compatibility", () => {
  it("routes a real native subagent turn, awaits background input, and translates guarded tool results", async () => {
    const result = await runStandalone("native");
    expect(result.stdout).toContain("NATIVE_E2E_OK");
    expect(result.readme).toBe("# Isolated router fixture\n");
    const root = result.requests.find(request => request.model === "orchestrator" && request.text.includes("SCENARIO_NATIVE") && request.toolNames.includes("subagent"));
    expect(root?.system).toContain("Model Delegation Protocol");
    expect(root?.system).toContain(`Working directory: ${result.project}`);
    const child = result.requests.find(request => request.model === "fast" && request.text.includes("NATIVE_CHILD"));
    expect(child?.system).toContain("ROLE: You are @fast");
    const afterRead = result.requests.find(request => request.model === "fast" && request.text.includes("[cap: 1/8]"));
    expect(afterRead, "the real read result should pass through the v2 after-hook").toBeDefined();
    expect(result.requests.filter(request => request.model === "fast" && request.text.includes("NATIVE_CHILD"))).toHaveLength(2);
  }, 120_000);

  it.each([
    { allow: false, temperature: 0 },
    { allow: true, temperature: 0 },
    { allow: true, temperature: 0.65 },
  ])("runs verified native children with grader temperature allowed=$allow and temperature $temperature", async ({ allow, temperature }) => {
    const result = await runStandalone("delegate", allow, temperature);
    expect(result.stdout).toContain("DELEGATE_E2E_OK");
    const root = result.requests.find(request => request.model === "orchestrator" && request.text.includes("SCENARIO_DELEGATE") && request.toolNames.includes("delegate"));
    expect(root?.system).toContain("Model Delegation Protocol");
    expect(root?.system).toContain(`Working directory: ${result.project}`);
    const producer = result.requests.find(request => request.model === "fast" && request.text.includes("DELEGATE_CHILD") && !request.system.includes("independent, skeptical"));
    expect(producer?.system).toContain("ROLE: You are @fast");
    const grader = result.requests.find(request => request.system.includes("independent, skeptical verification grader"));
    expect(grader).toMatchObject({ model: "fast" });
    if (allow) expect(grader).toHaveProperty("temperature", temperature);
    else expect(grader).not.toHaveProperty("temperature");
    const continuation = result.requests.find(request => request.model === "orchestrator" && request.text.includes("[router ✓ verified:"));
    expect(continuation, "the verified result should return to the orchestrator tool loop").toBeDefined();
  }, 120_000);
});
