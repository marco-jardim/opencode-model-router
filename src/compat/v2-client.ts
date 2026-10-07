import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { ResumeRejectedError, type ChildSessionRunner } from "./child-session";
import { markRunnerDispatch, runnerDescription } from "../router/sessions";

export const V2_GRADER_AGENT = "model-router-grader";
const RETAINED_CONTEXT_LIMIT = 500;
/** How long a delegation waits for the host to remove a child it started by mistake before it reports the error. */
export const STRAY_CLEANUP_TIMEOUT_MS = 2_000;

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
                // `id` and `status` are what the v1 shape had; the rest lets the cost doctor (Phase 2.4) read the SAME call instead of a second
                // `model.list` (QA-2.4-3). v1 consumers (`normalizeCatalog`) ignore the extra fields.
                .map(model => [model.id, {
                  id: model.id,
                  status: model.status,
                  enabled: model.enabled,
                  family: model.family,
                  capabilities: model.capabilities,
                  cost: model.cost,
                  variants: model.variants,
                  limit: model.limit,
                }])),
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

  /**
   * Stop and remove a child the host started that no caller knows (QA-2.3-5). Bounded (QA-2.3-R2-3): resolves with ""
   * when it is gone, otherwise with a sentence for the error (a failure, or a removal still running after
   * STRAY_CLEANUP_TIMEOUT_MS, which then finishes or fails in the background without anyone waiting for it). Never rejects.
   */
  const removeStray = async (sessionID: string): Promise<string> => {
    const removal = childRunner.dispose(sessionID).then(
      () => "",
      (error: unknown) => `; removing it failed (${error instanceof Error ? error.message : String(error)})`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`; removing it did not finish within ${STRAY_CLEANUP_TIMEOUT_MS} ms and may still be running`), STRAY_CLEANUP_TIMEOUT_MS);
      if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([removal, timeout]);
    } finally {
      clearTimeout(timer);
    }
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
      // Retained-scope permission prompts remain attributed to the originating
      // real call IDs, never fabricated replacements.
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
      const resumeID = request.resumeSessionID;
      if (resumeID !== undefined) {
        // The host resumes any session id it is given, so ours checks that the child exists and belongs to the
        // calling session before anything is sent. Whatever the lookup says other than "my child", the caller
        // falls back to a fresh child.
        const parent = scope.context.sessionID;
        let info: { parentID?: unknown } | undefined;
        try {
          info = await ctx.session.get({ sessionID: resumeID }, { signal });
        } catch (error) {
          signal.throwIfAborted();
          throw new ResumeRejectedError(resumeID, `session lookup failed (${error instanceof Error ? error.message : String(error)})`);
        }
        if (info?.parentID !== parent) throw new ResumeRejectedError(resumeID, `it is not a child of session ${parent}`);
      }
      // A resumed child is known up front: the host does not create one, and a progress event for another id is an error.
      let childID: string | undefined = resumeID;
      let confirmed = false;
      const confirmChild = async (sessionID: string): Promise<void> => {
        if (confirmed) return;
        confirmed = true;
        await request.onConfirmed?.(sessionID);
      };
      /** Set when the host answered a resume with another child; thrown from `run` whatever the host made of the progress error. */
      let strayResume: ResumeRejectedError | undefined;
      if (resumeID !== undefined) {
        activeChildren.set(resumeID, controller);
        if (request.system) childSystems.set(resumeID, request.system);
      }
      const model = request.model;
      // 2.2 / 2.3 single writer (QA-2.2-1): announce the native call to the 2.2 dispatch router, which must leave it alone
      // (this runner has chosen the agent and model#variant, writes the attempt's row and registers the child itself). Measured on 2.0.22
      // (Phase 3.2, H4): the host runs no plugin tool hook for a call made through `ctx.tool.list()`, so the router never sees it and the
      // mark is withdrawn below unconsumed; it is defensive, for a host that does hook such calls.
      let withdrawMark: (() => void) | undefined;
      try {
        // A resumed child is registered here, before the host can run it, exactly like a created one is in `progress`.
        if (resumeID !== undefined) {
          await request.onCreated(resumeID);
          signal.throwIfAborted();
        }
        withdrawMark = markRunnerDispatch({ parentSessionID: toolContext.sessionID, agent: request.agent ?? V2_GRADER_AGENT, prompt: request.prompt });
        const result = await native.execute({
          agent: request.agent ?? V2_GRADER_AGENT,
          description: runnerDescription(request.agent),
          prompt: request.prompt,
          ...(model ? { model: `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` } : {}),
          ...(resumeID !== undefined ? { sessionID: resumeID } : {}),
          background: false,
        }, {
          ...toolContext,
          signal,
          async progress(metadata) {
            const sessionID = metadata.sessionID;
            if (typeof sessionID === "string" && sessionID !== childID) {
              if (childID) {
                // The host started another child than the one this call is about (a resume that did not resume, or a
                // second child): no caller knows its id, so it is stopped and removed here before the error, or it
                // would live until the host is restarted (QA-2.3-5). The original child is interrupted below.
                // The removal is bounded (QA-2.3-R2-3): a host that hangs on it must not hang the delegation, and the error
                // says so instead of hiding it.
                const cleanup = await removeStray(sessionID);
                if (resumeID !== undefined && childID === resumeID) {
                  // A resume that did not resume: the caller starts a fresh child for the same attempt (D11 fallback)
                  // instead of counting a failed attempt. Kept aside so the host's own wrapping of a progress error
                  // cannot hide the type.
                  strayResume = new ResumeRejectedError(resumeID, `the host started another child (${sessionID}) instead${cleanup}`);
                  throw strayResume;
                }
                throw new Error(`[model-router] native subagent changed its child session ID (${childID} -> ${sessionID}${cleanup})`);
              }
              childID = sessionID;
              activeChildren.set(sessionID, controller);
              if (request.system) childSystems.set(sessionID, request.system);
              // The native subagent awaits progress after creating its child and
              // before prompting it. Register guards and scope graders here.
              await request.onCreated(sessionID);
              if (request.cwd) await ctx.session.move({ sessionID, directory: request.cwd }, { signal });
              signal.throwIfAborted();
            }
            if (typeof sessionID === "string" && sessionID === childID) await confirmChild(sessionID);
            // V2 rejects progress outside a running call. Deferred/queued graders
            // retain settled parent contexts; also tolerate settlement during progress.
            if (scope.active) {
              try { await toolContext.progress(metadata); }
              catch (error) { if (scope.active) throw error; }
            }
          },
        });
        const output = result.output as { sessionID?: unknown; status?: unknown; output?: unknown } | undefined;
        // A named child confirms an attempted resume even when its result failed or was aborted.
        if (childID && output?.sessionID === childID) await confirmChild(childID);
        signal.throwIfAborted();
        if (resumeID !== undefined && typeof output?.sessionID === "string" && output.sessionID !== resumeID) {
          const cleanup = await removeStray(output.sessionID);
          throw new ResumeRejectedError(resumeID, `the host started another child (${output.sessionID}) instead${cleanup}`);
        }
        if (!childID || output?.sessionID !== childID || output.status !== "completed" || typeof output.output !== "string") {
          throw new Error("[model-router] native subagent did not return a completed child result; verification cannot use a pending result");
        }
        await confirmChild(childID);
        return { sessionID: childID, text: output.output };
      } catch (error) {
        controller.abort();
        if (childID) {
          try { await ctx.session.interrupt({ sessionID: childID }); } catch { /* keep the original dispatch failure */ }
        }
        throw strayResume ?? error;
      } finally {
        withdrawMark?.(); // a hook that never fired must not leave a mark behind
        if (childID) {
          childSystems.delete(childID);
          activeChildren.delete(childID);
        }
      }
    },
    async dispose(sessionID) {
      childSystems.delete(sessionID);
      await interrupt(sessionID);
      // Removal was added in 2.0.21; older hosts retain child history.
      // disposeChildSession catches cleanup failures without masking the result.
      if (typeof ctx.session.remove === "function") await ctx.session.remove({ sessionID });
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
