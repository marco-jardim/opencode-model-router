/**
 * #161: the bound of the OpenCode v2 host's session reads, shared by the v2 adapter (compat/v2-hooks.ts) and the legacy plugin
 * surface it bridges (index.ts, on the v2 host only). A leaf module: OpenCode v1 loads it with index.ts and never uses it.
 */

/**
 * #161: how long the shared session record (`sessionInfoOf`: the directory, parent and agent the role checks, the file leases and
 * the stale-resume check read) waits for the host's `session.get`; past it the lookup counts as failed. Long on purpose, above
 * background.ts's 5 s LOOKUP_TIMEOUT_MS: a miss refuses a role agent's call, so a slow but healthy host must not cause one.
 */
export const SESSION_INFO_LOOKUP_MS = 10_000;

/** #161: `lookup`'s answer, or a rejection once `ms` pass without one (the host call itself is left running). */
export function sessionLookupWithin<T>(lookup: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`session lookup timed out after ${ms} ms`)), ms);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}
