import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CpxFront, CpxScriptedProvider, faultAnswer, withCacheUsageJson, withCacheUsageSse, type CpxProviderOptions, type UsageLimitVariant } from "./cpx-scripted-provider";
import { EVIDENCE_DIR, ROOT, RoutingHost, evidenceDir, obj } from "./routing-host";
import { ScriptedProvider } from "./scripted-provider";
import { isFetchSafePort } from "./fetch-safe-port";
import { parseFindings } from "../../../src/executor/qa-loop";
import type { FindingsReport } from "../../../src/executor/types";

const providers: { stop(): Promise<void> }[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map(p => p.stop()));
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function start(options: CpxProviderOptions = {}, host: "v1" | "v2" = "v1") {
  const provider = new CpxScriptedProvider(host, options);
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

it.each([false, true])("answers ESCALATE as a successful v2 assistant turn (stream=%s)", async stream => {
  const { provider, front, url } = await start({ cacheUsage: { read: 2, creation: 3 } }, "v2");
  front.escalateNext("authority: edit is required");
  const response = await post(url, { ...ask, stream });
  expect(response.status).toBe(200);
  const text = await response.text();
  if (stream) {
    const data = events(text).map(event => obj(JSON.parse(event.split("\n")[1]!.slice("data: ".length))));
    expect(data.find(event => event.type === "content_block_delta")!.delta).toEqual({ type: "text_delta", text: "ESCALATE: authority: edit is required" });
    expect(obj(data.find(event => event.type === "message_delta")!.delta).stop_reason).toBe("end_turn");
    expect(obj(data[0]!.message).usage).toMatchObject({ cache_read_input_tokens: 2, cache_creation_input_tokens: 3 });
  } else {
    expect(JSON.parse(text)).toMatchObject({ content: [{ type: "text", text: "ESCALATE: authority: edit is required" }], stop_reason: "end_turn", usage: { cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } });
  }
  expect(provider.captures).toHaveLength(0);
  expect(front.requests[0]!.served).toBe("scripted");
  expect(front.pendingReplies).toBe(0);
  expect(front.frontErrors).toEqual([]);
});

it.each([false, true])("scripts a real write-tool payload followed by a completion turn (stream=%s)", async stream => {
  const directory = await mkdtemp(join(ROOT, "tmp-cpx-provider-"));
  scratch.push(directory);
  const filePath = join(directory, "proof.txt");
  const content = "CPX_WRITE_DONE\nUnicode: λ\n";
  const { provider, front, url } = await start({}, "v2");
  front.writeNext(filePath, content).replyNext({ text: "DONE: proof.txt written" });
  const response = await post(url, { ...ask, stream, tools: [{ name: "write" }] });
  expect(response.status).toBe(200);
  const wire = await response.text();
  let tool: Record<string, unknown>;
  if (stream) {
    const data = events(wire).map(event => obj(JSON.parse(event.split("\n")[1]!.slice("data: ".length))));
    const block = obj(data.find(event => event.type === "content_block_start")!.content_block);
    expect(block).toMatchObject({ type: "tool_use", name: "write", input: {} });
    const delta = obj(data.find(event => event.type === "content_block_delta")!.delta);
    expect(delta.type).toBe("input_json_delta");
    tool = { ...block, input: JSON.parse(String(delta.partial_json)) };
    expect(obj(data.find(event => event.type === "message_delta")!.delta).stop_reason).toBe("tool_use");
    expect(data.at(-1)!.type).toBe("message_stop");
  } else {
    const message = JSON.parse(wire) as { content: Record<string, unknown>[]; stop_reason: string };
    expect(message.stop_reason).toBe("tool_use");
    tool = message.content[0]!;
  }
  expect(tool).toMatchObject({ type: "tool_use", name: "write", input: { path: filePath, content } });
  // Emulate only the host's write tool: the provider must not create files itself or bypass guards.
  await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  const input = obj(tool.input);
  await writeFile(String(input.path), String(input.content), "utf8");
  expect(await readFile(filePath, "utf8")).toBe(content);
  const followUp = await post(url, { ...ask, messages: [
    ...ask.messages,
    { role: "assistant", content: [tool] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "File written" }] },
  ] });
  expect(await followUp.json()).toMatchObject({ content: [{ type: "text", text: "DONE: proof.txt written" }], stop_reason: "end_turn" });
  expect(front.pendingReplies).toBe(0);
  expect(provider.captures).toHaveLength(0);
  expect(front.frontErrors).toEqual([]);
});

it.each([false, true])("emits structured QA findings and an empty passing report accepted by the executor (stream=%s)", async stream => {
  const { front, url } = await start({}, "v2");
  const report: FindingsReport = { findings: [
    { id: "QA-1", severity: "blocking", files: ["src/proof.ts"], problem: "Missing proof", fix: "Write the proof" },
    { id: "QA-2", severity: "minor", files: [], problem: "Clarify wording", fix: "" },
  ] };
  front.findingsNext(report).findingsNext({ findings: [] });
  for (const expected of [report, { findings: [] }]) {
    const response = await post(url, { ...ask, stream });
    expect(response.status).toBe(200);
    const wire = await response.text();
    let text: string;
    if (stream) {
      const data = events(wire).map(event => obj(JSON.parse(event.split("\n")[1]!.slice("data: ".length))));
      const delta = obj(data.find(event => event.type === "content_block_delta")!.delta);
      expect(delta.type).toBe("text_delta");
      text = String(delta.text);
      expect(obj(data.find(event => event.type === "message_delta")!.delta).stop_reason).toBe("end_turn");
    } else {
      const message = JSON.parse(wire) as { content: { type: string; text: string }[]; stop_reason: string };
      expect(message.content[0]!.type).toBe("text");
      expect(message.stop_reason).toBe("end_turn");
      text = message.content[0]!.text;
    }
    expect(parseFindings(text)).toEqual({ ok: true, report: expected });
    expect(JSON.parse(text)).toEqual(expected);
  }
  expect(front.pendingReplies).toBe(0);
});

it("rejects invalid scripted reply counts, empty write paths/escalations and malformed findings before queueing", () => {
  const front = new CpxFront();
  for (const times of [0, -1, 1.5, NaN, -Infinity]) {
    expect(() => front.replyNext({ text: "ok" }, { times })).toThrow("Reply times");
  }
  expect(() => front.writeNext("  ", "text")).toThrow("Write path");
  expect(() => front.escalateNext("\n ")).toThrow("reason");
  const invalid: FindingsReport = { findings: [{ id: "invalid id", severity: "major", files: ["proof.ts"], problem: "Missing proof", fix: "" }] };
  expect(() => front.findingsNext(invalid)).toThrow("FINDINGS_FORMAT");
  const extra = { findings: [], extra: true };
  expect(() => front.findingsNext(extra)).toThrow("FINDINGS_FORMAT");
  expect(front.pendingReplies).toBe(0);
});

it("matches scripted turns by predicate/count, preserves them across faults, and falls back to the fixture", async () => {
  const { provider, front, url } = await start({}, "v2");
  const options = { times: 2, when: (r: { headers: Record<string, unknown> }) => r.headers["x-proof-session"] === "ses_scripted" };
  front.escalateNext("authority", options);
  expect((await post(url)).status).toBe(200);
  expect(front.pendingReplies).toBe(2);
  front.failNext("rate-limit");
  expect((await post(url, ask, { "x-proof-session": "ses_scripted" })).status).toBe(429);
  expect(front.pendingReplies).toBe(2);
  for (let i = 0; i < 2; i++) {
    expect(await (await post(url, ask, { "x-proof-session": "ses_scripted" })).json()).toMatchObject({ content: [{ text: "ESCALATE: authority" }] });
  }
  expect(front.pendingReplies).toBe(0);
  expect(await (await post(url)).json()).toMatchObject({ content: [{ text: "ok" }] });
  expect(provider.captures).toHaveLength(2);
  expect(front.requests.map(r => r.served)).toEqual(["forwarded", "rate-limit", "scripted", "scripted", "forwarded"]);
  front.replyNext({ text: "repeat" }, { times: Infinity });
  for (let i = 0; i < 2; i++) expect(await (await post(url)).json()).toMatchObject({ content: [{ text: "repeat" }] });
  expect(front.pendingReplies).toBe(1);
  front.clearReplies();
  expect(front.pendingReplies).toBe(0);
  expect(await (await post(url)).json()).toMatchObject({ content: [{ text: "ok" }] });
});

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
  const { front, url } = await start({ delayMs: 200 });
  const began = Date.now();
  expect((await post(url)).status).toBe(200);
  expect(Date.now() - began).toBeGreaterThanOrEqual(150);
  await until("the measured duration", () => front.requests[0]!.durationMs !== undefined);
  expect(front.requests[0]!.durationMs).toBeGreaterThanOrEqual(150);
});

it("applies a delay before a fault too", async () => {
  const asked: number[] = [];
  const { front, url } = await start({ delayMs: 9, sleep: async ms => { asked.push(ms); } });
  front.failNext("overloaded");
  expect((await post(url)).status).toBe(529);
  expect(asked).toEqual([9]);
});

it("records each forwarded and faulted call's duration, including its scripted delay", async () => {
  let now = 100;
  const { front, url } = await start({
    now: () => now,
    delayMs: r => r.index === 0 ? 25 : 70,
    sleep: async ms => { now += ms; },
  });
  expect((await post(url)).status).toBe(200);
  front.failNext("overloaded");
  expect((await post(url)).status).toBe(529);
  await until("completed request durations", () => front.requests.every(r => r.durationMs !== undefined));
  expect(front.requests.map(r => r.durationMs)).toEqual([25, 70]);
});

it("leaves the duration absent while a call is in flight", async () => {
  let now = 0;
  let release: (() => void) | undefined;
  const { front, url } = await start({ now: () => now, delayMs: 20, sleep: () => new Promise<void>(resolve => { release = resolve; }) });
  const pending = post(url);
  await until("the delay to begin", () => release !== undefined);
  expect(front.requests[0]!.durationMs).toBeUndefined();
  now = 20;
  release!();
  await (await pending).text();
  await until("the duration to be recorded", () => front.requests[0]!.durationMs !== undefined);
  expect(front.requests[0]!.durationMs).toBe(20);
});

it("measures overlapping calls independently instead of recording a provider-wide duration", async () => {
  let now = 0;
  const release: (() => void)[] = [];
  const { front, url } = await start({ now: () => now, delayMs: 1, sleep: () => new Promise<void>(resolve => release.push(resolve)) });
  front.failWhen(r => r.index === 1, "overloaded");
  const first = post(url);
  await until("the first request's delay", () => release.length === 1);
  now = 5;
  const second = post(url);
  await until("both requests' delays", () => release.length === 2);
  now = 10;
  release[0]!();
  await (await first).text();
  await until("the first call's duration", () => front.requests[0]!.durationMs !== undefined);
  expect(front.requests[1]!.durationMs).toBeUndefined();
  now = 40;
  release[1]!();
  expect((await second).status).toBe(529);
  await until("the second call's duration", () => front.requests[1]!.durationMs !== undefined);
  expect(front.requests.map(r => r.durationMs)).toEqual([10, 35]);
});

it("records a cancelled call's duration when its connection closes during the delay", async () => {
  let now = 0;
  let release: (() => void) | undefined;
  const { provider, front, url } = await start({ now: () => now, delayMs: 30, sleep: () => new Promise<void>(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const pending = fetch(url, { method: "POST", body: JSON.stringify(ask), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await until("the cancelled call's delay", () => release !== undefined);
  now = 12;
  controller.abort();
  await rejected;
  await until("the closed connection's duration", () => front.requests[0]!.durationMs !== undefined);
  expect(front.requests[0]!.durationMs).toBe(12);
  release!();
  await tick();
  expect(provider.captures).toHaveLength(0);
  expect(front.requests[0]!.served).toBeUndefined();
  expect(front.frontErrors).toEqual([]);
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
  await until("the failed call's duration", () => front.requests[0]!.durationMs !== undefined);
  expect(front.requests[0]!.durationMs).toBeGreaterThanOrEqual(0);
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
