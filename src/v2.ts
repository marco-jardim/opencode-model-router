import type { Plugin } from "@opencode/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import ModelRouterPlugin from "./index";
import { createV2Runtime } from "./compat/v2-client";
import { registerV2Hooks } from "./compat/v2-hooks";

/** Keep the routing engine shared; translate only the host API at this boundary. */
export default {
  id: "opencode-model-router",
  server: ModelRouterPlugin,
  async setup(ctx: Plugin.Context) {
    const runtime = createV2Runtime(ctx);
    // The engine consumes directory/client only. V2 has no legacy HTTP server
    // URL or Bun shell context; do not invent either for the adapter.
    const input = {
      directory: ctx.location.directory,
      worktree: ctx.location.project.directory,
      client: runtime.client,
      routerChildRunner: runtime.childRunner,
    };
    const hooks = await ModelRouterPlugin(input as unknown as PluginInput);
    return registerV2Hooks(ctx, hooks, runtime);
  },
} satisfies Plugin.Plugin & { server: typeof ModelRouterPlugin };
