import type { PluginInput } from "@opencode-ai/plugin";
import type { RunnerCatalogModel } from "../escalate/resume";
import type { CatalogModel, Ingest } from "../routing/outcomes/ingest";
import type { HostGenerate } from "../routing/classify/types";

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
  /**
   * Resume this existing child (the host `subagent` call's `sessionID`, D11) instead of creating one: the
   * history is kept, `agent`/`model` switch it when they differ. The runner checks that it is a child of the
   * calling session first and rejects with {@link ResumeRejectedError} otherwise, before anything is sent.
   * `onCreated(resumeSessionID)` runs for a resumed child too (after that check, before the host runs it), so
   * one callback registers every child the request runs on; `cwd` is not applied again.
   */
  resumeSessionID?: string;
  /** Runs before the child can start its first model request. */
  onCreated(sessionID: string): Promise<void>;
  /** Runs once when progress or the completed result confirms which child the host actually ran. */
  onConfirmed?(sessionID: string): Promise<void>;
}

/**
 * A resume that was refused before the child ran: the session is gone, or it is not a child of the calling
 * session. Nothing was sent, so the caller may start a fresh child for the same attempt (D11 fallback).
 */
export class ResumeRejectedError extends Error {
  constructor(readonly sessionID: string, reason: string) {
    super(`[model-router] cannot resume child session ${sessionID}: ${reason}`);
    this.name = "ResumeRejectedError";
  }
}

export interface ChildSessionRunner {
  run(request: ChildSessionRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
}

export type RouterPluginInput = PluginInput & {
  routerChildRunner?: ChildSessionRunner;
  /** Set only by src/v2.ts; absent = v1 host (A3). */
  routerHost?: "v2";
  /**
   * Set only by src/v2.ts: the host model catalog (`ctx.model.list`): prices child steps (A1) and, with its `variants`
   * and `limit`, lets the delegate ladder validate variants and size resumes (D10/D11, Phase 2.3).
   */
  routerCatalog?: () => Promise<readonly (CatalogModel & RunnerCatalogModel)[]>;
  /**
   * Set only by src/v2.ts: the host's agents (`ctx.agent.list().data`, Agent.Info records). The cost doctor (Phase 2.4) reads which
   * agents have a model of their own (title, summary, the role agents) and which tier agents the host offers.
   */
  routerAgents?: () => Promise<readonly unknown[]>;
  /**
   * Set only by src/v2.ts: the host's synthetic transcript entry (`ctx.session.synthetic`, `resume: false`), the call the adapter already uses
   * for its config-reload and narration notices. The cost doctor's notice goes through it, never into the user's message.
   */
  routerSynthetic?: (input: { sessionID: string; text: string; description: string }) => Promise<void>;
  /** Set only by src/v2.ts: the host `generate` (the `host` classifier backend of `/annotate-plan`, A4); absent when the host has none. */
  routerGenerate?: HostGenerate;
  /** Set only by src/v2.ts: receives this plugin instance's telemetry ingest, whose step events the v2 adapter feeds (QA-2.1-7). */
  routerOnIngest?: (ingest: Ingest) => void;
};
