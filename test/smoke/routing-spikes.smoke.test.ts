/** Phase 0.P spike harness for the cost-aware routing plan (#74).
 *
 * Runs spikes S1-S6 (+ S1-deny, S2b, S2-agent-native, S3b) against a REAL OpenCode v2 host (2.0.22) and
 * records the evidence for each one as JSON in docs/qa/cost-aware-routing/spikes/.
 * Assertions read HOST STATE (session get/list/context, catalog, the host's own
 * event stream, the provider's wire requests); never only the variables of the
 * hook that caused the change.
 *
 *   RUN_OC_SMOKE_V2_SPIKES=1 [RUN_OC_SPIKE_LIVE_CATALOG=1] [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts
 *
 * - Without RUN_OC_SMOKE_V2_SPIKES=1 every test is skipped.
 * - Every spike except S4 runs against an isolated `opencode serve`: allowlisted
 *   environment (no provider credentials), private HOME/XDG, a scripted Anthropic
 *   Messages provider, and a probe plugin that records hook, event and generate
 *   traffic. Nothing there calls a paid model. S1-S3, S3b, S5, S6, S2b and S2 share
 *   one host with a global allow-all permission rule; S2-agent-native uses a second
 *   host with NO permission config (native agent defaults). Both process trees are
 *   killed at the end (taskkill /T /F on Windows) and their ports asserted closed.
 * - RUN_OC_SPIKE_LIVE_CATALOG=1 enables ONE thing: S4's read-only GETs against the
 *   user's REAL, already running OpenCode v2 service (URL/password come from the
 *   user's state dir and are never written to the evidence): GET /api/debug/location
 *   (before and after), GET /api/model and GET /api/provider for an ALREADY-LIVE
 *   location. No POST, no generate/model call, no session, no config write. Without
 *   the gate, or when the preferred location is not live, S4 is skipped.
 * - Evidence JSON is written BEFORE each assertion so a disproven hypothesis still
 *   leaves its observation behind. Every file carries the run id, recordedAt and
 *   the harness git ids. Strings longer than 400 chars INSIDE `observed` are
 *   clipped ("...[clipped, N chars]"); notes, hypothesis and assertionResult are
 *   never clipped. The user's home path and name are redacted to <home>/<user>.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listenOnFetchSafePort, pickFetchSafePort } from "./helpers/fetch-safe-port";
import type { Block, RequestBody } from "./helpers/scripted-provider";

const ROOT = path.resolve(__dirname, "../..");
const HARNESS_FILE = "test/smoke/routing-spikes.smoke.test.ts";
const RUN = process.env.RUN_OC_SMOKE_V2_SPIKES === "1";
const LIVE = RUN && process.env.RUN_OC_SPIKE_LIVE_CATALOG === "1";
const RUN_ID = randomUUID();
const EVIDENCE_DIR = path.join(ROOT, "docs", "qa", "cost-aware-routing", "spikes");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The host's effort order (@opencode/ai ReasoningEfforts); variants are expected in this order. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const IN_BAND_CAVEAT = "CAVEAT: the in-band {role:system, output_config:{effort}} message is how the host LOWERS an effort change for the Anthropic Messages protocol. It was observed against a scripted provider only; whether api.anthropic.com honours it was NOT verified. The host emits it only for same-model changes (to-llm-message.ts modelSwitched) and, per the host source, only for models that support effort updates: see the haiku case in S2b.";

// ---------------------------------------------------------------- types ----
type Obj = Record<string, unknown>;
interface ModelRef { id: string; providerID: string; variant?: string }
interface Rule { action: string; resource: string; effect: "allow" | "deny" | "ask" }
interface SessionInfo { id: string; parentID?: string; agent?: string; model?: ModelRef; cost?: unknown; tokens?: unknown; outcome?: string; title?: string; permissions?: unknown }
interface ModelInfo { id: string; providerID: string; enabled: boolean; variants: { id: string }[]; cost: unknown; limit: { context: number; input?: number; output: number } }
interface HostClient {
  session: {
    list(input?: { parentID?: string | null; limit?: number }): Promise<{ data: SessionInfo[] }>;
    create(input: { agent?: string; model?: ModelRef; title?: string; location?: { directory: string }; permissions?: Rule[] }): Promise<SessionInfo>;
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
  agent: { list(): Promise<{ data: { id: string; mode: string; model?: ModelRef; permissions?: unknown }[] }> };
  debug: { location: { list(): Promise<{ directory: string }[]>; evict(input: { location: { directory: string } }): Promise<void> } };
}
interface HookRecord { hook: "before" | "after"; sessionID: string; callID: string; agent: string; tool: string; before?: unknown; after?: unknown; status?: string; result?: unknown; error?: unknown }
interface EventRecord { type: string; id?: string; location?: unknown; __instance?: string; __instanceId?: string; data?: Obj; [key: string]: unknown }
interface Capture {
  model?: string; catalogModel?: string; session?: string; agent?: string; kind?: string; stream: boolean;
  outputConfig?: unknown; thinking?: unknown; inputTokens: number; lastText: string; toolResult: boolean; reply: "dispatch" | "text";
  /** Every top-level request field except messages/system/tools (those are reduced to their sizes). */
  payload: Obj;
  toolNames: string[];
  /** SHA-256 and length of the system prompt text (all system blocks joined by a newline). */
  systemSha256: string;
  systemChars: number;
  /** The request messages verbatim (the S2/S2b cases read them to see how an effort change reaches the provider). */
  messages?: RequestBody["messages"];
}

// -------------------------------------------------------------- helpers ----
const obj = (value: unknown): Obj => (value !== null && typeof value === "object" ? value as Obj : {});
/** Clip very long strings only (the S6 filler); everything else stays verbatim. Applied to `observed` only. */
function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 200)}...[clipped, ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  return value;
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces the user's home path (long, forward-slash and 8.3 short forms) and name in every string. */
function redact(value: unknown): unknown {
  const home = homedir();
  const shortHome = path.dirname(path.dirname(path.dirname(tmpdir())));
  const homes = [...new Set([home, home.replaceAll("\\", "/"), shortHome, shortHome.replaceAll("\\", "/")])].filter(h => h.length > 3);
  const patterns = homes.map(h => new RegExp(escapeRegExp(h), "gi"));
  const name = new RegExp(escapeRegExp(userInfo().username), "gi");
  const clean = (text: string) => patterns.reduce((acc, re) => acc.replace(re, "<home>"), text).replace(name, "<user>");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return clean(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [clean(k), walk(v)]));
    return node;
  };
  return walk(value);
}
/** Effort changes the host sends IN-BAND: {"role":"system","content":[],"output_config":{"effort":...}} messages. */
const inBandEfforts = (c: Capture): unknown[] => (c.messages ?? []).map(m => obj(obj(m).output_config).effort).filter(e => e !== undefined);
/** In-band efforts that sit AFTER the last assistant message, i.e. a change announced for THIS request. */
const inBandTrailing = (c: Capture): unknown[] => {
  const messages = c.messages ?? [];
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  return messages.slice(lastAssistant + 1).map(m => obj(obj(m).output_config).effort).filter(e => e !== undefined);
};
/** The effort the provider is actually told to use: the last in-band effort, else the top-level output_config.effort. */
const effectiveEffort = (c: Capture): unknown => inBandEfforts(c).at(-1) ?? obj(c.outputConfig).effort;
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
const canonical = (p: string) => { let real = p; try { real = realpathSync.native(p); } catch { /* not on disk (yet) */ } return path.normalize(real).replace(/[\\/]+$/, "").toLowerCase(); };
const samePath = (a: string, b: string) => canonical(a) === canonical(b);
const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
const locationSet = (list: { directory: string }[]) => list.map(l => canonical(l.directory)).sort();
const setDigest = (list: { directory: string }[]) => createHash("sha256").update(locationSet(list).join("\n")).digest("hex").slice(0, 16);

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
      const { messages: _messages, system: _system, tools: _tools, ...fields } = body;
      const systemText = typeof _system === "string" ? _system : Array.isArray(_system) ? _system.map(part => String(obj(part).text ?? JSON.stringify(part))).join("\n") : JSON.stringify(_system ?? "");
      this.captures.push({
        payload: { ...fields, "messages.length": _messages?.length, "tools.length": _tools?.length }, messages: _messages, toolNames: (_tools ?? []).map(t => t.name),
        systemSha256: createHash("sha256").update(systemText).digest("hex"), systemChars: systemText.length,
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
 * when SPIKE_REWRITE names a matching spec (S1), (b) from the same hook calls
 * ctx.generate.text when the spec asks for it (S5, the PLUGIN path), (c) logs every
 * subagent before/after, (d) logs session events from ctx.event.subscribe, tagged
 * with the location of the plugin instance that saw them (S3, S6) and (e) tags
 * provider requests with session/agent/model/kind headers. */
const PROBE_PLUGIN = `import {appendFileSync, readFileSync} from 'node:fs';
const log=(file,x)=>appendFileSync(process.env[file],JSON.stringify(x)+'\\n');
const rewriteSpec=()=>{try{return JSON.parse(readFileSync(process.env.SPIKE_REWRITE,'utf8'));}catch{return undefined;}};
const ser=(error)=>{try{return {string:String(error),props:JSON.parse(JSON.stringify(error,Object.getOwnPropertyNames(error).filter(k=>k!=='stack')))};}catch{return {string:String(error)};}};
export default {id:'routing-spike-probe',async setup(ctx){
 const instance=ctx.location&&ctx.location.directory;
 const instanceId=Math.random().toString(36).slice(2,8);
 log('SPIKE_EVENTS',{type:'probe.instance.started',__instance:instance,__instanceId:instanceId});
 await ctx.tool.hook('execute.before',async e=>{
  if(e.tool!=='subagent')return;
  const before=structuredClone(e.input);
  const spec=rewriteSpec();
  const hit=Boolean(spec&&e.input&&typeof e.input==='object'&&typeof e.input.prompt==='string'&&e.input.prompt.includes(spec.when));
  if(hit&&spec.set) e.input={...e.input,...spec.set};
  if(hit&&spec.generate){
   const t0=performance.now();
   try{const result=await ctx.generate.text(spec.generate.request);log('SPIKE_GENERATE',{label:spec.generate.label,ok:true,latencyMs:Math.round(performance.now()-t0),result,instance});}
   catch(error){log('SPIKE_GENERATE',{label:spec.generate.label,ok:false,latencyMs:Math.round(performance.now()-t0),error:ser(error),instance});}
  }
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
   if(typeof event.type==='string'&&event.type.startsWith('session.')&&!/(delta|streamed)/.test(event.type)) log('SPIKE_EVENTS',{...event,__instance:instance,__instanceId:instanceId});
  }}catch(error){log('SPIKE_EVENTS',{type:'probe.subscription.failed',error:String(error),__instance:instance,__instanceId:instanceId});}
 })();
}};`;

// ------------------------------------------------------------- host fixture ----
const ROOT_MODEL: ModelRef = { providerID: "anthropic", id: "claude-opus-4-7" };
const SMALL_CONTEXT = 12_000; // above the ~5k-token fixed system prompt, below the S6 oversize prompt
const ref = (m: ModelRef) => `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;
/** Environment the isolated host may inherit; everything else (provider credentials included) is dropped. */
const ENV_ALLOWLIST = new Set(["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"]);
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|COPILOT|GITHUB|^GH_|GEMINI|GOOGLE|AZURE|AWS_)/i;

interface Teardown { pid?: number; method: string; taskkill?: Obj; exitCode: number | null | undefined; hostPort: number; hostPortClosed: boolean; providerStopped: boolean }
interface Dispatched { before: HookRecord; after: HookRecord; childID: string }

class ScriptedHost {
  readonly provider = new SpikeProvider();
  client!: HostClient;
  baseUrl = "";
  authorization = "";
  project = "";
  port = 0;
  /** Names (never values) of the environment variables the host process received. */
  envKeys: string[] = [];
  /** The server base-configuration location that /api/experimental/generate always uses. */
  configDir = "";
  logs = { hooks: "", events: "", rewrite: "", generate: "" };
  private child?: ChildProcess;
  private output = "";
  private teardown?: Promise<Teardown>;
  /** `native`: write NO permission config, so the agents keep the host's native permission defaults (the root session gets a session-level allow for subagent instead). */
  constructor(readonly root: string, readonly native = false) {}

  async start(): Promise<this> {
    const executable = v2Executable();
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(version.stdout.trim(), version.stderr).toMatch(/^(?:opencode v)?2\./);
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(process.env)) if (ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
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
    this.logs = { hooks: path.join(this.root, "hooks.jsonl"), events: path.join(this.root, "events.jsonl"), rewrite: path.join(this.root, "rewrite.json"), generate: path.join(this.root, "generate.jsonl") };
    for (const file of [this.logs.hooks, this.logs.events, this.logs.generate]) await writeFile(file, "");
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
      ...(this.native ? {} : { permissions: [{ action: "*", resource: "*", effect: "allow" }] }),
    }));
    const password = randomBytes(24).toString("base64url");
    Object.assign(env, {
      OPENCODE_PASSWORD: password, OPENCODE_TEST_HOME: env.HOME, PWD: this.project,
      OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_FILEWATCHER_DISABLE: "true",
      SPIKE_HOOKS: this.logs.hooks, SPIKE_EVENTS: this.logs.events, SPIKE_REWRITE: this.logs.rewrite, SPIKE_GENERATE: this.logs.generate,
    });
    this.envKeys = Object.keys(env).sort();
    // No credential-shaped variable may reach the host; OPENCODE_PASSWORD is the harness's own random one.
    expect(this.envKeys.filter(name => CREDENTIAL_NAME.test(name) && name !== "OPENCODE_PASSWORD")).toEqual([]);
    this.port = await pickFetchSafePort();
    this.child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(this.port), "--print-logs"], { cwd: this.project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

  /** Kills the host process TREE (taskkill /T /F on Windows), stops the provider and asserts the host port is closed. Idempotent. */
  stop(): Promise<Teardown> { return this.teardown ??= this.doStop(); }
  private async doStop(): Promise<Teardown> {
    const child = this.child;
    const pid = child?.pid;
    let method = "none (never started or already exited)";
    let taskkill: Obj | undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      if (process.platform === "win32" && pid !== undefined) {
        const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
        method = "taskkill /PID <pid> /T /F";
        taskkill = { status: result.status, killedPids: [...new Set([...(result.stdout ?? "").matchAll(/PID\D*(\d+)/g)].map(m => Number(m[1])))], stderr: result.stderr?.trim() };
      } else { child.kill(); method = "SIGTERM"; }
      await Promise.race([closed, delay(10_000)]);
    }
    const providerStopped = await this.provider.stop().then(() => true, () => false);
    const hostPortClosed = this.port === 0 ? true : await waitFor("host port to close", async () => (await portOpen(this.port)) ? undefined : true, 10_000, 200).catch(() => false);
    return { pid, method, taskkill, exitCode: child?.exitCode, hostPort: this.port, hostPortClosed, providerStopped };
  }

  async hooks(): Promise<HookRecord[]> { return jsonl<HookRecord>(this.logs.hooks); }
  /** Every event line as logged: one per (event, plugin instance that saw it). */
  async rawEvents(): Promise<EventRecord[]> { return jsonl<EventRecord>(this.logs.events); }
  /** rawEvents() with duplicates (same event id seen by several plugin instances, one per live location) removed. Callers that report counts must also report rawEvents(). */
  async events(): Promise<EventRecord[]> {
    const seen = new Set<string>();
    return (await this.rawEvents()).filter(e => { const id = typeof e.id === "string" ? e.id : undefined; if (id === undefined) return true; if (seen.has(id)) return false; seen.add(id); return true; });
  }
  async generations(): Promise<Obj[]> { return jsonl<Obj>(this.logs.generate); }
  async setRewrite(spec: { when: string; set?: Obj; generate?: { label: string; request: Obj } } | undefined) {
    if (spec) await writeFile(this.logs.rewrite, JSON.stringify(spec)); else await rm(this.logs.rewrite, { force: true });
  }
  tail(): string { return this.output.slice(-3_000); }

  /** The scripted root orchestrator: creates a root session on the scripted model. */
  async root_(title: string, permissions?: Rule[]): Promise<string> {
    const rules = permissions ?? (this.native ? [{ action: "subagent", resource: "*", effect: "allow" } satisfies Rule] : undefined);
    return (await this.client.session.create({ agent: "build", model: ROOT_MODEL, title, location: { directory: this.project }, ...(rules ? { permissions: rules } : {}) })).id;
  }

  /** Prompts the root so that its scripted model emits one `subagent` call with `call` as input. The child id may be absent (a refused dispatch). */
  async dispatchMaybe(rootID: string, call: Obj): Promise<{ before: HookRecord; after: HookRecord; childID: string | undefined }> {
    const seen = (await this.hooks()).filter(h => h.sessionID === rootID && h.hook === "after").length;
    await this.client.session.prompt({ sessionID: rootID, text: `SPIKE_CALL=${JSON.stringify(call)}` });
    const after = await waitFor("subagent execute.after hook", async () => (await this.hooks()).filter(h => h.sessionID === rootID && h.hook === "after")[seen], 90_000);
    const before = (await this.hooks()).find(h => h.callID === after.callID && h.hook === "before");
    if (!before) throw new Error(`no execute.before record for ${after.callID}`);
    await this.settle(rootID);
    const result = obj(obj(after.result).output);
    const failed = /sessionID: (ses_[A-Za-z0-9]+)/.exec(String(obj(after.error).message ?? ""))?.[1];
    return { before, after, childID: typeof result.sessionID === "string" ? result.sessionID : failed };
  }

  /** dispatchMaybe that must identify exactly one child (from the tool result, or from a parent that has exactly one child). */
  async dispatch(rootID: string, call: Obj): Promise<Dispatched> {
    const d = await this.dispatchMaybe(rootID, call);
    if (d.childID) return { before: d.before, after: d.after, childID: d.childID };
    const kids = (await this.client.session.list({ parentID: rootID })).data;
    if (kids.length !== 1) throw new Error(`cannot identify the child: the tool result carried no sessionID and the parent has ${kids.length} children (${JSON.stringify(d.after)})`);
    return { before: d.before, after: d.after, childID: kids[0]!.id };
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

/** The user's real, already running OpenCode v2 service. Read-only GET helpers only: no POST, no generate, no session, no config write. */
async function liveService() {
  const file = path.join(homedir(), ".local", "state", "opencode", "service.json");
  if (!existsSync(file)) return undefined;
  const service = JSON.parse(await readFile(file, "utf8")) as { url: string; password: string; version?: string };
  /** The ONLY way the harness talks to the live service: a read-only GET. */
  const get = async (route: string, options: { directory?: string } = {}) => {
    const url = new URL(route, service.url);
    if (options.directory) url.searchParams.set("location[directory]", options.directory);
    const started = performance.now();
    const response = await fetch(url, { method: "GET", headers: { authorization: basic("opencode", service.password) }, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    return { status: response.status, text, latencyMs: Math.round(performance.now() - started) };
  };
  const locations = async () => JSON.parse((await get("/api/debug/location")).text) as { directory: string }[];
  return { version: service.version, get, locations };
}

// ------------------------------------------------------------ spike runner ----
/** `partial` marks a pass whose hypothesis only held in part; it is reported as PARTIAL-PASS in the evidence. */
interface Spike { observed: Obj; notes: string[]; verdict(pass: boolean, detail: string, partial?: boolean): void; keep: Set<string> }
/** "main": global allow-all permission rule; "native": no permission config (native agent defaults). */
type HostKind = "main" | "native";
const hostPromises: Partial<Record<HostKind, Promise<ScriptedHost>>> = {};
const hostRoots: string[] = [];
const startHost = (kind: HostKind) => hostPromises[kind] ??= (async () => {
  const root = await mkdtemp(path.join(tmpdir(), kind === "native" ? "omr-spikes-native-" : "omr-spikes-"));
  hostRoots.push(root);
  const host = new ScriptedHost(root, kind === "native");
  try { return await host.start(); } catch (error) { await host.stop().catch(() => undefined); throw error; }
})();
const getHost = () => startHost("main");

afterAll(async () => {
  for (const started of Object.values(hostPromises)) { try { await (await started).stop(); } catch { /* host never started */ } }
  for (const root of hostRoots) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}, 60_000);
let harnessIds: Obj | undefined;
/** Git ids of the harness file used for THIS run: HEAD, the file's blob sha (matches `git ls-tree` once committed) and whether it differs from HEAD. */
function harnessGitIds(): Obj {
  if (harnessIds) return harnessIds;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
    harnessIds = { file: HARNESS_FILE, headSha: git("rev-parse", "HEAD"), blobSha: git("hash-object", HARNESS_FILE), uncommittedChanges: git("status", "--porcelain", "--", HARNESS_FILE).length > 0 };
  } catch (error) { harnessIds = { file: HARNESS_FILE, error: String(error) }; }
  return harnessIds;
}

async function writeEvidence(id: string, hypothesis: string, assertionResult: string, spike: Spike): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const record = { spike: id, host: "opencode v2.0.22 (native v2 plugin API)", runId: RUN_ID, recordedAt: new Date().toISOString(), harness: harnessGitIds(), hypothesis, observed: clip(spike.observed), assertionResult, notes: spike.notes };
  await writeFile(path.join(EVIDENCE_DIR, `${id}.json`), `${JSON.stringify(redact(record), null, 2)}\n`);
}

/** Records a SKIPPED spike. With keepExistingResult, an earlier real result in the same file is never overwritten (a gate-off run must not destroy the evidence of a live run). */
async function recordSkip(id: string, hypothesis: string, reason: string, observed: Obj, keepExistingResult: boolean): Promise<void> {
  const file = path.join(EVIDENCE_DIR, `${id}.json`);
  if (keepExistingResult && existsSync(file) && !String((JSON.parse(await readFile(file, "utf8")) as { assertionResult?: string }).assertionResult).startsWith("SKIPPED")) return;
  await writeEvidence(id, hypothesis, `SKIPPED: ${reason}`, { observed: { skipped: reason, ...observed }, notes: [`skipped: ${reason}`], verdict: () => undefined, keep: new Set() });
}

/** Runs one spike: records evidence BEFORE asserting, sweeps the sessions it created on its host, and fails on orphans. */
async function spike(id: string, hypothesis: string, body: (s: Spike, host: ScriptedHost) => Promise<void>, mode: HostKind | "none" = "main"): Promise<void> {
  const host = mode === "none" ? undefined : await startHost(mode);
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

const sessionView = (s: SessionInfo) => ({ id: s.id, parentID: s.parentID, agent: s.agent, model: s.model, cost: s.cost, tokens: s.tokens, outcome: s.outcome, title: s.title, permissions: s.permissions });
async function childState(host: ScriptedHost, childID: string) {
  const session = await host.client.session.get({ sessionID: childID });
  const messages = await host.client.session.context({ sessionID: childID });
  return {
    session: sessionView(session), messageCount: messages.length, messageTypes: messages.map(m => String(m.type)),
    compactionMessages: messages.filter(m => m.type === "compaction").map(m => ({ status: m.status, reason: m.reason, error: m.error, cost: m.cost, tokens: m.tokens })),
  };
}
/** Raw vs deduplicated delivery of the events of ONE session, with every step.ended identified by id, location and plugin instance. */
async function eventAccounting(host: ScriptedHost, sessionID: string) {
  const all = await host.rawEvents();
  const raw = all.filter(e => e.data?.sessionID === sessionID);
  const deduped = (await host.events()).filter(e => e.data?.sessionID === sessionID);
  const rawEnded = raw.filter(e => e.type === "session.step.ended");
  const dedupedEnded = deduped.filter(e => e.type === "session.step.ended");
  const distinct = (events: EventRecord[]) => [...new Set(events.map(e => e.__instanceId))];
  return {
    counts: {
      rawSessionEvents: raw.length, dedupedSessionEvents: deduped.length, rawStepEnded: rawEnded.length, dedupedStepEnded: dedupedEnded.length,
      pluginInstancesStartedDuringRun: distinct(all.filter(e => e.type === "probe.instance.started")).length,
      pluginInstancesDeliveringTheSessionsEvents: distinct(raw).length, pluginInstancesDeliveringStepEnded: distinct(rawEnded).length,
    },
    rawStepEndedIdentity: rawEnded.map(e => ({ type: e.type, id: e.id, location: e.location, pluginInstance: e.__instance, pluginInstanceId: e.__instanceId })),
    dedupedStepEnded: dedupedEnded,
  };
}
const fmtTokens = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/** What a provider request says about the agent: tool list and system prompt (SHA-256), per request. */
const requestView = (c: Capture) => ({ kind: c.kind, agent: c.agent, catalogModel: c.catalogModel, wireModel: c.model, toolCount: c.toolNames.length, toolNames: c.toolNames, systemSha256: c.systemSha256, systemChars: c.systemChars });
/** Compares the request before an agent switch with the one after it. */
function agentSwitchDiff(before: Capture | undefined, after: Capture | undefined) {
  const a = before?.toolNames ?? [];
  const b = after?.toolNames ?? [];
  return { toolsChanged: a.join() !== b.join(), systemPromptChanged: before?.systemSha256 !== after?.systemSha256, toolCountBefore: a.length, toolCountAfter: b.length, onlyBefore: a.filter(t => !b.includes(t)), onlyAfter: b.filter(t => !a.includes(t)) };
}
/** First enabled anthropic catalog model with >=2 variants other than the root model (so the model really changes). */
async function pickTarget(host: ScriptedHost) {
  const catalog = (await host.client.model.list({ location: { directory: host.project } })).data;
  const usable = catalog.filter(m => m.providerID === "anthropic" && m.enabled && m.variants.length >= 2 && m.id !== "spike-small");
  const target = usable.find(m => m.id !== ROOT_MODEL.id) ?? usable[0];
  return { catalog, target, rootEntry: catalog.find(m => m.providerID === ROOT_MODEL.providerID && m.id === ROOT_MODEL.id) };
}
const costFields = (tier: unknown) => { const t = obj(tier); return [t.input, t.output, obj(t.cache).read, obj(t.cache).write]; };
/** A model is unpriced when its cost list is empty or every tier's input/output/cache fields are 0 or absent. */
const isUnpriced = (cost: unknown) => !Array.isArray(cost) || cost.length === 0 || cost.every(tier => costFields(tier).every(v => v === undefined || v === 0));
/** Variant ids that are effort names must appear in the host's effort order; others (e.g. "thinking") are reported separately. */
function variantOrder(variants: { id: string }[]) {
  const ids = variants.map(v => v.id);
  const known = ids.filter(id => EFFORT_ORDER.includes(id));
  const indexes = known.map(id => EFFORT_ORDER.indexOf(id));
  return { ids, nonEffortIds: ids.filter(id => !EFFORT_ORDER.includes(id)), inHostEffortOrder: indexes.every((v, i) => i === 0 || v >= indexes[i - 1]!) };
}

// ------------------------------------------------------------------ spikes ----
const d = RUN ? describe : describe.skip;
d("routing spikes S1-S6 on the real OpenCode v2 host", () => {
  it("S1: a plugin execute.before hook can reassign subagent agent+model and the host stores the child that way", async () => {
    await spike("S1", "tool.hook('execute.before') reassigning event.input of the subagent tool (agent general->explore, model -> provider/model#variant) makes the host create the CHILD session with the rewritten agent and model/variant.", async (s, host) => {
      const { target, rootEntry } = await pickTarget(host);
      s.observed.hostEnvKeys = host.envKeys;
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

  it("S1-deny: the same hook swap is refused when the parent is denied the target agent", async () => {
    await spike("S1-deny", "With a permission rule that DENIES subagent 'explore' to the parent session, the execute.before swap general->explore does not yield an explore child: the host refuses the dispatch (permission is asserted after the hook, on the rewritten input).", async (s, host) => {
      const { target } = await pickTarget(host);
      if (!target) throw new Error("no catalog model with variants to rewrite to");
      const rewritten = `${target.providerID}/${target.id}#${target.variants.at(-1)!.id}`;
      const captureMark = host.provider.captures.length; // only provider requests made during THIS spike are counted below
      // Session-level rule: permissions are merged [agent rules, session rules] and the LAST matching rule wins (permission.ts evaluate/findLast).
      const deny: Rule[] = [{ action: "subagent", resource: "explore", effect: "deny" }];
      const rootID = await host.root_("S1-deny root", deny);
      s.observed.rootSessionPermissions = (await host.client.session.get({ sessionID: rootID })).permissions;
      s.observed.denyRule = deny;
      // Control: an un-rewritten general dispatch under the same root must still work.
      const control = await host.dispatch(rootID, { agent: "general", description: "S1-deny control", prompt: "S1D_CONTROL reply briefly", background: false });
      await host.setRewrite({ when: "S1D_MARK", set: { agent: "explore", model: rewritten } });
      const denied = await host.dispatchMaybe(rootID, { agent: "general", description: "S1-deny dispatch", prompt: "S1D_MARK reply briefly", background: false });
      await host.setRewrite(undefined);
      const children = (await host.client.session.list({ parentID: rootID })).data.map(sessionView);
      s.observed.control = { childID: control.childID, status: control.after.status };
      s.observed.hookBefore = denied.before.before; s.observed.hookAfterRewrite = denied.before.after; s.observed.toolAfter = denied.after;
      s.observed.childrenOfRoot = children;
      s.observed.deniedDispatchChildID = denied.childID;
      s.observed.providerRequestsForExploreDuringThisSpike = host.provider.captures.slice(captureMark).filter(c => c.agent === "explore").length;
      const refused = denied.after.status === "error";
      const exploreChild = children.find(c => c.id !== control.childID && c.agent === "explore");
      s.observed.derived = { rewriteApplied: obj(denied.before.after).agent === "explore", refused, errorMessage: obj(denied.after.error).message, exploreChildCreated: exploreChild !== undefined, controlAllowed: control.after.status === "completed" };
      if (exploreChild) s.notes.push(`DENY BYPASSED: the host created child ${exploreChild.id} with agent=${exploreChild.agent} even though the parent is denied 'explore'.`);
      s.verdict(refused && exploreChild === undefined && control.after.status === "completed", `rewrite applied=${obj(denied.before.after).agent === "explore"}; dispatch status=${denied.after.status}; error=${JSON.stringify(obj(denied.after.error).message)}; explore child created=${exploreChild !== undefined}; control general dispatch=${control.after.status}`);
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
      const childRequests = host.provider.captures.filter(c => c.session === childID);
      s.observed.providerCapturesForChild = childRequests.map(c => ({ ...requestView(c), outputConfig: c.outputConfig, thinking: c.thinking, lastText: c.lastText.slice(0, 80) }));
      const primary = childRequests.filter(c => c.kind === "primary");
      const switchDiff = agentSwitchDiff(primary[1], primary[2]);
      s.observed.agentSwitchTools = { permissionConfig: "global allow-all (main fixture host)", requestAfterVariantResume: requestView(primary[1]!), requestAfterAgentSwitch: requestView(primary[2]!), ...switchDiff };
      if (low === high) s.notes.push("model exposes a single variant: variant-switch part is unverifiable");
      if (!switchDiff.toolsChanged) s.notes.push("Under this host's global allow-all permission config the request carries the SAME tool list for agent general and agent explore; see S2-agent-native for the same switch with the native permission defaults.");
      if (switchDiff.systemPromptChanged) s.notes.push("The system prompt DID change on the agent switch (different SHA-256).");
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
      const wire = (id: string) => host.provider.captures.filter(c => c.session === id && c.kind === "primary").map(c => ({ variantInRequestRef: c.catalogModel?.split("#")[1], topLevelEffort: obj(c.outputConfig).effort, inBandEfforts: inBandEfforts(c), effectiveEffort: effectiveEffort(c), lastText: c.lastText.slice(-24) }));
      s.observed.wireEffort = { firstChild: wire(childID), secondChild: wire(secondChild.childID), secondChildStored: await childState(host, secondChild.childID) };
      const wires = [...wire(childID), ...wire(secondChild.childID)];
      const followsWire = wires.every(w => w.variantInRequestRef === w.effectiveEffort);
      const topLevelFollows = wires.every(w => w.variantInRequestRef === w.topLevelEffort);
      s.observed.derived = { effectiveEffortFollowsVariant: followsWire, topLevelEffortFollowsVariant: topLevelFollows };
      if (!followsWire) s.notes.push("WIRE FINDING: after a resume the stored session variant changes, but the effort the provider receives (top-level output_config.effort or the last in-band output_config.effort) does not follow it; see observed.wireEffort.");
      else if (!topLevelFollows) s.notes.push("After a same-model resume the TOP-LEVEL output_config.effort stays at the first request value; the new effort is delivered in-band as a {role:system, output_config:{effort}} message (observed.wireEffort[].inBandEfforts). The EFFECTIVE effort follows the stored variant.");
      s.notes.push(IN_BAND_CAVEAT);
      s.verdict(variantOk && historyOk && agentOk, `variant ${one.session.model?.variant}->${two.session.model?.variant} (wanted ${low}->${high}); messages ${one.messageCount}->${two.messageCount}->${three.messageCount}; agent ${one.session.agent}->${two.session.agent}->${three.session.agent}`);
    });
  }, 300_000);

  it("S2b: resuming a child with a DIFFERENT model id moves the wire model; the wire effort is recorded for model-switch, variant-bump, no-variant, haiku and fresh-child cases", async () => {
    await spike("S2b", "Resuming a child with sessionID + a different model id makes the provider receive the new model (stored model == wire model); a later resume with a higher variant, and a fresh child started at that variant, show whether the effort the provider receives follows the variant. Control: a fresh child honours the variant on its first request. A later model switch to a higher variant (A#low -> A#high -> B#xhigh) delivers xhigh as the top-level effort with no new in-band message.", async (s, host) => {
      const catalog = (await host.client.model.list({ location: { directory: host.project } })).data;
      const entry = (id: string) => catalog.find(m => m.providerID === "anthropic" && m.id === id && m.enabled);
      const A = entry("claude-sonnet-5-5");
      const B = ["claude-opus-5-5", "claude-opus-4-7"].map(entry).find(m => m !== undefined && m.variants.some(v => v.id === "low") && m.variants.some(v => v.id === "high") && m.variants.some(v => v.id === "xhigh"));
      const haiku = entry("claude-haiku-4-5");
      s.observed.catalogModels = { A: A && { id: A.id, variants: A.variants.map(v => v.id) }, B: B && { id: B.id, variants: B.variants.map(v => v.id) }, haiku: haiku && { id: haiku.id, variants: haiku.variants.map(v => v.id) }, opus55InIsolatedCatalog: entry("claude-opus-5-5") !== undefined };
      if (!A || !B || !A.variants.some(v => v.id === "low") || !A.variants.some(v => v.id === "high")) throw new Error("isolated catalog lacks the A/B models or their low/high/xhigh variants");
      const refA = `anthropic/${A.id}`;
      const refB = `anthropic/${B.id}`;
      const rootID = await host.root_("S2b root");
      type Row = { case: string; core: boolean; request: number; asked: string | undefined; storedModelAfter: ModelRef | undefined; requestRef: string | undefined; wireModel: string | undefined; wireEffort: unknown; payload: Obj; messages: RequestBody["messages"]; inBandEfforts: unknown[]; inBandTrailing: unknown[]; effectiveEffort: unknown };
      const table: Row[] = [];
      const step = async (caseName: string, call: Obj, core = true) => {
        const mark = host.provider.captures.length;
        const dispatched = await host.dispatch(rootID, { agent: "general", description: `S2b ${caseName}`, ...call });
        const stored = await childState(host, dispatched.childID);
        const reqs = host.provider.captures.slice(mark).filter(c => c.session === dispatched.childID && c.kind === "primary");
        for (const c of reqs) table.push({ case: caseName, core, request: table.filter(r => r.case === caseName).length + 1, asked: typeof call.model === "string" ? call.model : undefined, storedModelAfter: stored.session.model, requestRef: c.catalogModel, wireModel: c.model, wireEffort: obj(c.outputConfig).effort, payload: c.payload, messages: c.messages, inBandEfforts: inBandEfforts(c), inBandTrailing: inBandTrailing(c), effectiveEffort: effectiveEffort(c) });
        return { childID: dispatched.childID, stored, reqs };
      };
      // Case 0 (the S2 situation): same model, variant bump on resume.
      const c0 = await step("case0 same-model variant bump", { prompt: "S2b case0 start", model: `${refA}#low` });
      await step("case0 same-model variant bump", { prompt: "S2b case0 resume", sessionID: c0.childID, model: `${refA}#high` });
      // Case 1/2: model switch on resume, then a variant bump on the new model.
      const c1 = await step("case1 model switch", { prompt: "S2b case1 start", model: `${refA}#low` });
      await step("case1 model switch", { prompt: "S2b case1 resume other model", sessionID: c1.childID, model: `${refB}#low` });
      await step("case2 variant bump after switch", { prompt: "S2b case2 resume higher variant", sessionID: c1.childID, model: `${refB}#high` });
      // Case 4: model id AND variant both change on one resume (an escalation to a stronger model at higher effort).
      const c4 = await step("case4 model and variant switch together", { prompt: "S2b case4 start", model: `${refA}#low` });
      await step("case4 model and variant switch together", { prompt: "S2b case4 resume other model, higher variant", sessionID: c4.childID, model: `${refB}#high` });
      // Case 3 (control): a fresh child started directly at the high variant.
      const c3 = await step("case3 fresh child at high", { prompt: "S2b case3 fresh", model: `${refA}#high` });
      // Case 7: A#low -> A#high (same-model bump, in-band) -> B#xhigh (model switch with a higher variant).
      const c7 = await step("case7 A low, A high, then B xhigh", { prompt: "S2b case7 start", model: `${refA}#low` }, false);
      await step("case7 A low, A high, then B xhigh", { prompt: "S2b case7 bump", sessionID: c7.childID, model: `${refA}#high` }, false);
      await step("case7 A low, A high, then B xhigh", { prompt: "S2b case7 switch to B xhigh", sessionID: c7.childID, model: `${refB}#xhigh` }, false);
      // Case 6: a child dispatched WITHOUT a variant, then resumed at #high.
      const c6 = await step("case6 no variant, then high", { prompt: "S2b case6 start", model: refA }, false);
      await step("case6 no variant, then high", { prompt: "S2b case6 resume high", sessionID: c6.childID, model: `${refA}#high` }, false);
      // Case 5: claude-haiku-4-5 (variants high, max): resume high -> max.
      if (haiku) {
        const ids = haiku.variants.map(v => v.id);
        const lo = ids.includes("high") ? "high" : ids[0]!;
        const hi = ids.includes("max") ? "max" : ids.at(-1)!;
        const c5 = await step("case5 haiku variant bump", { prompt: "S2b case5 start", model: `anthropic/${haiku.id}#${lo}` }, false);
        await step("case5 haiku variant bump", { prompt: "S2b case5 resume", sessionID: c5.childID, model: `anthropic/${haiku.id}#${hi}` }, false);
      } else s.notes.push("claude-haiku-4-5 is absent from the isolated catalog: the haiku case was not run");
      const messages = await host.client.session.context({ sessionID: c1.childID });
      s.observed.table = table;
      s.observed.switchedChildMessages = {
        modelSwitched: messages.filter(m => m.type === "model-switched").map(m => ({ model: m.model, previous: m.previous })),
        assistantModels: messages.filter(m => m.type === "assistant").map(m => m.model),
      };
      s.observed.finalStored = { case1Child: await childState(host, c1.childID), case3Child: c3.stored };
      const rowsOf = (name: string) => table.filter(r => r.case === name);
      const sw = rowsOf("case1 model switch");
      const bump = rowsOf("case2 variant bump after switch");
      const fresh = rowsOf("case3 fresh child at high");
      const wireFollowsModel = sw.length === 2 && sw[0]!.wireModel === A.id && sw[1]!.wireModel === B.id && bump[0]?.wireModel === B.id;
      const storedFollowsModel = sw[1]?.storedModelAfter?.id === B.id && sw[1]?.storedModelAfter?.variant === "low" && bump[0]?.storedModelAfter?.variant === "high";
      const freshHonoursVariant = fresh.length === 1 && fresh[0]!.wireEffort === "high";
      const effortFollowsAfterSwitch = sw[1]?.effectiveEffort === "low" && bump[0]?.effectiveEffort === "high";
      const allEffective = table.filter(r => r.core).every(r => r.effectiveEffort === r.storedModelAfter?.variant);
      const case0 = rowsOf("case0 same-model variant bump");
      const seven = rowsOf("case7 A low, A high, then B xhigh");
      const finalSeven = seven.at(-1);
      const xhighTopLevel = seven.length === 3 && finalSeven?.wireModel === B.id && finalSeven.wireEffort === "xhigh" && finalSeven.inBandTrailing.length === 0;
      const noVariant = rowsOf("case6 no variant, then high");
      const haikuRows = rowsOf("case5 haiku variant bump");
      s.observed.derived = {
        wireFollowsModelSwitch: wireFollowsModel, storedFollowsModelSwitch: storedFollowsModel, freshChildHonoursVariant: freshHonoursVariant,
        effectiveEffortFollowsVariantAfterSwitch: effortFollowsAfterSwitch, allEffectiveEffortsFollowStoredVariant: allEffective,
        sameModelResumeTopLevelEffort: case0.map(r => r.wireEffort), sameModelResumeEffectiveEffort: case0.map(r => r.effectiveEffort),
        caseA_low_A_high_B_xhigh: seven.map(r => ({ request: r.request, wireModel: r.wireModel, topLevelEffort: r.wireEffort, inBandAllHistory: r.inBandEfforts, inBandForThisRequest: r.inBandTrailing, stored: r.storedModelAfter })),
        xhighIsTopLevelWithNoNewInBandMessage: xhighTopLevel,
        noVariantChild: noVariant.map(r => ({ request: r.request, asked: r.asked, storedVariant: r.storedModelAfter?.variant, topLevelEffort: r.wireEffort, thinking: r.payload.thinking, inBandAllHistory: r.inBandEfforts, inBandForThisRequest: r.inBandTrailing })),
        haikuBump: haikuRows.map(r => ({ request: r.request, asked: r.asked, storedVariant: r.storedModelAfter?.variant, topLevelEffort: r.wireEffort, thinking: r.payload.thinking, outputConfig: r.payload.output_config, inBandAllHistory: r.inBandEfforts, inBandForThisRequest: r.inBandTrailing })),
        haikuInBandPresentOnResume: haikuRows.length === 2 ? haikuRows[1]!.inBandTrailing.length > 0 : undefined,
      };
      const inBand = table.filter(r => r.inBandTrailing.length > 0).map(r => ({ row: `${r.case}/${r.request}`, topLevelEffort: r.wireEffort, inBandForThisRequest: r.inBandTrailing }));
      const both = rowsOf("case4 model and variant switch together");
      const lost = both.length === 2 && both[1]!.effectiveEffort !== "high";
      s.observed.derived = { ...obj(s.observed.derived), requestsCarryingEffortInBand: inBand, modelAndVariantSwitchTogether: both.map(r => ({ wireModel: r.wireModel, topLevelEffort: r.wireEffort, inBandEfforts: r.inBandEfforts, stored: r.storedModelAfter })), effortLostOnModelAndVariantSwitch: lost };
      if (!effortFollowsAfterSwitch) s.notes.push("WIRE FINDING: after resuming with a different model and then a higher variant, the effective effort did not follow the stored variant; see observed.table.");
      if (case0.map(r => r.wireEffort).join() !== "low,high") s.notes.push("Top-level output_config.effort did not change on a same-model variant bump (the S2 observation is confirmed); the bump is delivered in-band, see derived.requestsCarryingEffortInBand.");
      if (inBand.length > 0) s.notes.push(`In-band effort for the request itself: ${inBand.map(r => `${r.row} top-level ${String(r.topLevelEffort)} + in-band ${JSON.stringify(r.inBandForThisRequest)}`).join("; ")}. The effort change travels as a {"role":"system","output_config":{"effort":...}} message inside the request messages, not in the top-level output_config.effort. Host source: session/runner/to-llm-message.ts modelSwitched() emits Message.effort({effort, previous}) only when the model id is unchanged.`);
      if (lost) s.notes.push("EFFORT LOST: resuming with a different model AND a higher variant sent neither a top-level nor an in-band effort of the requested value (modelSwitched() returns no effort message when the model id changes).");
      if (haikuRows.length === 2) s.notes.push(`Haiku (${haikuRows.map(r => r.storedModelAfter?.variant).join("->")}): top-level effort ${haikuRows.map(r => String(r.wireEffort)).join("->")}; in-band effort for the resumed request ${JSON.stringify(haikuRows[1]!.inBandTrailing)}; top-level thinking ${haikuRows.map(r => JSON.stringify(r.payload.thinking)).join(" -> ")}; output_config ${haikuRows.map(r => JSON.stringify(r.payload.output_config)).join(" -> ")}.`);
      s.notes.push(IN_BAND_CAVEAT);
      s.verdict(wireFollowsModel && storedFollowsModel && freshHonoursVariant && allEffective && xhighTopLevel, `wire model ${sw.map(r => r.wireModel).join("->")}->${bump.map(r => r.wireModel).join()} (stored ${sw.map(r => r.storedModelAfter?.id).join("->")}); effective effort by core request [${table.filter(r => r.core).map(r => String(r.effectiveEffort)).join(", ")}] vs stored variants [${table.filter(r => r.core).map(r => r.storedModelAfter?.variant).join(", ")}]; fresh child top-level effort ${fresh.map(r => r.wireEffort).join()}; A low->A high->B xhigh: final top-level ${String(finalSeven?.wireEffort)}, in-band for that request ${JSON.stringify(finalSeven?.inBandTrailing)}`);
    });
  }, 400_000);

  it("S3: a plugin event subscription receives session.step.ended with cost and tokens for the child", async () => {
    await spike("S3", "ctx.event.subscribe in a plugin delivers a session.step.ended event for the CHILD session whose data carries cost and tokens {input, output, reasoning, cache{read,write}}.", async (s, host) => {
      const { target } = await pickTarget(host);
      const rootID = await host.root_("S3 root");
      const { childID } = await host.dispatch(rootID, { agent: "general", description: "S3 dispatch", prompt: "S3 child task", ...(target ? { model: `${target.providerID}/${target.id}` } : {}) });
      const ended = await waitFor("session.step.ended for the child", async () => { const found = (await host.events()).filter(e => e.type === "session.step.ended" && e.data?.sessionID === childID); return found.length > 0 ? found : undefined; }, 20_000).catch(() => []);
      const stored = await childState(host, childID);
      const accounting = await eventAccounting(host, childID);
      s.observed.counts = accounting.counts;
      s.observed.rawStepEndedIdentity = accounting.rawStepEndedIdentity;
      s.observed.stepEndedEvents = ended;
      s.observed.childEventTypes = (await host.events()).filter(e => e.data?.sessionID === childID).map(e => e.type);
      s.observed.storedChildTotals = { cost: stored.session.cost, tokens: stored.session.tokens };
      s.observed.catalogCost = target && { id: target.id, cost: target.cost };
      const data = obj(ended[0]?.data);
      const tokens = obj(data.tokens);
      const shape = ended.length > 0 && Object.hasOwn(data, "cost") && ["input", "output", "reasoning"].every(k => Object.hasOwn(tokens, k)) && ["read", "write"].every(k => Object.hasOwn(obj(tokens.cache), k));
      s.observed.derived = { events: ended.length, costType: typeof data.cost, costValue: data.cost, costPositive: typeof data.cost === "number" ? data.cost > 0 : undefined, tokenKeys: Object.keys(tokens), cacheKeys: Object.keys(obj(tokens.cache)) };
      if (accounting.counts.rawSessionEvents !== accounting.counts.dedupedSessionEvents) s.notes.push(`${accounting.counts.rawSessionEvents - accounting.counts.dedupedSessionEvents} duplicate event line(s) were removed by id (see S3b for the multi-instance case).`);
      if (!(typeof data.cost === "number" && data.cost > 0)) s.notes.push("cost is not > 0: the model has no catalog pricing here, so cost is a zero/unpriced value (hypothesis says that yields 0)");
      s.verdict(shape, `${ended.length} session.step.ended event(s) for the child (${accounting.counts.rawStepEnded} raw line(s) from ${accounting.counts.pluginInstancesDeliveringStepEnded} plugin instance(s)); cost=${JSON.stringify(data.cost)} tokens=${JSON.stringify(data.tokens)}`);
    });
  }, 240_000);

  it("S2-agent-native: with the native permission defaults, an agent switch on resume changes the tools and the system prompt", async () => {
    await spike("S2-agent-native", "On a host with NO permission config (native agent defaults), resuming a child with a different agent changes the tool list and the system prompt the provider receives: explore is read-only (no edit/write/shell), general has the full set; a resume that only changes the variant changes neither.", async (s, host) => {
      const { target } = await pickTarget(host);
      if (!target) throw new Error("no catalog model with variants");
      const low = target.variants[0]!.id;
      const high = target.variants.at(-1)!.id;
      const base = `${target.providerID}/${target.id}`;
      s.observed.permissionConfig = "none: opencode.json has no permissions key, so every agent keeps its native permission defaults; the root session only carries a session-level allow for subagent";
      s.observed.nativeAgentPermissions = Object.fromEntries((await host.client.agent.list()).data.filter(a => ["build", "general", "explore"].includes(a.id)).map(a => [a.id, { mode: a.mode, permissions: a.permissions }]));
      const rootID = await host.root_("S2-agent-native root");
      const first = await host.dispatch(rootID, { agent: "general", description: "S2n general start", prompt: "S2n first prompt", model: `${base}#${low}` });
      const childID = first.childID;
      const one = await childState(host, childID);
      await host.dispatch(rootID, { agent: "general", description: "S2n general variant bump", prompt: "S2n second prompt", sessionID: childID, model: `${base}#${high}` });
      const two = await childState(host, childID);
      await host.dispatch(rootID, { agent: "explore", description: "S2n switch to explore", prompt: "S2n third prompt", sessionID: childID });
      const three = await childState(host, childID);
      await host.dispatch(rootID, { agent: "general", description: "S2n switch back to general", prompt: "S2n fourth prompt", sessionID: childID });
      const four = await childState(host, childID);
      const primary = host.provider.captures.filter(c => c.session === childID && c.kind === "primary");
      s.observed.storedAgentAfterEachStep = [one, two, three, four].map(x => x.session.agent);
      s.observed.requests = primary.map(c => ({ ...requestView(c), lastText: c.lastText.slice(-30) }));
      const control = agentSwitchDiff(primary[0], primary[1]);
      const toExplore = agentSwitchDiff(primary[1], primary[2]);
      const backToGeneral = agentSwitchDiff(primary[2], primary[3]);
      s.observed.diffs = { controlVariantBumpOnly: control, generalToExplore: toExplore, exploreBackToGeneral: backToGeneral };
      const exploreTools = primary[2]?.toolNames ?? [];
      const generalTools = primary[1]?.toolNames ?? [];
      const writeLike = ["edit", "write", "shell"];
      s.observed.derived = { exploreOffersEditWriteShell: writeLike.filter(t => exploreTools.includes(t)), generalOffersEditWriteShell: writeLike.filter(t => generalTools.includes(t)), toolsChangedOnSwitchToExplore: toExplore.toolsChanged, systemPromptChangedOnSwitchToExplore: toExplore.systemPromptChanged, toolsRestoredOnSwitchBackToGeneral: backToGeneral.toolsChanged && backToGeneral.onlyAfter.length > 0, systemPromptRestoredOnSwitchBack: backToGeneral.systemPromptChanged && primary[3]?.systemSha256 === primary[1]?.systemSha256 };
      s.notes.push("Evidence for QA-0P-33: the earlier allow-all S2 host offered identical tools to general and explore; this host keeps the native agent permission defaults.");
      const stored = [one, two, three, four].map(x => x.session.agent).join() === "general,general,explore,general";
      s.verdict(primary.length === 4 && stored && !control.toolsChanged && !control.systemPromptChanged && toExplore.toolsChanged && toExplore.systemPromptChanged && writeLike.every(t => !exploreTools.includes(t)) && writeLike.every(t => generalTools.includes(t)), `stored agents ${[one, two, three, four].map(x => x.session.agent).join("->")}; general->explore: tools ${toExplore.toolCountBefore}->${toExplore.toolCountAfter} (changed ${toExplore.toolsChanged}), system prompt changed ${toExplore.systemPromptChanged}; control variant bump: tools changed ${control.toolsChanged}, system changed ${control.systemPromptChanged}; explore offers edit/write/shell: ${JSON.stringify(writeLike.filter(t => exploreTools.includes(t)))}`);
    }, "native");
  }, 300_000);
  it("S4: the real host catalog (live, opt-in) lists variants[].id, cost and limit.context for the candidate models", async ctx => {
    const hypothesis = "The host model catalog (GET /api/model, the call behind ctx.model.list) of an already-live location of the user's running service exposes variants[].id in the host's effort order, cost (all tiers) and limit for anthropic/claude-sonnet-5-5, anthropic/claude-opus-5-5, anthropic/claude-haiku-4-5, openai/gpt-6-luna, opencode/deepseek-v4.1-flash and every gpt-6-luna* model (including gpt-6-luna-fast, the @fast tier model).";
    // A gate that is off, a missing service or a preferred location that is not live is a SKIP (recorded in S4.json), never a failure.
    const skipS4 = async (reason: string, observed: Obj = {}): Promise<never> => {
      await recordSkip("S4", hypothesis, reason, observed, !LIVE);
      return ctx.skip(`skipped: ${reason}`);
    };
    if (!LIVE) return skipS4("RUN_OC_SPIKE_LIVE_CATALOG is not 1, so the read-only live catalog check is not enabled");
    const live = await liveService();
    if (!live) return skipS4("the user's service.json does not exist, so there is no live service with the real config");
    const before = await live.locations();
    const preferred = ["D:\\git\\opencode-model-router", "D:\\git\\Claude-model-router"];
    const chosen = before.find(l => preferred.some(p => samePath(p, l.directory)));
    if (!chosen) return skipS4(`neither ${preferred.join(" nor ")} is a live location, and reading another location could start a plugin instance on the user's service`, { liveLocations: { count: before.length, digest: setDigest(before) } });
    await spike("S4", hypothesis, async (s) => {
      s.observed.source = "the user's running OpenCode v2 service: read-only GET /api/debug/location, /api/model and /api/provider for an ALREADY-LIVE location; no POST, no session, no generation, no config write";
      s.observed.serviceVersion = live.version;
      s.observed.liveLocationsBefore = { count: before.length, digest: setDigest(before) };
      s.observed.readLocation = chosen.directory;
      const models = await live.get("/api/model", { directory: chosen.directory });
      const providers = await live.get("/api/provider", { directory: chosen.directory });
      const after = await live.locations();
      const unchanged = JSON.stringify(locationSet(before)) === JSON.stringify(locationSet(after));
      s.observed.liveLocationsAfter = { count: after.length, digest: setDigest(after), setUnchanged: unchanged };
      const catalog = (JSON.parse(models.text).data ?? []) as ModelInfo[];
      const providerList = (JSON.parse(providers.text).data ?? []) as { id: string; activation: string }[];
      s.observed.status = { model: models.status, provider: providers.status, modelLatencyMs: models.latencyMs };
      s.observed.catalogModelCount = catalog.length;
      const wanted = ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-4-5", "openai/gpt-6-luna", "opencode/deepseek-v4.1-flash"];
      const view = (m: ModelInfo) => ({ ref: `${m.providerID}/${m.id}`, enabled: m.enabled, variants: m.variants.map(v => v.id), variantOrder: variantOrder(m.variants), cost: m.cost, unpriced: isUnpriced(m.cost), limit: { context: m.limit.context, input: m.limit.input, output: m.limit.output } });
      const relevant = new Set<string>();
      s.observed.requested = Object.fromEntries(wanted.map(w => {
        const [provider, ...rest] = w.split("/");
        const id = rest.join("/");
        const exact = catalog.find(m => m.providerID === provider && m.id === id);
        // The same model id under another provider (e.g. opencode-go) is reported separately, never conflated.
        const elsewhere = catalog.filter(m => m.id === id && m.providerID !== provider);
        [exact, ...elsewhere].forEach(m => m && relevant.add(m.providerID));
        return [w, { exact: exact ? view(exact) : "ABSENT from the catalog", sameIdOtherProviders: elsewhere.map(view) }];
      }));
      // @fast tier: every provider that lists any gpt-6-luna* id, with all tiers of cost and limit.context/limit.input.
      const luna = catalog.filter(m => m.id.includes("gpt-6-luna"));
      luna.forEach(m => relevant.add(m.providerID));
      s.observed.gpt6LunaFamily = luna.map(view);
      s.observed.gpt6LunaFast = luna.filter(m => m.id === "gpt-6-luna-fast").map(view);
      s.observed.providerActivationForRecordedProviders = providerList.filter(p => relevant.has(p.id)).map(p => `${p.id}:${p.activation}`);
      const exactEntries = wanted.flatMap(w => { const m = catalog.find(x => `${x.providerID}/${x.id}` === w); return m ? [m] : []; });
      const present = exactEntries.map(m => `${m.providerID}/${m.id}`);
      s.observed.presentExact = present;
      s.observed.absentExact = wanted.filter(w => !present.includes(w));
      const recorded = [...exactEntries, ...luna];
      const unpriced = recorded.filter(m => isUnpriced(m.cost)).map(m => `${m.providerID}/${m.id}`);
      s.observed.unpricedModels = [...new Set(unpriced)];
      const outOfOrder = recorded.filter(m => !variantOrder(m.variants).inHostEffortOrder).map(m => `${m.providerID}/${m.id}`);
      s.observed.variantsOutOfHostEffortOrder = outOfOrder;
      const complete = recorded.every(m => Array.isArray(m.variants) && Array.isArray(m.cost) && typeof m.limit.context === "number");
      if (s.observed.absentExact && (s.observed.absentExact as string[]).length > 0) s.notes.push("Some requested ids are absent under that exact provider/id; see sameIdOtherProviders for where the host actually lists them.");
      if (unpriced.length > 0) s.notes.push(`UNPRICED (catalog cost list empty or every field 0): ${[...new Set(unpriced)].join(", ")}. This is INFERRED from the catalog prices only: the harness ran no step on these models, so it did not observe a reported cost. A router must not treat a price of 0 as cheap.`);
      if (luna.filter(m => m.id === "gpt-6-luna-fast").length === 0) s.notes.push("gpt-6-luna-fast is not listed by any provider at this location.");
      s.verdict(models.status === 200 && present.length > 0 && complete && outOfOrder.length === 0 && unchanged, `${present.length}/${wanted.length} requested ids exist under that exact provider/id (${present.join(", ")}); absent: ${(s.observed.absentExact as string[]).join(", ") || "none"}; gpt-6-luna* entries: ${luna.map(m => `${m.providerID}/${m.id}`).join(", ") || "none"}; every recorded entry exposes variants[], cost[] and limit.context; variants in host effort order: ${outOfOrder.length === 0}; live location set unchanged by the read: ${unchanged}`, present.length < wanted.length);
    }, "none");
  }, 120_000);
  it("S5: ctx.generate.text from a plugin (and POST /api/experimental/generate) returns non-empty text for the scripted model", async () => {
    await spike("S5", "A plugin calling ctx.generate.text({ prompt, model }) (the PLUGIN path) returns non-empty text using the scripted provider model; the raw POST /api/experimental/generate route (which the host source runs against the server base-configuration location) is recorded as a secondary path, including what a cold base location does.", async (s, host) => {
      const rootID = await host.root_("S5 root");
      const rawCall = async (phase: string, prompt: string): Promise<Obj> => {
        const started = performance.now();
        const response = await fetch(new URL("/api/experimental/generate", host.baseUrl), { method: "POST", headers: { authorization: host.authorization, "content-type": "application/json" }, body: JSON.stringify({ prompt, model: ROOT_MODEL }), signal: AbortSignal.timeout(60_000) });
        const text = await response.text();
        return { phase, request: { prompt, model: ROOT_MODEL }, status: response.status, latencyMs: Math.round(performance.now() - started), rawBody: text };
      };
      const pluginCall = async (label: string, prompt: string): Promise<Obj> => {
        await host.setRewrite({ when: `S5_PLUGIN_${label}`, generate: { label, request: { prompt, model: ROOT_MODEL } } });
        await host.dispatch(rootID, { agent: "general", description: `S5 ${label}`, prompt: `S5_PLUGIN_${label} trigger` });
        await host.setRewrite(undefined);
        return (await host.generations()).filter(g => g.label === label).at(-1) ?? { label, missing: "the probe plugin logged no generate record" };
      };
      const baseLive = async () => (await host.client.debug.location.list()).some(l => samePath(l.directory, host.configDir));
      const coldStart = async () => {
        let evict: string;
        try { await host.client.debug.location.evict({ location: { directory: host.configDir } }); evict = "evicted"; } catch (error) { evict = `evict failed: ${String(error)}`; }
        await delay(300);
        return { evict, baseLocationLiveAfterEvict: await baseLive() };
      };
      const textOf = (rawBody: unknown) => { try { return obj(obj(JSON.parse(String(rawBody))).data).text; } catch { return undefined; } };
      s.observed.baseConfigLocation = host.configDir;
      s.observed.baseLocationLiveAtStart = await baseLive();
      // E1: the plugin path from a cold base location.
      const e1Cold = await coldStart();
      const e1 = await pluginCall("plugin-cold", "S5 plugin cold probe");
      const e1LiveAfter = await baseLive();
      // E3: raw route cold, then a catalog read at the base location (timed), then the retry.
      const e3Cold = await coldStart();
      const e3First = await rawCall("raw cold", "S5 raw cold probe 2");
      const catalogUrl = new URL("/api/model", host.baseUrl);
      catalogUrl.searchParams.set("location[directory]", host.configDir);
      const catalogStarted = performance.now();
      await waitFor("base-config catalog to list the scripted model", async () => {
        const response = await fetch(catalogUrl, { headers: { authorization: host.authorization }, signal: AbortSignal.timeout(30_000) });
        return ((obj(JSON.parse(await response.text())).data ?? []) as ModelInfo[]).some(m => m.providerID === ROOT_MODEL.providerID && m.id === ROOT_MODEL.id && m.enabled) ? true : undefined;
      }, 30_000, 250).catch(() => undefined);
      const catalogReadMs = Math.round(performance.now() - catalogStarted);
      const e3Retry = await rawCall("raw retry after catalog read", "S5 raw retry with catalog read");
      // E2: raw route cold again, then retries WITHOUT any catalog read: one immediately and one after the SAME pause the catalog read took.
      const e2Cold = await coldStart();
      const e2First = await rawCall("raw cold", "S5 raw cold probe");
      const e2Immediate = await rawCall("raw retry immediately, no catalog read", "S5 raw immediate retry");
      await delay(catalogReadMs);
      const e2Retry = await rawCall(`raw retry after the same ${catalogReadMs}ms pause, no catalog read`, "S5 raw retry without catalog read");      // Warm calls: plugin path (primary) and raw route (secondary).
      const pluginWarm = [await pluginCall("plugin-warm-1", "S5 plugin warm probe one"), await pluginCall("plugin-warm-2", "S5 plugin warm probe two")];
      const rawWarm = [await rawCall("raw warm", "S5 raw warm probe one"), await rawCall("raw warm", "S5 raw warm probe two")];
      s.observed.experiments = {
        E1_pluginPathCold: { coldStart: e1Cold, result: e1, baseLocationLiveAfterPluginCall: e1LiveAfter },
        E3_rawColdThenCatalogReadThenRetry: { coldStart: e3Cold, first: e3First, catalogReadMs, retry: e3Retry },
        E2_rawColdThenRetriesWithoutCatalogRead: { coldStart: e2Cold, first: e2First, immediateRetry: e2Immediate, retryAfterSamePause: e2Retry, pauseMs: catalogReadMs },
      };
      s.observed.pluginPathWarm = pluginWarm;
      s.observed.rawRouteWarm = rawWarm;
      s.observed.extractedRawTexts = [e3First, e3Retry, e2First, e2Immediate, e2Retry, ...rawWarm].map(r => ({ phase: r.phase, status: r.status, text: textOf(r.rawBody) }));
      s.observed.scriptedProviderCaptures = host.provider.captures.filter(c => c.lastText.startsWith("S5 ") || c.kind === "generate").map(c => ({ model: c.model, catalogModel: c.catalogModel, kind: c.kind, session: c.session, stream: c.stream, lastText: c.lastText }));
      const pluginTexts = pluginWarm.map(r => obj(r.result).text);
      const pluginOk = pluginWarm.every(r => r.ok === true) && pluginTexts.every(t => typeof t === "string" && t.length > 0);
      const rawOk = rawWarm.every(r => r.status === 200 && typeof textOf(r.rawBody) === "string");
      s.observed.derived = {
        pluginPathColdOutcome: e1.ok === true ? "ok" : e1.ok === false ? `error ${JSON.stringify(e1.error)}` : "no record",
        rawImmediateRetryWithoutCatalogReadFixesCold: e2First.status !== 200 ? e2Immediate.status === 200 : "cold call already succeeded",
        rawRetryAfterSamePauseWithoutCatalogReadFixesCold: e2First.status !== 200 ? e2Retry.status === 200 : "cold call already succeeded",
        rawRetryAfterCatalogReadFixesCold: e3First.status !== 200 ? e3Retry.status === 200 : "cold call already succeeded",
        pluginWarmLatencyMs: pluginWarm.map(r => r.latencyMs), rawWarmLatencyMs: rawWarm.map(r => r.latencyMs),
      };
      if (e1.ok !== true) s.notes.push(`The plugin-path cold call failed: ${JSON.stringify(e1.error ?? e1)}`);
      if (e2First.status !== 200 || e3First.status !== 200) s.notes.push(`Raw route, cold base location: ${e3First.status} ${String(e3First.rawBody)}. Retry after a catalog read at the base location (the read took ${catalogReadMs} ms): ${e3Retry.status}. Without any catalog read: immediate retry ${e2Immediate.status}, retry after the same ${catalogReadMs} ms pause ${e2Retry.status}.`);
      s.observed.liveGenerate = "not performed: this harness makes no generate or model call against the user's running service (the live-service check is deferred to A4)";
      if (e1.ok === true && !e1Cold.baseLocationLiveAfterEvict) s.notes.push(`The plugin path succeeded on its FIRST call while the base config location was not live before it (it was ${e1LiveAfter ? "live" : "still not live"} right after the call), whereas the raw route returned the cold 400 from the same state. It was issued from the plugin instance of ${String(e1.instance)}.`);
      s.verdict(pluginOk && rawOk, `plugin path: cold ${e1.ok === true ? "ok" : "failed"}, warm ${pluginWarm.map(r => `${r.ok === true ? "ok" : "failed"} ${JSON.stringify(obj(r.result).text)} ${r.latencyMs}ms`).join(" / ")}; raw route: cold ${e2First.status}, retry without catalog read ${e2Retry.status}, retry after catalog read ${e3Retry.status}, warm ${rawWarm.map(r => r.status).join(",")}`);
    });
  }, 300_000);

  it("S3b: with several live plugin instances the same step.ended is logged once per instance (raw vs deduplicated)", async () => {
    await spike("S3b", "After S5 has made the server base-configuration location live there are >=2 plugin instances; one child dispatch then yields ONE host session.step.ended event (one id) that the probe logs once per delivering instance, and de-duplication by event id collapses the raw lines to exactly that one event.", async (s, host) => {
      const baseLive = async () => (await host.client.debug.location.list()).some(l => samePath(l.directory, host.configDir));
      s.observed.baseLocationLiveBefore = await baseLive();
      if (!(await baseLive())) {
        // S5 normally leaves it live; if it does not, a catalog read at that location makes it live.
        const catalogUrl = new URL("/api/model", host.baseUrl);
        catalogUrl.searchParams.set("location[directory]", host.configDir);
        await waitFor("base-config catalog to list the scripted model", async () => {
          const response = await fetch(catalogUrl, { headers: { authorization: host.authorization }, signal: AbortSignal.timeout(30_000) });
          return ((obj(JSON.parse(await response.text())).data ?? []) as ModelInfo[]).some(m => m.providerID === ROOT_MODEL.providerID && m.id === ROOT_MODEL.id && m.enabled) ? true : undefined;
        }, 30_000, 250);
        s.notes.push("The base config location was not live when S3b started; it was made live by a catalog read.");
      }
      s.observed.liveLocationsOfTheIsolatedHost = (await host.client.debug.location.list()).map(l => l.directory);
      const rootID = await host.root_("S3b root");
      const { childID } = await host.dispatch(rootID, { agent: "general", description: "S3b dispatch", prompt: "S3b child task" });
      await waitFor("session.step.ended lines for the child", async () => (await host.rawEvents()).some(e => e.type === "session.step.ended" && e.data?.sessionID === childID) ? true : undefined, 20_000);
      await delay(2_000); // let every plugin instance deliver
      const accounting = await eventAccounting(host, childID);
      s.observed.counts = accounting.counts;
      s.observed.rawStepEndedIdentity = accounting.rawStepEndedIdentity;
      s.observed.dedupedStepEnded = accounting.dedupedStepEnded;
      const ids = new Set(accounting.rawStepEndedIdentity.map(e => e.id));
      const instances = new Set(accounting.rawStepEndedIdentity.map(e => e.pluginInstanceId));
      s.observed.derived = { distinctEventIds: ids.size, distinctDeliveringPluginInstances: instances.size, linesPerDeliveringInstance: Object.fromEntries([...instances].map(i => [String(i), accounting.rawStepEndedIdentity.filter(e => e.pluginInstanceId === i).length])) };
      if (accounting.counts.rawStepEnded > accounting.counts.dedupedStepEnded) s.notes.push(`${accounting.counts.rawStepEnded} raw session.step.ended lines carry ${ids.size} distinct event id(s): a consumer that subscribes in every plugin instance sees each event once per instance and must de-duplicate by event id.`);
      s.verdict(accounting.counts.dedupedStepEnded === 1 && ids.size === 1 && instances.size >= 2 && accounting.counts.rawStepEnded === instances.size, `${accounting.counts.rawStepEnded} raw step.ended line(s), ${accounting.counts.dedupedStepEnded} deduplicated, ${ids.size} distinct event id(s), delivered by ${instances.size} plugin instance(s) (${accounting.counts.pluginInstancesStartedDuringRun} instance(s) started during the run)`);
    });
  }, 240_000);
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
      const accounting = await eventAccounting(host, childID);
      s.observed.eventAccounting = { ...accounting.counts, rawStepEndedIdentity: accounting.rawStepEndedIdentity };
      s.observed.inputTokensNote = "childRequests[].inputTokens is an ESTIMATE made by the scripted provider (request body length / 4), not a host or provider measurement.";
      s.observed.derived = { compaction, error, requestKinds: kinds, oversizePrimaryRequestsSent: oversize.length };
      if (!compaction && !error) s.notes.push("Neither compaction nor an error was observed: the host sent the oversize request to the provider unchanged.");
      if (compaction && oversize.length > 0) s.notes.push(`Compaction ran BEFORE the primary request, but it did not make the request fit: ${oversize.length} primary request(s) of ≈${oversize.map(c => fmtTokens(c.inputTokens)).join(" / ")} tokens (estimated by the scripted provider from body length) still reached the provider against limit.context ${fmtTokens(SMALL_CONTEXT)} (the oversize user message is kept as recent context).`);
      s.verdict(compaction || error, `compaction=${compaction} errorSurfaced=${error}; request kinds ${JSON.stringify(kinds)}; ${oversize.length} primary request(s) estimated above ${fmtTokens(SMALL_CONTEXT)} tokens (scripted provider estimate from body length) reached the provider`);
    });
  }, 300_000);

  it("cleanup: no orphan sessions remain; every host process tree is killed and its port is closed", async () => {
    await spike("cleanup", "After every spike swept its sessions, each scripted host has no session left, and tearing it down (taskkill /T /F on Windows) leaves its port closed.", async (s) => {
      const results: Obj[] = [];
      for (const kind of ["main", "native"] as const) {
        const started = hostPromises[kind];
        if (!started) { results.push({ host: kind, started: false }); continue; }
        const host = await started;
        const remaining = (await host.everySession()).map(sessionView);
        const teardown = await host.stop();
        results.push({ host: kind, started: true, remainingSessions: remaining, teardown });
      }
      s.observed.hosts = results;
      const started = results.filter(r => r.started === true);
      const ok = started.length > 0 && started.every(r => (r.remainingSessions as unknown[]).length === 0 && obj(r.teardown).hostPortClosed === true && obj(r.teardown).providerStopped === true);
      s.verdict(ok, started.map(r => `${String(r.host)}: ${(r.remainingSessions as unknown[]).length} session(s) remain; ${String(obj(r.teardown).method)} (exit ${String(obj(r.teardown).exitCode)}); port ${String(obj(r.teardown).hostPort)} closed=${String(obj(r.teardown).hostPortClosed)}; provider stopped=${String(obj(r.teardown).providerStopped)}`).join(" | "));
    }, "none");
  }, 90_000);});
