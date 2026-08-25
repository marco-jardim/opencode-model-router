import { describe, it, expect, vi, afterEach } from "vitest";
import { createPluginLogger, LOG_SERVICE } from "../../src/router/logger";

type LogReq = {
  body: {
    service: string;
    level: string;
    message: string;
    extra?: Record<string, unknown>;
  };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPluginLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the opencode log with a service tag and level", () => {
    const log = vi.fn(() => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("something drifted");
    expect(log).toHaveBeenCalledWith({
      body: { service: LOG_SERVICE, level: "warn", message: "something drifted" },
    });
  });

  it("passes structured extra through when given", () => {
    const log = vi.fn((_req: LogReq) => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("m", { pattern: "opus-4-8" });
    expect(log.mock.calls[0]![0].body.extra).toEqual({ pattern: "opus-4-8" });
  });

  it("omits extra entirely rather than sending an empty object", () => {
    const log = vi.fn((_req: LogReq) => Promise.resolve());
    createPluginLogger({ app: { log } }).warn("m");
    expect(log.mock.calls[0]![0].body).not.toHaveProperty("extra");
  });

  // The whole point: nothing reaches stderr, because stderr paints over the TUI.
  it("does not touch the console on the happy path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({ app: { log: () => Promise.resolve() } }).warn("m");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the console when the client cannot log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const client of [undefined, {}, { app: {} }, { app: { log: 42 } }]) {
      createPluginLogger(client).warn("m");
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  // A diagnostic that cannot be delivered is still a diagnostic worth seeing.
  it("falls back when the post rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({ app: { log: () => Promise.reject(new Error("down")) } }).warn("m");
    await flush();
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  it("falls back when the call throws synchronously", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createPluginLogger({
      app: { log: () => { throw new Error("boom"); } },
    }).warn("m");
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  // Fire-and-forget: a hook must never block on a warning, and a slow or
  // rejected post must never surface as an unhandled rejection.
  it("returns without awaiting the post", () => {
    let settled = false;
    const log = () => new Promise((r) => setTimeout(() => { settled = true; r(undefined); }, 20));
    createPluginLogger({ app: { log } }).warn("m");
    expect(settled).toBe(false);
  });

  it("tolerates a non-promise return", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => createPluginLogger({ app: { log: () => undefined } }).warn("m")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  // The real `client.app` is a class instance (`App extends _HeyApiClient`)
  // whose methods read `this._client`. A plain-object stub cannot catch a lost
  // receiver, because it never touches `this` — so mirror the SDK's shape. With
  // a detached `const log = client.app.log`, this throws and silently degrades
  // to the console fallback on every real install.
  it("keeps the receiver bound, as the class-based SDK client requires", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const posted: LogReq[] = [];
    class FakeApp {
      _client = { post: (req: LogReq) => posted.push(req) };
      log(req: LogReq) {
        this._client.post(req);
        return Promise.resolve({ data: {}, error: undefined });
      }
    }
    createPluginLogger({ app: new FakeApp() }).warn("m");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.message).toBe("m");
    expect(warn).not.toHaveBeenCalled();
  });

  // App.log defaults to ThrowOnError = false, so a 400 RESOLVES as
  // `{ data: undefined, error }` rather than rejecting. A bare .catch() sees
  // nothing, and the diagnostic would be lost — which is the one thing the
  // fallback exists to prevent.
  it("falls back when the post resolves reporting an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = () =>
      Promise.resolve({ data: undefined, error: { message: "bad request" } });
    createPluginLogger({ app: { log } }).warn("m");
    await flush();
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  it("stays quiet when the post resolves cleanly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = () => Promise.resolve({ data: {}, error: undefined });
    createPluginLogger({ app: { log } }).warn("m");
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // flush(): the counterpart to fire-and-forget. A short-lived process
  // (`opencode run`, `opencode debug`) exits before a post settles, so the
  // warning is lost without a failure anyone can see. `dispose` awaits this.
  //
  // Note: the module-level `flush` helper above is the "let microtasks/timers
  // run" tick, NOT the logger method. The method is always called as
  // `logger.flush()` below.
  // -------------------------------------------------------------------------

  it("flush() resolves only after an in-flight post settles", async () => {
    let settled = false;
    const log = () =>
      new Promise((r) =>
        setTimeout(() => {
          settled = true;
          r({ data: {}, error: undefined });
        }, 20),
      );
    const logger = createPluginLogger({ app: { log } });
    logger.warn("m");
    // warn is still fire-and-forget: it returned before the post finished.
    expect(settled).toBe(false);
    await logger.flush();
    expect(settled).toBe(true);
  });

  it("flush() on the console-fallback logger resolves without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createPluginLogger({});
    logger.warn("m");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  // A failing flush must not be the thing that breaks teardown.
  it("flush() does not reject when the post rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createPluginLogger({
      app: { log: () => Promise.reject(new Error("down")) },
    });
    logger.warn("m");
    await expect(logger.flush()).resolves.toBeUndefined();
    // the diagnostic still went somewhere
    expect(warn).toHaveBeenCalledWith(`[${LOG_SERVICE}] m`);
  });

  it("flush() with nothing in flight resolves immediately", async () => {
    const log = vi.fn(() => Promise.resolve({ data: {}, error: undefined }));
    const logger = createPluginLogger({ app: { log } });
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  // Entries remove themselves once settled, so the set stays bounded on a
  // long-lived server. A second flush must neither hang on a stale entry nor
  // re-run the fallback for a post that already reported.
  it("flush() drains the tracked set, so a second flush is a no-op", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createPluginLogger({
      app: { log: () => Promise.resolve({ data: undefined, error: { message: "bad" } }) },
    });
    logger.warn("m");
    await logger.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
