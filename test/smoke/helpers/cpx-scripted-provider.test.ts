import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { CpxFront, CpxScriptedProvider, faultAnswer, withCacheUsageJson, withCacheUsageSse, type CpxProviderOptions, type UsageLimitVariant } from "./cpx-scripted-provider";
import { EVIDENCE_DIR, RoutingHost, evidenceDir } from "./routing-host";
import { ScriptedProvider } from "./scripted-provider";
import { isFetchSafePort } from "./fetch-safe-port";

const providers: { stop(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(providers.splice(0).map(p => p.stop())); });
async function start(options: CpxProviderOptions = {}) {
  const provider = new CpxScriptedProvider("v1", options);
  providers.push(provider);
  const base = await provider.start();
  expect(isFetchSafePort(Number(new URL(base).port))).toBe(true);
  return { provider, front: provider.front, url: `${base}/messages` };
}
/** The unmodified fixture, for byte comparisons with what the front returns. */
async function startPlain() {
  const provider = new ScriptedProvider("v1");
  providers.push(provider);
  return `${await provider.start()}/messages`;
}
const ask = { model: "fixture", stream: false, messages: [{ role: "user", content: "ok" }] };
const post = (url: string, body: unknown = ask, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(label: string, done: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) await tick();
  if (!done()) throw new Error(`Timed out waiting for ${label}`);
}
const events = (sse: string) => sse.split("\n\n").filter(Boolean);

it("is a transparent pass-through with no options (JSON and SSE bytes equal the fixture's)", async () => {
  const plain = await startPlain();
  const { url, front } = await start();
  for (const stream of [false, true]) {
    const body = { ...ask, stream };
    const direct = await post(plain, body);
    const fronted = await post(url, body);
    expect(fronted.status).toBe(direct.status);
    expect(fronted.headers.get("content-type")).toBe(direct.headers.get("content-type"));
    expect(await fronted.text()).toBe(await direct.text());
  }
  expect(front.requests.map(r => r.served)).toEqual(["forwarded", "forwarded"]);
  expect(front.frontErrors).toEqual([]);
});

it("forwards the fixture's own errors unchanged even when cache usage is configured", async () => {
  const plain = await startPlain();
  const { url } = await start({ cacheUsage: { read: 1, creation: 2 } });
  const direct = await post(plain, "not-json");
  const fronted = await post(url, "not-json");
  expect(fronted.status).toBe(400);
  expect(await fronted.text()).toBe(await direct.text());
});

it("answers a 429 rate limit with retry-after instead of forwarding", async () => {
  const { provider, front, url } = await start();
  front.failNext("rate-limit", { retryAfterSeconds: 7 });
  const response = await post(url);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("7");
  expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("0");
  expect(await response.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } });
  expect(provider.captures).toHaveLength(0);
  expect(front.requests.map(r => r.served)).toEqual(["rate-limit"]);
});

it("answers a 529 overloaded error", async () => {
  const { provider, front, url } = await start();
  front.failNext("overloaded");
  const response = await post(url);
  expect(response.status).toBe(529);
  expect(await response.json()).toEqual({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  expect(provider.captures).toHaveLength(0);
});

it("answers a non-retryable 400 invalid-request error without forwarding (the fixture records nothing)", async () => {
  const { provider, front, url } = await start();
  front.failNext("invalid-request");
  const response = await post(url);
  expect(response.status).toBe(400);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "cpx scripted invalid request" } });
  expect(provider.captures).toHaveLength(0);
  expect(front.requests.map(r => r.served)).toEqual(["invalid-request"]);
  expect(front.frontErrors).toEqual([]);
  expect(faultAnswer("invalid-request")).toMatchObject({ status: 400, headers: { "request-id": "req_cpx_invalid-request" } });
});

it("serves invalid-request by count and by predicate like the other kinds", async () => {
  const { provider, front, url } = await start();
  front.failWhen(r => (r.body as { stream?: boolean }).stream === true, "invalid-request", { times: 2 });
  expect((await post(url, { ...ask, stream: false })).status).toBe(200);
  expect(front.pendingFaults).toBe(2);
  expect((await post(url, { ...ask, stream: true })).status).toBe(400);
  expect((await post(url, { ...ask, stream: true })).status).toBe(400);
  expect((await post(url, { ...ask, stream: true })).status).toBe(200);
  expect(front.pendingFaults).toBe(0);
  expect(front.requests.map(r => r.served)).toEqual(["forwarded", "invalid-request", "invalid-request", "forwarded"]);
  expect(provider.captures).toHaveLength(2);
  front.failNext("invalid-request", { times: Infinity });
  expect(front.pendingFaults).toBe(1);
  expect((await post(url)).status).toBe(400);
  expect((await post(url)).status).toBe(400);
  front.clearFaults();
  expect((await post(url)).status).toBe(200);
});

it("answers a usage-limit 429 that names the reset time in the body and the reset headers", async () => {
  const { front, url } = await start();
  const resetAt = new Date(Date.now() + 7_200_000);
  front.failNext("usage-limit", { resetAt });
  const response = await post(url);
  const reset = resetAt.toISOString();
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: `Usage limit reached. Your limit will reset at ${reset}.` } });
  for (const name of ["requests", "tokens", "unified"]) expect(response.headers.get(`anthropic-ratelimit-${name}-reset`)).toBe(reset);
  const retryAfter = Number(response.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(7_100);
  expect(retryAfter).toBeLessThanOrEqual(7_200);
});

it("builds fault answers purely from the injected clock", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  const usage = faultAnswer("usage-limit", { resetAt: "2026-10-10T17:00:00.000Z" }, now);
  expect(usage.status).toBe(429);
  expect(usage.headers["retry-after"]).toBe("18000");
  expect(faultAnswer("usage-limit", { resetAt: "2026-10-10T11:00:00.000Z" }, now).headers["retry-after"]).toBe("1"); // an elapsed reset still asks for a 1s wait
  expect(faultAnswer("usage-limit", {}, now).headers["anthropic-ratelimit-unified-reset"]).toBe("2026-10-10T13:00:00.000Z");
  expect(faultAnswer("rate-limit", {}, now).headers).toMatchObject({ "retry-after": "1", "anthropic-ratelimit-requests-reset": "2026-10-10T12:00:01.000Z" });
  expect(faultAnswer("overloaded", {}, now)).toMatchObject({ status: 529 });
  expect(() => faultAnswer("usage-limit", { resetAt: "not a date" }, now)).toThrow("Invalid resetAt");
});

it("answers each usage-limit variant with exactly its own features (default unchanged)", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  const resetAt = "2026-10-10T13:00:00.000Z";
  const answer = (variant?: UsageLimitVariant) => faultAnswer("usage-limit", { resetAt, ...(variant ? { variant } : {}) }, now);
  const message = (body: string): string => (JSON.parse(body) as { error: { message: string } }).error.message;
  expect(answer()).toEqual(answer("reset-sentence"));
  expect(message(answer().body)).toBe(`Usage limit reached. Your limit will reset at ${resetAt}.`);

  const headerOnly = answer("header-only");
  expect(headerOnly.status).toBe(429);
  expect(message(headerOnly.body)).toBe("Usage limit reached.");
  expect(headerOnly.headers["anthropic-ratelimit-unified-reset"]).toBe(resetAt);
  expect(headerOnly.headers["retry-after"]).toBeUndefined();

  const retryOnly = answer("retry-after-only");
  expect(retryOnly.status).toBe(429);
  expect(message(retryOnly.body)).toBe("Usage limit reached.");
  expect(retryOnly.headers["retry-after"]).toBe("3600");
  expect(Object.keys(retryOnly.headers).filter(name => name.startsWith("anthropic-ratelimit"))).toEqual([]);

  const alt = answer("alt-wording");
  expect(message(alt.body)).toBe("You have reached your usage limit");
  expect(alt.headers).toMatchObject({ "retry-after": "3600", "anthropic-ratelimit-unified-reset": resetAt });

  const control = answer("no-usage-wording");
  expect(control.status).toBe(429);
  expect(message(control.body)).not.toMatch(/usage limit|reset at/i);
  expect(JSON.parse(control.body)).toMatchObject({ error: { type: "rate_limit_error" } });
  expect(control.headers).toMatchObject({ "retry-after": "3600", "anthropic-ratelimit-unified-reset": resetAt });
});

it("serves a fault `times` times, then forwards", async () => {
  const { provider, front, url } = await start();
  front.failNext("overloaded", { times: 2 }).failNext("rate-limit");
  expect(front.pendingFaults).toBe(3);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(url)).status);
  expect(statuses).toEqual([529, 529, 429, 200]);
  expect(front.pendingFaults).toBe(0);
  expect(provider.captures).toHaveLength(1);
  expect(front.requests.map(r => r.served)).toEqual(["overloaded", "overloaded", "rate-limit", "forwarded"]);
});

it("matches faults by predicate without consuming them for other requests, and clears them", async () => {
  const { front, url } = await start();
  front.failWhen(r => (r.body as { stream?: boolean }).stream === true, "overloaded", { times: 1 });
  expect((await post(url, { ...ask, stream: false })).status).toBe(200);
  expect(front.pendingFaults).toBe(1);
  expect((await post(url, { ...ask, stream: true })).status).toBe(529);
  expect((await post(url, { ...ask, stream: true })).status).toBe(200);
  front.failNext("rate-limit", { times: Infinity });
  expect(front.pendingFaults).toBe(1);
  front.clearFaults();
  expect((await post(url)).status).toBe(200);
});

it("holds each request for the configured delay before answering (injected waiter, no wall clock)", async () => {
  const release: (() => void)[] = [];
  const asked: number[] = [];
  const sleep = (ms: number) => { asked.push(ms); return new Promise<void>(resolve => release.push(resolve)); };
  const { provider, url } = await start({ delayMs: 250, sleep });
  let answered = false;
  const pending = post(url).then(response => { answered = true; return response; });
  await until("the front to start waiting", () => asked.length === 1);
  await tick();
  expect(asked).toEqual([250]);
  expect(answered).toBe(false);
  expect(provider.captures).toHaveLength(0); // the request was not forwarded yet
  release[0]!();
  expect((await pending).status).toBe(200);
  expect(provider.captures).toHaveLength(1);
});

it("derives the delay from the request, and does not wait for a zero delay", async () => {
  const asked: number[] = [];
  const { url } = await start({ delayMs: r => r.index === 1 ? 40 : 0, sleep: async ms => { asked.push(ms); } });
  for (let i = 0; i < 3; i++) expect((await post(url)).status).toBe(200);
  expect(asked).toEqual([40]);
});

it("really delays with the default timer (generous lower bound)", async () => {
  const { url } = await start({ delayMs: 200 });
  const began = Date.now();
  expect((await post(url)).status).toBe(200);
  expect(Date.now() - began).toBeGreaterThanOrEqual(150);
});

it("applies a delay before a fault too", async () => {
  const asked: number[] = [];
  const { front, url } = await start({ delayMs: 9, sleep: async ms => { asked.push(ms); } });
  front.failNext("overloaded");
  expect((await post(url)).status).toBe(529);
  expect(asked).toEqual([9]);
});

it("captures method, url, parsed body and headers without credentials", async () => {
  const { front, url } = await start();
  await post(url, { ...ask, marker: "CAPTURE_ME" }, { authorization: "Bearer secret-token", "x-api-key": "secret-key", "x-proof-session": "ses_1" });
  await post(url, "plain text, not json");
  expect(front.requests).toHaveLength(2);
  const [first, second] = front.requests;
  expect(first).toMatchObject({ index: 0, method: "POST", url: "/v1/messages", body: { marker: "CAPTURE_ME", model: "fixture" }, served: "forwarded" });
  expect(first!.headers["x-proof-session"]).toBe("ses_1");
  expect(Object.keys(first!.headers)).not.toContain("authorization");
  expect(Object.keys(first!.headers)).not.toContain("x-api-key");
  expect(JSON.stringify(front.requests)).not.toContain("secret");
  expect(second).toMatchObject({ index: 1, body: "plain text, not json" });
});

it("adds cache usage fields to a non-stream JSON body, keeping the other fields", async () => {
  const plain = await startPlain();
  const { url } = await start({ cacheUsage: { read: 100, creation: 20 } });
  const direct = (await (await post(plain)).json()) as { usage: object };
  const body = (await (await post(url)).json()) as { usage: object };
  expect(body.usage).toEqual({ ...direct.usage, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
  expect({ ...body, usage: undefined }).toEqual({ ...direct, usage: undefined });
});

it("takes cache usage per request and leaves a request alone when the function returns undefined", async () => {
  const { url } = await start({ cacheUsage: r => r.index === 0 ? undefined : { read: r.index * 10, creation: r.index } });
  const usages = [];
  for (let i = 0; i < 3; i++) usages.push(((await (await post(url)).json()) as { usage: object }).usage);
  expect(usages[0]).toEqual({ input_tokens: 10, output_tokens: 5 });
  expect(usages[1]).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 });
  expect(usages[2]).toMatchObject({ cache_read_input_tokens: 20, cache_creation_input_tokens: 2 });
});

it("rewrites only the SSE message_start data line; every other event is byte-identical", async () => {
  const plain = await startPlain();
  const { url } = await start({ cacheUsage: { read: 7, creation: 3 } });
  const direct = events(await (await post(plain, { ...ask, stream: true })).text());
  const response = await post(url, { ...ask, stream: true });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const text = await response.text();
  const fronted = events(text);
  expect(fronted).toHaveLength(direct.length);
  expect(text.endsWith("\n\n")).toBe(true);
  fronted.forEach((event, i) => { if (i !== 0) expect(event).toBe(direct[i]); });
  expect(fronted[0]!.split("\n")[0]).toBe("event: message_start");
  const start0 = JSON.parse(fronted[0]!.split("\n")[1]!.slice("data: ".length)) as { message: { usage: object } };
  const plain0 = JSON.parse(direct[0]!.split("\n")[1]!.slice("data: ".length)) as { message: { usage: object } };
  expect(start0.message.usage).toEqual({ ...plain0.message.usage, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 });
  expect({ ...start0, message: { ...start0.message, usage: undefined } }).toEqual({ ...plain0, message: { ...plain0.message, usage: undefined } });
});

it("rewrites usage text with pure helpers (missing usage, other events, no message_start)", () => {
  expect(JSON.parse(withCacheUsageJson(JSON.stringify({ id: "m" }), { read: 1, creation: 2 }))).toEqual({ id: "m", usage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } });
  const stream = "event: ping\ndata: {\"type\":\"ping\"}\n\n";
  expect(withCacheUsageSse(stream, { read: 1, creation: 2 })).toBe(stream);
});

it("fronts any fixture: CpxFront in front of a plain http server, and stop() before start() is harmless", async () => {
  const idle = new CpxFront();
  await idle.stop();
  const inner = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ path: req.url, usage: { input_tokens: 1 } })); });
  await new Promise<void>(resolve => inner.listen(0, "127.0.0.1", resolve));
  providers.push({ stop: () => new Promise<void>((resolve, reject) => { inner.closeAllConnections(); inner.close(error => error ? reject(error) : resolve()); }) });
  const port = (inner.address() as { port: number }).port;
  const front = new CpxFront({ cacheUsage: { read: 5, creation: 6 } });
  providers.push(front);
  const base = await front.start(`http://127.0.0.1:${port}/v1`);
  expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(await (await post(`${base}/anything`)).json()).toEqual({ path: "/v1/anything", usage: { input_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } });
});

it("stops the front and the fixture: neither port accepts connections any more", async () => {
  const provider = new CpxScriptedProvider("v1");
  const url = `${await provider.start()}/messages`;
  expect((await post(url)).status).toBe(200);
  await provider.stop();
  await expect(post(url)).rejects.toThrow();
});

it("reports a front error as an Anthropic api_error when the fixture is unreachable", async () => {
  const { provider, front, url } = await start();
  await ScriptedProvider.prototype.stop.call(provider); // the inner fixture only; the front keeps listening
  providers.pop(); // do not stop it twice
  providers.push(front);
  const response = await post(url);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "cpx front error" } });
  expect(front.frontErrors).toHaveLength(1);
});

it("OMR_SMOKE_EVIDENCE_DIR is read at call time; unset keeps the tracked directory", () => {
  const saved = process.env.OMR_SMOKE_EVIDENCE_DIR;
  try {
    delete process.env.OMR_SMOKE_EVIDENCE_DIR;
    expect(evidenceDir()).toBe(EVIDENCE_DIR);
    const target = process.platform === "win32" ? "C:\\tmp\\evidence-x" : "/tmp/evidence-x";
    process.env.OMR_SMOKE_EVIDENCE_DIR = target;
    expect(evidenceDir()).toBe(target);
    process.env.OMR_SMOKE_EVIDENCE_DIR = "relative/evidence";
    expect(() => evidenceDir()).toThrow("absolute");
  } finally {
    if (saved === undefined) delete process.env.OMR_SMOKE_EVIDENCE_DIR; else process.env.OMR_SMOKE_EVIDENCE_DIR = saved;
  }
});

it("RoutingHost refuses a relative extra plugin before creating anything", async () => {
  const spy = vi.fn();
  await expect(RoutingHost.start("cpx-relative", { extraPlugins: ["relative/plugin"], prepare: spy })).rejects.toThrow("extraPlugins entries must be absolute");
  expect(spy).not.toHaveBeenCalled();
});
