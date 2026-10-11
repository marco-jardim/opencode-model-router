/**
 * cpx-probe-plugin: a minimal native OpenCode v2 server plugin for the host-contract smoke. TEST-ONLY: it is loaded through
 * `HostOptions.extraPlugins`, AFTER the router, and must never ship. Same module shape as the harness's embedded PROBE_PLUGIN
 * (test/smoke/helpers/routing-host.ts): a default export `{ id, setup(ctx) }`. When loaded by path the harness wraps it the
 * way it wraps PROBE_PLUGIN (a directory with package.json `exports: { ".": "./server.mjs", "./server": "./server.mjs" }`).
 *
 * Environment
 *   CPX_PROBE_OUT          path of the JSONL log (append, one object per line: { t: Date.now(), kind, ...fields }).
 *                          Unset: nothing is recorded and no mode mutates anything.
 *   CPX_PROBE_MODE         at most one mutation mode (unset / empty: observe only). An unknown value records a "probe-error"
 *                          line and the probe observes only.
 *   CPX_PROBE_RELAUNCH_MS  retained-launch only: launch a second batch of children (same count) this many ms after the first.
 *   CPX_PROBE_RETAINED_COUNT retained-launch only, optional: children per batch, an integer 1..32 (default 3, anything else: 3).
 *   CPX_PROBE_CHILD_PROMPT retained-launch only, optional: prompt of the launched children, `{n}` replaced by the child number
 *                          (1..CPX_PROBE_RETAINED_COUNT). Unset: "CPX_RETAINED_CHILD <n>". Lets a harness script a tool call in the children's own turn.
 *   CPX_PROBE_CHILD_AGENT / CPX_PROBE_CHILD_MODEL  retained-launch only, optional: agent id and `model` argument (e.g. "provider/id#variant")
 *                          of the launched `subagent` calls. Unset: the probe's own agent pick (general) and no `model` key.
 *   CPX_PROBE_USE_RETAINED_SIGNAL  retained-launch only: "1" passes the retained context's own `signal` to the launches instead of the probe's
 *                          300 s controller (default: the probe's controller; `progress` is always replaced by a recorder).
 *                          The "retained-launch-batch" line records `signalReplaced`, `retainedSignalAbortedAtLaunch`.
 *   CPX_PROBE_MOVE_DIR     retained-launch only, optional: absolute directory (must exist). The recording `progress` of each launched child then waits 2 s and
 *                          moves the child session there with ctx.session.move (QA-0.1-19; lines retained-progress-called / -move / -resolved).
 *   CPX_PROBE_TOOL_URL     retained-launch only, optional: file URL of a module exporting `tool` (from @opencode-ai/plugin),
 *                          used to build the input schema of `cpx_probe_capture` when the bare specifier does not resolve.
 *
 * Always observed (recorded): events session.created / session.execution.* / session.step.failed; execute.before and
 * execute.after of subagent, file tools, search tools, router_run and cpx_probe_capture; every session "context" hook call;
 * every session "compaction" hook call (SessionHooks.compaction, @opencode/plugin dist/promise/session.d.ts:132; whether the
 * host accepts the registration is recorded once as "compaction-hook-available").
 *
 * Modes (each performs only its own mutation)
 *   rewrite-completion     context hook: a message whose content holds a subagent completion envelope
 *                          (<subagent sessionID="..." state="..."> ... </subagent>) gets that text replaced by
 *                          "held \u2014 verdict pending (probe)" in the REQUEST's messages array (element replaced, never edited in place).
 *   append-tail-system     context hook: push a LAST message { role: "system" } holding "CPX_TAIL_MARKER <request counter>".
 *   append-tail-user       same with role "user".
 *   append-tail-newest     context hook: add the marker as a new text part to the newest existing message.
 *   cache-hint-1h          context hook: set `cache: { type: "ephemeral", ttlSeconds: 3600 }` (the plugin API's CacheHint, @opencode/ai
 *                          schema/messages.d.ts + options.d.ts; the key is created) on the LAST system part; what was set is recorded.
 *   cache-hint-1h-message  same CacheHint on the last text part of the last real message.
 *   cache-hint-1h-all      QA-0.1-17: the same CacheHint on the FIRST and the LAST system part, the LAST tool of `e.tools` (the typed tool object has no `cache`
 *                          field; the key is created anyway and what the host did with it is the observation) and the last text part of the last real message.
 *                          One "cache-hint-1h-all" line records per target { did, ... }.
 *   append-tail-user+hint-last-real  append-tail-user, and BEFORE the tail a manual `cache: { type: "ephemeral" }` on the last text part of
 *                          the last real message (records "cache-hint-last-real").
 *   mutate-subagent-prompt execute.before of subagent: append " CPX_MUTATED" to the prompt.
 *   filter-grep            execute.after of grep / glob: drop result lines containing CPX_LEASED, append "[cpx: 1 hidden]".
 *   rewrite-compaction     compaction hook: CPX_HELD_ORIGINAL -> CPX_HELD_PLACEHOLDER in the messages / system parts.
 *   rewrite-completion+compaction  both of the above at once: the context hook rewrites completion envelopes as in rewrite-completion, and the
 *                          compaction hook rewrites CPX_HELD_ORIGINAL as in rewrite-compaction AND replaces any text holding a subagent
 *                          completion envelope with the same placeholder (recorded in "rewrite-compaction" as `completionReplacements`).
 *   retry-observe          registers session.hook("retry") (SessionRetry: error, attempt, mutable decision); records every call as "retry-hook"
 *                          (error type / status / message, attempt, the keys of the event and of the decision, the decision as received). Mutates nothing.
 *   retry-stop             retry-observe, and sets `e.decision = { retry: false }` on every call (records "retry-stop" with the decision read back).
 *   plugin-session-api     registers tool cpx_probe_session_api (optional arg `interruptSessionID`). The call is only recorded ("session-api-armed");
 *                          when that session's execution ends (the parent is idle), the PLUGIN-side session API is exercised on it:
 *                          ctx.session.context({ sessionID }), ctx.session.interrupt({ sessionID: interruptSessionID }) when given, then
 *                          ctx.session.synthetic({ sessionID, text: "CPX_PLUGIN_SYNTHETIC wake", description, metadata, resume: true }).
 *                          Every input and result (or error) is recorded as "session-api-call".
 *   retained-launch        registers tool cpx_probe_capture (no args, returns "captured") that retains its tool context; when the
 *                          turn that called it ends, starts CPX_PROBE_RETAINED_COUNT (default THREE) concurrent native `subagent` children with that retained context
 *                          (the way src/compat/v2-client.ts does), and again after CPX_PROBE_RELAUNCH_MS if set.
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const MODES = new Set([
  "rewrite-completion", "append-tail-system", "append-tail-user", "append-tail-newest", "cache-hint-1h", "cache-hint-1h-message", "cache-hint-1h-all", "append-tail-user+hint-last-real",
  "mutate-subagent-prompt", "filter-grep", "rewrite-compaction", "retained-launch",
  "rewrite-completion+compaction", "retry-observe", "retry-stop", "plugin-session-api",
]);
const OBSERVED_TOOLS = new Set([
  "subagent", "read", "write", "edit", "multiedit", "patch", "apply_patch", "glob", "grep", "list", "router_run", "cpx_probe_capture", "cpx_probe_session_api",
]);
const PICKED_ARGS = ["path", "filePath", "pattern", "cwd", "directory", "background", "agent", "subagent_type", "description", "script", "sessionID"];
const PLACEHOLDER = "held \u2014 verdict pending (probe)";
const COMPLETION = /<subagent\s+sessionID=/;
const HIDDEN_NOTE = "[cpx: 1 hidden]";
/** retained-launch with CPX_PROBE_MOVE_DIR: how long the recording `progress` blocks (a timer inside the probe; the experiment, not a harness sleep). */
const PROGRESS_DELAY_MS = 2000;

const outPath = process.env.CPX_PROBE_OUT;
let logFailures = 0;

const cut = (value, n) => (typeof value === "string" ? value.slice(0, n) : value);
const bigintSafe = (_key, value) => (typeof value === "bigint" ? String(value) : value);

/** Appends one JSON line; never throws (a failed write is counted, a failed serialisation is written as a probe-error). */
function rec(kind, fields) {
  if (!outPath) return;
  let line;
  try {
    line = JSON.stringify({ t: Date.now(), kind, ...fields }, bigintSafe);
  } catch (error) {
    line = JSON.stringify({ t: Date.now(), kind: "probe-error", where: "serialize", for: kind, error: String(error) });
  }
  try {
    appendFileSync(outPath, line + "\n");
  } catch (error) {
    logFailures += 1;
    if (logFailures === 1) process.stderr.write(`[cpx-probe] log write failed: ${String(error)}\n`);
  }
}

/** Wraps a hook body: a failure is recorded as "probe-error" and swallowed, so the probe never breaks the host turn. */
const guard = (where, body) => async (event) => {
  try {
    return await body(event);
  } catch (error) {
    rec("probe-error", { where, error: String(error), stack: cut(error && error.stack, 600) });
    return undefined;
  }
};

/** JSON text of `value` cut to `n` characters; a failed serialisation is returned as text. */
function jsonCut(value, n) {
  try {
    return cut(JSON.stringify(value, bigintSafe), n);
  } catch (error) {
    return `unserializable: ${String(error)}`;
  }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function deepStrings(value, acc = [], depth = 0, limit = 20) {
  if (acc.length >= limit || depth > 8 || value === null || value === undefined) return acc;
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const item of value) deepStrings(item, acc, depth + 1, limit);
  else if (typeof value === "object") for (const key of Object.keys(value)) deepStrings(value[key], acc, depth + 1, limit);
  return acc;
}

/** Returns [value, replacements]: strings are mapped with `fn(string) -> string | undefined`; containers are copied only when changed. */
function mapStrings(value, fn, depth = 0) {
  if (typeof value === "string") {
    const next = fn(value);
    return next === undefined || next === value ? [value, 0] : [next, 1];
  }
  if (depth > 8 || value === null || typeof value !== "object") return [value, 0];
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map((item) => {
      const [next, n] = mapStrings(item, fn, depth + 1);
      count += n;
      return next;
    });
    return count ? [items, count] : [value, 0];
  }
  let count = 0;
  const changes = {};
  for (const key of Object.keys(value)) {
    const [next, n] = mapStrings(value[key], fn, depth + 1);
    if (n) {
      changes[key] = next;
      count += n;
    }
  }
  return count ? [Object.assign(Object.create(Object.getPrototypeOf(value)), value, changes), count] : [value, 0];
}

const partsOf = (message) => {
  const content = message && message.content;
  if (Array.isArray(content)) return content;
  return content === undefined || content === null ? [] : [content];
};
const textOf = (part) => (typeof part === "string" ? part : part && part.type === "text" && typeof part.text === "string" ? part.text : undefined);

function summarizeMessage(message) {
  const parts = partsOf(message);
  return {
    id: message && message.id,
    role: message && message.role,
    partCount: parts.length,
    texts: parts.map(textOf).filter((text) => text !== undefined).map((text) => cut(text, 200)),
    other: parts.filter((part) => textOf(part) === undefined).map((part) => ({ type: part && part.type, snippet: cut(deepStrings(part, [], 0, 1)[0], 200) })),
  };
}

function systemInfo(system) {
  const parts = Array.isArray(system) ? system : [];
  const joined = parts.map((part) => (typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : "")).join("");
  return { hasSystem: parts.length > 0 && joined.length > 0, systemParts: parts.length, systemLength: joined.length, systemSha256: joined.length ? sha256(joined) : undefined };
}

function describeInput(input) {
  if (input === null || typeof input !== "object") return { inputType: typeof input };
  const picked = {};
  for (const key of PICKED_ARGS) if (key in input) picked[key] = typeof input[key] === "string" ? cut(input[key], 300) : input[key];
  if (Array.isArray(input.args)) picked.args = input.args.map((item) => cut(String(item), 100));
  if (typeof input.prompt === "string") picked.prompt = cut(input.prompt, 200);
  return { argKeys: Object.keys(input), args: picked };
}

function describeResult(result) {
  if (result === null || result === undefined) return { resultType: String(result) };
  if (typeof result === "string") return { resultKeys: [], text: cut(result, 300) };
  const content = result.content;
  const contentText = typeof content === "string" ? content
    : Array.isArray(content) ? content.map(textOf).filter((text) => text !== undefined).join("\n") : undefined;
  const output = result.output;
  const outputText = typeof output === "string" ? output : output && typeof output === "object" && typeof output.output === "string" ? output.output : undefined;
  const structured = output && typeof output === "object" ? output : {};
  return {
    resultKeys: Object.keys(result),
    contentText: cut(contentText, 300),
    outputText: cut(outputText, 300),
    resultStatus: structured.status,
    resultSessionID: structured.sessionID,
  };
}

/** Copy of `message` whose LAST text part carries `cache: hint` (the key is created); undefined when it has no array of parts with a text part. */
function withLastTextCache(message, hint) {
  if (!message || !Array.isArray(message.content)) return undefined;
  let partIndex = -1;
  message.content.forEach((part, i) => { if (part && typeof part === "object" && part.type === "text") partIndex = i; });
  if (partIndex < 0) return undefined;
  const content = message.content.map((part, i) => (i === partIndex ? { ...part, cache: hint } : part));
  return { message: Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content }), partIndex };
}

const scalars = (data) => {
  const picked = {};
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) picked[key] = cut(value, 500);
    }
  }
  return picked;
};
const errorFields = (data) => {
  if (!data || typeof data !== "object") return {};
  let error;
  try {
    error = data.error === undefined ? undefined : cut(JSON.stringify(data.error, bigintSafe), 1000);
  } catch (failure) {
    error = `unserializable: ${String(failure)}`;
  }
  return { error };
};

const loadTool = async () => {
  const candidates = [process.env.CPX_PROBE_TOOL_URL, "@opencode-ai/plugin/tool", "@opencode-ai/plugin"].filter(Boolean);
  const failures = [];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      const found = mod.tool ?? (mod.default && mod.default.tool);
      if (found && found.schema) return { tool: found, from: specifier };
      failures.push(`${specifier}: no tool.schema export`);
    } catch (error) {
      failures.push(`${specifier}: ${String(error)}`);
    }
  }
  return { failures };
};

export default {
  id: "cpx-probe",
  async setup(ctx) {
    const rawMode = process.env.CPX_PROBE_MODE;
    let mode = rawMode && rawMode.length > 0 ? rawMode : undefined;
    if (mode !== undefined && !MODES.has(mode)) {
      rec("probe-error", { where: "mode", error: "unknown CPX_PROBE_MODE", mode, known: [...MODES] });
      mode = undefined;
    }
    const relaunchMs = Number(process.env.CPX_PROBE_RELAUNCH_MS);
    rec("loaded", { mode: mode ?? null, outSet: Boolean(outPath), relaunchMs: Number.isFinite(relaunchMs) && relaunchMs > 0 ? relaunchMs : null, pid: process.pid });

    let requestNo = 0;
    let shapeRecorded = false;

    // ---- tool hooks ------------------------------------------------------------------------------------------------
    await ctx.tool.hook("execute.before", guard("execute.before", (e) => {
      if (!OBSERVED_TOOLS.has(e.tool)) return;
      const base = { tool: e.tool, callID: e.id, sessionID: e.sessionID, agent: e.agent, messageID: e.messageID };
      if (mode === "mutate-subagent-prompt" && e.tool === "subagent" && e.input && typeof e.input.prompt === "string") {
        const original = e.input.prompt;
        const mutated = `${original} CPX_MUTATED`;
        rec("execute.before", { ...base, ...describeInput(e.input) });
        e.input = { ...e.input, prompt: mutated };
        rec("mutate-subagent-prompt", { ...base, original: cut(original, 500), mutated: cut(mutated, 500) });
        return;
      }
      rec("execute.before", { ...base, ...describeInput(e.input) });
    }));

    await ctx.tool.hook("execute.after", guard("execute.after", (e) => {
      if (!OBSERVED_TOOLS.has(e.tool)) return;
      const base = { tool: e.tool, callID: e.id, sessionID: e.sessionID, agent: e.agent, messageID: e.messageID, status: e.status };
      const shape = e.status === "completed" ? describeResult(e.result) : { error: cut(String(e.error && e.error.message ? e.error.message : e.error), 300) };
      rec("execute.after", { ...base, ...describeInput(e.input), ...shape });
      if (mode !== "filter-grep" || (e.tool !== "grep" && e.tool !== "glob") || e.status !== "completed") return;
      let removed = 0;
      let sawLeasedFull = false; // the leased token in the FULL pre-filter text (the execute.after line above only keeps a 300-character preview)
      const filter = (text) => {
        if (text.includes("CPX_LEASED")) sawLeasedFull = true;
        const lines = text.split("\n");
        const kept = lines.filter((line) => !line.includes("CPX_LEASED"));
        if (kept.length === lines.length) return undefined;
        removed += lines.length - kept.length;
        return `${kept.join("\n")}\n${HIDDEN_NOTE}`;
      };
      const result = e.result;
      const [content, contentCount] = mapStrings(result && result.content, filter);
      const outputIsString = typeof (result && result.output) === "string";
      const outputIsObject = result && result.output && typeof result.output === "object" && typeof result.output.output === "string";
      const [output, outputCount] = outputIsString || outputIsObject ? mapStrings(result.output, filter) : [undefined, 0];
      if (contentCount + outputCount === 0) {
        rec("filter-grep", { ...base, mutable: null, removedLines: 0, sawLeasedFull, note: "no CPX_LEASED line in the result" });
        return;
      }
      const next = { ...result };
      if (contentCount) next.content = content;
      if (outputCount) next.output = output;
      let mutable = true;
      let failure;
      try {
        e.result = next;
      } catch (error) {
        mutable = false;
        failure = String(error);
      }
      rec("filter-grep", { ...base, mutable: mutable && e.result === next, removedLines: removed, sawLeasedFull, error: failure });
    }));

    // ---- session context hook --------------------------------------------------------------------------------------
    await ctx.session.hook("context", guard("context", (e) => {
      requestNo += 1;
      const messages = Array.isArray(e.messages) ? e.messages : [];
      rec("context", {
        sessionID: e.sessionID, agent: e.agent, requestNo,
        model: e.model && `${e.model.providerID}/${e.model.id}`,
        messageCount: messages.length, messages: messages.map(summarizeMessage), ...systemInfo(e.system),
      });
      if (!shapeRecorded) {
        shapeRecorded = true;
        const systemFirst = Array.isArray(e.system) ? e.system[0] : undefined;
        const lastMessage = messages[messages.length - 1];
        rec("context-shape", {
          sessionID: e.sessionID,
          eventKeys: Object.keys(e),
          systemPartKeys: systemFirst && typeof systemFirst === "object" ? Object.keys(systemFirst) : null,
          messageKeys: lastMessage && typeof lastMessage === "object" ? Object.keys(lastMessage) : null,
          partKeys: partsOf(lastMessage).map((part) => (part && typeof part === "object" ? Object.keys(part) : typeof part)),
          optionKeys: e.options && typeof e.options === "object" ? Object.keys(e.options) : null,
        });
      }
      const marker = `CPX_TAIL_MARKER ${requestNo}`;
      const base = { sessionID: e.sessionID, mode, requestNo };
      if (mode === "rewrite-completion" || mode === "rewrite-completion+compaction") {
        const replaced = [];
        for (let i = 0; i < messages.length; i += 1) {
          const [next, count] = mapStrings(messages[i], (text) => (COMPLETION.test(text) ? PLACEHOLDER : undefined));
          if (count === 0) continue;
          e.messages[i] = next;
          replaced.push({ index: i, id: messages[i] && messages[i].id, role: messages[i] && messages[i].role, count, original: cut(deepStrings(messages[i]).find((text) => COMPLETION.test(text)), 300) });
        }
        rec("rewrite-completion", { ...base, did: replaced.length > 0, replaced });
      } else if (mode === "append-tail-system" || mode === "append-tail-user" || mode === "append-tail-user+hint-last-real") {
        const role = mode === "append-tail-system" ? "system" : "user";
        if (mode === "append-tail-user+hint-last-real") {
          // O8: a MANUAL breakpoint on the last REAL message (before the tail is added).
          const index = messages.length - 1;
          const hint = { type: "ephemeral" };
          const hinted = withLastTextCache(messages[index], hint);
          if (hinted) e.messages[index] = hinted.message;
          rec("cache-hint-last-real", { ...base, did: Boolean(hinted), index, id: messages[index] && messages[index].id, role: messages[index] && messages[index].role, partIndex: hinted ? hinted.partIndex : null, set: hint });
        }
        e.messages.push({ role, content: [{ type: "text", text: marker }] });
        rec(mode, { ...base, role, marker, messageCountAfter: e.messages.length });
      } else if (mode === "append-tail-newest") {
        const index = messages.length - 1;
        const newest = messages[index];
        if (!newest || !Array.isArray(newest.content)) {
          rec("append-tail-newest", { ...base, did: false, reason: "no newest message with an array of parts" });
        } else {
          e.messages[index] = Object.assign(Object.create(Object.getPrototypeOf(newest)), newest, { content: [...newest.content, { type: "text", text: marker }] });
          rec("append-tail-newest", { ...base, did: true, marker, index, id: newest.id, role: newest.role, partCountAfter: newest.content.length + 1 });
        }
      } else if (mode === "cache-hint-1h") {
        // The plugin API's own lever: `SystemPart.cache` / `TextPart.cache` = CacheHint { type: "ephemeral" | "persistent", ttlSeconds? } (@opencode/ai
        // schema/messages.d.ts, options.d.ts); the Anthropic protocol maps ttlSeconds >= 3600 to `ttl: "1h"`. The key is CREATED when the part has none.
        const system = Array.isArray(e.system) ? e.system : [];
        const index = system.length - 1;
        const part = system[index];
        if (!part || typeof part !== "object") {
          rec("cache-hint-1h", { ...base, did: false, reason: "no system part" });
        } else {
          const hint = { type: "ephemeral", ttlSeconds: 3600 };
          e.system = [...system.slice(0, index), { ...part, cache: hint }, ...system.slice(index + 1)];
          rec("cache-hint-1h", { ...base, did: true, via: "system part field `cache` (created)", target: `system[${index}]`, set: hint, hadCacheKey: "cache" in part, partKeys: Object.keys(part), systemParts: system.length });
        }
      } else if (mode === "cache-hint-1h-message") {
        const index = messages.length - 1;
        const hint = { type: "ephemeral", ttlSeconds: 3600 };
        const hinted = withLastTextCache(messages[index], hint);
        if (hinted) e.messages[index] = hinted.message;
        rec("cache-hint-1h-message", { ...base, did: Boolean(hinted), via: "text part field `cache` (created) on the last text part of the last real message", index, id: messages[index] && messages[index].id, role: messages[index] && messages[index].role, partIndex: hinted ? hinted.partIndex : null, set: hint, messageCount: messages.length });
      } else if (mode === "cache-hint-1h-all") {
        // QA-0.1-17: D5's all-1h layout. The provider wants longer TTLs before shorter ones in the prefix order tools -> system -> messages, while the host
        // keeps 5-minute markers on the last tool and the first system part. So every breakpoint the plugin API can reach is set to 1 h: the FIRST and the
        // LAST system part, the LAST tool and the last text part of the last real message. Each target records what was set, so the harness can compare
        // it with the wire. `SessionContext.tools` is `Record<name, { description, input }>` (@opencode/plugin dist/promise/session.d.ts:31): the typed
        // tool object has NO cache field, so the probe still tries to create one (an unknown key) and records whether it reached the wire.
        const hint = { type: "ephemeral", ttlSeconds: 3600 };
        const targets = {};
        const system = Array.isArray(e.system) ? e.system : [];
        if (system.length === 0 || !system.every((part) => part && typeof part === "object")) {
          targets.systemFirst = { did: false, reason: "no (object) system parts" };
          targets.systemLast = { did: false, reason: "no (object) system parts" };
        } else {
          const lastIndex = system.length - 1;
          e.system = system.map((part, i) => (i === 0 || i === lastIndex ? { ...part, cache: hint } : part));
          targets.systemFirst = { did: true, target: "system[0]", hadCacheKey: "cache" in system[0], partKeys: Object.keys(system[0]) };
          targets.systemLast = { did: true, target: `system[${lastIndex}]`, hadCacheKey: "cache" in system[lastIndex], partKeys: Object.keys(system[lastIndex]), sameAsFirst: lastIndex === 0 };
        }
        const toolNames = e.tools && typeof e.tools === "object" ? Object.keys(e.tools) : [];
        if (toolNames.length === 0) {
          targets.toolLast = { did: false, reason: "the context event carries no tools", toolsType: typeof e.tools };
        } else {
          const name = toolNames[toolNames.length - 1];
          const tool = e.tools[name];
          let failure;
          try {
            e.tools = { ...e.tools, [name]: { ...tool, cache: hint } };
          } catch (error) {
            failure = String(error);
          }
          const back = e.tools && e.tools[name];
          targets.toolLast = {
            did: failure === undefined && Boolean(back) && typeof back === "object" && "cache" in back, tool: name, toolIndex: toolNames.length - 1, toolCount: toolNames.length,
            toolKeys: tool && typeof tool === "object" ? Object.keys(tool) : null, hadCacheKey: Boolean(tool) && typeof tool === "object" && "cache" in tool,
            via: "tool object field `cache` (an unknown key, created)", error: failure,
          };
        }
        const index = messages.length - 1;
        const hinted = withLastTextCache(messages[index], hint);
        if (hinted) e.messages[index] = hinted.message;
        targets.messageLast = { did: Boolean(hinted), index, id: messages[index] && messages[index].id, role: messages[index] && messages[index].role, partIndex: hinted ? hinted.partIndex : null };
        rec("cache-hint-1h-all", { ...base, set: hint, targets, did: Object.values(targets).every((t) => t.did === true), messageCount: messages.length, systemParts: system.length });
      }
    }));

    // ---- compaction hook (feature-detected by registering it) ------------------------------------------------------
    let compactionAvailable = false;
    let compactionReason;
    try {
      await ctx.session.hook("compaction", guard("compaction", (e) => {
        const messages = Array.isArray(e.messages) ? e.messages : [];
        rec("compaction", {
          sessionID: e.sessionID, agent: e.agent, messageCount: messages.length, messages: messages.map(summarizeMessage), ...systemInfo(e.system),
          hasResult: e.result !== undefined,
        });
        if (mode !== "rewrite-compaction" && mode !== "rewrite-completion+compaction") return;
        const swap = (text) => (text.includes("CPX_HELD_ORIGINAL") ? text.split("CPX_HELD_ORIGINAL").join("CPX_HELD_PLACEHOLDER") : undefined);
        const swapCompletion = (text) => (COMPLETION.test(text) ? PLACEHOLDER : undefined);
        const combined = mode === "rewrite-completion+compaction";
        let replacements = 0;
        let completionReplacements = 0;
        for (let i = 0; i < messages.length; i += 1) {
          const [next, count] = mapStrings(messages[i], swap);
          if (count) {
            e.messages[i] = next;
            replacements += count;
          }
          if (combined) {
            const [rewritten, n] = mapStrings(e.messages[i], swapCompletion);
            if (n) {
              e.messages[i] = rewritten;
              completionReplacements += n;
            }
          }
        }
        if (Array.isArray(e.system)) {
          const system = e.system.map((part) => {
            const [next, count] = mapStrings(part, swap);
            replacements += count;
            return next;
          });
          e.system = system;
        }
        rec("rewrite-compaction", { sessionID: e.sessionID, mode, did: replacements + completionReplacements > 0, replacements, completionReplacements });
      }));
      compactionAvailable = true;
    } catch (error) {
      compactionReason = String(error);
    }
    rec("compaction-hook-available", { "compaction-hook-available": compactionAvailable, reason: compactionReason });

    // ---- retained-launch -------------------------------------------------------------------------------------------
    const retained = new Map(); // parent sessionID -> the tool context of cpx_probe_capture
    const launched = new Set(); // parent sessionIDs whose first batch was started
    let batchNo = 0;

    const pickAgent = async () => {
      try {
        const list = (await ctx.agent.list()).data ?? [];
        const idOf = (agent) => agent.id ?? agent.name;
        const ids = list.map(idOf);
        const sub = list.find((agent) => agent.mode === "subagent");
        return { agent: ids.includes("general") ? "general" : sub ? idOf(sub) : "general", available: ids };
      } catch (error) {
        return { agent: "general", available: [], error: String(error) };
      }
    };

    const requestedCount = Number(process.env.CPX_PROBE_RETAINED_COUNT);
    const retainedCount = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 32 ? requestedCount : 3;
    const childAgent = process.env.CPX_PROBE_CHILD_AGENT || undefined;
    const childModel = process.env.CPX_PROBE_CHILD_MODEL || undefined;
    const useRetainedSignal = process.env.CPX_PROBE_USE_RETAINED_SIGNAL === "1";
    const moveDir = process.env.CPX_PROBE_MOVE_DIR || undefined;
    const childPromptTemplate = process.env.CPX_PROBE_CHILD_PROMPT;
    const childPrompt = (n) => (childPromptTemplate && childPromptTemplate.length > 0 ? childPromptTemplate.split("{n}").join(String(n)) : `CPX_RETAINED_CHILD ${n}`);

    const launchBatch = async (parentID, context, label) => {
      batchNo += 1;
      const batch = batchNo;
      const chosen = await pickAgent();
      let native;
      try {
        native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
      } catch (error) {
        rec("retained-launch-error", { batch, label, parentID, error: `tool.list failed: ${String(error)}` });
        return;
      }
      if (!native) {
        rec("retained-launch-error", { batch, label, parentID, error: "native subagent tool not found in ctx.tool.list()" });
        return;
      }
      const agent = childAgent ?? chosen.agent;
      rec("retained-launch-batch", {
        batch, label, parentID, agent, requestedAgent: childAgent ?? null, requestedModel: childModel ?? null, agents: chosen.available, agentError: chosen.error, contextKeys: Object.keys(context),
        // What the probe changes in the retained context for its launches: `signal` (own controller unless CPX_PROBE_USE_RETAINED_SIGNAL=1) and `progress` (records only).
        signalReplaced: !(useRetainedSignal && Boolean(context.signal)), progressReplaced: true, retainedSignalType: typeof context.signal,
        retainedSignalAbortedAtLaunch: context.signal && typeof context.signal.aborted === "boolean" ? context.signal.aborted : null,
      });
      await Promise.allSettled(Array.from({ length: retainedCount }, (_, i) => i + 1).map(async (n) => {
        const id = `${batch}.${n}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        timer.unref();
        let childID;
        rec("retained-launch-attempt", { batch, n, id, label, parentID, agent: childAgent ?? chosen.agent, description: `cpx-retained-${n}`, prompt: cut(childPrompt(n), 300) });
        try {
          const result = await native.execute(
            { agent: childAgent ?? chosen.agent, ...(childModel ? { model: childModel } : {}), description: `cpx-retained-${n}`, prompt: childPrompt(n), background: false },
            {
              ...context,
              signal: useRetainedSignal && context.signal ? context.signal : controller.signal,
              // The parent's call has ended, so the host would reject a progress update on its context: it is not forwarded, only recorded.
              // QA-0.1-19 (launcher A binding timing): the router's runner binds and moves the child inside its `onCreated` (src/compat/v2-client.ts), which
              // assumes the host AWAITS `progress` before it prompts the child. With CPX_PROBE_MOVE_DIR set, the FIRST progress call that carries the child
              // id therefore (1) records "retained-progress-called", (2) waits PROGRESS_DELAY_MS on a timer (the experiment itself: if the host does not
              // await `progress`, the child's first context hook fires inside this window), (3) moves the child with ctx.session.move({ sessionID, directory })
              // ("retained-progress-move": input, result or error, and the session's directory read back), (4) records "retained-progress-resolved" and
              // returns. The harness compares resolved-time with the child's first "context" line and checks where the child's relative `read` resolved.
              async progress(metadata) {
                const sessionID = metadata && metadata.sessionID;
                if (typeof sessionID === "string" && sessionID !== childID) {
                  childID = sessionID;
                  rec("retained-launch-child", { batch, n, id, parentID, childSessionID: sessionID });
                  rec("retained-progress-called", { batch, n, id, parentID, childSessionID: sessionID, moveDir: moveDir ?? null, delayMs: moveDir ? PROGRESS_DELAY_MS : 0, metadataKeys: Object.keys(metadata) });
                  if (moveDir) {
                    await new Promise((resolve) => setTimeout(resolve, PROGRESS_DELAY_MS));
                    const input = { sessionID, directory: moveDir };
                    try {
                      const moved = await ctx.session.move(input);
                      let directoryAfter;
                      let getError;
                      try {
                        const got = await ctx.session.get({ sessionID });
                        const session = got && typeof got === "object" && "data" in got ? got.data : got;
                        directoryAfter = session && typeof session === "object" ? session.directory : undefined;
                      } catch (error) {
                        getError = String(error);
                      }
                      rec("retained-progress-move", { batch, n, id, childSessionID: sessionID, input, status: "ok", result: jsonCut(moved, 500), directoryAfter, getError });
                    } catch (error) {
                      rec("retained-progress-move", { batch, n, id, childSessionID: sessionID, input, status: "error", error: String(error) });
                    }
                  }
                  rec("retained-progress-resolved", { batch, n, id, parentID, childSessionID: sessionID });
                }
              },
            },
          );
          const output = result && result.output && typeof result.output === "object" ? result.output : {};
          rec("retained-launch-result", {
            batch, n, id, parentID, ok: true, childSessionID: output.sessionID ?? childID, seenInProgress: childID,
            status: output.status, output: cut(typeof output.output === "string" ? output.output : undefined, 300), ...describeResult(result),
          });
        } catch (error) {
          rec("retained-launch-result", { batch, n, id, parentID, ok: false, childSessionID: childID, error: String(error), name: error && error.name });
        } finally {
          clearTimeout(timer);
        }
      }));
    };

    const startRetainedLaunch = (parentID) => {
      const context = retained.get(parentID);
      if (!context || launched.has(parentID)) return;
      launched.add(parentID);
      void launchBatch(parentID, context, "first").catch((error) => rec("probe-error", { where: "launchBatch", error: String(error) }));
      if (Number.isFinite(relaunchMs) && relaunchMs > 0) {
        const timer = setTimeout(() => {
          void launchBatch(parentID, context, "relaunch").catch((error) => rec("probe-error", { where: "relaunchBatch", error: String(error) }));
        }, relaunchMs);
        timer.unref();
      }
    };

    if (mode === "retained-launch") {
      const loaded = await loadTool();
      if (!loaded.tool) {
        rec("probe-error", { where: "retained-launch", error: "cannot build the tool input schema; cpx_probe_capture not registered", failures: loaded.failures });
      } else {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "cpx_probe_capture",
            description: "Test probe: records and retains the tool context of this call. Takes no arguments and returns \"captured\".",
            input: loaded.tool.schema.object({}),
            options: { codemode: false },
            execute: async (_args, context) => {
              retained.set(context.sessionID, context);
              rec("retained-capture", { sessionID: context.sessionID, messageID: context.messageID, agent: context.agent, contextKeys: Object.keys(context) });
              return { content: "captured" };
            },
          });
        });
        rec("retained-tool-registered", { from: loaded.from });
      }
    }

    // ---- retry hook (retry-observe / retry-stop) -------------------------------------------------------------------
    if (mode === "retry-observe" || mode === "retry-stop") {
      let retryRegistered = false;
      let retryReason;
      try {
        // SessionRetry (@opencode/plugin dist/promise/session.d.ts): readonly sessionID/agent/model/error/attempt + mutable `decision: { retry: false } | { retry: true, delay }`.
        await ctx.session.hook("retry", guard("retry", (e) => {
          const received = e.decision && typeof e.decision === "object" ? { ...e.decision } : e.decision;
          const error = e.error && typeof e.error === "object" ? e.error : {};
          rec("retry-hook", {
            sessionID: e.sessionID, agent: e.agent, attempt: e.attempt, model: e.model && `${e.model.providerID}/${e.model.id}`,
            errorType: error.type, errorStatus: error.status, errorMessage: cut(error.message, 300), errorKeys: Object.keys(error), error: jsonCut(e.error, 800),
            eventKeys: Object.keys(e), decisionKeys: received && typeof received === "object" ? Object.keys(received) : null, decisionReceived: received,
          });
          if (mode !== "retry-stop") return;
          let failure;
          try {
            e.decision = { retry: false };
          } catch (assignError) {
            failure = String(assignError);
          }
          rec("retry-stop", { sessionID: e.sessionID, attempt: e.attempt, assigned: failure === undefined, error: failure, decisionAfter: e.decision && typeof e.decision === "object" ? { ...e.decision } : e.decision });
        }));
        retryRegistered = true;
      } catch (error) {
        retryReason = String(error);
      }
      rec("retry-hook-available", { available: retryRegistered, reason: retryReason });
    }

    // ---- plugin-side session API (plugin-session-api) ------------------------------------------------------------------
    const apiPending = new Map(); // sessionID of the cpx_probe_session_api call -> { interruptSessionID }
    const apiDone = new Set();
    const apiCall = async (name, input) => {
      const fn = ctx.session && ctx.session[name];
      if (typeof fn !== "function") {
        rec("session-api-call", { name, input, status: "absent" });
        return undefined;
      }
      try {
        const result = await fn.call(ctx.session, input);
        rec("session-api-call", { name, input, status: "ok", resultKind: Array.isArray(result) ? "array" : typeof result, resultLength: Array.isArray(result) ? result.length : null, result: jsonCut(result, 1500) });
        return result;
      } catch (error) {
        rec("session-api-call", { name, input, status: "error", error: String(error) });
        return undefined;
      }
    };
    const runSessionApi = async (sessionID) => {
      const armed = apiPending.get(sessionID);
      if (!armed || apiDone.has(sessionID)) return;
      apiDone.add(sessionID);
      apiPending.delete(sessionID);
      rec("session-api-start", { sessionID, sessionMethods: Object.keys(ctx.session ?? {}), interruptSessionID: armed.interruptSessionID ?? null });
      const messages = await apiCall("context", { sessionID });
      if (Array.isArray(messages)) rec("session-api-context", { sessionID, count: messages.length, types: messages.map((m) => (m && (m.type ?? m.role))) });
      if (armed.interruptSessionID) await apiCall("interrupt", { sessionID: armed.interruptSessionID });
      await apiCall("synthetic", {
        sessionID, text: "CPX_PLUGIN_SYNTHETIC wake", description: "cpx plugin-side synthetic", metadata: { source: "cpx-probe", resume: true }, resume: true,
      });
    };

    if (mode === "plugin-session-api") {
      const loaded = await loadTool();
      if (!loaded.tool) {
        rec("probe-error", { where: "plugin-session-api", error: "cannot build the tool input schema; cpx_probe_session_api not registered", failures: loaded.failures });
      } else {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "cpx_probe_session_api",
            description: "Test probe: when this session's turn has ended, calls the plugin-side session API on it. Optional interruptSessionID names a session to interrupt.",
            input: loaded.tool.schema.object({ interruptSessionID: loaded.tool.schema.string().optional() }),
            options: { codemode: false },
            execute: async (args, context) => {
              const interruptSessionID = args && typeof args.interruptSessionID === "string" && args.interruptSessionID.length > 0 ? args.interruptSessionID : undefined;
              apiPending.set(context.sessionID, { interruptSessionID });
              rec("session-api-armed", { sessionID: context.sessionID, interruptSessionID: interruptSessionID ?? null });
              return { content: "armed" };
            },
          });
        });
        rec("session-api-tool-registered", { from: loaded.from });
      }
    }

    // ---- event stream ----------------------------------------------------------------------------------------------
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({})) {
          try {
            const type = event && event.type;
            if (typeof type !== "string") continue;
            const data = event.data && typeof event.data === "object" ? event.data : {};
            const watched = type === "session.created" || type.startsWith("session.execution.") || type === "session.step.failed";
            if (watched) {
              rec(type, {
                eventID: event.id, sessionID: data.sessionID, parentID: data.parentID, agent: data.agent, title: cut(data.title, 200),
                data: scalars(data), ...errorFields(data),
              });
            }
            if (mode === "plugin-session-api" && ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)
              && typeof data.sessionID === "string") {
              void runSessionApi(data.sessionID).catch((error) => rec("probe-error", { where: "runSessionApi", error: String(error) }));
            }
            if (mode === "retained-launch" && ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)
              && typeof data.sessionID === "string") {
              startRetainedLaunch(data.sessionID);
            }
          } catch (error) {
            rec("probe-error", { where: "event", error: String(error) });
          }
        }
      } catch (error) {
        rec("probe-error", { where: "event-subscription", error: String(error) });
      }
    })();
  },
};
