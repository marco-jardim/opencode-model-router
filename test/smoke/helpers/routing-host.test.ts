/**
 * Unit tests (no real OpenCode host) for the 0.1.0 additions to `routing-host.ts`: `HostOptions.extraPlugins`,
 * `RoutingHost.restart()` (one-time setup vs `launch()`), `HostOptions.provider` (a `CpxFront` in front of the `RoutingProvider`),
 * the "server listening" regex applied only to the NEW child's output, `killChild()` (through `restart()`/`stop()`) and `evidenceDir()`.
 *
 * The host process is a STUB: a node script that answers `--version`, prints `server listening on …` for `serve` and serves the two
 * routes `launch()` reads (`GET /api/agent`, `GET /api/plugin`, both behind the host's Basic password). It is started through a
 * `vi.mock` of `node:child_process` that maps the absolute `OPENCODE_V2_BIN` path onto `node <stub>`: a `.cmd` wrapper cannot be
 * spawned without a shell on win32, and `RoutingHost` (unchanged by this file) spawns without one. Everything else (the isolated root,
 * opencode.json, the logs, the provider, the front, the client, taskkill) is the real harness.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpawnOptions, SpawnSyncOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pidAlive, removeDirWhenReleased, waitUntil } from "../../helpers/remove-dir";
import { EVIDENCE_DIR, OPENAI_PROVIDER, ROOT, RoutingHost, arr, evidenceDir, jsonl, obj, str, waitFor, type HostOptions, type Obj } from "./routing-host";
import { CpxTimings } from "./cpx-timing";
import { collectObservationFiles } from "./cpx-idle-oracle";

const redirect = vi.hoisted(() => ({ executable: "", script: "" }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const target = (file: string, args: readonly string[]): [string, readonly string[]] =>
    redirect.executable !== "" && file === redirect.executable ? [process.execPath, [redirect.script, ...args]] : [file, args];
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: SpawnOptions) => { const [f, a] = target(file, args); return actual.spawn(f, a, options); },
    spawnSync: (file: string, args: readonly string[], options: SpawnSyncOptions) => { const [f, a] = target(file, args); return actual.spawnSync(f, a, options); },
  };
});

/** What the stub records per `serve` launch (`launches.jsonl` next to the script). */
interface Launch { pid: number; port: number; password: string; cwd: string; home: string; silent: boolean; observations?: string }

const NL = "\\n";
/** `mode.json` next to the script: `{ "silent": true }` makes later launches stay alive WITHOUT printing the listening line. */
const STUB = `'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('opencode v2.0.22-stub${NL}'); process.exit(0); }
const modeFile = path.join(__dirname, 'mode.json');
const mode = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, 'utf8')) : {};
const port = Number(args[args.indexOf('--port') + 1]);
const password = process.env.OPENCODE_PASSWORD;
fs.appendFileSync(path.join(__dirname, 'launches.jsonl'), JSON.stringify({ pid: process.pid, port, password, cwd: process.cwd(), home: process.env.HOME, silent: mode.silent === true, observations: process.env.MODEL_ROUTER_V2_OBSERVATIONS }) + '${NL}');
const plugin = id => ({ id, state: { status: 'active' } });
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + password).toString('base64')) { res.writeHead(401).end(); return; }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const reply = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })); };
  if (pathname === '/api/agent') { reply([]); return; }
  if (pathname === '/api/plugin') { reply([plugin('routing-smoke-preprobe'), plugin('opencode-model-router'), plugin('routing-smoke-probe')]); return; }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
});
server.listen(port, '127.0.0.1', () => { if (mode.silent !== true) process.stdout.write('server listening on http://127.0.0.1:' + port + '${NL}'); });
`;

let stubDir = "";
let modeFile = "";
const hosts: RoutingHost[] = [];
const saved = { bin: process.env.OPENCODE_V2_BIN, evidence: process.env.OMR_SMOKE_EVIDENCE_DIR };
const restoreEnv = (name: "OPENCODE_V2_BIN" | "OMR_SMOKE_EVIDENCE_DIR", value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

beforeEach(async () => {
  stubDir = await mkdtemp(path.join(tmpdir(), "omr-routing-host-test-"));
  redirect.script = path.join(stubDir, "stub-opencode.cjs");
  redirect.executable = path.join(stubDir, "opencode-stub");
  modeFile = path.join(stubDir, "mode.json");
  await writeFile(redirect.script, STUB);
  process.env.OPENCODE_V2_BIN = redirect.executable;
}, 30_000);
afterEach(async () => {
  try {
    await Promise.all(hosts.splice(0).map(host => host.stop()));
  } finally {
    restoreEnv("OPENCODE_V2_BIN", saved.bin);
    restoreEnv("OMR_SMOKE_EVIDENCE_DIR", saved.evidence);
    redirect.executable = "";
    redirect.script = "";
    await removeDirWhenReleased(stubDir);
  }
}, 40_000);

async function startHost(name: string, options: HostOptions = {}): Promise<RoutingHost> {
  const host = await RoutingHost.start(name, options);
  hosts.push(host);
  return host;
}
const launches = () => jsonl<Launch>(path.join(stubDir, "launches.jsonl"));
const anthropicBaseURL = (config: Obj): string | undefined => str(obj(obj(obj(config.providers).anthropic).settings).baseURL);
const ask = JSON.stringify({ model: "fixture", stream: false, messages: [{ role: "user", content: "ok" }] });
const post = (baseURL: string) => fetch(`${baseURL}/messages`, { method: "POST", body: ask });
const get = (host: RoutingHost, authorization: string) => fetch(new URL("/api/agent", host.baseUrl), { headers: { authorization } });

// ------------------------------------------------------------ extraPlugins ----
it("enables observations only by opt-in in a per-host directory outside project/worktrees, never inherited", async () => {
  const previous = process.env.MODEL_ROUTER_V2_OBSERVATIONS;
  process.env.MODEL_ROUTER_V2_OBSERVATIONS = path.join(stubDir, "must-not-inherit");
  try {
    const plain = await startHost("observations-off");
    const observed = await startHost("observations-on", { v2Observations: true });
    const [first, second] = await launches();
    expect(first!.observations).toBeUndefined();
    expect(plain.envKeys).not.toContain("MODEL_ROUTER_V2_OBSERVATIONS");
    expect(second!.observations).toBe(observed.observationDirectory);
    expect(path.dirname(observed.observationDirectory)).toBe(observed.root);
    expect(path.dirname(observed.project)).toBe(observed.root);
    expect(observed.observationDirectory).not.toBe(observed.project);
    expect((await stat(observed.observationDirectory)).isDirectory()).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.MODEL_ROUTER_V2_OBSERVATIONS;
    else process.env.MODEL_ROUTER_V2_OBSERVATIONS = previous;
  }
}, 30_000);

it("seals secondary adapters before the project and captures observation files before scratch removal without reopening adapters", async () => {
  const captures: unknown[] = [];
  const host = await startHost("observations-seal", { v2Observations: true, diagnostics: {
    timing: new CpxTimings(),
    collect: async (host, point) => { captures.push({ point, files: await collectObservationFiles(host.observationDirectory) }); },
  } });
  const file = { file: "raw.jsonl", text: "unsealed failure evidence\n" };
  await writeFile(path.join(host.observationDirectory, file.file), file.text);
  const other = path.join(host.root, "slots", "slot-1");
  const list = vi.spyOn(host.client.debug.location, "list").mockResolvedValue([{ directory: host.project }, { directory: other }]);
  const evict = vi.spyOn(host.client.debug.location, "evict").mockResolvedValue(undefined);
  const inventory = vi.spyOn(host, "everySession");
  await host.sealObservations();
  expect(list).toHaveBeenCalledOnce();
  expect(evict.mock.calls).toEqual([[{ location: { directory: other } }], [{ location: { directory: host.project } }]]);
  await host.stop();
  expect(captures).toEqual([{ point: "before-stop", files: [file] }, { point: "after-kill", files: [file] }]);
  expect(inventory).not.toHaveBeenCalled(); // An SDK session read here could create a new, unsealed stream.
  expect(existsSync(host.root)).toBe(false);
}, 30_000);

it("writes opencode.json plugins as [preProbe, router, ...extraPlugins, probe]: extras after the router, before the probe", async () => {
  const extraA = path.join(stubDir, "plugin-a");
  const extraB = path.join(stubDir, "plugin-b.mjs");
  const host = await startHost("extra-order", { preProbe: { routerStackNeedle: "omr" }, extraPlugins: [extraA, extraB] });
  const probe = path.join(host.root, "probe-plugin");
  const preProbe = path.join(host.root, "pre-probe-plugin");
  expect(arr((await host.hostConfigOnDisk()).plugins)).toEqual([preProbe, ROOT, extraA, extraB, probe]);
}, 30_000);

it("keeps the default plugins [router, probe] without extraPlugins, and [extras, probe] without the router", async () => {
  const plain = await startHost("extra-none");
  expect(arr((await plain.hostConfigOnDisk()).plugins)).toEqual([ROOT, path.join(plain.root, "probe-plugin")]);
  const extra = path.join(stubDir, "plugin-only");
  const control = await startHost("extra-control", { withoutRouter: true, extraPlugins: [extra] });
  expect(arr((await control.hostConfigOnDisk()).plugins)).toEqual([extra, path.join(control.root, "probe-plugin")]);
}, 30_000);

it("rejects a relative extraPlugins entry before anything is created", async () => {
  await expect(RoutingHost.start("extra-relative", { extraPlugins: [path.join(stubDir, "ok"), path.join("relative", "plugin")] }))
    .rejects.toThrow(/extraPlugins entries must be absolute paths: .*relative/);
  expect(await launches()).toEqual([]);
});

// ---------------------------------------------------------------- provider ----
it("puts a CpxFront in front of the scripted provider: opencode.json's baseURL is the front's, and host.front exists", async () => {
  const host = await startHost("front-on", { provider: {}, providers: OPENAI_PROVIDER });
  expect(host.front).toBeDefined();
  const baseURL = anthropicBaseURL(await host.hostConfigOnDisk());
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect((await post(baseURL!)).status).toBe(200);
  // The request went through the front first, then (forwarded) to the inner provider.
  expect(host.front!.requests).toHaveLength(1);
  expect(host.provider.requests).toHaveLength(1);
  // `$BASE_URL` of an extra provider resolves to the same (front) URL.
  expect(str(obj(obj(obj((await host.hostConfigOnDisk()).providers).openai).settings).baseURL)).toBe(baseURL);
}, 30_000);

it("without `provider` there is no front and opencode.json's baseURL is the inner provider's", async () => {
  const host = await startHost("front-off", { providers: OPENAI_PROVIDER });
  expect(host.front).toBeUndefined();
  const baseURL = anthropicBaseURL(await host.hostConfigOnDisk());
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect((await post(baseURL!)).status).toBe(200);
  expect(host.provider.requests).toHaveLength(1);
  expect(str(obj(obj(obj((await host.hostConfigOnDisk()).providers).openai).settings).baseURL)).toBe(baseURL);
}, 30_000);

// ----------------------------------------------------------------- restart ----
it("restart() keeps root, project, config files and logs, takes a new port/password/process, and leaves stop() working", async () => {
  const host = await startHost("restart", { provider: {} });
  const before = { root: host.root, project: host.project, port: host.port, baseUrl: host.baseUrl, authorization: host.authorization, client: host.client, front: host.front };
  const configFile = path.join(host.root, "config", "opencode", "opencode.json");
  const overridesFile = path.join(host.configHome, "opencode-model-router.overrides.jsonc");
  const configBefore = { text: await readFile(configFile, "utf8"), mtimeMs: (await stat(configFile)).mtimeMs };
  const overridesBefore = { text: await readFile(overridesFile, "utf8"), mtimeMs: (await stat(overridesFile)).mtimeMs };
  // Marks both logs: a truncation by the second boot would lose these lines.
  const hookLine = JSON.stringify({ __t: 1, hook: "before", marker: "before-restart" });
  const eventLine = JSON.stringify({ type: "marker.before-restart" });
  await appendFile(host.logs.hooks, `${hookLine}\n`);
  await appendFile(host.logs.events, `${eventLine}\n`);
  const [first] = await launches();
  expect(first).toBeDefined();

  await host.restart();

  // Same sandbox.
  expect(host.root).toBe(before.root);
  expect(host.project).toBe(before.project);
  expect(host.front).toBe(before.front);
  expect(await readFile(configFile, "utf8")).toBe(configBefore.text);
  expect((await stat(configFile)).mtimeMs).toBe(configBefore.mtimeMs);
  expect(await readFile(overridesFile, "utf8")).toBe(overridesBefore.text);
  expect((await stat(overridesFile)).mtimeMs).toBe(overridesBefore.mtimeMs);
  expect(await readFile(host.logs.hooks, "utf8")).toBe(`${hookLine}\n`);
  expect(await readFile(host.logs.events, "utf8")).toBe(`${eventLine}\n`);
  // New process, port, password, client.
  const runs = await launches();
  expect(runs).toHaveLength(2);
  const [old, current] = [runs[0]!, runs[1]!];
  expect(old.pid).toBe(first!.pid);
  expect(current.pid).not.toBe(old.pid);
  expect(host.port).toBe(current.port);
  expect(host.port).not.toBe(before.port);
  expect(host.baseUrl).toBe(`http://127.0.0.1:${current.port}`);
  expect(host.authorization).not.toBe(before.authorization);
  expect(host.client).not.toBe(before.client);
  expect(current.password).not.toBe(old.password);
  expect(current.home).toBe(old.home);
  expect(realpathSync.native(current.cwd)).toBe(realpathSync.native(before.project));
  expect(await waitUntil(() => !pidAlive(old.pid), 5_000)).toBe(true);
  expect(pidAlive(current.pid)).toBe(true);
  // The old password does not open the new child; the old port is closed; the new client works.
  expect((await get(host, before.authorization)).status).toBe(401);
  expect((await get(host, host.authorization)).status).toBe(200);
  await expect(fetch(new URL("/api/agent", before.baseUrl), { headers: { authorization: before.authorization } })).rejects.toThrow();
  expect((await host.client.agent.list()).data).toEqual([]);
  // The captured output accumulated both children's lines.
  expect(host.tail(10_000).match(/server listening on/g)).toHaveLength(2);
  // The front and provider survived: the config's baseURL still answers.
  expect((await post(anthropicBaseURL(await host.hostConfigOnDisk())!)).status).toBe(200);
  expect(host.front!.requests).toHaveLength(1);

  // restart() did not set the teardown: stop() still runs, kills the second child and removes the root.
  const teardown = await host.stop();
  expect(teardown.pid).toBe(current.pid);
  expect(teardown.hostPort).toBe(current.port);
  expect(teardown.hostPortClosed).toBe(true);
  expect(teardown.providerStopped).toBe(true);
  expect(teardown.rootRemoved).toBe(true);
  expect(existsSync(before.root)).toBe(false);
  expect(await waitUntil(() => !pidAlive(current.pid), 5_000)).toBe(true);
  await expect(host.restart()).rejects.toThrow(/already stopped/);
}, 60_000);

it("a restarted host is not satisfied by the previous child's 'server listening' line", async () => {
  const host = await startHost("restart-sliced");
  const [first] = await launches();
  expect(host.tail(10_000)).toContain(`server listening on http://127.0.0.1:${first!.port}`);
  // The next child stays alive but never announces its address.
  await writeFile(modeFile, JSON.stringify({ silent: true }));
  let settled = false;
  const outcome = host.restart().then(
    () => { settled = true; return { ok: true as const }; },
    (error: unknown) => { settled = true; return { ok: false as const, message: error instanceof Error ? error.message : String(error) }; },
  );
  const second = await waitFor("the silent child to start", async () => (await launches())[1]);
  expect(second.silent).toBe(true);
  // Unsliced output would already hold a match (the old line) and move on to the client; sliced output keeps waiting for the new child.
  expect(settled).toBe(false);
  process.kill(second.pid);
  const result = await outcome;
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.message).toMatch(/OpenCode 2 exited early/);
  // The failed restart left the host stoppable.
  expect((await host.stop()).rootRemoved).toBe(true);
}, 60_000);

// ------------------------------------------------------------- evidenceDir ----
it("opt-in timing observes setup/launch and captures diagnostics before cleanup, including boot failure", async () => {
  const timing = new CpxTimings();
  const captures: { point: string; root: string; marker: string }[] = [];
  const diagnostics: NonNullable<HostOptions["diagnostics"]> = { timing, collect: async (host, point) => {
    captures.push({ point, root: host.root, marker: await readFile(path.join(host.project, "marker"), "utf8") });
    if (point === "after-kill") throw new Error("Diagnostic failure must not prevent scratch cleanup");
  } };
  const host = await startHost("diagnostic", { diagnostics, prepare: async ({ project }) => { await writeFile(path.join(project, "marker"), "retained"); } });
  await host.stop();
  expect(timing.records.map(row => row.point)).toEqual(expect.arrayContaining(["host.boot.start", "host.prepare.start", "host.prepare.end", "host.spawn.start", "host.listening.observed", "host.catalog.start", "host.catalog.end", "host.launch.end", "host.boot.end"]));
  expect(captures.map(capture => capture.point)).toEqual(["before-stop", "after-kill"]);
  expect(captures.every(capture => capture.marker === "retained" && !existsSync(capture.root))).toBe(true);
  expect(timing.records.some(row => row.point === "host.diagnostics.capture-failed")).toBe(true);
  expect(JSON.stringify(timing)).not.toMatch(/authorization|password|Basic /i);

  await expect(RoutingHost.start("diagnostic-failed", { diagnostics, prepare: async ({ project }) => {
    await writeFile(path.join(project, "marker"), "boot failure retained");
    throw new Error("prepare failed");
  } })).rejects.toThrow("prepare failed");
  expect(captures.slice(2).map(capture => capture.point)).toEqual(["before-stop", "after-kill"]);
  expect(captures.slice(2).every(capture => capture.marker === "boot failure retained" && !existsSync(capture.root))).toBe(true);
  expect(timing.records.filter(row => row.point === "host.boot.end").at(-1)).toMatchObject({ ok: false });
}, 30_000);

it("evidenceDir(): the default without OMR_SMOKE_EVIDENCE_DIR (unset or empty), the override when absolute, an error when relative", () => {
  delete process.env.OMR_SMOKE_EVIDENCE_DIR;
  expect(evidenceDir()).toBe(EVIDENCE_DIR);
  process.env.OMR_SMOKE_EVIDENCE_DIR = "";
  expect(evidenceDir()).toBe(EVIDENCE_DIR);
  const absolute = path.join(stubDir, "evidence");
  process.env.OMR_SMOKE_EVIDENCE_DIR = absolute;
  expect(evidenceDir()).toBe(absolute); // read at call time, not at import
  process.env.OMR_SMOKE_EVIDENCE_DIR = path.join("relative", "evidence");
  expect(() => evidenceDir()).toThrow(/OMR_SMOKE_EVIDENCE_DIR must be an absolute path/);
});
