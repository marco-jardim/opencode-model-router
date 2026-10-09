/**
 * #90 P1.2 (amendment A1): the server→TUI effort channel, as a plain rpc definition shared by the v2 server plugin (which
 * registers it, src/compat/v2-hooks.ts) and the TUI entry (which calls it). No imports on purpose: the TUI entry loads this
 * file as is, so it must not pull the server side (or any host package) in.
 *
 * `effortOf({ sessionID })` answers what the router's own `chat.params` bridge applied to that session's latest turn (root and
 * child sessions alike); `{}` when nothing is known.
 */
export const effortRpc = {
  id: "opencode-model-router.effort",
  methods: {
    effortOf: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          effort: { type: "string" },
          variant: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          agent: { type: "string" },
          at: { type: "number" },
          thinkingBudget: { type: "number" },
        },
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const;

export type EffortRpc = typeof effortRpc;

/** The input of `effortOf`. */
export interface EffortOfInput {
  readonly sessionID: string;
}

/** The output of `effortOf`; every field is absent when unknown (`{}` for a session the router never saw). */
export interface EffortOfOutput {
  /**
   * The effort the turn's request carried after the router's hook: the Anthropic `effort` key first for a Claude model,
   * `reasoningEffort` first for any other (each falling back to the other).
   */
  readonly effort?: string;
  /** The turn's model variant (`Model.Ref.variant`). */
  readonly variant?: string;
  readonly providerID?: string;
  readonly modelID?: string;
  readonly agent?: string;
  /** When the turn was recorded (epoch ms). */
  readonly at?: number;
  /** The Anthropic thinking budget the request carried (`thinking: { type: "enabled", budgetTokens }`), a positive integer. */
  readonly thinkingBudget?: number;
}
