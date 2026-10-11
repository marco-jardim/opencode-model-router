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
 *   cache-hint-1h          context hook: try a 1-hour cache hint on the last system part (a cache field present on the part), else
 *                          as a provider option of the request (session.d.ts:20-21); what was set is recorded.
 *   mutate-subagent-prompt execute.before of subagent: append " CPX_MUTATED" to the prompt.
 *   filter-grep            execute.after of grep / glob: drop result lines containing CPX_LEASED, append "[cpx: 1 hidden]".
 *   rewrite-compaction     compaction hook: CPX_HELD_ORIGINAL -> CPX_HELD_PLACEHOLDER in the messages / system parts.
 *   retained-launch        registers tool cpx_probe_capture (no args, returns "captured") that retains its tool context; when the
 *                          turn that called it ends, starts CPX_PROBE_RETAINED_COUNT (default THREE) concurrent native `subagent` children with that retained context
 *                          (the way src/compat/v2-client.ts does), and again after CPX_PROBE_RELAUNCH_MS if set.
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const MODES = new Set([
  "rewrite-completion", "append-tail-system", "append-tail-user", "append-tail-newest", "cache-hint-1h",
  "mutate-subagent-prompt", "filter-grep", "rewrite-compaction", "retained-launch",
]);
const OBSERVED_TOOLS = new Set([
  "subagent", "read", "write", "edit", "multiedit", "patch", "apply_patch", "glob", "grep", "list", "router_run", "cpx_probe_capture",
]);
const PICKED_ARGS = ["path", "filePath", "pattern", "cwd", "directory", "background", "agent", "subagent_type", "description", "script", "sessionID"];
const PLACEHOLDER = "held \u2014 verdict pending (probe)";
const COMPLETION = /<subagent\s+sessionID=/;
const HIDDEN_NOTE = "[cpx: 1 hidden]";

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
      if (mode === "rewrite-completion") {
        const replaced = [];
        for (let i = 0; i < messages.length; i += 1) {
          const [next, count] = mapStrings(messages[i], (text) => (COMPLETION.test(text) ? PLACEHOLDER : undefined));
          if (count === 0) continue;
          e.messages[i] = next;
          replaced.push({ index: i, id: messages[i] && messages[i].id, role: messages[i] && messages[i].role, count, original: cut(deepStrings(messages[i]).find((text) => COMPLETION.test(text)), 300) });
        }
        rec("rewrite-completion", { ...base, did: replaced.length > 0, replaced });
      } else if (mode === "append-tail-system" || mode === "append-tail-user") {
        const role = mode === "append-tail-system" ? "system" : "user";
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
        const system = Array.isArray(e.system) ? e.system : [];
        const index = system.length - 1;
        const part = system[index];
        const hint = { type: "ephemeral", ttl: "1h" };
        const fields = part && typeof part === "object" ? Object.keys(part) : [];
        const direct = ["cacheControl", "cache_control", "cache"].find((key) => fields.includes(key));
        const nested = ["providerOptions", "providerMetadata", "options"].find((key) => fields.includes(key));
        const providerID = e.model && e.model.providerID;
        if (direct) {
          e.system = [...system.slice(0, index), { ...part, [direct]: { ...(part[direct] && typeof part[direct] === "object" ? part[direct] : {}), ...hint } }, ...system.slice(index + 1)];
          rec("cache-hint-1h", { ...base, did: true, via: `system part field ${direct}`, set: hint, partKeys: fields });
        } else if (nested && providerID) {
          const existing = part[nested] && typeof part[nested] === "object" ? part[nested] : {};
          const value = { ...existing, [providerID]: { ...(existing[providerID] && typeof existing[providerID] === "object" ? existing[providerID] : {}), cacheControl: hint } };
          e.system = [...system.slice(0, index), { ...part, [nested]: value }, ...system.slice(index + 1)];
          rec("cache-hint-1h", { ...base, did: true, via: `system part field ${nested}.${providerID}.cacheControl`, set: hint, partKeys: fields });
        } else if (providerID && e.options && typeof e.options === "object") {
          // No cache field on the system part: SessionRequestOptions accepts any other key as a provider option (session.d.ts:20-21).
          const existing = e.options[providerID] && typeof e.options[providerID] === "object" ? e.options[providerID] : {};
          e.options[providerID] = { ...existing, cacheControl: hint };
          rec("cache-hint-1h", { ...base, did: true, via: `request option ${providerID}.cacheControl (not a documented field; attempt only)`, set: hint, partKeys: fields });
        } else {
          rec("cache-hint-1h", { ...base, did: false, reason: "no cache field on the system part and no request options", partKeys: fields });
        }
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
        if (mode !== "rewrite-compaction") return;
        const swap = (text) => (text.includes("CPX_HELD_ORIGINAL") ? text.split("CPX_HELD_ORIGINAL").join("CPX_HELD_PLACEHOLDER") : undefined);
        let replacements = 0;
        for (let i = 0; i < messages.length; i += 1) {
          const [next, count] = mapStrings(messages[i], swap);
          if (count) {
            e.messages[i] = next;
            replacements += count;
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
        rec("rewrite-compaction", { sessionID: e.sessionID, did: replacements > 0, replacements });
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
      rec("retained-launch-batch", { batch, label, parentID, agent: chosen.agent, agents: chosen.available, agentError: chosen.error, contextKeys: Object.keys(context) });
      await Promise.allSettled(Array.from({ length: retainedCount }, (_, i) => i + 1).map(async (n) => {
        const id = `${batch}.${n}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300000);
        timer.unref();
        let childID;
        rec("retained-launch-attempt", { batch, n, id, label, parentID, agent: chosen.agent, description: `cpx-retained-${n}`, prompt: cut(childPrompt(n), 300) });
        try {
          const result = await native.execute(
            { agent: chosen.agent, description: `cpx-retained-${n}`, prompt: childPrompt(n), background: false },
            {
              ...context,
              signal: controller.signal,
              // The parent's call has ended, so the host would reject a progress update on its context: only record it.
              async progress(metadata) {
                const sessionID = metadata && metadata.sessionID;
                if (typeof sessionID === "string" && sessionID !== childID) {
                  childID = sessionID;
                  rec("retained-launch-child", { batch, n, id, parentID, childSessionID: sessionID });
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
