/** Phase 0.P spike harness for the cost-aware routing plan (#74).
 *
 * Runs spikes S1-S6 against a REAL OpenCode v2 host (2.0.22) and records the
 * verbatim evidence for each one as JSON in docs/qa/cost-aware-routing/spikes/.
 * Assertions read HOST STATE (session get/list/context, catalog, the host's own
 * event stream); never only the variables of the hook that caused the change.
 *
 *   RUN_OC_SMOKE_V2_SPIKES=1 [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts
 *
 * - S1-S3, S5, S6 start ONE isolated `opencode serve` (private HOME/XDG, keyless,
 *   a scripted Anthropic Messages provider, a probe plugin that records hook and
 *   event traffic). Nothing here calls a paid model.
 * - S4 is a catalog READ against the user's real, already running OpenCode v2
 *   service (its URL/password come from the user's state dir and are never
 *   written to the evidence). v2 keeps credentials in its own database, so a
 *   fresh isolated host has no real providers; copying a 7 GB live database is
 *   not an option. S4 never creates a session and never generates.
 * The evidence JSON is written BEFORE each assertion so a disproven hypothesis
 * still leaves its observation behind. Strings over 400 chars are clipped in the
 * evidence ("...[clipped, N chars]"); everything else is verbatim.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listenOnFetchSafePort, pickFetchSafePort } from "./helpers/fetch-safe-port";
import type { Block, RequestBody } from "./helpers/scripted-provider";

const ROOT = path.resolve(__dirname, "../..");
const RUN = process.env.RUN_OC_SMOKE_V2_SPIKES === "1";
const EVIDENCE_DIR = path.join(ROOT, "docs", "qa", "cost-aware-routing", "spikes");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- types ----
type Obj = Record<string, unknown>;
interface ModelRef { id: string; providerID: string; variant?: string }
interface SessionInfo { id: string; parentID?: string; agent?: string; model?: ModelRef; cost?: unknown; tokens?: unknown; outcome?: string; title?: string }
interface ModelInfo { id: string; providerID: string; enabled: boolean; variants: { id: string }[]; cost: unknown; limit: { context: number; input?: number; output: number } }
interface HostClient {
  session: {
    list(input?: { parentID?: string | null; limit?: number }): Promise<{ data: SessionInfo[] }>;
    create(input: { agent?: string; model?: ModelRef; title?: string; location?: { directory: string } }): Promise<SessionInfo>;
    get(input: { sessionID: string }): Promise<SessionInfo>;
    remove(input: { sessionID: string }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    context(input: { sessionID: string }): Promise<Obj[]>;
    active(): Promise<Record<string, unknown>>;
    interrupt(input: { sessionID: string }): Promise<unknown>;
  };
  model: { list(input?: { location?: { directory: string } }): Promise<{ data: ModelInfo[] }> };
  plugin: { list(): Promise<{ data: { id: string; state: { status: string; error?: string } }[] }> };
  agent: { list(): Promise<{ data: { id: string; mode: string; model?: ModelRef }[] }> };
}
interface HookRecord { hook: "before" | "after"; sessionID: string; callID: string; agent: string; tool: string; before?: unknown; after?: unknown; status?: string; result?: unknown; error?: unknown }
interface EventRecord { type: string; data?: Obj; [key: string]: unknown }
interface Capture {
  model?: string; catalogModel?: string; session?: string; agent?: string; kind?: string; stream: boolean;
  outputConfig?: unknown; thinking?: unknown; inputTokens: number; lastText: string; toolResult: boolean; reply: "dispatch" | "text";
}

// -------------------------------------------------------------- helpers ----
const obj = (value: unknown): Obj => (value !== null && typeof value === "object" ? value as Obj : {});
/** Clip very long strings only (the S6 filler); everything else stays verbatim. */
function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 200)}...[clipped, ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  return value;
}
async function waitFor<T>(label: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(stepMs);
  }
}
function v2Executable(): string {
  const executable = process.env.OPENCODE_V2_BIN
    ?? spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" }).stdout?.trim().split(/\r?\n/)[0]
    ?? "";
  if (!path.isAbsolute(executable)) throw new Error("Set OPENCODE_V2_BIN to an absolute OpenCode v2 executable path");
  return executable;
}
async function loadClient(baseUrl: string, authorization: string): Promise<HostClient> {
  // @opencode/client is a dependency of @opencode/plugin and is not hoisted.
  const candidates = [
    path.join(ROOT, "node_modules", "@opencode", "client", "dist", "promise", "index.js"),
    path.join(ROOT, "node_modules", "@opencode", "plugin", "node_modules", "@opencode", "client", "dist", "promise", "index.js"),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`@opencode/client not found in ${candidates.join(" | ")}`);
  const mod: { OpenCode: { make(options: { baseUrl: string; headers: Record<string, string> }): HostClient } } = await import(/* @vite-ignore */ pathToFileURL(file).href);
  return mod.OpenCode.make({ baseUrl, headers: { authorization } });
}
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

// ----------------------------------------------------- scripted provider ----
/** Fills every heading of the host's compaction SUMMARY_TEMPLATE (session/compaction.ts) so a compaction can complete. */
const COMPACTION_SUMMARY = ["## Objective", "spike", "## Requirements", "none", "## Decisions", "none", "## Work State", "### Completed", "none", "### Active", "none", "### Blocked", "none", "## Next Move", "reply", "## Relevant Files", "none", "## Important Context", "none"].join("\n");

/** Anthropic Messages fixture. `SPIKE_CALL={json}` in the last user message makes
 * the caller emit one `subagent` tool call with that exact input; after the tool
 * result it answers ROOT_DONE; every other request is answered CHILD_OK. Reported
 * input tokens are body-length/4 so context pressure is realistic. */
class SpikeProvider {
  readonly captures: Capture[] = [];
  readonly errors: string[] = [];
  private sequence = 0;
  private server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body: RequestBody & { thinking?: unknown } = JSON.parse(raw);
      const header = (key: string) => { const value = req.headers[key]; return Array.isArray(value) ? value[0] : value; };
      const last = body.messages?.at(-1)?.content ?? [];
      const lastBlocks: Block[] = typeof last === "string" ? [{ type: "text", text: last }] : last;
      const toolResult = lastBlocks.some(b => b.type === "tool_result");
      const lastText = lastBlocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
      const call = toolResult ? undefined : /SPIKE_CALL=(\{[^\n]*\})/.exec(lastText)?.[1];
      const inputTokens = Math.max(10, Math.ceil(raw.length / 4));
      this.captures.push({
        model: body.model, catalogModel: header("x-proof-model"), session: header("x-proof-session"), agent: header("x-proof-agent"), kind: header("x-proof-kind"),
        stream: body.stream === true, outputConfig: body.output_config, thinking: body.thinking, inputTokens, lastText, toolResult, reply: call ? "dispatch" : "text",
      });
      if (call && !body.tools?.some(t => t.name === "subagent")) throw new Error("Fixture requested subagent but the request carries no such tool");
      const text = header("x-proof-kind") === "compaction" ? COMPACTION_SUMMARY : toolResult ? "ROOT_DONE" : "CHILD_OK";
      this.send(res, body, inputTokens, text, call ? JSON.parse(call) as Record<string, unknown> : undefined);
    } catch (error) {
      this.errors.push(String(error));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted provider error" } }));
    }
  });
  async start(): Promise<string> { return `http://127.0.0.1:${await listenOnFetchSafePort(this.server)}/v1`; }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private send(res: import("node:http").ServerResponse, body: RequestBody, inputTokens: number, text: string, input?: Record<string, unknown>) {
    const n = ++this.sequence;
    const message = { id: `msg_spike_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, content: input ? [{ type: "tool_use", id: `toolu_spike_${n}`, name: "subagent", input }] : [{ type: "text", text }], stop_reason: input ? "tool_use" : "end_turn", usage: { input_tokens: inputTokens, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message });
    event("ping", {});
    event("content_block_start", { index: 0, content_block: input ? { type: "tool_use", id: `toolu_spike_${n}`, name: "subagent", input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: input ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: input ? "tool_use" : "end_turn", stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  }
}

// ------------------------------------------------------------ probe plugin ----
/** Native v2 plugin. It (a) rewrites `subagent` input in `tool.execute.before`
 * when SPIKE_REWRITE names a matching rewrite (S1), (b) logs every subagent
 * before/after, (c) logs session events from ctx.event.subscribe (S3, S6) and
 * (d) tags provider requests with session/agent/model/kind headers. */
const PROBE_PLUGIN = `import {appendFileSync, readFileSync} from 'node:fs';
const log=(file,x)=>appendFileSync(process.env[file],JSON.stringify(x)+'\\n');
const rewriteSpec=()=>{try{return JSON.parse(readFileSync(process.env.SPIKE_REWRITE,'utf8'));}catch{return undefined;}};
export default {id:'routing-spike-probe',async setup(ctx){
 await ctx.tool.hook('execute.before',e=>{
  if(e.tool!=='subagent')return;
  const before=structuredClone(e.input);
  const spec=rewriteSpec();
  if(spec&&e.input&&typeof e.input==='object'&&typeof e.input.prompt==='string'&&e.input.prompt.includes(spec.when)) e.input={...e.input,...spec.set};
  log('SPIKE_HOOKS',{hook:'before',sessionID:e.sessionID,callID:e.id,agent:e.agent,tool:e.tool,before,after:structuredClone(e.input)});
 });
 await ctx.tool.hook('execute.after',e=>{
  if(e.tool!=='subagent')return;
  log('SPIKE_HOOKS',{hook:'after',sessionID:e.sessionID,callID:e.id,agent:e.agent,tool:e.tool,status:e.status,result:e.status==='completed'?e.result:undefined,error:e.status==='error'?e.error:undefined});
 });
 await ctx.session.hook('http.request',e=>{
  e.request.headers.set('x-proof-session',e.sessionID);
  e.request.headers.set('x-proof-agent',e.agent??'aux');
  e.request.headers.set('x-proof-kind',e.kind);
  e.request.headers.set('x-proof-model',e.model.providerID+'/'+e.model.id+(e.model.variant?'#'+e.model.variant:''));
 });
 (async()=>{
  try{for await(const event of ctx.event.subscribe({})){
   if(typeof event.type==='string'&&event.type.startsWith('session.')&&!/(delta|streamed)/.test(event.type)) log('SPIKE_EVENTS',event);
  }}catch(error){log('SPIKE_EVENTS',{type:'probe.subscription.failed',error:String(error)});}
 })();
}};`;

// ------------------------------------------------------------- host fixture ----
const ROOT_MODEL: ModelRef = { providerID: "anthropic", id: "claude-opus-4-7" };
const SMALL_CONTEXT = 12_000; // above the ~5k-token fixed system prompt, below the S6 oversize prompt
const ref = (m: ModelRef) => `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;

class ScriptedHost {
  readonly provider = new SpikeProvider();
  client!: HostClient;
  baseUrl = "";
  authorization = "";
  project = "";
  /** The server base-configuration location that /api/experimental/generate always uses. */
  configDir = "";
  logs = { hooks: "", events: "", rewrite: "" };
  private child?: ChildProcess;
  private output = "";
  constructor(readonly root: string) {}

  async start(): Promise<this> {
    const executable = v2Executable();
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(version.stdout.trim(), version.stderr).toMatch(/^(?:opencode v)?2\./);
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const name of Object.keys(env)) if (/^(OPENCODE_|MODEL_ROUTER_|XDG_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) delete env[name];
    for (const [name, dir] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp" })) {
      env[name] = path.join(this.root, dir);
      await mkdir(env[name]!, { recursive: true });
    }
    this.project = path.join(this.root, "project");
    await mkdir(this.project, { recursive: true });
    const plugin = path.join(this.root, "probe-plugin");
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "routing-spike-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
    await writeFile(path.join(plugin, "server.mjs"), PROBE_PLUGIN);
    this.logs = { hooks: path.join(this.root, "hooks.jsonl"), events: path.join(this.root, "events.jsonl"), rewrite: path.join(this.root, "rewrite.json") };
    await writeFile(this.logs.hooks, "");
    await writeFile(this.logs.events, "");
    const baseURL = await this.provider.start();
    const configDir = this.configDir = path.join(env.XDG_CONFIG_HOME!, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: ref(ROOT_MODEL),
      plugins: [plugin],
      providers: { anthropic: { settings: { baseURL, apiKey: "keyless-spike-fake" }, models: {
        // S6: an alias of the scripted model whose window is tiny. Its catalog id differs from the wire id.
        "spike-small": { modelID: ROOT_MODEL.id, name: "Spike Small Window", limit: { context: SMALL_CONTEXT, output: 1_000 } },
      } } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    }));
    const password = randomBytes(24).toString("base64url");
    Object.assign(env, {
      OPENCODE_PASSWORD: password, OPENCODE_TEST_HOME: env.HOME, PWD: this.project,
      OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_FILEWATCHER_DISABLE: "true",
      SPIKE_HOOKS: this.logs.hooks, SPIKE_EVENTS: this.logs.events, SPIKE_REWRITE: this.logs.rewrite,
    });
    const port = await pickFetchSafePort();
    this.child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], { cwd: this.project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout!.on("data", chunk => { this.output += chunk; });
    this.child.stderr!.on("data", chunk => { this.output += chunk; });
    this.baseUrl = await waitFor("host to listen", () => {
      if (this.child!.exitCode !== null) throw new Error(`OpenCode 2 exited early:\n${this.output}`);
      return /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(this.output)?.[1];
    }, 40_000);
    this.authorization = basic("opencode", password);
    this.client = await loadClient(this.baseUrl, this.authorization);
    // A catalog read starts the native plugin graph; wait for THIS plugin.
    await this.client.agent.list();
    const state = await waitFor("probe plugin state", async () => {
      const found = (await this.client.plugin.list()).data.find(p => p.id === "routing-spike-probe")?.state;
      return found && (found.status === "active" || found.status === "failed") ? found : undefined;
    }, 40_000);
    expect(state, this.output).toMatchObject({ status: "active" });
    return this;
  }

  async stop(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      const closed = new Promise<void>(resolve => this.child!.once("close", () => resolve()));
      this.child.kill();
      await Promise.race([closed, delay(5_000)]);
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    await this.provider.stop();
  }

  async hooks(): Promise<HookRecord[]> { return jsonl<HookRecord>(this.logs.hooks); }
  /** Every plugin instance (one per initialised location) subscribes, so the same host event can be logged twice: dedupe by event id. */
  async events(): Promise<EventRecord[]> {
    const seen = new Set<string>();
    return (await jsonl<EventRecord>(this.logs.events)).filter(e => { const id = typeof e.id === "string" ? e.id : undefined; if (id === undefined) return true; if (seen.has(id)) return false; seen.add(id); return true; });
  }
  async setRewrite(spec: { when: string; set: Obj } | undefined) {
    if (spec) await writeFile(this.logs.rewrite, JSON.stringify(spec)); else await rm(this.logs.rewrite, { force: true });
  }
  tail(): string { return this.output.slice(-3_000); }

  /** The scripted root orchestrator: creates a root session on the scripted model. */
  async root_(title: string): Promise<string> {
    return (await this.client.session.create({ agent: "build", model: ROOT_MODEL, title, location: { directory: this.project } })).id;
  }

  /** Prompts the root so that its scripted model emits one `subagent` call with `call` as input. */
  async dispatch(rootID: string, call: Obj): Promise<{ before: HookRecord; after: HookRecord; childID: string }> {
    const seen = (await this.hooks()).filter(h => h.sessionID === rootID && h.hook === "after").length;
    await this.client.session.prompt({ sessionID: rootID, text: `SPIKE_CALL=${JSON.stringify(call)}` });
    const after = await waitFor("subagent execute.after hook", async () => (await this.hooks()).filter(h => h.sessionID === rootID && h.hook === "after")[seen], 90_000);
    const before = (await this.hooks()).find(h => h.callID === after.callID && h.hook === "before");
    if (!before) throw new Error(`no execute.before record for ${after.callID}`);
    await this.settle(rootID);
    const result = obj(obj(after.result).output);
    const childID = typeof result.sessionID === "string" ? result.sessionID : (await this.client.session.list({ parentID: rootID })).data[0]?.id;
    if (!childID) throw new Error(`dispatch produced no child session: ${JSON.stringify(after)}`);
    return { before, after, childID };
  }

  /** Waits until the session is idle again (root turn fully finished). */
  async settle(sessionID: string): Promise<void> {
    await Promise.race([this.client.session.wait({ sessionID }), delay(90_000).then(() => { throw new Error(`session.wait(${sessionID}) timed out`); })]);
    await waitFor(`${sessionID} to leave the active set`, async () => Object.hasOwn(await this.client.session.active(), sessionID) ? undefined : true, 60_000);
  }

  async everySession(): Promise<SessionInfo[]> {
    const roots = (await this.client.session.list({ limit: 500 })).data;
    const all = new Map(roots.map(s => [s.id, s] as const));
    for (const root of roots) for (const child of (await this.client.session.list({ parentID: root.id, limit: 500 })).data) all.set(child.id, child);
    return [...all.values()];
  }

  /** Deletes every session that did not exist in `keep`, children first. Returns what is left. */
  async sweep(keep: ReadonlySet<string>): Promise<{ removed: string[]; errors: string[]; orphans: string[] }> {
    const removed: string[] = [];
    const errors: string[] = [];
    for (let round = 0; round < 3; round++) {
      const extra = (await this.everySession()).filter(s => !keep.has(s.id)).sort((a, b) => Number(Boolean(b.parentID)) - Number(Boolean(a.parentID)));
      if (extra.length === 0) break;
      for (const s of extra) {
        try { await this.client.session.interrupt({ sessionID: s.id }); } catch { /* best effort */ }
        try { await this.client.session.remove({ sessionID: s.id }); removed.push(s.id); } catch (error) { errors.push(`${s.id}: ${String(error)}`); }
      }
    }
    return { removed, errors, orphans: (await this.everySession()).filter(s => !keep.has(s.id)).map(s => s.id) };
  }
}
async function jsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

// ------------------------------------------------------------ spike runner ----
/** `partial` marks a pass whose hypothesis only held in part; it is reported as PARTIAL-PASS in the evidence. */
interface Spike { observed: Obj; notes: string[]; verdict(pass: boolean, detail: string, partial?: boolean): void; keep: Set<string> }
let scriptedHost: Promise<ScriptedHost> | undefined;
let hostRoot: string | undefined;
const getHost = () => scriptedHost ??= (async () => {
  hostRoot = await mkdtemp(path.join(tmpdir(), "omr-spikes-"));
  const host = new ScriptedHost(hostRoot);
  try { return await host.start(); } catch (error) { await host.stop().catch(() => undefined); throw error; }
})();

afterAll(async () => {
  try { await (await scriptedHost)?.stop(); } catch { /* host never started */ }
  if (hostRoot) await rm(hostRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}, 60_000);

async function writeEvidence(id: string, hypothesis: string, assertionResult: string, spike: Spike): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(path.join(EVIDENCE_DIR, `${id}.json`), `${JSON.stringify(clip({
    spike: id, host: "opencode v2.0.22 (native v2 plugin API)", recordedAt: new Date().toISOString(),
    hypothesis, observed: spike.observed, assertionResult, notes: spike.notes,
  }), null, 2)}\n`);
}

/** Runs one spike: records evidence BEFORE asserting, sweeps the sessions it created, and fails on orphans. */
async function spike(id: string, hypothesis: string, body: (s: Spike, host: ScriptedHost) => Promise<void>, scripted = true): Promise<void> {
  const host = scripted ? await getHost() : undefined;
  const keep = new Set((await host?.everySession() ?? []).map(s => s.id));
  let verdict: { pass: boolean; detail: string; partial: boolean } | undefined;
  let failure: unknown;
  const state: Spike = { observed: {}, notes: [], keep, verdict: (pass, detail, partial = false) => { verdict = { pass, detail, partial }; } };
  try { await body(state, host as ScriptedHost); } catch (error) { failure = error; }
  if (host) {
    const cleanup = await host.sweep(keep);
    state.observed.cleanup = cleanup;
    if (cleanup.orphans.length > 0 || cleanup.errors.length > 0) state.notes.push(`CLEANUP PROBLEM: ${JSON.stringify(cleanup)}`);
    if (failure === undefined && (cleanup.orphans.length > 0 || cleanup.errors.length > 0)) failure = new Error(`orphan sessions remain: ${JSON.stringify(cleanup)}`);
    state.observed.providerErrors = host.provider.errors;
  }
  const result = failure !== undefined ? `ERROR: ${failure instanceof Error ? failure.message : String(failure)}` : verdict ? `${verdict.pass ? (verdict.partial ? "PARTIAL-PASS" : "PASS") : "FAIL"}: ${verdict.detail}` : "NO VERDICT";
  if (failure !== undefined && host) state.notes.push(`host log tail: ${host.tail()}`);
  await writeEvidence(id, hypothesis, result, state);
  if (failure !== undefined) throw failure;
  expect(verdict, `${id} produced no verdict`).toBeDefined();
  expect(verdict!.pass, `${id} hypothesis disproven — ${verdict!.detail}`).toBe(true);
}

const sessionView = (s: SessionInfo) => ({ id: s.id, parentID: s.parentID, agent: s.agent, model: s.model, cost: s.cost, tokens: s.tokens, outcome: s.outcome, title: s.title });
async function childState(host: ScriptedHost, childID: string) {
  const session = await host.client.session.get({ sessionID: childID });
  const messages = await host.client.session.context({ sessionID: childID });
  return {
    session: sessionView(session), messageCount: messages.length, messageTypes: messages.map(m => String(m.type)),
    compactionMessages: messages.filter(m => m.type === "compaction").map(m => ({ status: m.status, reason: m.reason, error: m.error, cost: m.cost, tokens: m.tokens })),
  };
}
/** First enabled anthropic catalog model with >=2 variants other than the root model (so the model really changes). */
async function pickTarget(host: ScriptedHost) {
  const catalog = (await host.client.model.list({ location: { directory: host.project } })).data;
  const usable = catalog.filter(m => m.providerID === "anthropic" && m.enabled && m.variants.length >= 2 && m.id !== "spike-small");
  const target = usable.find(m => m.id !== ROOT_MODEL.id) ?? usable[0];
  return { catalog, target, rootEntry: catalog.find(m => m.providerID === ROOT_MODEL.providerID && m.id === ROOT_MODEL.id) };
}

// ------------------------------------------------------------------ spikes ----
const d = RUN ? describe : describe.skip;
d("routing spikes S1-S6 on the real OpenCode v2 host", () => {
  it("S1: a plugin execute.before hook can reassign subagent agent+model and the host stores the child that way", async () => {
    await spike("S1", "tool.hook('execute.before') reassigning event.input of the subagent tool (agent general->explore, model -> provider/model#variant) makes the host create the CHILD session with the rewritten agent and model/variant.", async (s, host) => {
      const { target, rootEntry } = await pickTarget(host);
      s.observed.catalogRootModel = rootEntry && { id: rootEntry.id, variants: rootEntry.variants.map(v => v.id), cost: rootEntry.cost, limit: rootEntry.limit };
      if (!target) { s.observed.catalogProblem = "no anthropic model with >=2 variants"; throw new Error("no catalog model with variants to rewrite to"); }
      const variant = target.variants.at(-1)!.id;
      const rewritten = `${target.providerID}/${target.id}#${variant}`;
      s.observed.target = { ref: rewritten, variants: target.variants.map(v => v.id) };
      s.observed.agents = (await host.client.agent.list()).data.map(a => ({ id: a.id, mode: a.mode, model: a.model }));
      const rootID = await host.root_("S1 root");
      await host.setRewrite({ when: "S1_MARK", set: { agent: "explore", model: rewritten } });
      const { before, after, childID } = await host.dispatch(rootID, { agent: "general", description: "S1 dispatch", prompt: "S1_MARK reply briefly", background: false });
      await host.setRewrite(undefined);
      const stored = await childState(host, childID);
      const listed = (await host.client.session.list({ parentID: rootID })).data.map(sessionView);
      s.observed.hookBefore = before.before; s.observed.hookAfterRewrite = before.after; s.observed.toolAfter = after;
      s.observed.storedChild = stored; s.observed.listedChildren = listed;
      s.observed.providerCapturesForChild = host.provider.captures.filter(c => c.session === childID).map(c => ({ model: c.model, catalogModel: c.catalogModel, agent: c.agent, kind: c.kind, outputConfig: c.outputConfig, thinking: c.thinking }));
      const expected = { providerID: target.providerID, id: target.id, variant };
      const sameModel = (m: ModelRef | undefined) => m?.providerID === expected.providerID && m.id === expected.id && m.variant === expected.variant;
      const ok = stored.session.agent === "explore" && sameModel(stored.session.model) && listed.some(x => x.id === childID && x.agent === "explore" && sameModel(x.model));
      s.verdict(ok, `child stored as agent=${stored.session.agent} model=${JSON.stringify(stored.session.model)} (wanted explore ${JSON.stringify(expected)})`);
    });
  }, 240_000);

  it("S2: resuming a child with sessionID + a higher #variant keeps history and changes the variant; a different agent switches the agent", async () => {
    await spike("S2", "A subagent call with sessionID + model '<same model>#<higher variant>' switches the stored child's variant while its history grows; a further call with a different agent switches the stored agent.", async (s, host) => {
      const { target } = await pickTarget(host);
      if (!target) throw new Error("no catalog model with variants");
      const low = target.variants[0]!.id;
      const high = target.variants.at(-1)!.id;
      s.observed.target = { id: `${target.providerID}/${target.id}`, variants: target.variants.map(v => v.id), low, high };
      const rootID = await host.root_("S2 root");
      const base = `${target.providerID}/${target.id}`;
      const first = await host.dispatch(rootID, { agent: "general", description: "S2 dispatch", prompt: "S2 first prompt", model: `${base}#${low}` });
      const childID = first.childID;
      const one = await childState(host, childID);
      const second = await host.dispatch(rootID, { agent: "general", description: "S2 resume variant", prompt: "S2 second prompt", sessionID: childID, model: `${base}#${high}` });
      const two = await childState(host, childID);
      const third = await host.dispatch(rootID, { agent: "explore", description: "S2 resume agent", prompt: "S2 third prompt", sessionID: childID });
      const three = await childState(host, childID);
      s.observed.afterFirstDispatch = one; s.observed.afterVariantResume = two; s.observed.afterAgentResume = three;
      s.observed.hooks = { first: [first.before.before, first.after.status], second: [second.before.before, second.after.status, second.after.result], third: [third.before.before, third.after.status, third.after.result] };
      s.observed.sameChildEverywhere = [first.childID, second.childID, third.childID];
      s.observed.providerCapturesForChild = host.provider.captures.filter(c => c.session === childID).map(c => ({ model: c.model, catalogModel: c.catalogModel, agent: c.agent, kind: c.kind, outputConfig: c.outputConfig, thinking: c.thinking, lastText: c.lastText.slice(0, 80) }));
      if (low === high) s.notes.push("model exposes a single variant: variant-switch part is unverifiable");
      const variantOk = low !== high && one.session.model?.variant === low && two.session.model?.variant === high;
      const historyOk = two.messageCount > one.messageCount && three.messageCount > two.messageCount && second.childID === childID;
      const agentOk = one.session.agent === "general" && two.session.agent === "general" && three.session.agent === "explore";
      s.observed.checks = { variantOk, historyOk, agentOk };
      // Extra data point for the routing plan (not part of the verdict): does the effort the
      // provider RECEIVES follow the stored variant after a resume? Start a second child at the
      // highest variant, then resume it at the lowest and a middle one.
      const mid = target.variants[Math.floor(target.variants.length / 2)]!.id;
      const secondChild = await host.dispatch(rootID, { agent: "general", description: "S2 wire effort", prompt: "S2 effort start", model: `${base}#${high}` });
      await host.dispatch(rootID, { agent: "general", description: "S2 wire effort low", prompt: "S2 effort resume low", sessionID: secondChild.childID, model: `${base}#${low}` });
      await host.dispatch(rootID, { agent: "general", description: "S2 wire effort mid", prompt: "S2 effort resume mid", sessionID: secondChild.childID, model: `${base}#${mid}` });
      const wire = (id: string) => host.provider.captures.filter(c => c.session === id && c.kind === "primary").map(c => ({ variantInRequestRef: c.catalogModel?.split("#")[1], effortOnWire: obj(c.outputConfig).effort, lastText: c.lastText.slice(-24) }));
      s.observed.wireEffort = { firstChild: wire(childID), secondChild: wire(secondChild.childID), secondChildStored: await childState(host, secondChild.childID) };
      const followsWire = [...wire(childID), ...wire(secondChild.childID)].every(w => w.variantInRequestRef === w.effortOnWire);
      s.observed.derived = { wireEffortFollowsVariant: followsWire };
      if (!followsWire) s.notes.push("WIRE FINDING: after a resume the stored session variant changes, but the effort the provider receives (output_config.effort) does not follow it on every request; see observed.wireEffort.");
      s.verdict(variantOk && historyOk && agentOk, `variant ${one.session.model?.variant}->${two.session.model?.variant} (wanted ${low}->${high}); messages ${one.messageCount}->${two.messageCount}->${three.messageCount}; agent ${one.session.agent}->${two.session.agent}->${three.session.agent}`);
    });
  }, 300_000);

  it("S3: a plugin event subscription receives session.step.ended with cost and tokens for the child", async () => {
    await spike("S3", "ctx.event.subscribe in a plugin delivers a session.step.ended event for the CHILD session whose data carries cost and tokens {input, output, reasoning, cache{read,write}}.", async (s, host) => {
      const { target } = await pickTarget(host);
      const rootID = await host.root_("S3 root");
      const { childID } = await host.dispatch(rootID, { agent: "general", description: "S3 dispatch", prompt: "S3 child task", ...(target ? { model: `${target.providerID}/${target.id}` } : {}) });
      const ended = await waitFor("session.step.ended for the child", async () => (await host.events()).filter(e => e.type === "session.step.ended" && e.data?.sessionID === childID), 20_000).catch(() => []);
      const stored = await childState(host, childID);
      const all = (await host.events()).filter(e => e.data?.sessionID === childID);
      s.observed.stepEndedEvents = ended;
      s.observed.childEventTypes = all.map(e => e.type);
      s.observed.storedChildTotals = { cost: stored.session.cost, tokens: stored.session.tokens };
      s.observed.catalogCost = target && { id: target.id, cost: target.cost };
      const data = obj(ended[0]?.data);
      const tokens = obj(data.tokens);
      const shape = ended.length > 0 && Object.hasOwn(data, "cost") && ["input", "output", "reasoning"].every(k => Object.hasOwn(tokens, k)) && ["read", "write"].every(k => Object.hasOwn(obj(tokens.cache), k));
      s.observed.derived = { events: ended.length, costType: typeof data.cost, costValue: data.cost, costPositive: typeof data.cost === "number" ? data.cost > 0 : undefined, tokenKeys: Object.keys(tokens), cacheKeys: Object.keys(obj(tokens.cache)) };
      if (!(typeof data.cost === "number" && data.cost > 0)) s.notes.push("cost is not > 0: the model has no catalog pricing here, so cost is a zero/unpriced value (hypothesis says that yields 0)");
      s.verdict(shape, `${ended.length} session.step.ended event(s) for the child; cost=${JSON.stringify(data.cost)} tokens=${JSON.stringify(data.tokens)}`);
    });
  }, 240_000);

  it("S4: the real host catalog lists variants[].id, cost and limit.context for the candidate models", async () => {
    await spike("S4", "The host model catalog (GET /api/model, the call behind ctx.model.list) exposes variants[].id in order, cost and limit.context for the real configured models anthropic/claude-sonnet-5-5, anthropic/claude-opus-5-5, anthropic/claude-haiku-4-5, openai/gpt-6-luna, opencode/deepseek-v4.1-flash.", async (s) => {
      const file = path.join(homedir(), ".local", "state", "opencode", "service.json");
      s.observed.source = "the user's running OpenCode v2 service (read-only GET /api/model and /api/provider; no session, no generation)";
      if (!existsSync(file)) { s.notes.push(`IMPOSSIBLE: ${file} does not exist, so there is no live service with the real config`); s.verdict(false, "no live real-config host"); return; }
      const service = JSON.parse(await readFile(file, "utf8")) as { url: string; password: string; version?: string };
      const get = async (route: string) => {
        const response = await fetch(new URL(route, service.url), { headers: { authorization: basic("opencode", service.password) }, signal: AbortSignal.timeout(30_000) });
        return { status: response.status, body: JSON.parse(await response.text()) as Obj };
      };
      s.observed.serviceVersion = service.version;
      const models = await get("/api/model");
      const providers = await get("/api/provider");
      const catalog = (models.body.data ?? []) as ModelInfo[];
      s.observed.status = { model: models.status, provider: providers.status };
      s.observed.location = models.body.location;
      s.observed.providerActivation = ((providers.body.data ?? []) as { id: string; activation: string }[]).map(p => `${p.id}:${p.activation}`);
      s.observed.catalogProviders = [...new Set(catalog.map(m => m.providerID))];
      const wanted = ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "openai/gpt-6-luna", "opencode/deepseek-v4.1-flash"];
      const view = (m: ModelInfo) => ({ ref: `${m.providerID}/${m.id}`, enabled: m.enabled, variants: m.variants.map(v => v.id), cost: m.cost, limitContext: m.limit.context, limit: m.limit });
      s.observed.requested = Object.fromEntries(wanted.map(w => {
        const [provider, ...rest] = w.split("/");
        const id = rest.join("/");
        const exact = catalog.find(m => m.providerID === provider && m.id === id);
        // The same model id under another provider (e.g. opencode-go) is reported separately, never conflated.
        const elsewhere = catalog.filter(m => m.id === id && m.providerID !== provider).map(view);
        return [w, { exact: exact ? view(exact) : "ABSENT from the catalog", sameIdOtherProviders: elsewhere }];
      }));
      const present = wanted.filter(w => catalog.some(m => `${m.providerID}/${m.id}` === w));
      s.observed.presentExact = present;
      s.observed.absentExact = wanted.filter(w => !present.includes(w));
      const complete = present.every(w => { const m = catalog.find(x => `${x.providerID}/${x.id}` === w)!; return Array.isArray(m.variants) && Array.isArray(m.cost) && typeof m.limit.context === "number"; });
      if (s.observed.absentExact && (s.observed.absentExact as string[]).length > 0) s.notes.push("Some requested ids are absent under that exact provider/id; see sameIdOtherProviders for where the host actually lists them.");
      s.verdict(models.status === 200 && present.length > 0 && complete, `${present.length}/${wanted.length} requested ids exist under that exact provider/id (${present.join(", ")}); absent: ${(s.observed.absentExact as string[]).join(", ") || "none"}; every present entry exposes variants[], cost[] and limit.context`, present.length < wanted.length);
    }, false);
  }, 120_000);

  it("S5: POST /api/experimental/generate returns non-empty data.text for the scripted model", async () => {
    await spike("S5", "POST /api/experimental/generate with { prompt, model } returns data.text (non-empty) using the scripted provider model.", async (s, host) => {
      // The host runs this route against the server's BASE configuration location
      // (the global config dir), never the request's project location, and that
      // location's plugin graph is lazy. Record the cold call, warm that location
      // with a catalog read, then measure the calls that matter.
      const url = new URL("/api/experimental/generate", host.baseUrl);
      const call = async (phase: string, prompt: string): Promise<Obj> => {
        const started = performance.now();
        const response = await fetch(url, { method: "POST", headers: { authorization: host.authorization, "content-type": "application/json" }, body: JSON.stringify({ prompt, model: ROOT_MODEL }), signal: AbortSignal.timeout(60_000) });
        const text = await response.text();
        return { phase, request: { prompt, model: ROOT_MODEL }, status: response.status, latencyMs: Math.round(performance.now() - started), rawBody: text };
      };
      const cold = await call("cold (base-config location not yet initialised)", "S5 cold probe");
      const catalogUrl = new URL("/api/model", host.baseUrl);
      catalogUrl.searchParams.set("location[directory]", host.configDir);
      const warmedAfterMs = await (async () => {
        const started = performance.now();
        await waitFor("base-config catalog to list the scripted model", async () => {
          const response = await fetch(catalogUrl, { headers: { authorization: host.authorization }, signal: AbortSignal.timeout(30_000) });
          const body = obj(JSON.parse(await response.text()));
          return ((body.data ?? []) as ModelInfo[]).some(m => m.providerID === ROOT_MODEL.providerID && m.id === ROOT_MODEL.id && m.enabled) ? true : undefined;
        }, 30_000, 250);
        return Math.round(performance.now() - started);
      })().catch((error: unknown) => `never warmed: ${String(error)}`);
      const runs: Obj[] = [cold];
      for (const prompt of ["S5 generate probe one", "S5 generate probe two"]) runs.push(await call("warm", prompt));
      s.observed.runs = runs;
      s.observed.baseConfigLocation = host.configDir;
      s.observed.baseConfigCatalogWarmedAfterMs = warmedAfterMs;
      s.observed.providerCaptures = host.provider.captures.filter(c => c.lastText.startsWith("S5 ") || c.kind === "generate").map(c => ({ model: c.model, catalogModel: c.catalogModel, kind: c.kind, session: c.session, stream: c.stream, lastText: c.lastText }));
      const texts = runs.map(r => { try { return obj(obj(JSON.parse(String(r.rawBody))).data).text; } catch { return undefined; } });
      s.observed.extractedText = texts;
      const warm = runs.slice(1);
      const warmTexts = texts.slice(1);
      if (cold.status !== 200) s.notes.push(`The cold call failed (${cold.status} ${String(cold.rawBody)}): the route resolves models in the server base-configuration location, which must be initialised first (a catalog read at that location does it).`);
      s.verdict(warm.every(r => r.status === 200) && warmTexts.every(t => typeof t === "string" && t.length > 0), `cold ${cold.status}; warm status ${warm.map(r => r.status).join(",")}; data.text ${JSON.stringify(warmTexts)}; warm latency ${warm.map(r => r.latencyMs).join("/")} ms`);
    });
  }, 180_000);

  it("S6: switching a child to a smaller-context model and sending an oversize prompt triggers compaction or surfaces an error", async () => {
    await spike("S6", "Resuming a child with a model whose limit.context is far below the prompt size results in a host reaction (compaction request/message or a surfaced error) rather than silently sending the oversize request unchanged.", async (s, host) => {
      const small = (await host.client.model.list({ location: { directory: host.project } })).data.find(m => m.providerID === "anthropic" && m.id === "spike-small");
      const big = (await pickTarget(host)).rootEntry;
      s.observed.catalog = { small: small && { id: small.id, limit: small.limit, variants: small.variants.map(v => v.id) }, big: big && { id: big.id, limit: big.limit } };
      if (!small) throw new Error("spike-small alias is not in the catalog (config alias unsupported?)");
      const rootID = await host.root_("S6 root");
      const first = await host.dispatch(rootID, { agent: "general", description: "S6 dispatch", prompt: "S6 initial prompt", model: ref(ROOT_MODEL) });
      const childID = first.childID;
      const before = await childState(host, childID);
      const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil((SMALL_CONTEXT * 4 * 1.5) / 27));
      const capturesBefore = host.provider.captures.length;
      const eventsBefore = (await host.events()).length;
      const second = await host.dispatch(rootID, { agent: "general", description: "S6 oversize", prompt: `S6 oversize ${filler}`, sessionID: childID, model: `anthropic/${small.id}` });
      await delay(3_000); // let any post-step compaction run
      const after = await childState(host, childID);
      const childCaptures = host.provider.captures.slice(capturesBefore).filter(c => c.session === childID);
      const childEvents = (await host.events()).slice(eventsBefore).filter(e => e.data?.sessionID === childID);
      s.observed.oversizePromptChars = filler.length + 12;
      s.observed.smallContextTokens = SMALL_CONTEXT;
      s.observed.beforeResume = before;
      s.observed.afterResume = after;
      s.observed.toolAfter = second.after;
      s.observed.childRequests = childCaptures.map(c => ({ kind: c.kind, catalogModel: c.catalogModel, wireModel: c.model, inputTokens: c.inputTokens, lastText: c.lastText.slice(0, 120) }));
      s.observed.childEvents = childEvents.map(e => ({ type: e.type, data: e.type === "session.step.ended" || /compact|fail|error/.test(e.type) ? e.data : undefined }));
      const kinds = childCaptures.map(c => c.kind);
      const compaction = kinds.includes("compaction") || after.messageTypes.includes("compaction") || childEvents.some(e => /compact/.test(e.type));
      const error = second.after.status === "error" || after.session.outcome === "failed" || childEvents.some(e => /(step|execution)\.failed/.test(e.type));
      const oversize = childCaptures.filter(c => c.kind === "primary" && c.inputTokens > SMALL_CONTEXT);
      s.observed.derived = { compaction, error, requestKinds: kinds, oversizePrimaryRequestsSent: oversize.length };
      if (!compaction && !error) s.notes.push("Neither compaction nor an error was observed: the host sent the oversize request to the provider unchanged.");
      if (compaction && oversize.length > 0) s.notes.push(`Compaction ran BEFORE the primary request, but it did not make the request fit: ${oversize.length} primary request(s) of ${oversize.map(c => c.inputTokens).join("/")} tokens still reached the provider against limit.context ${SMALL_CONTEXT} (the oversize user message is kept as recent context).`);
      s.verdict(compaction || error, `compaction=${compaction} errorSurfaced=${error}; request kinds ${JSON.stringify(kinds)}; ${oversize.length} oversize primary request(s) (> ${SMALL_CONTEXT} tokens) reached the provider`);
    });
  }, 300_000);

  it("cleanup: no orphan sessions remain on the scripted host", async () => {
    const host = await getHost();
    expect((await host.everySession()).map(sessionView)).toEqual([]);
  }, 60_000);
});
