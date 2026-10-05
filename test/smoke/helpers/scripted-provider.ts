/** Keyless Anthropic Messages fixture, promoted from the Phase 2.3 host proof.
 * Deliberately tests host lowering, not acceptance by the upstream provider.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type HostVersion = "v1" | "v2";
export interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
}
export interface RequestBody {
  model?: string;
  stream?: boolean;
  system?: unknown;
  messages?: { role: string; content: string | Block[] }[];
  tools?: { name: string }[];
  output_config?: { effort?: string };
}
export interface Capture {
  body: RequestBody;
  session?: string;
  agent?: string;
  role: "producer" | "grader" | "title" | "orchestrator" | "child";
}
export const blocks = (body: RequestBody): Block[] =>
  (body.messages ?? []).flatMap(m => typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
export const blockText = (content: Block["content"]): string =>
  typeof content === "string" ? content : (content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("\n");

export class ScriptedProvider {
  readonly captures: Capture[] = [];
  readonly replies: { role: Capture["role"]; tool?: string; input?: Record<string, unknown>; text: string }[] = [];
  readonly errors: string[] = [];
  readonly barrierEvents: { parent: string; event: "armed" | "leaf-waiting" | "result-observed" | "leaf-released" }[] = [];
  private background = new Map<string, { promise: Promise<void>; release: () => void; observed: boolean }>();
  private graders = 0;
  private sequence = 0;
  private server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: RequestBody = JSON.parse(Buffer.concat(chunks).toString());
      const header = (key: string) => { const value = req.headers[key]; return Array.isArray(value) ? value[0] : value; };
      const agent = header("x-proof-agent");
      const grader = JSON.stringify(body.system ?? "").includes("You are an independent, skeptical verification grader.");
      const role: Capture["role"] = grader ? "grader" : agent === "fast" ? "producer" : agent === "title" || header("x-proof-kind") === "title" ? "title" : agent === "build" ? "orchestrator" : "child";
      this.captures.push({ body, session: header("x-proof-session"), agent, role });
      const parent = header("x-proof-session");
      const gate = parent ? this.background.get(parent) : undefined;
      const history = blocks(body);
      if (gate && !gate.observed && history.some(b => b.type === "tool_result" && history.some(use => use.type === "tool_use" && use.id === b.tool_use_id && use.input?.background === true))) {
        gate.observed = true;
        this.barrierEvents.push({ parent: parent!, event: "result-observed" });
        gate.release();
      }
      const last = body.messages?.at(-1)?.content ?? [];
      const content: Block[] = typeof last === "string" ? [{ type: "text", text: last }] : last;
      const marker = content.filter(b => b.type === "text").map(b => b.text).join("\n");
      let tool: string | undefined;
      let input: Record<string, unknown> | undefined;
      let text = "ok";
      if (grader) text = JSON.stringify({ pass: ++this.graders > 1, reasons: [this.graders === 1 ? "scripted first-attempt failure" : "CHILD_DONE observed"] });
      else if (body.tools?.length && !content.some(b => b.type === "tool_result")) {
        if (marker.includes("CALL_DELEGATE")) {
          tool = "delegate";
          input = { tier: "fast", task: "VERIFY:required\nCHILD_DONE", acceptance: "[acceptance]\ncriteria: the reply says CHILD_DONE\n[/acceptance]" };
        } else if (marker.includes("ROOT_SETUP") || marker.includes("ROOT_NEST_") || /\bNEST_(FG|BG|RESUME)\b/.test(marker)) {
          tool = this.host === "v1" ? "task" : "subagent";
          const resume = /RESUME_ID=(ses_[A-Za-z0-9]+)/.exec(marker)?.[1];
          const nested = !marker.includes("ROOT_");
          const prompt = marker.includes("ROOT_SETUP") ? "LEAF_DONE" : marker.includes("ROOT_NEST_") ? marker.includes("ROOT_NEST_BG") ? "NEST_BG" : marker.includes("ROOT_NEST_RESUME") ? `NEST_RESUME RESUME_ID=${resume}` : "NEST_FG" : "LEAF_DONE";
          input = this.host === "v1" ? { description: "Depth smoke dispatch", prompt, subagent_type: "general" } : { description: "Depth smoke dispatch", prompt, agent: "general", background: nested && marker.includes("NEST_BG") };
          if (nested && resume) input[this.host === "v1" ? "task_id" : "sessionID"] = resume;
          const caller = /RESUME_CALLER_ID=(ses_[A-Za-z0-9]+)/.exec(marker)?.[1];
          if (!nested && caller) input[this.host === "v1" ? "task_id" : "sessionID"] = caller;
          if (input.background === true) {
            if (!parent) throw new Error("Background fixture requires the caller session header");
            let release = () => {};
            const promise = new Promise<void>(resolve => { release = resolve; });
            this.background.set(parent, { promise, release, observed: false });
            this.barrierEvents.push({ parent, event: "armed" });
            input.prompt = `${prompt} WAIT_FOR_PARENT=${parent}`;
          }
        } else if (marker.includes("CHILD_DONE")) text = "CHILD_DONE";
      }
      this.replies.push({ role, tool, input, text });
      if (tool && !body.tools?.some(t => t.name === tool)) throw new Error(`Fixture requested unavailable ${tool} (${agent})`);
      // A background leaf cannot finish before the parent has sent its actual
      // tool_result back to the provider. No wall-clock margin is assumed.
      const waitingFor = /WAIT_FOR_PARENT=(\S+)/.exec(marker)?.[1];
      if (waitingFor && marker.includes("LEAF_DONE") && !tool) {
        const pending = this.background.get(waitingFor);
        if (!pending) throw new Error("Background leaf has no armed parent barrier");
        this.barrierEvents.push({ parent: waitingFor, event: "leaf-waiting" });
        await pending.promise;
        if (!pending.observed) { res.destroy(); return; } // teardown releases cancelled leaves
        this.barrierEvents.push({ parent: waitingFor, event: "leaf-released" });
      }
      this.send(res, body, text, tool, input);
    } catch (error) {
      this.errors.push(String(error));
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(error) } }));
    }
  });

  constructor(readonly host: HostVersion) {}

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    for (const gate of this.background.values()) gate.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }

  private send(res: ServerResponse, body: RequestBody, text: string, tool?: string, input?: Record<string, unknown>) {
    const n = ++this.sequence;
    const message = { id: `msg_smoke_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, content: tool ? [{ type: "tool_use", id: `toolu_smoke_${n}`, name: tool, input }] : [{ type: "text", text }], stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message });
    event("ping", {});
    event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_smoke_${n}`, name: tool, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    event("message_stop", {});
    res.end();
  }
}
