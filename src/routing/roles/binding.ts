/**
 * Child-session binding contracts (plan §2.4, spikes amendment P-2). Pure.
 *
 * A dispatch registers a pending entry (keyed by parent + callID); the first
 * context hook of the child session binds it: exact when one candidate matches,
 * intersection when ambiguous, unknown when none (unbound → max ∩ local).
 *
 * Every body is a total, fail-closed placeholder (empty grant, no state) until
 * T1.6.1 completes the registry, matching and eviction.
 */

import type { AuthorityAction } from "../../router/roles";
import type { DispatchGrant } from "./policy";

export interface PendingDispatch {
  parentSessionID: string;
  callID: string;
  agent: string;
  description: string;
  /** Router-inserted per-dispatch nonce (P-2). */
  nonce: string;
  grant: DispatchGrant;
  budget: number;
  decisionID: string | null;
  registeredAt: number;
}

export type SessionLookup = (
  id: string,
) => Promise<{ parentID?: string; agent?: string; title?: string; firstText?: string } | undefined>;

export interface Binding {
  childSessionID: string;
  kind: "exact" | "intersection" | "unknown";
  grant: DispatchGrant;
  /** callIDs of the pending dispatches that matched. */
  candidates: readonly string[];
  decisionID: string | null;
}

function emptyGrant(note: string): DispatchGrant {
  return { actions: new Set<AuthorityAction>(), notes: [note], workRoot: null };
}

/** Registers a dispatch, keyed by parent + callID. No-op until T1.6.1. */
export function registerPending(_entry: PendingDispatch): void {}

/**
 * Binds a child session to its dispatch. Ambiguous → intersection, unknown →
 * local. Placeholder: always unknown with an empty grant until T1.6.1.
 */
export async function bind(childSessionID: string, _getSession: SessionLookup): Promise<Binding> {
  return {
    childSessionID,
    kind: "unknown",
    grant: emptyGrant("binding not implemented"),
    candidates: [],
    decisionID: null,
  };
}

/** Widens the grant of a bound child. Placeholder: empty grant until T1.6.1. */
export function widen(_childSessionID: string, _actions: readonly AuthorityAction[]): DispatchGrant {
  return emptyGrant("binding not implemented");
}

/** Drops a session's or call's binding state. No-op until T1.6.1. */
export function evict(_sessionOrCallID: string): void {}
