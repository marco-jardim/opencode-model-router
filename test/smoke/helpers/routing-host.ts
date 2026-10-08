/** Phase 3.2 harness: an isolated, real OpenCode v2 host (2.0.22) with THIS checkout loaded as the router plugin,
 * a scripted keyless provider and a probe plugin that records tool hooks, session events and the host's own
 * agent/model records.
 *
 * Adapted from the Phase 0.P spike harness (`test/smoke/routing-spikes.smoke.test.ts`: ScriptedHost, SpikeProvider,
 * PROBE_PLUGIN); that file is frozen evidence and is not edited. Differences:
 *  - the router plugin itself is loaded (`plugins: [ROOT, probe]`) with an override file written in the isolated HOME;
 *  - the provider also answers the grader, the `delegate` tool call and (scenario 7) the OpenAI Responses protocol;
 *  - the outcomes store is a temp directory; nothing under the real home, the real config or the live store is touched.
 *
 * Isolation (§0.6.9 / task rules): the host receives an allow-listed environment (no provider credentials, no
 * MODEL_ROUTER_* / OPENCODE_* variable of the caller), a private HOME/USERPROFILE/XDG/APPDATA/LOCALAPPDATA/TEMP, an
 * explicit `routing.outcomes.path` and a random port; its process tree is killed with taskkill and the port asserted closed.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listenOnFetchSafePort, pickFetchSafePort } from "./fetch-safe-port";
import { DEFAULT_OUTCOME_TUNING, acquireOutcomes, type OutcomeKey } from "../../../src/routing/outcomes";
import type { DecisionRow, LogRow, OutcomeEntrySnapshot } from "../../../src/routing/outcomes/types";

export const ROOT = path.resolve(__dirname, "../../..");
export const RUN_ID = randomUUID();
export const EVIDENCE_DIR = path.join(ROOT, "docs", "qa", "cost-aware-routing", "evidence-3.2");
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// -------------------------------------------------------------------- types ----
export type Obj = Record<string, unknown>;
export interface ModelRef { id: string; providerID: string; variant?: string }
export interface Rule { action: string; resource: string; effect: "allow" | "deny" | "ask" }
export interface Tokens { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export interface SessionInfo {
  id: string; parentID?: string; agent?: string; model?: ModelRef; cost?: number; tokens?: Tokens; outcome?: string; title?: string;
  permissions?: Rule[]; location?: { directory: string };
}
export interface ModelInfo { id: string; providerID: string; enabled: boolean; status?: string; family?: string; variants: { id: string }[]; cost: unknown; capabilities?: unknown; limit: { context: number; input?: number; output: number } }
export interface AgentInfo { id: string; mode: string; hidden?: boolean; model?: ModelRef; permissions?: unknown; description?: string }
export interface HostClient {
  session: {
    list(input?: { parentID?: string | null; limit?: number }): Promise<{ data: SessionInfo[] }>;
    create(input: { agent?: string; model?: ModelRef; title?: string; location?: { directory: string }; permissions?: Rule[]; parentID?: string }): Promise<SessionInfo>;
    get(input: { sessionID: string }): Promise<SessionInfo>;
    remove(input: { sessionID: string }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    command(input: { sessionID: string; name: string; text: string }): Promise<void>;
    wait(input: { sessionID: string }): Promise<void>;
    context(input: { sessionID: string }): Promise<Obj[]>;
    active(): Promise<Record<string, unknown>>;
    interrupt(input: { sessionID: string }): Promise<unknown>;
    switchAgent(input: { sessionID: string; agent: string }): Promise<void>;
  };
  model: { list(input?: { location?: { directory: string } }): Promise<{ data: ModelInfo[] }> };
  plugin: { list(): Promise<{ data: { id: string; state: { status: string; error?: string } }[] }> };
  agent: { list(): Promise<{ data: AgentInfo[] }> };
  command: { list(): Promise<{ data: { name: string }[] }> };
  debug: { location: { list(): Promise<{ directory: string }[]> } };
}
export interface HookRecord { __t: number; hook: "before" | "after"; iid: string; instance?: string; sessionID: string; callID: string; agent?: string; tool: string; input?: Obj; status?: string; result?: Obj; error?: Obj }
export interface EventRecord { __t?: number; id?: string; type: string; created?: number; location?: unknown; data?: Obj; __instance?: string; __iid?: string; [key: string]: unknown }
export interface SessionTimeline { id: string; parentID?: string; firstSeen: number; snapshots: { at: number; agent?: string; model?: string; input: number; output: number; cost: number }[] }
export interface Dispatched { before: HookRecord; after: HookRecord; childID: string | undefined; callID: string }

// ------------------------------------------------------------------ helpers ----
export const obj = (value: unknown): Obj => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const ref = (m: ModelRef) => `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;
export async function waitFor<T>(label: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(stepMs);
  }
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Replaces the user's home path (long, forward-slash and 8.3 short forms, each also as it appears inside JSON text: `\\`-escaped and
 * `\\\\`-escaped, which is how a path inside a string that was itself serialized shows up), the 8.3 short user name and the user name.
 * Works on the SERIALIZED text, so no spelling survives inside a nested JSON string (QA-3.2-9).
 */
export function redactText(text: string): string {
  const home = homedir();
  const shortHome = path.dirname(path.dirname(path.dirname(tmpdir())));
  const forms = (value: string): string[] => [value, value.replaceAll("\\", "/"), value.replaceAll("\\", "\\\\"), value.replaceAll("\\", "\\\\\\\\")];
  const homes = [...new Set([home, shortHome].flatMap(forms))].filter(h => h.length > 3).sort((x, y) => y.length - x.length);
  const names = [...new Set([path.basename(shortHome), userInfo().username].filter(n => n.length > 2))].sort((x, y) => y.length - x.length);
  let out = text;
  for (const h of homes) out = out.replace(new RegExp(escapeRegExp(h), "gi"), "<home>");
  for (const n of names) out = out.replace(new RegExp(escapeRegExp(n), "gi"), "<user>");
  return out;
}
export function redact(value: unknown): unknown { return JSON.parse(redactText(JSON.stringify(value))) as unknown; }
export function clip(value: unknown, max = 600): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max / 2)}...[clipped, ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(v => clip(v, max));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  return value;
}
export function v2Executable(): string {
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
const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
export async function jsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
}

// ------------------------------------------------------------ scripted provider ----
export interface WireRequest {
  seq: number;
  protocol: "anthropic" | "responses";
  model?: string;
  /** `provider/model#variant` as the host's http.request hook saw it (the probe plugin's x-proof-model header). */
  catalogModel?: string;
  session?: string; agent?: string; kind?: string;
  stream: boolean;
  system: string;
  messages: Obj[];
  toolNames: string[];
  /** Every top-level field except messages/system/tools/input/instructions. */
  payload: Obj;
  /** Estimate: request body length / 4 (the scripted provider's own number, NOT a measurement of a real provider). */
  inputTokens: number;
  lastText: string;
  toolResult: boolean;
  reply: "tool" | "text" | "grader";
}
const GRADER_MARK = "independent, skeptical verification grader";
/** Effort changes the host sends IN-BAND: {"role":"system","content":[],"output_config":{"effort":...}} messages. */
export const inBandEfforts = (r: WireRequest): unknown[] => r.messages.map(m => obj(m.output_config).effort).filter(e => e !== undefined);
/** The effort the provider is actually told to use (Anthropic Messages): the last in-band effort, else the top-level output_config.effort. */
export const effectiveEffort = (r: WireRequest): unknown => inBandEfforts(r).at(-1) ?? obj(r.payload.output_config).effort;

/** Anthropic Messages (and OpenAI Responses) fixture.
 *  - `SPIKE_CALL={json}` in the last user message: one `subagent` tool call with that input.
 *  - `SPIKE_DELEGATE={json}`: one `delegate` tool call with that input.
 *  - a request whose system prompt is the router's grader prompt gets a verdict from `graderVerdicts` (empty queue: pass).
 *  - after a tool result the caller answers ROOT_DONE; everything else CHILD_OK (CHILD_DONE when the prompt says so).
 * Reported input tokens are body-length/4 so the context growth of a resumed child is visible in the host's own totals. */
export class RoutingProvider {
  readonly requests: WireRequest[] = [];
  readonly errors: string[] = [];
  readonly graderVerdicts: boolean[] = [];
  graders = 0;
  /** Held before a grader answers, so a poller can see the producer child between two attempts (the runner removes its children when the delegation ends). */
  graderDelayMs = 0;
  /** See `loopSource` in `handle`: repeat the READ_ONLY_PROBE tool call on every request after the first tool result. */
  loopProbe = false;
  private sequence = 0;
  private server = createServer((req, res) => { void this.handle(req, res); });
  async start(): Promise<string> { return `http://127.0.0.1:${await listenOnFetchSafePort(this.server)}/v1`; }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const header = (key: string) => { const value = req.headers[key]; return Array.isArray(value) ? value[0] : value; };
      const url = req.url ?? "";
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      const body = obj(JSON.parse(raw));
      const responses = /\/responses(\?|$)/.test(url);
      const system = responses ? String(body.instructions ?? "") : this.systemText(body.system);
      const messages = (responses ? arr(body.input) : arr(body.messages)).map(obj);
      const last = messages.at(-1);
      const lastBlocks = this.blocks(last?.content);
      const toolResult = responses ? messages.some(m => m.type === "function_call_output") && last?.type === "function_call_output" : lastBlocks.some(b => b.type === "tool_result");
      const lastText = responses
        ? (last?.type === "function_call_output" ? "" : this.blocks(last?.content).filter(b => b.type === "input_text" || b.type === "text").map(b => String(b.text ?? "")).join("\n"))
        : lastBlocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).join("\n");
      const grader = system.includes(GRADER_MARK);
      const subagentCall = toolResult || grader ? undefined : /SPIKE_CALL=(\{[^\n]*\})/.exec(lastText)?.[1];
      const delegateCall = toolResult || grader ? undefined : /SPIKE_DELEGATE=(\{[^\n]*\})/.exec(lastText)?.[1];
      // `loopProbe` (off by default): once any tool result is in the history (even if the last message is no longer one, e.g. the host's max-steps note), keep emitting the READ_ONLY_PROBE call found in the earlier user text, so a
      // child never finishes by itself and only the host's step limit can stop it.
      const hadToolResult = toolResult || messages.some(m => m.type === "function_call_output" || this.blocks(m.content).some(b => b.type === "tool_result"));
      const loopSource = this.loopProbe && hadToolResult && !grader
        ? /READ_ONLY_PROBE=(\{[^\n]*\})/.exec(messages.flatMap(m => this.blocks(m.content)).filter(b => b.type === "text" || b.type === "input_text").map(b => String(b.text ?? "")).filter(text => !/SPIKE_(CALL|DELEGATE)=/.test(text)).join("\n"))?.[1]
        : undefined;
      // Issue #77: intentionally emit even an unadvertised tool to prove that
      // the HOST rejects it, rather than a cooperative model merely abstaining.
      const readOnlyProbe = (toolResult && !loopSource) || grader || subagentCall || delegateCall ? undefined : (loopSource ?? /READ_ONLY_PROBE=(\{[^\n]*\})/.exec(lastText)?.[1]);
      const probe = readOnlyProbe ? obj(JSON.parse(readOnlyProbe)) : undefined;
      const toolName = subagentCall ? "subagent" : delegateCall ? "delegate" : str(probe?.tool);
      const toolInput = subagentCall ?? delegateCall ?? (probe ? JSON.stringify(probe.input) : undefined);
      const { messages: _m, system: _s, tools, input: _i, instructions: _in, ...fields } = body;
      const toolNames = arr(tools).map(t => String(obj(t).name ?? obj(obj(t).function).name ?? ""));
      const inputTokens = Math.max(10, Math.ceil(raw.length / 4));
      const request: WireRequest = {
        seq: ++this.sequence, protocol: responses ? "responses" : "anthropic", model: str(body.model), catalogModel: header("x-proof-model"),
        session: header("x-proof-session"), agent: header("x-proof-agent"), kind: header("x-proof-kind"), stream: body.stream === true, system, messages,
        toolNames, payload: fields, inputTokens, lastText, toolResult, reply: grader ? "grader" : toolName ? "tool" : "text",
      };
      this.requests.push(request);
      if (toolName && !probe && !toolNames.includes(toolName)) throw new Error(`Fixture requested ${toolName} but the request carries no such tool (${toolNames.join(",")})`);
      let text = toolResult ? "ROOT_DONE" : lastText.includes("CHILD_DONE") ? "CHILD_DONE" : "CHILD_OK";
      if (grader) {
        this.graders += 1;
        const pass = this.graderVerdicts.length > 0 ? this.graderVerdicts.shift()! : true;
        text = JSON.stringify({ pass, reasons: [pass ? "CHILD_DONE observed" : "scripted verification failure"] });
      }
      const input = toolInput ? JSON.parse(toolInput) as Obj : undefined;
      if (grader && this.graderDelayMs > 0) await delay(this.graderDelayMs);
      if (responses) this.sendResponses(res, request, inputTokens, text, toolName, input);
      else this.sendAnthropic(res, request, inputTokens, text, toolName, input);
    } catch (error) {
      this.errors.push(String(error));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted provider error" } }));
    }
  }
  private systemText(system: unknown): string {
    if (typeof system === "string") return system;
    if (Array.isArray(system)) return system.map(part => String(obj(part).text ?? JSON.stringify(part))).join("\n");
    return system === undefined ? "" : JSON.stringify(system);
  }
  private blocks(content: unknown): Obj[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return arr(content).map(obj);
  }
  private sendAnthropic(res: ServerResponse, request: WireRequest, inputTokens: number, text: string, tool?: string, input?: Obj) {
    const n = request.seq;
    const message = { id: `msg_smoke_${n}`, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } };
    if (!request.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, content: tool ? [{ type: "tool_use", id: `toolu_smoke_${n}`, name: tool, input }] : [{ type: "text", text }], stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: inputTokens, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type: string, data: Obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message });
    event("ping", {});
    event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_smoke_${n}`, name: tool, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  }
  /** OpenAI Responses protocol (SSE `response.*` events, or one JSON object when the request is not streamed). */
  private sendResponses(res: ServerResponse, request: WireRequest, inputTokens: number, text: string, tool?: string, input?: Obj) {
    const n = request.seq;
    const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + 5 };
    const item = tool
      ? { type: "function_call", id: `fc_smoke_${n}`, call_id: `call_smoke_${n}`, name: tool, arguments: JSON.stringify(input), status: "completed" }
      : { type: "message", id: `msg_smoke_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const base = { id: `resp_smoke_${n}`, object: "response", created_at: 1, model: request.model, parallel_tool_calls: true, tools: [], metadata: {} };
    if (!request.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...base, status: "completed", output: [item], usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let sequence = 0;
    const event = (type: string, data: Obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    event("response.created", { response: { ...base, status: "in_progress", output: [] } });
    event("response.in_progress", { response: { ...base, status: "in_progress", output: [] } });
    if (tool) {
      event("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
      event("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: JSON.stringify(input) });
      event("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: JSON.stringify(input) });
      event("response.output_item.done", { output_index: 0, item });
    } else {
      event("response.output_item.added", { output_index: 0, item: { type: "message", id: item.id, role: "assistant", status: "in_progress", content: [] } });
      event("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text });
      event("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text });
      event("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text, annotations: [] } });
      event("response.output_item.done", { output_index: 0, item });
    }
    event("response.completed", { response: { ...base, status: "completed", output: [item], usage } });
    res.end();
  }
}

// -------------------------------------------------------------- probe plugin ----
/** Native v2 plugin loaded NEXT TO the router. It only observes: tool hooks (every tool, with the plugin-instance id), the
 * session event stream (with event ids), the provider requests (it tags them with session/agent/kind/model headers) and the host's
 * own `ctx.agent.list()` / `ctx.model.list()` records (dumped once, on the first context hook). It never rewrites anything. */
export const PROBE_PLUGIN = `import {appendFileSync,writeFileSync,readFileSync} from 'node:fs';
const tick=()=>(globalThis.__smokeSeq=(globalThis.__smokeSeq||0)+1);
const log=(file,x)=>appendFileSync(process.env[file],JSON.stringify({...x,__t:Date.now(),__n:tick()})+'\\n');
const clone=(x)=>{try{return structuredClone(x);}catch{return {unclonable:String(x)};}};
const ser=(error)=>{try{return {string:String(error),props:JSON.parse(JSON.stringify(error,Object.getOwnPropertyNames(error).filter(k=>k!=='stack')))};}catch{return {string:String(error)};}};
export default {id:'routing-smoke-probe',async setup(ctx){
 const instance=ctx.location&&ctx.location.directory;
 const iid=Math.random().toString(36).slice(2,8);
 log('SMOKE_EVENTS',{type:'probe.instance.started',__instance:instance,__iid:iid});
 await ctx.tool.hook('execute.before',e=>{log('SMOKE_HOOKS',{hook:'before',iid,instance,sessionID:e.sessionID,callID:e.id,agent:e.agent,tool:e.tool,input:clone(e.input)});});
 await ctx.tool.hook('execute.after',e=>{log('SMOKE_HOOKS',{hook:'after',iid,instance,sessionID:e.sessionID,callID:e.id,agent:e.agent,tool:e.tool,status:e.status,result:e.status==='completed'?clone(e.result):undefined,error:e.status==='error'?ser(e.error):undefined});});
 await ctx.session.hook('http.request',e=>{
  e.request.headers.set('x-proof-session',e.sessionID);
  e.request.headers.set('x-proof-agent',e.agent??'aux');
  e.request.headers.set('x-proof-kind',e.kind);
  e.request.headers.set('x-proof-model',e.model.providerID+'/'+e.model.id+(e.model.variant?'#'+e.model.variant:''));
 });
 // Opt-in (SMOKE_PROBE_CONFIG, written by HostOptions.probe): lifecycle records at the FIRST context build / permission evaluation of
 // each session (what session.get answers at that moment) and an optional plugin-guard denial. Nothing happens without the file.
 const cfg=(()=>{try{return process.env.SMOKE_PROBE_CONFIG?JSON.parse(readFileSync(process.env.SMOKE_PROBE_CONFIG,'utf8')):{};}catch{return {};}})();
 const snap=async(id)=>{try{const s=await ctx.session.get({sessionID:id});return {parentID:s.parentID,agent:s.agent,title:s.title,model:clone(s.model)};}catch(error){return {error:String(error)};}};
 if(cfg.lifecycle){
  const firstContext=new Set();
  const firstEvaluate=new Set();
  await ctx.session.hook('context',async e=>{
   if(firstContext.has(e.sessionID))return; firstContext.add(e.sessionID);
   const entered=Date.now(),enteredN=tick();
   log('SMOKE_EVENTS',{type:'probe.lifecycle',point:'context',sessionID:e.sessionID,agent:e.agent,model:clone(e.model),options:clone(e.options),entered,enteredN,got:await snap(e.sessionID),__instance:instance,__iid:iid});
  });
  await ctx.permission.hook('evaluate',async e=>{
   const entered=Date.now(),enteredN=tick();
   const first=!firstEvaluate.has(e.sessionID); firstEvaluate.add(e.sessionID);
   const deny=cfg.deny&&(cfg.deny.agent===undefined||cfg.deny.agent===e.agent)&&(cfg.deny.actions||[]).includes(e.action);
   if(deny){e.effect='deny';e.message='PLUGIN_GUARD_DENIED: '+e.action;}
   log('SMOKE_EVENTS',{type:'probe.lifecycle',point:'evaluate',sessionID:e.sessionID,agent:e.agent,action:e.action,resources:clone(e.resources),first,denied:!!deny,entered,enteredN,got:first?await snap(e.sessionID):undefined,__instance:instance,__iid:iid});
  });
 }
 let dumped=false;
 await ctx.session.hook('context',e=>{
  if(dumped)return; dumped=true;
  (async()=>{try{
   const agents=(await ctx.agent.list()).data.map(a=>{const c=clone(a);delete c.system;return c;});
   const models=(await ctx.model.list({location:ctx.location})).data.map(m=>({providerID:m.providerID,id:m.id,enabled:m.enabled,status:m.status,family:m.family,capabilities:clone(m.capabilities),variants:(m.variants||[]).map(v=>v.id),cost:clone(m.cost),limit:clone(m.limit),keys:Object.keys(m)}));
   writeFileSync(process.env.SMOKE_DUMP,JSON.stringify({instance,agents,models}));
  }catch(error){writeFileSync(process.env.SMOKE_DUMP,JSON.stringify({error:String(error)}));}})();
 });
 (async()=>{
  try{for await(const event of ctx.event.subscribe({})){
   if(typeof event.type==='string'&&event.type.startsWith('session.')&&!/(delta|streamed)/.test(event.type)) log('SMOKE_EVENTS',{...event,__instance:instance,__iid:iid});
  }}catch(error){log('SMOKE_EVENTS',{type:'probe.subscription.failed',error:String(error),__instance:instance,__iid:iid});}
 })();
}};`;

// ------------------------------------------------------------------ the host ----
export const ROOT_MODEL: ModelRef = { providerID: "anthropic", id: "claude-opus-4-7" };
const ENV_ALLOWLIST = new Set(["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"]);
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|COPILOT|GITHUB|^GH_|GEMINI|GOOGLE|AZURE|AWS_)/i;
export const MODELS = { sonnet: "anthropic/claude-sonnet-5-5", opus: "anthropic/claude-opus-5-5", haiku: "anthropic/claude-haiku-4-5" } as const;

/** The smoke preset: three router tiers on the isolated catalog's anthropic models, variants only (no `effort` key, so no tier is effort-configured). */
export const SMOKE_PRESET = {
  fast: { model: MODELS.sonnet, variant: "low", costRatio: 1, description: "smoke fast tier", whenToUse: ["search", "reads"] },
  medium: { model: MODELS.sonnet, variant: "medium", costRatio: 5, description: "smoke medium tier", whenToUse: ["implementation"] },
  heavy: { model: MODELS.opus, variant: "xhigh", costRatio: 20, description: "smoke heavy tier", whenToUse: ["architecture"] },
};

/** A second scripted provider: the same server answers `/v1/responses` (OpenAI Responses). Pass as `providers` of `HostOptions`. */
export const OPENAI_PROVIDER: Obj = { openai: { settings: { baseURL: "$BASE_URL", apiKey: "keyless-smoke-fake" } } };
/** A host agent entry (`hostConfig.agents[name]`) with NO `model` key: the caller's fields are copied, a `model` / `variant` is refused. */
export function agentWithoutModel(fields: Obj = {}): Obj {
  if ("model" in fields || "variant" in fields) throw new Error("agentWithoutModel: the entry must not carry a model or variant");
  return { mode: "subagent", description: "role spike agent without a model", ...fields };
}

export interface HostOptions {
  /** Router override file content, merged over the smoke preset. `routing.outcomes.path` is always forced to this host's temp directory. */
  readonly overrides?: Obj;
  /** The `routing` block; `null` writes no routing block at all. Default: engine shadow. */
  readonly routing?: Obj | null;
  /** Extra `providers` entries of opencode.json (merged with the scripted anthropic provider). */
  readonly providers?: Obj;
  /** Replaces the default `plugins` entries after ROOT (the probe is always last). */
  readonly rootModel?: ModelRef;
  /** Skip the router plugin (control host). */
  readonly withoutRouter?: boolean;
  /** Merged over the generated opencode.json (the host's own config: agents, providers…). */
  readonly hostConfig?: Obj;
  /** Seeds written to the outcomes store BEFORE the host starts (through the repo's own store + persister, on the temp dir). */
  readonly seed?: readonly Seed[];
  /** Probe-plugin configuration (written to a JSON file the probe reads): `lifecycle` logs first context/evaluate per session; `deny` = { agent?, actions[] } denies those permission actions. */
  readonly probe?: { readonly lifecycle?: boolean; readonly deny?: { readonly agent?: string; readonly actions: readonly string[] } };
}
export interface Seed { readonly key: OutcomeKey; readonly pass: number; readonly fail: number }
export interface Teardown { pid?: number; method: string; taskkill?: Obj; exitCode: number | null | undefined; hostPort: number; hostPortClosed: boolean; providerStopped: boolean; rootRemoved: boolean }

const liveHosts = new Set<RoutingHost>();
/** Every session id any isolated host of this run held (roots and children), kept so the live-store check can show none of them reached the user's store. */
export const seenSessionIDs = new Set<string>();
/** Every project / location directory of every isolated host of this run (as the host reports it and as the harness created it), for `noticeFiles()` in the live-store check (QA-3.2-R2-7). */
export const seenProjectDirs = new Set<string>();

export class RoutingHost {
  readonly provider = new RoutingProvider();
  client!: HostClient;
  baseUrl = "";
  authorization = "";
  project = "";
  port = 0;
  envKeys: string[] = [];
  readonly outcomes: string;
  readonly logs: { hooks: string; events: string; dump: string };
  readonly configHome: string;
  private child?: ChildProcess;
  private output = "";
  private teardown?: Promise<Teardown>;

  private constructor(readonly root: string, readonly options: HostOptions) {
    this.outcomes = path.join(root, "outcomes");
    this.logs = { hooks: path.join(root, "hooks.jsonl"), events: path.join(root, "events.jsonl"), dump: path.join(root, "dump.json") };
    this.configHome = path.join(root, "home", ".config", "opencode");
  }

  static async start(name: string, options: HostOptions = {}): Promise<RoutingHost> {
    const root = await mkdtemp(path.join(tmpdir(), `omr-p32-${name}-`));
    const host = new RoutingHost(root, options);
    liveHosts.add(host);
    try { return await host.boot(); } catch (error) { await host.stop().catch(() => undefined); throw error; }
  }

  /** Router override file: the smoke preset + the caller's overrides; `routing.outcomes.path` is forced to the temp store. */
  overrideFile(extra: Obj = {}): Obj {
    const o = this.options;
    const merged: Obj = {
      activePreset: "smoke", defaultTier: "fast", presets: { smoke: SMOKE_PRESET },
      ...obj(o.overrides), ...extra,
    };
    const enforcement = { ...obj(obj(o.overrides).enforcement), ...obj(extra.enforcement) };
    merged.enforcement = { ...enforcement, verify: { testBaseline: false, ...obj(enforcement.verify) } };
    const routing = o.routing === undefined ? { engine: "shadow" } : o.routing;
    if (routing !== null) merged.routing = { ...routing, ...obj(extra.routing), outcomes: { ...obj(obj(routing).outcomes), path: this.outcomes } };
    return merged;
  }

  /** Rewrites the router override file (the adapter hot-reloads it on the next prompt). */
  async writeOverrides(extra: Obj = {}): Promise<void> {
    await mkdir(this.configHome, { recursive: true });
    await writeFile(path.join(this.configHome, "opencode-model-router.overrides.jsonc"), JSON.stringify(this.overrideFile(extra), null, 1));
  }

  private async boot(): Promise<this> {
    const executable = v2Executable();
    const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (!/^(?:opencode v)?2\./.test(version.stdout.trim())) throw new Error(`not an OpenCode 2 executable: ${version.stdout} ${version.stderr}`);
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(process.env)) if (ENV_ALLOWLIST.has(name.toUpperCase())) env[name] = value;
    for (const [name, dir] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp" })) {
      env[name] = path.join(this.root, dir);
      await mkdir(env[name]!, { recursive: true });
    }
    this.project = path.join(this.root, "project");
    await mkdir(this.project, { recursive: true });
    await mkdir(this.outcomes, { recursive: true });
    const probe = path.join(this.root, "probe-plugin");
    await mkdir(probe, { recursive: true });
    await writeFile(path.join(probe, "package.json"), JSON.stringify({ name: "routing-smoke-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
    await writeFile(path.join(probe, "server.mjs"), PROBE_PLUGIN);
    for (const file of [this.logs.hooks, this.logs.events]) await writeFile(file, "");
    const probeConfig = path.join(this.root, "probe-config.json");
    if (this.options.probe) await writeFile(probeConfig, JSON.stringify(this.options.probe));
    if (this.options.seed && this.options.seed.length > 0) await seedOutcomes(this.outcomes, this.options.seed);
    await this.writeOverrides();
    const baseURL = await this.provider.start();
    const root = this.options.rootModel ?? ROOT_MODEL;
    const configDir = path.join(env.XDG_CONFIG_HOME!, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: ref(root),
      plugins: [...(this.options.withoutRouter ? [] : [ROOT]), probe],
      providers: { anthropic: { settings: { baseURL, apiKey: "keyless-smoke-fake" } }, ...this.resolveProviders(baseURL) },
      ...obj(this.options.hostConfig),
    }));
    const password = randomBytes(24).toString("base64url");
    Object.assign(env, {
      OPENCODE_PASSWORD: password, OPENCODE_TEST_HOME: env.HOME, PWD: this.project,
      OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_FILEWATCHER_DISABLE: "true",
      SMOKE_HOOKS: this.logs.hooks, SMOKE_EVENTS: this.logs.events, SMOKE_DUMP: this.logs.dump,
      ...(this.options.probe ? { SMOKE_PROBE_CONFIG: probeConfig } : {}),
    });
    this.envKeys = Object.keys(env).sort();
    // No credential-shaped variable may reach the host; OPENCODE_PASSWORD is the harness's own random one.
    const leaked = this.envKeys.filter(name => CREDENTIAL_NAME.test(name) && name !== "OPENCODE_PASSWORD");
    if (leaked.length > 0) throw new Error(`credential-shaped variable(s) would reach the host: ${leaked.join(",")}`);
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
    await this.client.agent.list(); // a catalog read starts the native plugin graph
    const wanted = this.options.withoutRouter ? ["routing-smoke-probe"] : ["opencode-model-router", "routing-smoke-probe"];
    for (const id of wanted) {
      const state = await waitFor(`${id} plugin state`, async () => {
        const found = (await this.client.plugin.list()).data.find(p => p.id === id)?.state;
        return found && (found.status === "active" || found.status === "failed") ? found : undefined;
      }, 40_000);
      if (state.status !== "active") throw new Error(`${id} plugin is ${state.status}: ${state.error ?? ""}\n${this.output}`);
    }
    return this;
  }

  /** Extra providers: values may contain the placeholder `$BASE_URL`, replaced by the scripted provider's base URL. */
  private resolveProviders(baseURL: string): Obj {
    return JSON.parse(JSON.stringify(this.options.providers ?? {}).replaceAll("$BASE_URL", baseURL)) as Obj;
  }

  stop(): Promise<Teardown> { return this.teardown ??= this.doStop(); }
  private async doStop(): Promise<Teardown> {
    const child = this.child;
    const pid = child?.pid;
    // Every session id this host ever created, from its own event log (the session list misses children the runner already deleted), plus what it holds now.
    try {
      for (const e of await this.rawEvents()) {
        if (e.type === "session.created") for (const id of [obj(e.data).sessionID, obj(e.data).parentID]) if (typeof id === "string") seenSessionIDs.add(id);
        for (const dir of [obj(e.location).directory, e.__instance]) if (typeof dir === "string" && dir !== "") seenProjectDirs.add(dir);
      }
    } catch { /* no event log */ }
    seenProjectDirs.add(this.project);
    seenProjectDirs.add(path.join(this.root, "config", "opencode"));
    if (child && child.exitCode === null) { try { for (const s of await this.everySession()) seenSessionIDs.add(s.id); } catch { /* the host is already gone */ } }
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
    liveHosts.delete(this);
    const rootRemoved = await rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).then(() => !existsSync(this.root), () => false);
    return { pid, method, taskkill, exitCode: child?.exitCode, hostPort: this.port, hostPortClosed, providerStopped, rootRemoved };
  }

  /** Makes the server base-configuration location live (as S3b did): a second plugin instance (location) starts in the same process. */
  async makeBaseLocationLive(): Promise<string> {
    const base = path.join(this.root, "config", "opencode");
    const url = new URL("/api/model", this.baseUrl);
    url.searchParams.set("location[directory]", base);
    await waitFor("base-config catalog", async () => {
      const response = await fetch(url, { headers: { authorization: this.authorization }, signal: AbortSignal.timeout(30_000) });
      return ((obj(JSON.parse(await response.text())).data ?? []) as ModelInfo[]).length > 0 ? true : undefined;
    }, 30_000, 250);
    await waitFor("a second plugin instance", async () => new Set((await this.rawEvents()).filter(e => e.type === "probe.instance.started").map(e => e.__iid)).size >= 2 ? true : undefined, 30_000, 250);
    return base;
  }
  /** Polls every session of the host while a delegation runs (the runner removes its producer and grader children when it ends). */
  watchSessions(everyMs = 120): { stop(): Promise<Map<string, SessionTimeline>> } {
    const timeline = new Map<string, SessionTimeline>();
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          for (const s of await this.everySession()) {
            const view = { agent: s.agent, model: s.model ? ref(s.model) : undefined, input: s.tokens?.input ?? 0, output: s.tokens?.output ?? 0, cost: s.cost ?? 0 };
            const entry = timeline.get(s.id) ?? { id: s.id, parentID: s.parentID, firstSeen: Date.now(), snapshots: [] };
            timeline.set(s.id, entry);
            const last = entry.snapshots.at(-1);
            if (last === undefined || last.agent !== view.agent || last.model !== view.model || last.input !== view.input || last.output !== view.output) entry.snapshots.push({ at: Date.now(), ...view });
          }
        } catch { /* a session removed between list and get */ }
        await delay(everyMs);
      }
    })();
    return { stop: async () => { running = false; await loop; return timeline; } };
  }
  /** The events of one session (de-duplicated by event id). */
  async eventsOf(sessionID: string): Promise<EventRecord[]> { return (await this.events()).filter(e => obj(e.data).sessionID === sessionID); }
  /** A read-only GET against THIS isolated host (never the user's service). */
  async getJson(route: string): Promise<unknown> {
    const url = new URL(route, this.baseUrl);
    url.searchParams.set("location[directory]", this.project);
    const response = await fetch(url, { headers: { authorization: this.authorization }, signal: AbortSignal.timeout(30_000) });
    return JSON.parse(await response.text());
  }
  tail(chars = 3_000): string { return this.output.slice(-chars); }
  /** Every host log line that mentions the router at warn/error level (the plugin's own diagnostics). */
  routerLogLines(): string[] { return this.output.split(/\r?\n/).filter(line => /\[router\]|\[model-router\]/.test(line) && /(WARN|ERROR)/i.test(line)); }
  /** Host log lines at ERROR level (a failed model initialization, a failed session drain…). */
  errorLines(): string[] { return this.output.split(/\r?\n/).filter(line => /level=ERROR/.test(line)); }
  async hooks(): Promise<HookRecord[]> { return jsonl<HookRecord>(this.logs.hooks); }
  async rawEvents(): Promise<EventRecord[]> { return jsonl<EventRecord>(this.logs.events); }
  /** rawEvents() with duplicates (the same event id seen by several plugin instances) removed. */
  async events(): Promise<EventRecord[]> {
    const seen = new Set<string>();
    return (await this.rawEvents()).filter(e => { if (typeof e.id !== "string") return true; if (seen.has(e.id)) return false; seen.add(e.id); return true; });
  }
  /** The project and location directories of this host: the one the harness made, the base-configuration location, and every directory its events name (as the host spells them). */
  async projectDirs(): Promise<string[]> {
    const dirs = new Set<string>([this.project, path.join(this.root, "config", "opencode")]);
    for (const e of await this.rawEvents()) for (const dir of [obj(e.location).directory, e.__instance]) if (typeof dir === "string" && dir !== "") dirs.add(dir);
    return [...dirs];
  }
  /** The opencode.json the harness generated for this host (what the host loaded, e.g. to prove an agent entry has no `model`). */
  async hostConfigOnDisk(): Promise<Obj> { return obj(JSON.parse(await readFile(path.join(this.root, "config", "opencode", "opencode.json"), "utf8"))); }
  async dump(): Promise<Obj | undefined> { return existsSync(this.logs.dump) ? obj(JSON.parse(await readFile(this.logs.dump, "utf8"))) : undefined; }

  /** The scripted root orchestrator: a root session on the scripted model with a session-level allow-all (no `ask` can block headless). */
  async newRoot(title: string, model: ModelRef = this.options.rootModel ?? ROOT_MODEL, directory: string = this.project, permissions: Rule[] = [{ action: "*", resource: "*", effect: "allow" }]): Promise<string> {
    return (await this.client.session.create({ agent: "build", model, title, location: { directory }, permissions })).id;
  }

  /** Prompts the root so that its scripted model emits one tool call; waits for the matching execute.after and for the root to go idle. */
  async call(rootID: string, tool: "subagent" | "delegate", input: Obj, timeoutMs = 120_000): Promise<Dispatched> {
    const seen = new Set((await this.hooks()).filter(h => h.hook === "after" && h.sessionID === rootID && h.tool === tool).map(h => h.callID));
    await this.client.session.prompt({ sessionID: rootID, text: `${tool === "subagent" ? "SPIKE_CALL" : "SPIKE_DELEGATE"}=${JSON.stringify(input)}` });
    const after = await waitFor(`${tool} execute.after of ${rootID}`, async () => (await this.hooks()).find(h => h.hook === "after" && h.sessionID === rootID && h.tool === tool && !seen.has(h.callID)), timeoutMs);
    const before = (await this.hooks()).find(h => h.hook === "before" && h.callID === after.callID);
    if (!before) throw new Error(`no execute.before record for ${after.callID}`);
    await this.settle(rootID);
    const output = obj(obj(after.result).output);
    const failed = /sessionID: (ses_[A-Za-z0-9]+)/.exec(String(obj(after.error).string ?? ""))?.[1];
    return { before, after, callID: after.callID, childID: str(output.sessionID) ?? failed };
  }
  /** `call("subagent", …)` that must identify exactly one child (from the result, or from a parent with exactly one child). */
  async dispatch(rootID: string, input: Obj): Promise<Dispatched & { childID: string }> {
    const d = await this.call(rootID, "subagent", input);
    if (d.childID) return { ...d, childID: d.childID };
    const kids = (await this.client.session.list({ parentID: rootID })).data;
    if (kids.length !== 1) throw new Error(`cannot identify the child: no sessionID in the result and ${kids.length} children (${JSON.stringify(d.after)})`);
    return { ...d, childID: kids[0]!.id };
  }
  async prompt(rootID: string, text: string): Promise<void> {
    await this.client.session.prompt({ sessionID: rootID, text });
    await this.settle(rootID);
  }
  /** Waits until the session is idle again (root turn fully finished). */
  async settle(sessionID: string): Promise<void> {
    await Promise.race([this.client.session.wait({ sessionID }), delay(90_000).then(() => { throw new Error(`session.wait(${sessionID}) timed out`); })]);
    await waitFor(`${sessionID} to leave the active set`, async () => Object.hasOwn(await this.client.session.active(), sessionID) ? undefined : true, 60_000);
  }
  async children(rootID: string): Promise<SessionInfo[]> { return (await this.client.session.list({ parentID: rootID, limit: 500 })).data; }
  async everySession(): Promise<SessionInfo[]> {
    const roots = (await this.client.session.list({ limit: 500 })).data;
    const all = new Map(roots.map(s => [s.id, s] as const));
    for (const r of roots) for (const c of (await this.client.session.list({ parentID: r.id, limit: 500 })).data) all.set(c.id, c);
    return [...all.values()];
  }
  /** Requests the provider received for one session. */
  requestsOf(sessionID: string): WireRequest[] { return this.provider.requests.filter(r => r.session === sessionID); }
  /** Text of the user messages of a session as the host stores them. */
  async userTexts(sessionID: string): Promise<string[]> {
    return (await this.client.session.context({ sessionID })).filter(m => m.type === "user").map(m => JSON.stringify(m));
  }

  // ---- the outcomes store on disk (what the plugin inside the host wrote) ----
  async decisionRows(): Promise<DecisionRow[]> { return (await this.logRows()).filter((r): r is DecisionRow => r.kind === "decision"); }
  async logRows(): Promise<LogRow[]> {
    const names = existsSync(this.outcomes) ? (await readdir(this.outcomes)).filter(n => /^decisions(\..+)?\.jsonl$/.test(n)).sort() : [];
    const rows: LogRow[] = [];
    for (const name of names) rows.push(...await jsonl<LogRow>(path.join(this.outcomes, name)));
    return rows;
  }
  async outcomeEntries(): Promise<Record<string, OutcomeEntrySnapshot>> {
    const file = path.join(this.outcomes, "outcomes.json");
    if (!existsSync(file)) return {};
    return obj(JSON.parse(await readFile(file, "utf8")).entries) as Record<string, OutcomeEntrySnapshot>;
  }
  /** The persister flushes the first write at once and then at most every 30 s (D15): poll for what the host has written. */
  async waitForRows(label: string, predicate: (rows: DecisionRow[]) => boolean, timeoutMs = 60_000): Promise<DecisionRow[]> {
    return waitFor(label, async () => { const rows = await this.decisionRows(); return predicate(rows) ? rows : undefined; }, timeoutMs, 500);
  }
  async waitForLogRows(label: string, predicate: (rows: LogRow[]) => boolean, timeoutMs = 70_000): Promise<LogRow[]> {
    return waitFor(label, async () => { const rows = await this.logRows(); return predicate(rows) ? rows : undefined; }, timeoutMs, 500);
  }
  async waitForEntries(label: string, predicate: (entries: Record<string, OutcomeEntrySnapshot>) => boolean, timeoutMs = 60_000): Promise<Record<string, OutcomeEntrySnapshot>> {
    return waitFor(label, async () => { const entries = await this.outcomeEntries(); return predicate(entries) ? entries : undefined; }, timeoutMs, 500);
  }
  async storeListing(): Promise<{ name: string; size: number }[]> {
    const names = existsSync(this.outcomes) ? await readdir(this.outcomes) : [];
    return Promise.all(names.sort().map(async name => ({ name, size: (await stat(path.join(this.outcomes, name))).size })));
  }
}

/** Kills whatever a failed test left running. */
export async function stopAllHosts(): Promise<void> {
  for (const host of [...liveHosts]) await host.stop().catch(() => undefined);
}

/** Seeds an outcomes directory through the repo's own store and persister (no hand-written snapshot). */
export async function seedOutcomes(dir: string, seeds: readonly Seed[]): Promise<void> {
  const bundle = acquireOutcomes({ dir, tuning: DEFAULT_OUTCOME_TUNING, logger: { warn: () => undefined } });
  await bundle.ready;
  for (const { key, pass, fail } of seeds) {
    for (let i = 0; i < pass; i++) bundle.store.recordVerdict(key, "pass", { attemptID: `${key}:p${i}`, step: "dispatch" });
    for (let i = 0; i < fail; i++) bundle.store.recordVerdict(key, "fail", { attemptID: `${key}:f${i}`, step: "dispatch" });
  }
  await bundle.flusher.flushNow();
  await bundle.release();
}

// ----------------------------------------------------------------- evidence ----
let harnessIds: Obj | undefined;
function harnessGitIds(): Obj {
  if (harnessIds) return harnessIds;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
    harnessIds = {
      headSha: git("rev-parse", "HEAD"),
      blobShas: Object.fromEntries(["test/smoke/routing-engine.smoke.test.ts", "test/smoke/helpers/routing-host.ts"].map(f => [f, git("hash-object", f)])),
      uncommittedChanges: git("status", "--porcelain", "--", "src", "test/smoke", "package.json").length > 0,
    };
  } catch (error) { harnessIds = { error: String(error) }; }
  return harnessIds;
}
export interface Scenario { observed: Obj; notes: string[]; verdict(pass: boolean, detail: string): void }
/** Runs one scenario body: the evidence is written BEFORE the assertion so a disproven expectation still leaves its observations. */
export async function runScenario(id: string, expectation: string, body: (s: Scenario) => Promise<void>): Promise<{ pass: boolean; detail: string }> {
  let verdict: { pass: boolean; detail: string } | undefined;
  let failure: unknown;
  const state: Scenario = { observed: {}, notes: [], verdict: (pass, detail) => { verdict = { pass, detail }; } };
  try { await body(state); } catch (error) { failure = error; }
  const result = failure !== undefined ? `ERROR: ${failure instanceof Error ? failure.message : String(failure)}` : verdict ? `${verdict.pass ? "PASS" : "FAIL"}: ${verdict.detail}` : "NO VERDICT";
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const record = { scenario: id, host: "opencode v2.0.22 (native v2 plugin API), this checkout loaded as the router plugin", runId: RUN_ID, recordedAt: new Date().toISOString(), harness: harnessGitIds(), expectation, observed: clip(state.observed), assertionResult: result, notes: state.notes };
  await writeFile(path.join(EVIDENCE_DIR, `${id}.json`), `${JSON.stringify(redact(record), null, 2)}\n`);
  if (failure !== undefined) throw failure;
  if (!verdict) throw new Error(`${id} produced no verdict`);
  if (!verdict.pass) throw new Error(`${id} expectation disproven: ${verdict.detail}`);
  return verdict;
}
