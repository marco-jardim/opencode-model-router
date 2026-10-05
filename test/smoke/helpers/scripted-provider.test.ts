import { afterEach, expect, it } from "vitest";
import { ScriptedProvider } from "./scripted-provider";

const providers: ScriptedProvider[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(pending.splice(0));
  await Promise.all(providers.splice(0).map(p => p.stop()));
});
async function start(host: "v1" | "v2" = "v1") {
  const provider = new ScriptedProvider(host);
  providers.push(provider);
  return { provider, url: `${await provider.start()}/messages` };
}

it("retains scripted tool calls and inputs in non-stream Anthropic messages", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ model: "fixture", stream: false, tools: [{ name: "task" }], messages: [{ role: "user", content: "ROOT_NEST_FG" }] }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ type: "message", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_smoke_1", name: "task", input: { prompt: "NEST_FG", subagent_type: "general" } }] });
});

it("reports fixture faults as non-retryable Anthropic errors", async () => {
  const { provider, url } = await start();
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ tools: [{ name: "task" }], messages: [{ role: "user", content: "CALL_DELEGATE" }] }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: expect.stringContaining("unavailable delegate") } });
  expect(provider.errors).toHaveLength(1);
  expect(provider.captures).toHaveLength(1);
});

it("streams ordered Anthropic message events including ping", async () => {
  const { url } = await start();
  const response = await fetch(url, { method: "POST", body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "ok" }] }) });
  const events = (await response.text()).split("\n").filter(line => line.startsWith("event: "));
  expect(events).toEqual(["event: message_start", "event: ping", "event: content_block_start", "event: content_block_delta", "event: content_block_stop", "event: message_delta", "event: message_stop"]);
});

it("holds a background leaf until the captured parent tool result releases it", async () => {
  const { provider, url } = await start("v2");
  const controller = new AbortController();
  controllers.push(controller);
  const post = (body: object, session: string) => {
    const request = fetch(url, { method: "POST", signal: controller.signal, headers: { "x-proof-session": session }, body: JSON.stringify(body) });
    pending.push(request);
    // Attach immediately, before an assertion can bypass the eventual await.
    void request.catch(() => undefined);
    return request;
  };
  const response = await post({ tools: [{ name: "subagent" }], messages: [{ role: "user", content: "NEST_BG" }] }, "parent");
  const message: { content: { id: string; input: { prompt: string; background: boolean } }[] } = await response.json();
  const call = message.content[0];
  let answered = false;
  const leaf = post({ messages: [{ role: "user", content: call.input.prompt }] }, "leaf").then(
    response => { answered = true; return { response }; },
    (error: unknown) => ({ error }),
  );
  pending.push(leaf);
  const deadline = Date.now() + 5_000;
  while (!provider.barrierEvents.some(e => e.event === "leaf-waiting") && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  expect(provider.barrierEvents.map(e => e.event)).toEqual(["armed", "leaf-waiting"]);
  expect(answered).toBe(false);
  await post({ messages: [{ role: "assistant", content: [{ type: "tool_use", ...call }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "working in background" }] }] }, "parent");
  const settled = await leaf;
  if ("error" in settled) throw settled.error;
  expect(settled.response.status).toBe(200);
  expect(provider.barrierEvents.map(e => e.event)).toEqual(["armed", "leaf-waiting", "result-observed", "leaf-released"]);
}, 10_000);
