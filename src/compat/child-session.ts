import type { PluginInput } from "@opencode-ai/plugin";
import type { CatalogModel, Ingest } from "../routing/outcomes/ingest";

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
  /** Set only by src/v2.ts: the host model catalog (`ctx.model.list`), used to price child steps (A1). */
  routerCatalog?: () => Promise<readonly CatalogModel[]>;
  /** Set only by src/v2.ts: receives this plugin instance's telemetry ingest, whose step events the v2 adapter feeds (QA-2.1-7). */
  routerOnIngest?: (ingest: Ingest) => void;
};
