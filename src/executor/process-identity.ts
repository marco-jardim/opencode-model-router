import { hostname } from "node:os";

export interface ProcessIdentity { pid: number; hostname: string; token: string }

/** QA-DF1-21: one journal token for every module copy in this process. Keep the existing global slot and token format. */
const PROCESS_TOKEN_SLOT = Symbol.for("opencode-model-router.v2.process-token");

export function processToken(): string {
  const known: unknown = Reflect.get(globalThis, PROCESS_TOKEN_SLOT);
  if (typeof known === "string") return known;
  const token = `${process.pid.toString(16)}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  Reflect.set(globalThis, PROCESS_TOKEN_SLOT, token);
  return token;
}

/** A later process may reuse the pid, never the token. */
export function processIdentity(): ProcessIdentity {
  return { pid: process.pid, hostname: hostname(), token: processToken() };
}
