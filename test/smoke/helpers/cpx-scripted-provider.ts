/** Critical-Path Execution (Phase 0.1) extension of the keyless Anthropic fixtures.
 *
 * `scripted-provider.ts` is v1-frozen (scenario `6-v1-untouched` pins it byte-identical), so it is not edited: {@link CpxFront}
 * is a FRONT http server (fetch-safe port) that sits in front of ANY fixture (the host harness's `RoutingProvider` or a
 * `ScriptedProvider`), and {@link CpxScriptedProvider} is `ScriptedProvider` + such a front. Per request the front
 *  1. captures the request (method, url, headers without credentials, parsed JSON body) in {@link CpxScriptedProvider.requests};
 *  2. waits the configured per-request delay;
 *  3. answers a queued fault (429 rate limit, 529 overloaded, usage limit with a reset time) instead of forwarding, or
 *  4. forwards method/path/body to the inner provider and streams the answer back, optionally
 *  5. rewriting the Anthropic `usage` object with `cache_read_input_tokens` / `cache_creation_input_tokens` (non-stream JSON
 *     body and the SSE `message_start` event's `message.usage`; every other byte of the stream is left unchanged).
 * With no options and no queued fault the front is a transparent pass-through. `start()` returns the FRONT base URL, same shape as
 * `ScriptedProvider` (`http://127.0.0.1:<port>/v1`), so `RoutingHost` can use either.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { listenOnFetchSafePort } from "./fetch-safe-port";
import { ScriptedProvider, type HostVersion } from "./scripted-provider";

/** Fault shapes the front can answer instead of forwarding (all are Anthropic error envelopes `{type:"error",error:{type,message}}`). */
export type FaultKind = "rate-limit" | "overloaded" | "usage-limit" | "invalid-request";
/** `usage-limit` answer variants (QA-0.1-7: which feature makes the host classify a 429 as a quota error is not known, so each is probed alone):
 *  - `reset-sentence` (default): "Usage limit reached. Your limit will reset at <ISO>." + retry-after + requests/tokens/unified reset headers;
 *  - `header-only`: body "Usage limit reached." (no reset sentence), the `anthropic-ratelimit-unified-reset` header only (no retry-after);
 *  - `alt-wording`: body "You have reached your usage limit" (no reset sentence), same headers as the default;
 *  - `retry-after-only`: body "Usage limit reached.", a `retry-after` header only;
 *  - `no-usage-wording`: CONTROL, a 429 `rate_limit_error` with the default's headers but a per-minute rate-limit text. */
export type UsageLimitVariant = "reset-sentence" | "header-only" | "alt-wording" | "retry-after-only" | "no-usage-wording";
/** Cache token counters added to the Anthropic `usage` object. */
export interface CacheUsage { read: number; creation: number }
/** One request seen by the front. `headers` never contain `authorization`, `x-api-key` or `proxy-authorization`. */
export interface CpxRequest {
  /** 0-based arrival order across the provider's lifetime. */
  index: number;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body; the raw text when it is not JSON; `undefined` when empty. */
  body: unknown;
  /** How the request was answered; `undefined` while it is still in flight. */
  served?: "forwarded" | FaultKind;
}
/** Options of a queued fault. */
export interface FaultOptions {
  /** How many matching requests fail before the queue entry is exhausted (default 1; `Infinity` never exhausts). */
  times?: number;
  /** `rate-limit`: value of the `retry-after` header in seconds (default 1). `usage-limit` derives it from `resetAt`. */
  retryAfterSeconds?: number;
  /** `usage-limit` (and the `anthropic-ratelimit-*-reset` headers): when the limit resets (default: one hour after the answer). */
  resetAt?: Date | string;
  /** `usage-limit` only: which answer shape (default `reset-sentence`, the original). */
  variant?: UsageLimitVariant;
  /** Only requests for which this returns true consume and receive the fault (default: every request). */
  when?: (request: CpxRequest) => boolean;
}
/** Behaviour switches of the front; every one is optional and unset means "transparent". */
export interface CpxProviderOptions {
  /** Milliseconds to wait before answering each request: a constant or a function of the captured request. */
  delayMs?: number | ((request: CpxRequest) => number);
  /** Cache counters to add to the `usage` of every 200 answer: a constant or a per-request function (`undefined` = leave unchanged). */
  cacheUsage?: CacheUsage | ((request: CpxRequest) => CacheUsage | undefined);
  /** Waiter used for `delayMs` (default: a real timer). Inject a controlled one to test without wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}
interface QueuedFault { kind: FaultKind; remaining: number; options: FaultOptions }
export interface FaultAnswer { status: number; headers: OutgoingHttpHeaders; body: string }

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization"]);
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);
const iso = (value: Date | string | undefined, fallback: number): string => {
  const date = value === undefined ? new Date(fallback) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid resetAt: ${String(value)}`);
  return date.toISOString();
};

/** Builds the exact HTTP answer of a fault. Pure: `now` is injected so the shapes are testable.
 *
 * - `rate-limit`: 429, `retry-after: <seconds>`, `anthropic-ratelimit-requests-remaining: 0`, `anthropic-ratelimit-requests-reset: <ISO>`;
 *   body `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}`.
 * - `overloaded`: 529, no `retry-after`; body `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
 * - `usage-limit`: 429, `retry-after: <seconds until reset, >= 1>`, `anthropic-ratelimit-requests-reset`, `anthropic-ratelimit-tokens-reset`
 *   and `anthropic-ratelimit-unified-reset` all `<ISO reset time>`, `anthropic-ratelimit-*-remaining: 0`; body
 *   `{"type":"error","error":{"type":"rate_limit_error","message":"Usage limit reached. Your limit will reset at <ISO reset time>."}}`.
 *   `options.variant` selects other shapes (see {@link UsageLimitVariant}).
 * - `invalid-request`: 400, no `retry-after`; body `{"type":"error","error":{"type":"invalid_request_error","message":"cpx scripted invalid request"}}`.
 *   A NON-retryable failure answered by the front itself (never forwarded), so the fixture behind it records no error of its own.
 */
export function faultAnswer(kind: FaultKind, options: FaultOptions = {}, now = Date.now()): FaultAnswer {
  const headers: OutgoingHttpHeaders = { "content-type": "application/json", "request-id": `req_cpx_${kind}` };
  const envelope = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });
  if (kind === "invalid-request") return { status: 400, headers, body: envelope("invalid_request_error", "cpx scripted invalid request") };
  if (kind === "overloaded") return { status: 529, headers, body: envelope("overloaded_error", "Overloaded") };
  if (kind === "rate-limit") {
    const seconds = options.retryAfterSeconds ?? 1;
    headers["retry-after"] = String(seconds);
    headers["anthropic-ratelimit-requests-remaining"] = "0";
    headers["anthropic-ratelimit-requests-reset"] = iso(options.resetAt, now + seconds * 1000);
    return { status: 429, headers, body: envelope("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit") };
  }
  const reset = iso(options.resetAt, now + 3_600_000);
  const variant = options.variant ?? "reset-sentence";
  const retryAfter = String(Math.max(1, Math.ceil((Date.parse(reset) - now) / 1000)));
  if (variant === "header-only") {
    // Same short body as "retry-after-only"; the ONLY reset signal is the unified-reset header.
    headers["anthropic-ratelimit-unified-reset"] = reset;
    return { status: 429, headers, body: envelope("rate_limit_error", "Usage limit reached.") };
  }
  if (variant === "retry-after-only") {
    headers["retry-after"] = retryAfter;
    return { status: 429, headers, body: envelope("rate_limit_error", "Usage limit reached.") };
  }
  headers["retry-after"] = retryAfter;
  for (const name of ["requests", "tokens"]) {
    headers[`anthropic-ratelimit-${name}-remaining`] = "0";
    headers[`anthropic-ratelimit-${name}-reset`] = reset;
  }
  headers["anthropic-ratelimit-unified-reset"] = reset;
  if (variant === "alt-wording") return { status: 429, headers, body: envelope("rate_limit_error", "You have reached your usage limit") };
  // Control: every header of the default answer, but a plain per-minute rate-limit text (no usage wording, no reset time in the body).
  if (variant === "no-usage-wording") return { status: 429, headers, body: envelope("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit") };
  return { status: 429, headers, body: envelope("rate_limit_error", `Usage limit reached. Your limit will reset at ${reset}.`) };
}

/** Adds cache counters to the `usage` object of a non-stream message body; any other JSON is returned as is. */
export function withCacheUsageJson(text: string, cache: CacheUsage): string {
  const message: Record<string, unknown> = JSON.parse(text);
  const usage = message.usage !== null && typeof message.usage === "object" ? message.usage : {};
  return JSON.stringify({ ...message, usage: { ...usage, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.creation } });
}
/** Rewrites only the `data:` line of the SSE `message_start` event (`message.usage` gets the cache counters); all other bytes stay. */
export function withCacheUsageSse(text: string, cache: CacheUsage): string {
  return text.replace(/^(event: message_start\r?\ndata: )(.*)$/m, (_whole, prefix: string, data: string) => {
    const event: { message?: { usage?: Record<string, unknown> } } = JSON.parse(data);
    if (!event.message) return `${prefix}${data}`;
    event.message.usage = { ...event.message.usage, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.creation };
    return `${prefix}${JSON.stringify(event)}`;
  });
}

/** The front proxy itself, independent of the fixture behind it: `RoutingHost` puts one in front of its own `RoutingProvider`
 * (whose request log, grader queue and barriers the smoke scenarios keep using unchanged), {@link CpxScriptedProvider} in front of
 * the `ScriptedProvider` it extends. */
export class CpxFront {
  /** Every request that reached the front, in arrival order (credentials stripped). */
  readonly requests: CpxRequest[] = [];
  /** Front-side failures (the inner provider unreachable, a bad `delayMs`...), as text. Inner fixture errors stay with the fixture. */
  readonly frontErrors: string[] = [];
  private faults: QueuedFault[] = [];
  private innerPort = 0;
  private readonly server = createServer((req, res) => { void this.handle(req, res); });

  /** `options` is read on every request, so a test may reassign or mutate it between requests. */
  constructor(public options: CpxProviderOptions = {}) {}

  /** Starts the front in front of the fixture at `innerBaseUrl`; resolves to the FRONT base URL (`http://127.0.0.1:<port>/v1`). */
  async start(innerBaseUrl: string): Promise<string> {
    this.innerPort = Number(new URL(innerBaseUrl).port);
    const port = await listenOnFetchSafePort(this.server);
    return `http://127.0.0.1:${port}/v1`;
  }

  /** Closes the front (open connections included). The fixture behind it is NOT stopped. */
  async stop(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }

  /** Queues a fault for the next `times` (default 1) matching requests. Entries are consulted in queue order. */
  failNext(kind: FaultKind, options: FaultOptions = {}): this {
    this.faults.push({ kind, remaining: options.times ?? 1, options });
    return this;
  }
  /** Like {@link failNext}, matching by predicate. */
  failWhen(when: (request: CpxRequest) => boolean, kind: FaultKind, options: Omit<FaultOptions, "when"> = {}): this { return this.failNext(kind, { ...options, when }); }
  /** Drops every queued fault. */
  clearFaults(): void { this.faults = []; }
  /** Number of faults still to be served (finite entries only; an `Infinity` entry counts as 1). */
  get pendingFaults(): number { return this.faults.reduce((n, f) => n + (Number.isFinite(f.remaining) ? f.remaining : 1), 0); }

  private takeFault(request: CpxRequest): QueuedFault | undefined {
    const fault = this.faults.find(f => f.remaining > 0 && (f.options.when?.(request) ?? true));
    if (fault) fault.remaining -= 1;
    this.faults = this.faults.filter(f => f.remaining > 0);
    return fault;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const text = raw.toString();
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = text; } // a non-JSON body is captured verbatim
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name)));
      const request: CpxRequest = { index: this.requests.length, method: req.method ?? "GET", url: req.url ?? "/", headers, body };
      this.requests.push(request);
      const wait = typeof this.options.delayMs === "function" ? this.options.delayMs(request) : this.options.delayMs ?? 0;
      if (wait > 0) await (this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(wait);
      if (res.destroyed) return; // stop() closed the connection during the delay
      const fault = this.takeFault(request);
      if (fault) {
        const answer = faultAnswer(fault.kind, fault.options);
        request.served = fault.kind;
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body);
        return;
      }
      request.served = "forwarded";
      const cache = typeof this.options.cacheUsage === "function" ? this.options.cacheUsage(request) : this.options.cacheUsage;
      await this.forward(req, res, raw, cache);
    } catch (error) {
      this.frontErrors.push(String(error));
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "cpx front error" } }));
    }
  }

  private forward(req: IncomingMessage, res: ServerResponse, body: Buffer, cache: CacheUsage | undefined): Promise<void> {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)));
    return new Promise<void>((resolve, reject) => {
      const upstream = httpRequest({ host: "127.0.0.1", port: this.innerPort, method: req.method, path: req.url, headers: { ...headers, "content-length": String(body.length) } }, answer => {
        const type = String(answer.headers["content-type"] ?? "");
        const rewrite = cache !== undefined && answer.statusCode === 200 && (type.includes("application/json") || type.includes("text/event-stream"));
        const out: OutgoingHttpHeaders = { ...answer.headers };
        delete out.connection; // hop-by-hop: the front manages its own connection
        delete out["keep-alive"];
        if (!rewrite) {
          res.writeHead(answer.statusCode ?? 502, out);
          answer.pipe(res);
          answer.once("end", resolve);
          answer.once("error", reject);
          return;
        }
        const parts: Buffer[] = [];
        answer.on("data", (part: Buffer) => parts.push(part));
        answer.once("error", reject);
        answer.once("end", () => {
          try {
            const text = Buffer.concat(parts).toString();
            const rewritten = type.includes("text/event-stream") ? withCacheUsageSse(text, cache) : withCacheUsageJson(text, cache);
            delete out["transfer-encoding"];
            out["content-length"] = String(Buffer.byteLength(rewritten));
            res.writeHead(200, out);
            res.end(rewritten);
            resolve();
          } catch (error) { reject(error); }
        });
      });
      upstream.once("error", reject);
      upstream.end(body);
    });
  }
}

/** `ScriptedProvider` + a {@link CpxFront}: `start()` returns the FRONT base URL, `stop()` closes the front, then the fixture.
 * Queue faults and read captures through {@link CpxScriptedProvider.front} (`provider.front.failNext(...)`, `provider.front.requests`). */
export class CpxScriptedProvider extends ScriptedProvider {
  /** The front proxy; its `options` (delay, cache usage) may be changed between requests. */
  readonly front: CpxFront;

  constructor(host: HostVersion, options: CpxProviderOptions = {}) { super(host); this.front = new CpxFront(options); }

  /** Starts the inner fixture, then the front; resolves to the FRONT base URL (`http://127.0.0.1:<port>/v1`). */
  override async start(): Promise<string> { return this.front.start(await super.start()); }

  /** Closes the front (open connections included), then the inner fixture. */
  override async stop(): Promise<void> {
    await this.front.stop();
    await super.stop();
  }
}
