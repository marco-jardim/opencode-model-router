import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SystemPart } from "@opencode/ai";
import type { V2Runtime } from "./v2-client";
import { V2_GRADER_AGENT } from "./v2-client";
import { DEPTH_BANNER, TASK_VERIFICATION } from "./child-session";
import { isAbsolute, resolve } from "node:path";
import { loadConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { DEFER_MISSING_SUBAGENT_NOTICE, HOST_SEED_AGENTS, resolveSubagentOverrides } from "../router/subagents";
import { warnAgentOptionsEffortOnce } from "../router/agent-options";
import { pluginAgentMarker } from "../router/plugin-agents";
import { registerRoleAgents, roleAgentAlias, roleAgentOf } from "../router/role-agents";
import { stripDelegateInstructions } from "../router/instructions";
import { createPluginLogger } from "../router/logger";
import { GRADER_SYSTEM } from "../verify/checker";
import { EXECUTION_END_TYPES, FLUSH_EVENT_TYPES, NOOP_INGEST } from "../routing/outcomes/ingest";
import type { Ingest } from "../routing/outcomes/ingest";
import { createEngineRuntime } from "../routing/wire/runtime";
import { childSessionOf, createDispatchRouter } from "../routing/wire/dispatch";
import { createSystemAugmenter } from "../routing/wire/hint";
import { CONTEXT7_DOC_TOOLS, evaluatePermission, permissionRules, publishReadOnlyPermissions } from "../router/read-only";
import { filterSensitiveGrep, isSensitivePath } from "../router/sensitive-paths";

/** Translate the router's own v1 tool vocabulary at the v2 boundary. */
export function v2Instructions(text: string): string {
  return text
    .replace(/\bTask(?=\s*\()/g, "subagent")
    .replace(/\bTask (calls?|tool)\b/g, "subagent $1")
    .replace(/\btask tool\b/g, "subagent tool")
    .replace(/`task`/g, "`subagent`")
    .replace(/\bsubagent_type\b/g, "agent")
    .replace(/\btask_id\b/g, "sessionID");
}

type LegacyAgent = Record<string, any>;
type LegacyConfig = { agent: Record<string, LegacyAgent>; command: Record<string, any>; mcp?: Parameters<NonNullable<Hooks["config"]>>[0]["mcp"] };
type LegacyHook = (input: any, output: any) => Promise<void>;

function modelRef(value: string, variant?: string): any {
  const slash = value.indexOf("/");
  if (slash < 1) throw new Error(`[model-router] Invalid model reference: ${value}`);
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1), ...(variant ? { variant } : {}) };
}

function taskArgs(toolName: string, input: unknown): any {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;
  if (toolName === "subagent") return { ...args, subagent_type: args.agent, task_id: args.sessionID };
  if (toolName === "shell") return { ...args, cwd: args.workdir };
  if (["read", "write", "edit"].includes(toolName)) return { ...args, filePath: args.path };
  return input;
}

function nativeArgs(toolName: string, args: any, original: any, verifying: boolean): any {
  if (!args || typeof args !== "object") return args;
  if (toolName === "subagent") {
    const { subagent_type, task_id, ...rest } = args;
    return { ...rest, agent: subagent_type, ...(task_id === undefined ? {} : { sessionID: task_id }), ...(verifying ? { background: false } : {}) };
  }
  if (toolName === "shell") { const { cwd, ...rest } = args; return { ...rest, ...(cwd === undefined ? {} : { workdir: cwd }) }; }
  if (["read", "write", "edit"].includes(toolName)) {
    const { filePath, ...rest } = args;
    return { ...rest, path: filePath === original?.filePath ? rest.path : filePath };
  }
  return args;
}

function legacyToolName(name: string): string { return name === "subagent" ? "task" : name === "shell" ? "bash" : name; }

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

/** Rewrite new router prose without changing retained source code or user text. */
function translateAdded(before: string, after: string): string {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  return after.slice(0, prefix) + v2Instructions(after.slice(prefix, after.length - suffix)) + after.slice(after.length - suffix);
}

/** Register the existing router engine on the public OpenCode 2 domain APIs. */
export async function registerV2Hooks(
  ctx: Context,
  hooks: Hooks,
  runtime?: Pick<V2Runtime, "withToolContext" | "applyChildSystem"> & Partial<Pick<V2Runtime, "dispose" | "forgetSession">>,
  /** `ingest`: the plugin instance's telemetry ingest (M6, QA-2.1-7); without one the adapter ingests nothing. */
  options: { ingest?: Ingest } = {},
): Promise<() => Promise<void>> {
  // The old plugin surface uses separate mutable input/output bags. Keep those
  // casts confined to this adapter, rather than weakening the v2 event types.
  const legacy = hooks as unknown as Record<string, LegacyHook | undefined>;
  const registrations: Array<{ dispose(): Promise<void> }> = [];
  const abort = new AbortController();
  const verifyingCalls = new Set<string>();
  const depthBanners = new Map<string, string>();
  // M6 (2.1.3): child-session outcomes and costs reach the outcome store through the plugin instance's ingest, which
  // does nothing unless routing.engine != static (its settings are null otherwise: no bundle, no files).
  const ingestLogger = createPluginLogger();
  const ingest: Ingest = options.ingest ?? NOOP_INGEST;
  // An ingestion error is logged and the loop carries on: it must never cost the router an event.
  const ingesting = async (what: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!abort.signal.aborted) ingestLogger.warn(`[router] telemetry ingestion: ${what} failed`, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // M7 (2.2): dispatch routing and the protocol/hint adaptation share one runtime; it touches nothing (no host call, no
  // store, no disk) while routing.engine is static, which is the default and what every config without a `routing` block is.
  const sessionOf = (sessionID: string): Promise<unknown> => ctx.session.get({ sessionID } as Parameters<typeof ctx.session.get>[0]);
  const engine = createEngineRuntime({
    loadConfig: () => loadConfig(ctx.location.directory),
    listAgents: async () => (await ctx.agent.list()).data,
    listModels: async () => (await ctx.model.list({ location: { directory: ctx.location.directory } })).data,
    ...(ctx.generate === undefined ? {} : { generate: ctx.generate }),
    logger: ingestLogger,
  });
  const dispatchRouter = createDispatchRouter({
    runtime: engine, getSession: sessionOf, graderAgent: V2_GRADER_AGENT, directory: ctx.location.directory,
    logger: { warn: (message, extra) => ingestLogger.warn(message, extra), debug: (message, extra) => console.debug(message, extra ?? "") },
  });
  const systemAugmenter = createSystemAugmenter({ runtime: engine, getSession: sessionOf, logger: ingestLogger });
  let eventTask: Promise<void> | undefined;
  let disposed = false;
  const within = <T>(context: ToolContext, operation: () => Promise<T>): Promise<T> =>
    runtime ? runtime.withToolContext(context, operation) : operation();
  const scopedArgs = async (event: { tool: string; input: unknown; sessionID: any }): Promise<any> => {
    const args = taskArgs(event.tool, event.input);
    if (["read", "write", "edit"].includes(event.tool) && typeof args?.filePath === "string" && !isAbsolute(args.filePath)) {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      args.filePath = resolve(session.location?.directory ?? ctx.location.directory, args.filePath);
    }
    return args;
  };
  const hookContext = (event: { sessionID: any; agent: any; messageID: any; id: any }): ToolContext => ({
    ...event, signal: abort.signal, progress: async () => {},
  });
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    abort.abort();
    await runtime?.dispose?.();
    // Before the event task: disposing releases a step handler that waits for the model catalog (QA-2.1-5).
    await ingest.dispose();
    dispatchRouter.dispose(); // this location no longer owns its sessions
    await engine.dispose();
    await eventTask;
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
    await hooks.dispose?.();
  };

  try {
    // Captured once: after our own transform, ctx.agent.list() returns
    // router-modified agents, which would defeat the originals diff on refresh.
    const agents = await ctx.agent.list();
    const baseSeed: Record<string, LegacyAgent> = {};
    for (const agent of agents.data) baseSeed[agent.id] = {
      mode: agent.mode,
      model: agent.model && `${agent.model.providerID}/${agent.model.id}`,
      variant: agent.model?.variant,
    };
    let config: LegacyConfig = { agent: {}, command: {} };
    let originals = new Map<string, string>();
    let agentOptions = new Map<string, Record<string, unknown>>();
    const warnedPermissions = new Set<string>();
    const warnPermissionOnce = (message: string) => {
      if (warnedPermissions.has(message)) return;
      warnedPermissions.add(message);
      ingestLogger.warn(message);
    };
    const warnedRoles = new Set<string>();
    const warnRoleOnce = (key: string, message: string) => {
      if (warnedRoles.has(key)) return;
      warnedRoles.add(key);
      ingestLogger.warn(message);
    };
    // Plugin agents (#81) are protected like read-only tiers: readOnly ones and explicit-permission ones
    // (which start from `* deny`) both keep their own deny/ask rules against inherited session grants.
    // The config hook builds plugin agents in the v1 vocabulary (`bash`, `task`); the v2 host evaluates `shell`/`subagent`.
    const V2_ACTIONS: Readonly<Record<string, string>> = { bash: "shell", task: "subagent" };
    const v2Actions = (rules: ReturnType<typeof permissionRules>) => rules.map((rule) => ({ ...rule, action: V2_ACTIONS[rule.action] ?? rule.action }));
    const protectedAgent = (name: string | undefined) => name !== undefined
      && (config.agent[name]?.permission?.["*"] === "deny" || pluginAgentMarker(config.agent[name]) !== undefined);
    const agentLabel = (name: string | undefined): string => {
      const marker = name === undefined ? undefined : pluginAgentMarker(config.agent[name]);
      return marker !== undefined && !marker.readOnly ? "plugin agent" : "read-only agent";
    };
    // Host agents appear after setup (the host's config-agent plugin activates after the router). Names
    // the router created itself never count as host agents, or a tier would look like an existing one.
    const routerCreated = new Set<string>();
    let promptChecked = false;
    const pendingSubagentNames = (): string[] => {
      const routerConfig = loadConfig(ctx.location.directory);
      const tiers = getActiveTiers(routerConfig);
      return Object.keys(routerConfig.subagentTiers ?? {}).filter((name) =>
        !Object.hasOwn(tiers, name) && !Object.hasOwn(routerConfig.agents ?? {}, name) && !Object.hasOwn(baseSeed, name));
    };
    /** Adds host agents that appeared since setup to the seed; true when the seed grew. */
    const discoverHostAgents = async (): Promise<boolean> => {
      const pending = pendingSubagentNames();
      if (pending.length === 0) return false;
      let grew = false;
      for (const agent of (await ctx.agent.list()).data) {
        if (!pending.includes(agent.id) || routerCreated.has(agent.id) || Object.hasOwn(baseSeed, agent.id)) continue;
        baseSeed[agent.id] = {
          mode: agent.mode,
          model: agent.model && `${agent.model.providerID}/${agent.model.id}`,
          variant: agent.model?.variant,
        };
        grew = true;
      }
      return grew;
    };
    let lastConfig: unknown;
    // Returns the router config the registry state was built from; the caller
    // advances `lastConfig` only once the host registries have reloaded from it.
    const buildConfig = async (): Promise<unknown> => {
      const next: LegacyConfig = { agent: JSON.parse(JSON.stringify(baseSeed)), command: {} };
      const context7 = ctx.mcp && (await ctx.mcp.list()).data.some(server => server.name === "context7" && server.status.status !== "disabled");
      // Presence-only bridge input, never registered as an MCP definition.
      if (context7) next.mcp = { context7: { type: "local", command: [], enabled: true } };
      const nextOriginals = new Map(Object.entries(next.agent).map(([id, agent]) => [id, JSON.stringify(agent)]));
      // The "no such agent" notice for `subagentTiers` waits for the first prompt-time check (see the prompt hook).
      Object.defineProperty(next, DEFER_MISSING_SUBAGENT_NOTICE, { value: !promptChecked, enumerable: false });
      // Names in the setup seed are host built-in agents (not opencode.json entries the config hook can tell apart).
      Object.defineProperty(next, HOST_SEED_AGENTS, { value: new Set(Object.keys(baseSeed)), enumerable: false });
      await hooks.config?.(next);
      const routerConfig = loadConfig(ctx.location.directory);
      // #84 P2.1: the role agents (roles mode only; tiers mode returns at once). Built like plugin agents, so the transform
      // below publishes their max policy and protectedAgent() holds for each; fail closed (no role agent) on any error.
      await registerRoleAgents(next.agent, routerConfig, {
        context7: Boolean(context7), directory: ctx.location.directory, seed: baseSeed, warn: warnRoleOnce,
      });
      for (const name of Object.keys(next.agent)) if (!Object.hasOwn(baseSeed, name)) routerCreated.add(name);
      const nextOptions = new Map<string, Record<string, unknown>>();
      for (const [name, definition] of Object.entries(next.agent)) {
        if (nextOriginals.get(name) === JSON.stringify(definition) || !definition.options) continue;
        const { reasoning_effort, reasoning_summary, budget_tokens, ...options } = definition.options;
        const normalized = { ...options };
        if (reasoning_effort !== undefined && normalized.reasoningEffort === undefined) normalized.reasoningEffort = reasoning_effort;
        if (reasoning_summary !== undefined && normalized.reasoningSummary === undefined) normalized.reasoningSummary = reasoning_summary;
        if (budget_tokens !== undefined && normalized.thinking === undefined) normalized.thinking = { type: "enabled", budgetTokens: budget_tokens };
        nextOptions.set(name, normalized);
      }
      config = next;
      originals = nextOriginals;
      agentOptions = nextOptions;
      return routerConfig;
    };
    lastConfig = await buildConfig();
    let refreshChain: Promise<void> = Promise.resolve();
    const refresh = (): Promise<void> => {
      const run = refreshChain.then(async () => {
        if (disposed) return;
        const built = await buildConfig();
        await ctx.agent.reload();
        await ctx.command.reload();
        // Only after both registries reloaded: a rejected reload leaves
        // `lastConfig` stale so the next prompt retries the refresh.
        lastConfig = built;
      });
      refreshChain = run.catch(() => {});
      return run;
    };
    registrations.push(await ctx.agent.transform((editor) => {
      if (runtime) editor.update(V2_GRADER_AGENT, (agent) => {
        agent.mode = "subagent";
        agent.hidden = true;
        agent.description = "Model router verification grader";
        agent.system = GRADER_SYSTEM;
      });
      for (const [name, definition] of Object.entries(config.agent)) {
        if (originals.get(name) === JSON.stringify(definition)) continue;
        editor.update(name, (agent) => {
          if (definition.model) agent.model = modelRef(definition.model, definition.variant);
          if (definition.mode) agent.mode = definition.mode;
          if (definition.description !== undefined) agent.description = definition.description;
          // A plugin agent's prompt is the user's own text: used verbatim, never rewritten for the host vocabulary.
          const marker = pluginAgentMarker(definition);
          if (definition.prompt !== undefined) agent.system = marker ? definition.prompt : v2Instructions(definition.prompt);
          if (definition.color !== undefined) agent.color = definition.color;
          if (definition.steps !== undefined) agent.steps = definition.steps;
          if (definition.permission) {
            agent.permissions = publishReadOnlyPermissions(
              name, marker ? v2Actions(permissionRules(definition.permission)) : permissionRules(definition.permission), agent.permissions ?? [], warnPermissionOnce, { plugin: marker !== undefined },
            );
          }
        });
      }
    }));

    // Enforce the protected agent's own deny/ask without destroying inherited
    // grants: the same session can later resume as medium/heavy (P-R2-3).
    registrations.push(await ctx.permission.hook("evaluate", async event => {
      let name: string | undefined = event.agent;
      let protectedKnown = protectedAgent(name);
      try {
        // An explicit event agent is authoritative, even when session lookup
        // would fail or still refers to the previous agent during a switch.
        name ??= (await ctx.session.get({ sessionID: event.sessionID })).agent;
        protectedKnown = protectedAgent(name);
        if (!protectedKnown) return;
        const agent = (await ctx.agent.list()).data.find(agent => agent.id === name);
        const effects = agent ? event.resources.map(resource => evaluatePermission(agent.permissions, event.action, resource)) : ["deny"];
        if (effects.includes("deny")) {
          event.effect = "deny";
          event.message = `Permission denied by ${agentLabel(name)} ${name}: ${event.action}`;
        } else if (effects.includes("ask") && event.effect === "allow") {
          event.effect = "ask";
          event.message = `Approval required by ${agentLabel(name)} ${name}: ${event.action}`;
        }
      } catch (error) {
        if (protectedKnown) event.effect = "deny";
        warnPermissionOnce(`read-only permission evaluation failed for ${name ?? "unknown agent"}: ${String(error)}`);
      }
    }));

    registrations.push(await ctx.command.transform((editor) => {
      for (const [name, definition] of Object.entries(config.command)) editor.add({
        name,
        description: definition.description,
        execute: async (invocation) => {
          const text = String(definition.template ?? "").replaceAll("$ARGUMENTS", () => invocation.prompt.text);
          const output = { parts: text ? [{ type: "text", text }] : [] };
          await legacy["command.execute.before"]?.({
            command: name, arguments: invocation.prompt.text, sessionID: invocation.sessionID,
          }, output);
          if (name === "router-reload") {
            const reloadText = output.parts.map((part) => v2Instructions(part.text)).join("\n\n");
            await refresh();
            await ctx.session.synthetic({
              sessionID: invocation.sessionID, text: reloadText, description: "Model router config reload", resume: false,
            });
            return;
          }
          if (name === "preset") await refresh();
          await ctx.session.prompt({
            ...invocation.prompt,
            sessionID: invocation.sessionID,
            delivery: invocation.delivery,
            text: output.parts.map((part) => v2Instructions(part.text)).join("\n\n"),
          });
        },
      });
    }));

    registrations.push(await ctx.tool.transform((editor) => {
      // execute is denied for read-only tiers. Keep the explicitly allowed docs
      // lookups directly callable rather than stranding them in Code Mode.
      if (config.mcp?.context7) for (const name of CONTEXT7_DOC_TOOLS) editor.update(name, definition => {
        const { pinned: _pinned, ...options } = definition.options ?? {};
        definition.options = { ...options, codemode: false };
      });
      for (const [name, definition] of Object.entries(hooks.tool ?? {})) editor.add({
        name,
        description: v2Instructions(definition.description),
        input: tool.schema.object(definition.args),
        // Router tools must remain directly callable, matching v1 tool exposure.
        options: { codemode: false },
        execute: async (args, context) => within(context, async () => {
          const directory = name.startsWith("router_git_")
            ? (await ctx.session.get({ sessionID: context.sessionID })).location?.directory ?? ctx.location.directory
            : ctx.location.directory;
          const result = await definition.execute(args, {
            sessionID: context.sessionID, messageID: context.messageID, agent: context.agent,
            directory, worktree: name.startsWith("router_git_") ? "" : ctx.location.project.directory, // Session.Info.location has no project; discover from its directory, never the plugin's project.
            abort: context.signal,
            metadata: (metadata) => { void context.progress(metadata); },
            ask: async () => { throw new Error("[model-router] This tool cannot request v1 permissions on OpenCode 2"); },
          });
          if (typeof result === "string") return { content: result };
          return {
            content: [
              { type: "text" as const, text: result.output },
              ...(result.attachments ?? []).map((file) => ({
                type: "file" as const, uri: file.url, mime: file.mime, ...(file.filename ? { name: file.filename } : {}),
              })),
            ],
            metadata: { ...result.metadata, ...(result.title ? { title: result.title } : {}) },
          };
        }),
      });
    }));

    registrations.push(await ctx.session.hook("prompt", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      const output = { message: { agent: session.agent }, parts: [{ type: "text", text: event.prompt.text }] };
      await legacy["chat.message"]?.({ sessionID: event.sessionID, agent: session.agent }, output);
      event.prompt.text = output.parts.map((part) => part.text).join("\n\n");
      // Host agents defined in opencode.json appear after setup: refresh once a pending `subagentTiers` name shows up.
      const discovered = await discoverHostAgents();
      if (loadConfig(ctx.location.directory) !== lastConfig || discovered) await refresh();
      if (!promptChecked) {
        promptChecked = true;
        for (const name of pendingSubagentNames()) {
          warnAgentOptionsEffortOnce(`subagent-tiers:missing:${name}`, `subagentTiers: '${name}' is not defined in opencode.json or the router \`agents\` block; skipped (the router never creates it)`, ingestLogger);
        }
      }
    }));
    registrations.push(await ctx.session.hook("context", async (event) => {
      if (protectedAgent(event.agent)) {
        try {
          // Catalogs use merged session rules; remove widened tools from this
          // request snapshot only. Resource-specific asks remain callable.
          const agent = (await ctx.agent.list()).data.find(agent => agent.id === event.agent);
          for (const name of Object.keys(event.tools ?? {})) {
            const action = name === "write" || name === "patch" ? "edit" : name;
            if (!agent || (evaluatePermission(agent.permissions, action, "*") === "deny"
              && !agent.permissions.some(rule => rule.effect !== "deny" && rule.action === action && rule.resource !== "*"))) delete event.tools[name];
          }
        } catch (error) {
          // Known protected agent: no usable catalog is safer than widened
          // tools. Never turn a hook rejection into a host operation failure.
          for (const name of Object.keys(event.tools ?? {})) delete event.tools[name];
          warnPermissionOnce(`read-only tool catalog failed for ${event.agent}: ${String(error)}`);
        }
      }
      const input = { sessionID: event.sessionID, agent: event.agent, model: { ...event.model, modelID: event.model.id } };
      // V2 consumes per-turn options, not Agent.Info.request.settings.
      for (const [key, value] of Object.entries(agentOptions.get(event.agent) ?? {})) {
        if (!(key in event.options)) event.options[key] = value;
      }
      await legacy["chat.params"]?.(input, event.options);
      const routerConfig = loadConfig(ctx.location.directory);
      const verify = routerConfig.enforcement?.verify;
      if (event.agent === V2_GRADER_AGENT
        && (verify?.graderTemperature === null
          || !(verify?.graderTemperatureModels ?? []).includes(`${event.model.providerID}/${event.model.id}`))) {
        delete event.options.temperature;
      }
      const original = new Map<string, SystemPart[]>();
      for (const part of event.system) {
        const copies = original.get(part.text) ?? [];
        copies.push(part);
        original.set(part.text, copies);
      }
      const output = { system: event.system.map((part) => part.text) };
      // The router pushes its own instructions, but may splice edited user text.
      // Only pushed text belongs to the router and may have its vocabulary translated.
      const added = new Set<string>();
      Object.defineProperty(output.system, "push", { value: (...texts: string[]) => {
        for (const text of texts) added.add(text);
        return Array.prototype.push.apply(output.system, texts);
      } });
      await legacy["experimental.chat.system.transform"]?.(input, output);
      // M7 (2.2): advise/enforce swap the R: line, append the route-line paragraph and add the per-turn hint.
      // static/shadow (and every config without a routing block) leave `output.system` exactly as the legacy hook built it.
      await systemAugmenter.augment({
        sessionID: event.sessionID, agent: event.agent, parentModel: `${event.model.providerID}/${event.model.id}`, messages: event.messages, cfg: routerConfig,
      }, output.system, added);
      event.system = output.system.map((text): SystemPart =>
        original.get(text)?.shift() ?? { type: "text", text: added.has(text) ? v2Instructions(text) : text });
      runtime?.applyChildSystem(event.sessionID, event.system);
      // Native reads load nested AGENTS.md as synthetic user-role messages.
      // Correlate their IDs with durable attribution before removing anything;
      // a user prompt containing identical text must remain untouched.
      const candidates = event.messages?.filter((message) => message.role === "user"
        && message.content.some((part) => part.type === "text" && /^Instructions from:/m.test(part.text)));
      if (candidates?.length) {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        if (session.parentID) {
          const history = await ctx.session.context({ sessionID: event.sessionID });
          const attributed = new Map(history.filter((message) => message.type === "synthetic"
            && message.metadata?.instruction && typeof message.metadata.instruction === "object"
            && "paths" in message.metadata.instruction && Array.isArray(message.metadata.instruction.paths))
            .map((message) => [message.id, message]));
          for (const message of candidates) {
            const source = message.id ? attributed.get(message.id) : undefined;
            if (!source || source.type !== "synthetic") continue;
            const filtered = { system: [source.text] };
            stripDelegateInstructions(filtered, loadConfig(ctx.location.directory), session.location?.directory ?? ctx.location.directory);
            const retained = filtered.system.join("");
            if (retained === source.text) continue;
            const index = event.messages.indexOf(message);
            const content = message.content.flatMap((part) => part.type === "text" && part.text === source.text
              ? retained ? [{ ...part, text: retained }] : [] : [part]);
            if (content.length) event.messages[index] = Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content });
            else event.messages.splice(index, 1);
          }
        }
      }
    }));

    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      const args = await scopedArgs(event);
      if (event.tool === "subagent" && args && typeof args.agent === "string") {
        // The model `subagentTiers` would fill in when the call names none (unchanged behaviour: only then, only for a mapped agent).
        const cfg = loadConfig(ctx.location.directory);
        // #84 P-7: roles mode dispatches the host-native `explore` as the `explorer` role agent. Legacy shape: nativeArgs
        // derives `agent` from `subagent_type`; `args.agent` is set too, so everything below keys on the role name.
        const alias = roleAgentAlias(args.agent, cfg, (name) => roleAgentOf(config.agent[name]) === name);
        if (alias !== undefined) { args.agent = alias; args.subagent_type = alias; }
        let tierModel: string | undefined;
        if (args.model === undefined) {
          if (cfg.subagentTiers?.[args.agent]) {
            const actual = await ctx.agent.list();
            const overrides = actual.data.some((agent) => agent.id === args.agent) ? resolveSubagentOverrides({
              subagentTiers: cfg.subagentTiers, tiers: getActiveTiers(cfg), pluginAgents: cfg.agents,
              existingAgents: Object.fromEntries(actual.data.map((agent) => [agent.id, { mode: agent.mode }])),
            }) : {};
            const override = overrides[args.agent];
            if (override) tierModel = `${override.model}${override.variant ? `#${override.variant}` : ""}`;
          }
        }
        // M7 (2.2): the engine goes first. Static (the default) returns untouched without any host call; shadow/advise only
        // log and strip `[route …]`; enforce may also replace agent and model. `subagentTiers` then only fills a missing model.
        const routed = await dispatchRouter.route({
          callID: event.id, sessionID: event.sessionID, agent: event.agent, args, tierModel, cfg,
        });
        if (routed.prompt !== undefined) args.prompt = routed.prompt;
        if (routed.agent !== undefined) { args.agent = routed.agent; args.subagent_type = routed.agent; }
        if (routed.model !== undefined) args.model = routed.model;
        if (args.model === undefined && tierModel !== undefined) args.model = tierModel;
      }
      // After routing: the prompt the legacy hook starts from is the one the engine left (a stripped route line is not "added" text).
      try {
        const original = args && typeof args === "object" ? { ...args } : args;
        const output = { args };
        await within(hookContext(event), async () => {
          await legacy["tool.execute.before"]?.({ ...event, tool: legacyToolName(event.tool), callID: event.id }, output);
        });
        const verifying = (output as Record<PropertyKey, unknown>)[TASK_VERIFICATION] === true;
        const banner = (output as Record<PropertyKey, unknown>)[DEPTH_BANNER];
        if (typeof banner === "string") {
          depthBanners.delete(event.id);
          depthBanners.set(event.id, banner);
          while (depthBanners.size > 1000) depthBanners.delete(depthBanners.keys().next().value!);
        }
        if (verifying) {
          verifyingCalls.add(event.id);
          while (verifyingCalls.size > 1000) verifyingCalls.delete(verifyingCalls.values().next().value!);
        }
        if (event.tool === "subagent" && typeof output.args?.prompt === "string") {
          const prompt = typeof original?.prompt === "string" ? original.prompt : typeof original?.description === "string" ? original.description : "";
          output.args.prompt = translateAdded(prompt, output.args.prompt);
        }
        event.input = nativeArgs(event.tool, output.args, original, verifying);
      } catch (error) {
        dispatchRouter.onCallFinished(event.id); // the hook chain rejected the call: it will never reach execute.after (2.2)
        throw error;
      }
      // The input the host will execute (after the legacy hook): the dispatch is registered for ingestion from it, not from what the engine decided (2.2).
      dispatchRouter.commit(event.id, event.input);
    }));
    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      // 2.2: the result names the child. A dispatch still waiting for it is registered under it, and a heuristic claim that picked
      // the wrong child is corrected here, before the legacy hook below records the verdict. A call without a result is just dropped.
      dispatchRouter.onCallResult(event.id, event.status === "completed" ? childSessionOf(event.result) : null);
      const banner = depthBanners.get(event.id);
      depthBanners.delete(event.id);
      const verifying = verifyingCalls.delete(event.id);
      if (event.status !== "completed") return;
      if (event.tool === "grep" && protectedAgent(event.agent)) {
        const content = event.result.content;
        event.result = {
          ...event.result,
          content: filterSensitiveGrep(contentText(content)),
          // Native grep also exposes raw matches to SDK callers. Do not leave
          // their text behind after scrubbing the model-facing representation.
          ...(Array.isArray(event.result.output) ? { output: event.result.output.filter(match => {
            if (!match || typeof match !== "object" || !("entry" in match)) return false;
            const entry = match.entry;
            return entry !== null && typeof entry === "object" && "path" in entry
              && typeof entry.path === "string" && !isSensitivePath(entry.path);
          }) } : {}),
        };
      }
      const structured = event.result.output;
      // A user can background a foreground subagent while it is running. That
      // acknowledgement is not a final result and must never enter acceptance.
      if (event.tool === "subagent" && structured?.status === "running") {
        const notices = [
          ...(verifying ? ["[router] This subagent is still running. Its result has not been verified; automatic acceptance requires a completed foreground return."] : []),
          ...(banner === undefined ? [] : [banner]),
        ];
        if (!notices.length) return;
        const notice = notices.join("\n\n");
        const content = Array.isArray(event.result.content) ? [...event.result.content]
          : typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : [];
        event.result = {
          ...event.result,
          content: [...content, { type: "text", text: notice }],
          output: { ...structured, output: `${typeof structured.output === "string" ? structured.output + "\n\n" : ""}${notice}` },
        };
        return;
      }
      const text = event.tool === "subagent" && structured && typeof structured === "object" && typeof structured.output === "string"
        ? structured.output : contentText(event.result.content);
      const output = { title: "", output: text, metadata: { ...event.result.metadata } };
      await within(hookContext(event), async () => {
        await legacy["tool.execute.after"]?.({
          ...event, tool: legacyToolName(event.tool),
          callID: event.id, args: await scopedArgs(event),
        }, output);
      });
      const changed = output.output !== text;
      if (!changed && banner === undefined) return;
      const routed = changed ? translateAdded(text, output.output) : text;
      const final = banner === undefined ? routed : [routed.trimEnd(), banner].filter(Boolean).join("\n\n");
      const content = Array.isArray(event.result.content) ? [...event.result.content]
        : typeof event.result.content === "string" ? [{ type: "text" as const, text: event.result.content }] : [];
      const childText = text.trimEnd();
      const routedText = routed.trimEnd();
      let visible;
      if (event.tool === "subagent" && structured && typeof structured === "object" && typeof structured.output === "string"
        && content.some((part) => part.type === "text") && routedText.startsWith(childText)) {
        // The host's visible text owns the session envelope (and resume handle).
        // Footer helpers trim the bare output. Compare trimmed tails before taking
        // only the router's suffix; other rewrites must replace, not repeat, it.
        const suffix = changed ? routedText.slice(childText.length) : "";
        const notices = [suffix, banner].filter((part) => part !== undefined && part !== "").join("\n\n");
        visible = [
          ...content,
          ...(notices ? [{ type: "text" as const, text: notices }] : []),
        ];
      } else {
        visible = [{ type: "text" as const, text: final }, ...content.filter((part) => part.type !== "text")];
      }
      event.result = {
        ...event.result,
        content: visible,
        metadata: output.metadata,
        ...(typeof structured === "string" ? { output: final }
          : structured && typeof structured === "object" && typeof structured.output === "string"
            ? { output: { ...structured, output: final } } : {}),
      };
    }));

    // V2 events are immutable facts. A completed-text warning is a synthetic
    // transcript entry, instead of mutating an already-persisted text part.
    eventTask = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (abort.signal.aborted) break;
        try {
          const data = event.data as Record<string, any>;
          if (event.type === "session.step.ended" || event.type === "session.step.failed") {
            // Cost and tokens of a registered child dispatch (ingest ignores every other session).
            await ingesting(event.type, () => ingest.onStepEnded(event));
            continue;
          }
          // A new child session: the dispatch the engine routed for it is registered with the 2.1 registry (2.2).
          if (event.type === "session.created") dispatchRouter.onSessionCreated({ sessionID: data.sessionID, parentID: data.parentID, agent: data.agent, title: data.title });
          if (event.type === "session.deleted") {
            runtime?.forgetSession?.(data.sessionID);
            await ingesting("session.deleted", () => ingest.onSessionGone(data.sessionID));
          } else if (FLUSH_EVENT_TYPES.has(event.type)) {
            // The v2 equivalents of session.idle: coalesced, throttled flush (D15); never awaited.
            await ingesting(event.type, () => {
              // The child's attempt is over: fold it before the flush that persists it.
              if (EXECUTION_END_TYPES.has(event.type)) ingest.onExecutionEnded(data.sessionID, event.id);
              ingest.sweep();
              ingest.requestFlush();
            });
          }
          if (event.type === "session.text.ended") {
            const output = { text: data.text };
            await legacy["experimental.text.complete"]?.({ sessionID: data.sessionID, messageID: data.assistantMessageID }, output);
            if (typeof data.text === "string" && output.text.startsWith(data.text) && output.text !== data.text && !abort.signal.aborted) {
              await ctx.session.synthetic({ sessionID: data.sessionID, text: output.text.slice(data.text.length).trim(), description: "Model router narration warning", resume: false });
            }
            continue;
          }
          const translated = event.type === "session.created"
            ? { type: event.type, properties: { info: { ...data, id: data.sessionID } } }
            : event.type === "session.deleted"
              ? { type: event.type, properties: { info: { id: data.sessionID } } }
              : ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)
                ? { type: "session.idle", properties: { sessionID: data.sessionID } } : undefined;
          if (translated) await legacy.event?.({ event: translated }, undefined);
        } catch (error) {
          if (!abort.signal.aborted) console.warn("[model-router] OpenCode 2 event handling failed", error);
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) console.warn("[model-router] OpenCode 2 event subscription failed", error);
    });
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
