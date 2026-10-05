import type { PluginInput } from "@opencode-ai/plugin";

/** Marks the legacy tool.execute.before output bag when verification starts for
 * that task call. V1 hosts read only output.args, so this symbol is invisible. */
export const TASK_VERIFICATION = Symbol.for("opencode-model-router.task-verification");

/** An advisory depth banner for this call; the v2 bridge delivers it. */
export const DEPTH_BANNER = Symbol.for("opencode-model-router.depth-banner");

/** A host-owned child lifecycle, so v2 never fabricates REST sessions or IDs. */
export interface ChildSessionRequest {
  parentSessionID?: string;
  cwd?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  /** Runs before the child can start its first model request. */
  onCreated(sessionID: string): Promise<void>;
}

export interface ChildSessionRunner {
  run(request: ChildSessionRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
}

export type RouterPluginInput = PluginInput & {
  routerChildRunner?: ChildSessionRunner;
  /** Set only by src/v2.ts; absent = v1 host (A3). */
  routerHost?: "v2";
};
