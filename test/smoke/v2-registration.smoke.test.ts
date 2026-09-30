/**
 * Keyless native OpenCode 2 loader regression. Install @opencode/cli separately;
 * set RUN_OC_SMOKE_V2=1 and OPENCODE_V2_BIN to its executable, then run this file
 * with vitest.smoke.config.ts. No provider credentials or model calls are used.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "../..");
const RUN = process.env.RUN_OC_SMOKE_V2 === "1";
const d = RUN ? describe : describe.skip;
const fixtures: Array<{ root: string; child?: ChildProcess; closed?: Promise<void> }> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child?.exitCode === null) fixture.child.kill();
    await fixture.closed;
    // Only remove the exact temp directory allocated by this test.
    if (path.dirname(fixture.root) !== path.resolve(tmpdir()) || !path.basename(fixture.root).startsWith("omr-v2-")) {
      throw new Error(`Unexpected smoke fixture path: ${fixture.root}`);
    }
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 30_000);

async function start(legacy: boolean) {
  const executable = process.env.OPENCODE_V2_BIN;
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("Set OPENCODE_V2_BIN to the absolute OpenCode 2 executable path");
  }
  const root = await mkdtemp(path.join(tmpdir(), "omr-v2-"));
  const fixture: typeof fixtures[number] = { root };
  fixtures.push(fixture);
  const project = path.join(root, "project");
  await mkdir(project);
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OPENCODE_|MODEL_ROUTER_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_GENERATIVE_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) {
      delete env[name];
    }
  }
  for (const [name, dir] of Object.entries({
    HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata",
    LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp",
  })) {
    env[name] = path.join(root, dir);
    await mkdir(env[name], { recursive: true });
  }
  const config = path.join(env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(path.join(config, "plugins"), { recursive: true });
  if (legacy) {
    const source = pathToFileURL(path.join(ROOT, "src/index.ts")).href;
    await writeFile(path.join(config, "plugins", "router.ts"), `export { default } from ${JSON.stringify(source)};\n`);
  } else {
    await writeFile(path.join(config, "opencode.json"), JSON.stringify({ plugins: [ROOT] }));
  }
  const password = randomBytes(24).toString("base64url");
  Object.assign(env, {
    OPENCODE_PASSWORD: password, OPENCODE_TEST_HOME: env.HOME,
    OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_FILEWATCHER_DISABLE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
  });
  const version = spawnSync(executable, ["--version"], { env, cwd: project, encoding: "utf8", timeout: 15_000, windowsHide: true });
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout.trim()).toMatch(/^(?:opencode v)?2\./);
  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    env, cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  fixture.child = child;
  fixture.closed = new Promise((resolve) => child.once("close", () => resolve()));
  let log = "";
  child.stdout!.on("data", (chunk) => { log += chunk; });
  child.stderr!.on("data", (chunk) => { log += chunk; });
  child.on("error", (error) => { log += error.message; });
  let address: string | undefined;
  const deadline = Date.now() + 30_000;
  while (!(address = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1])) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`OpenCode 2 did not start:\n${log}`);
    await sleep(100);
  }
  const get = async (endpoint: string): Promise<any> => {
    const url = new URL(endpoint, address);
    url.searchParams.set("location[directory]", project);
    const response = await fetch(url, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${body}\n${log}`);
    return JSON.parse(body);
  };
  // Reading a catalog initializes the plugin graph; inventory alone may be empty.
  await get("/api/agent");
  let plugin: any;
  while (Date.now() < deadline) {
    const inventory = await get("/api/plugin");
    plugin = inventory.data.find((item: any) => item.source.type !== "builtin");
    if (plugin?.state.status === "active" || plugin?.state.status === "failed") break;
    await sleep(100);
  }
  if (!plugin) throw new Error(`Plugin did not load:\n${log}`);
  return { plugin, get };
}

d("OpenCode 2 native plugin registration", () => {
  it("reproduces rejection of the v1 function default export", async () => {
    const { plugin } = await start(true);
    expect(plugin.state).toMatchObject({
      status: "failed",
      error: "Plugin must export a default definition with an id and an effect or setup function.",
    });
  }, 60_000);

  it("loads the package server entrypoint and registers tiers and commands", async () => {
    const { plugin, get } = await start(false);
    expect(plugin.id).toBe("opencode-model-router");
    expect(plugin.state.status).toBe("active");
    expect(plugin.source.path.replaceAll("\\", "/")).toBe(`${ROOT.replaceAll("\\", "/")}/server.ts`);
    const agents = (await get("/api/agent")).data;
    for (const tier of ["fast", "medium", "heavy"]) {
      expect(agents.find((agent: any) => agent.id === tier)).toMatchObject({
        mode: "subagent", model: { id: expect.any(String), providerID: expect.any(String) },
      });
    }
    const commands = (await get("/api/command")).data.map((command: any) => command.name);
    expect(commands).toEqual(expect.arrayContaining(["tiers", "preset", "budget", "bypass", "router"]));
  }, 60_000);
});
