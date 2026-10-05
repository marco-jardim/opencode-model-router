import { afterEach, expect, it } from "vitest";
import { ScriptedProvider } from "./scripted-provider";

const providers: ScriptedProvider[] = [];
afterEach(async () => { await Promise.all(providers.splice(0).map(p => p.stop())); });
async function start() {
  const provider = new ScriptedProvider("v1");
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
