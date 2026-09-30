import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ChildSessionRunner } from "./child-session";

export const V2_GRADER_AGENT = "model-router-grader";
const RETAINED_CONTEXT_LIMIT = 500;

/** The small v1 client surface still used by the shared hooks. */
export function createV2Runtime(ctx: Plugin.Context) {
  type ToolScope = { context: ToolContext; active: boolean };
  const currentTool = new AsyncLocalStorage<ToolScope>();
  const retainedContexts = new Map<string, ToolScope>();
  const lifetime = new AbortController();
  const childSystems = new Map<string, string>();
  const activeChildren = new Map<string, AbortController>();

  const interrupt = async (sessionID: string, signal?: AbortSignal) => {
    activeChildren.get(sessionID)?.abort();
    return ctx.session.interrupt({ sessionID }, signal ? { signal } : undefined);
  };

  const client = {
    session: {
      async get(input: { path: { id: string }; signal?: AbortSignal }) {
        return { data: await ctx.session.get({ sessionID: input.path.id }, input.signal ? { signal: input.signal } : undefined) };
      },
      async abort(input: { path: { id: string }; signal?: AbortSignal }) {
        return { data: await interrupt(input.path.id, input.signal) };
      },
    },
    config: {
      async providers() {
        const location = { directory: ctx.location.directory };
        const [providers, models, defaultModel] = await Promise.all([
          ctx.provider.list({ location }),
          ctx.model.list({ location }),
          ctx.model.default({ location }),
        ]);
        return {
          data: {
            providers: providers.data.map(provider => ({
              id: provider.id,
              name: provider.name,
              models: Object.fromEntries(models.data
                .filter(model => model.providerID === provider.id && model.enabled)
                .map(model => [model.id, { id: model.id, status: model.status }])),
            })),
            default: defaultModel.data
              ? { [defaultModel.data.providerID]: defaultModel.data.id }
              : {},
          },
        };
      },
    },
    // v2 has no app.log endpoint. createPluginLogger uses its console fallback.
  };

  const childRunner: ChildSessionRunner = {
    async run(request) {
      lifetime.signal.throwIfAborted();
      const current = currentTool.getStore();
      // A shared background worker can run in a different caller's async
      // scope. Only a real context previously observed for the requested
      // parent may authorize that dispatch; never manufacture call/message IDs.
      const scope = request.parentSessionID && request.parentSessionID !== current?.context.sessionID
        ? retainedContexts.get(request.parentSessionID)
        : current;
      if (!scope) throw new Error("[model-router] v2 child dispatch requires an active tool context or a retained context matching its parent");
      const toolContext = scope.context;
      const native = (await ctx.tool.list()).find(tool => tool.id === "subagent");
      if (!native) throw new Error("[model-router] OpenCode v2's native subagent tool is unavailable");
      const controller = new AbortController();
      // Deferred verification outlives its originating tool call. Its own
      // deadline and plugin lifetime govern cancellation once that call ends.
      const signal = AbortSignal.any([
        lifetime.signal, controller.signal,
        ...(scope.active ? [toolContext.signal] : []),
        ...(request.signal ? [request.signal] : []),
      ]);
      signal.throwIfAborted();
      let childID: string | undefined;
      const model = request.model;
      try {
        const result = await native.execute({
          agent: request.agent ?? V2_GRADER_AGENT,
          description: request.agent ? `Router ${request.agent} delegation` : "Router result verification",
          prompt: request.prompt,
          ...(model ? { model: `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` } : {}),
          background: false,
        }, {
          ...toolContext,
          signal,
          async progress(metadata) {
            const sessionID = metadata.sessionID;
            if (typeof sessionID === "string" && sessionID !== childID) {
              if (childID) throw new Error("[model-router] native subagent changed its child session ID");
              childID = sessionID;
              activeChildren.set(sessionID, controller);
              if (request.system) childSystems.set(sessionID, request.system);
              // The native subagent awaits progress after creating its child and
              // before prompting it. Register guards and scope graders here.
              await request.onCreated(sessionID);
              if (request.cwd) await ctx.session.move({ sessionID, directory: request.cwd }, { signal });
              signal.throwIfAborted();
            }
            await toolContext.progress(metadata);
          },
        });
        signal.throwIfAborted();
        const output = result.output as { sessionID?: unknown; status?: unknown; output?: unknown } | undefined;
        if (!childID || output?.sessionID !== childID || output.status !== "completed" || typeof output.output !== "string") {
          throw new Error("[model-router] native subagent did not return a completed child result; verification cannot use a pending result");
        }
        return { sessionID: childID, text: output.output };
      } catch (error) {
        controller.abort();
        if (childID) {
          try { await ctx.session.interrupt({ sessionID: childID }); } catch { /* keep the original dispatch failure */ }
        }
        throw error;
      } finally {
        if (childID) {
          childSystems.delete(childID);
          activeChildren.delete(childID);
        }
      }
    },
    async dispose(sessionID) {
      childSystems.delete(sessionID);
      await interrupt(sessionID);
      // The public v2 plugin context cannot remove sessions. Keep the native
      // child history for inspection; never turn it into an unparented session.
    },
  };

  return {
    client,
    childRunner,
    async withToolContext<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
      lifetime.signal.throwIfAborted();
      const scope = { context, active: true };
      retainedContexts.delete(context.sessionID);
      retainedContexts.set(context.sessionID, scope);
      while (retainedContexts.size > RETAINED_CONTEXT_LIMIT) {
        retainedContexts.delete(retainedContexts.keys().next().value!);
      }
      try {
        return await currentTool.run(scope, operation);
      } finally {
        scope.active = false;
      }
    },
    applyChildSystem(sessionID: string, system: SessionContext["system"]): void {
      const text = childSystems.get(sessionID);
      if (text && !system.some(part => part.text === text)) system.push({ type: "text", text });
    },
    forgetSession(sessionID: string): void {
      retainedContexts.delete(sessionID);
      childSystems.delete(sessionID);
      activeChildren.get(sessionID)?.abort();
    },
    async dispose(): Promise<void> {
      lifetime.abort();
      const sessions = [...activeChildren.keys()];
      retainedContexts.clear();
      childSystems.clear();
      await Promise.allSettled(sessions.map(sessionID => interrupt(sessionID)));
      activeChildren.clear();
    },
  };
}

export type V2Runtime = ReturnType<typeof createV2Runtime>;
