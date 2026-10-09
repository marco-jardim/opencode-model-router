/**
 * #90 P1.3 (amendment A2): the subset of the OpenCode v2 TUI plugin context the status plugin reads, typed
 * structurally so the shipped code imports no host package. Shapes copied from `@opencode/plugin/tui` `Context`,
 * `SlotMap`, `SlotClaim`, `Data` and `UI` (v2.0.24 `packages/plugin/src/tui/context.ts`, unchanged through 2.0.26).
 *
 * Every member is optional: the plugin feature-detects each one at runtime, and a missing member turns off what needs
 * it (never a throw). No imports and no runtime code on purpose.
 */

/** `SlotMap["prompt.footer.status"]` (`PromptFooterInput`): `sessionID` is absent on the home/new-session prompt. */
export interface PromptFooterInput {
  readonly sessionID?: string;
  readonly mode?: "normal" | "shell";
  readonly showDetails?: boolean;
}

/** `SlotMap["session.composer.top"]`: rendered in root and child session views. */
export interface ComposerTopInput {
  readonly sessionID: string;
}

/**
 * The `SlotClaim`s the plugin makes (placement `append`). The host calls `render` once, untracked, with reactive
 * props; it returns a host element (`JSX.Element` on the host side).
 */
export type HostSlotClaim =
  | { readonly append: "prompt.footer.status"; readonly render: (input: PromptFooterInput) => unknown }
  | { readonly append: "session.composer.top"; readonly render: (input: ComposerTopInput) => unknown };

/** `Model.Ref`. */
export interface HostModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** Epoch milliseconds, or an Effect `DateTime.Utc`. */
export type HostTime = number | { readonly epochMilliseconds: number };

/** The read subset of `SessionInfo`. */
export interface HostSession {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly model?: HostModelRef;
  readonly time?: { readonly created?: HostTime | null };
  /** `LocationRef`: passed as is to the rpc call options and to `data.location.model.list`. */
  readonly location?: unknown;
}

/** The read subset of `SessionMessageInfo` (tagged by `type`; assistant messages carry `agent` and `model`). */
export interface HostMessage {
  readonly id: string;
  readonly type?: string;
  readonly role?: string;
  readonly agent?: string;
  readonly model?: HostModelRef;
  readonly time?: { readonly created?: HostTime | null };
}

/** The read subset of an entry of `data.location.model.list()`. */
export interface HostModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly name?: string;
  readonly variants?: ReadonlyArray<{ readonly id: string }>;
}

export type HostSessionStatus = "idle" | "running";

/** `Data` (reactive when read in a Solid computation). */
export interface HostData {
  readonly session?: {
    get?(sessionID: string): HostSession | undefined;
    family?(sessionID: string): readonly string[];
    status?(sessionID: string): HostSessionStatus;
    readonly message?: {
      list?(sessionID: string): readonly HostMessage[];
      sync?(sessionID: string): Promise<void>;
    };
  };
  readonly location?: {
    readonly model?: {
      /** Undefined while the location's list is not loaded. */
      list?(location?: unknown): readonly HostModelInfo[] | undefined;
      sync?(location?: unknown): Promise<void>;
    };
  };
}

export type HostToastVariant = "info" | "success" | "warning" | "error";

/** `Toast`. */
export interface HostToast {
  show?(options: {
    readonly title?: string;
    readonly message: string;
    readonly variant?: HostToastVariant;
    readonly duration?: number;
  }): void;
}

/** `ui.model.current()`: the prompt's selected model; `variant` is absent for the model default. */
export interface HostCurrentModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

/** `UI`. `slot` returns its dispose function. */
export interface HostUI {
  readonly toast?: HostToast;
  readonly model?: {
    current?(): HostCurrentModel | undefined;
  };
  readonly slot?: (claim: HostSlotClaim) => unknown;
}

/** A plugin rpc definition, as passed to `client.rpc(definition)`. */
export interface HostRpcDefinition {
  readonly id: string;
  readonly methods: object;
  readonly events: object;
}

/** `OpenCodeClient`: `rpc(definition)` returns a client with one method per definition method. */
export interface HostClient {
  rpc?(definition: HostRpcDefinition): unknown;
}

export type HostResizeListener = (...args: unknown[]) => void;

/** `CliRenderer` (an event emitter): its width in columns and its `resize` event. */
export interface HostRenderer {
  readonly width?: number;
  on?(event: "resize", listener: HostResizeListener): unknown;
  off?(event: "resize", listener: HostResizeListener): unknown;
}

/** `ResolvedTheme`: only the muted text colour is read. */
export interface HostTheme {
  readonly textMuted?: unknown;
}

/** `Context` (the TUI plugin `setup` argument). `options` is whatever the user configured. */
export interface HostContext {
  readonly options?: unknown;
  readonly renderer?: HostRenderer;
  readonly client?: HostClient;
  readonly data?: HostData;
  readonly theme?: HostTheme;
  readonly ui?: HostUI;
}
