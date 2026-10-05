import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { ScriptedProvider } from "./scripted-provider";
import { FETCH_BAD_PORTS, isFetchSafePort, listenOnFetchSafePort, pickFetchSafePort } from "./fetch-safe-port";

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
  const url = `${await provider.start()}/messages`;
  expect(isFetchSafePort(Number(new URL(url).port))).toBe(true);
  return { provider, url };
}

it("rejects the observed blocked port 3659 before returning a free safe port", async () => {
  const source = vi.fn<() => Promise<number>>().mockResolvedValueOnce(3659).mockResolvedValueOnce(49152);
  expect(await pickFetchSafePort(source)).toBe(49152);
  expect(source).toHaveBeenCalledTimes(2);
});

it("rejects every Fetch bad port and invalid destination before accepting a safe port", async () => {
  const candidates = [0, -1, 65536, NaN, 1.5, ...FETCH_BAD_PORTS];
  for (const port of candidates) expect(isFetchSafePort(port)).toBe(false);
  const source = vi.fn<() => Promise<number>>();
  for (const port of candidates) source.mockResolvedValueOnce(port);
  source.mockResolvedValueOnce(49152);
  expect(await pickFetchSafePort(source)).toBe(49152);
  expect(source).toHaveBeenCalledTimes(candidates.length + 1);
});

it("bounds blocked-port retries without ever returning a blocked destination", async () => {
  const source = vi.fn<() => Promise<number>>().mockResolvedValue(3659);
  await expect(pickFetchSafePort(source)).rejects.toThrow("after 128 probes");
  expect(source).toHaveBeenCalledTimes(128);
});

it("retries a safe port taken between probe and bind without retaining error listeners", async () => {
  const occupied = createServer();
  const server = createServer();
  try {
    const port = await listenOnFetchSafePort(occupied);
    const source = vi.fn<() => Promise<number>>().mockResolvedValueOnce(port).mockImplementation(pickFetchSafePort);
    const actual = await listenOnFetchSafePort(server, source);
    expect(actual).not.toBe(port);
    expect(isFetchSafePort(actual)).toBe(true);
    expect(source).toHaveBeenCalledTimes(2);
    expect(server.listenerCount("error")).toBe(0);
    expect(server.listenerCount("listening")).toBe(0);
  } finally {
    await Promise.all([occupied, server].filter(s => s.listening).map(s => new Promise<void>((resolve, reject) => s.close(error => error ? reject(error) : resolve()))));
  }
});

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
  expect(await response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "scripted provider error" } });
  expect(provider.errors).toEqual(["Error: Fixture requested unavailable delegate (undefined)"]);
  expect(provider.captures).toHaveLength(1);
});

it("keeps malformed request diagnostics in memory instead of the HTTP response", async () => {
  const { provider, url } = await start();
  const response = await fetch(url, { method: "POST", body: "not-json-private-request" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "scripted provider error" } });
  expect(provider.errors).toEqual([expect.stringContaining("SyntaxError")]);
  expect(provider.captures).toHaveLength(0);
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
  const message = (await response.json()) as { content: { id: string; input: { prompt: string; background: boolean } }[] };
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
