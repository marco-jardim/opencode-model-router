/**
 * Where the plugin's passive warnings go.
 *
 * `console.warn` from a plugin lands on the server process's stderr, which the
 * TUI does not own, so anything written there paints over whatever the terminal
 * was drawing. A user reported exactly that: a preset switch smeared a
 * ~230-character warning across two lines of UI.
 *
 * opencode exposes `POST /log` for this, reachable as `client.app.log`. Entries
 * go to opencode's own log with a service tag instead of into the terminal.
 *
 * Fail-soft by contract. The call is fire-and-forget: a warning is never worth
 * blocking a hook on, and a logging failure must never surface as a plugin
 * error. When the endpoint is unavailable, when the post rejects, and when it
 * resolves reporting an error, the message falls back to console.warn so a
 * diagnostic is never silently dropped.
 *
 * Two properties of the real SDK client shape this file, and getting either
 * wrong degrades the feature silently rather than loudly:
 *
 *  1. `client.app` is a class instance (`App extends _HeyApiClient`) whose
 *     methods read `this._client`. Detaching the method — `const log =
 *     client.app.log` — leaves `this` undefined under ESM strict mode, so every
 *     call throws and every warning quietly takes the console fallback. The
 *     method is therefore always invoked with its receiver bound.
 *  2. `App.log` defaults to `ThrowOnError = false`, so an HTTP failure RESOLVES
 *     as `{ data: undefined, error }` instead of rejecting. A bare `.catch()`
 *     sees nothing on a 400, so the settled value is inspected as well.
 *  3. Fire-and-forget loses the message outright when the process is about to
 *     exit: the post never settles, and the fallback never runs because nothing
 *     failed. A long-lived server never notices; `opencode run` and `opencode
 *     debug` are short-lived and would go silent, which is strictly worse than
 *     the stderr write this file exists to avoid. Hence `flush()`, awaited from
 *     the plugin's `dispose` hook. Verified against a live opencode 1.18.16:
 *     `dispose` is both called and awaited on `opencode debug agent`.
 *
 * One thing to know before debugging this: the `service` tag is a namespace,
 * not a rendered field. Entries land as
 * `timestamp=... level=WARN run=... message="..." <extra keys>` with no
 * `service=` anywhere, so grepping opencode's log for `service=model-router`
 * finds nothing even when the entry is there. Match on the message text.
 */

export interface PluginLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
  /**
   * Await every post still in flight, so a shutting-down process does not drop
   * warnings it already decided to emit. Never rejects: a failing flush must
   * not be the thing that breaks teardown.
   */
  flush(): Promise<void>;
}

/** The service tag on every entry, so entries are greppable by origin. */
export const LOG_SERVICE = "model-router";

/** Prefix used only on the console fallback, where there is no service field. */
const CONSOLE_PREFIX = `[${LOG_SERVICE}]`;

type LogRequest = {
  body: {
    service: string;
    level: "debug" | "info" | "error" | "warn";
    message: string;
    extra?: Record<string, unknown>;
  };
};

/**
 * Structural view of the one method we use. Deliberately narrow: the plugin
 * must keep working against a bare stub (every unit test hands it one) and
 * against an older server with no `/log` at all, so the capability is probed at
 * runtime rather than demanded by the type.
 */
type LogCapableClient = {
  app?: {
    log?: (req: LogRequest) => unknown;
  };
};

/**
 * The SDK resolves rather than rejects on an HTTP failure, reporting it as a
 * populated `error` field on the settled value. Treat that as a failed post.
 */
function isErrorResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    (value as { error?: unknown }).error !== undefined
  );
}

/**
 * Build a logger over an opencode client. Falls back to the console when the
 * client cannot log, which covers older servers and every unit test that hands
 * the plugin a stub.
 */
export function createPluginLogger(client?: unknown): PluginLogger {
  const app = (client as LogCapableClient | undefined)?.app;
  const log = app?.log;

  if (!app || typeof log !== "function") {
    return {
      warn(message) {
        console.warn(`${CONSOLE_PREFIX} ${message}`);
      },
      // console.warn is synchronous, so there is never anything to wait for.
      flush: () => Promise.resolve(),
    };
  }

  // Posts still in flight. Entries remove themselves once settled, so this
  // stays bounded on a long-lived server rather than growing for its lifetime.
  const inFlight = new Set<Promise<void>>();

  return {
    warn(message, extra) {
      const toConsole = () => console.warn(`${CONSOLE_PREFIX} ${message}`);
      let result: unknown;
      try {
        // Bound to `app` on purpose — see (1) in the module comment. Calling
        // the detached reference would throw on every real client.
        result = log.call(app, {
          body: {
            service: LOG_SERVICE,
            level: "warn",
            message,
            ...(extra ? { extra } : {}),
          },
        });
      } catch {
        // A synchronous throw means the transport is unusable; say it somewhere.
        toConsole();
        return;
      }
      // Fire-and-forget: never await, but never leave a rejection unhandled
      // either, and do not lose the diagnostic when the post fails — whether it
      // fails by rejecting or by resolving with an error. See (2) above.
      const settled: Promise<void> = Promise.resolve(result)
        .then((value) => {
          if (isErrorResult(value)) toConsole();
        })
        .catch(toConsole);
      // Tracked so `flush` can wait for it. `settled` already absorbs its own
      // failures, so nothing here can reject. See (3) above.
      inFlight.add(settled);
      void settled.finally(() => {
        inFlight.delete(settled);
      });
    },
    async flush() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
