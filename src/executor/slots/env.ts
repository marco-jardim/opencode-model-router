/**
 * Slot environment (Phase 2.4.5, memo section 6).
 *
 * A child process whose working directory is inside a registered executor slot gets that
 * slot's virtual environment and `node_modules/.bin` first on PATH, and loses the variables
 * that can make it import another checkout's code. The registry is empty unless a v2 executor
 * pool registered slots, so outside a slot (and on Claude Code v1) nothing changes.
 *
 * Imports only node built-ins and git-tools helpers: `router/run-tools` and `verify/exec`
 * import this module, so it must not pull in any executor runtime.
 */
import { realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { envLookup, isInside } from "../../router/git-tools";

export interface SlotEnv {
  root: string;
  /** VIRTUAL_ENV, only when a Python manager is present. */
  set: Readonly<Record<string, string>>;
  /** `<root>\.venv\Scripts` or `.venv/bin` (Python), `<root>\node_modules\.bin` (Node). */
  prependPath: readonly string[];
  /** PYTHONPATH, PYTHONHOME, NODE_PATH, UV_PROJECT_ENVIRONMENT. */
  unset: readonly string[];
}

interface RegisteredSlot {
  /** The native real path of the slot root. */
  root: string;
  managers: readonly string[];
}

const REGISTRY_KEY = Symbol.for("omr.executor.slots");
const PYTHON_MANAGERS: ReadonlySet<string> = new Set(["pip", "uv", "poetry"]);
const NODE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn"]);
const UNSET_NAMES: readonly string[] = ["PYTHONPATH", "PYTHONHOME", "NODE_PATH", "UV_PROJECT_ENVIRONMENT"];

/** One registry shared by every copy of this module in the process; a foreign value is replaced. */
function registry(): Map<string, RegisteredSlot> {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (existing instanceof Map) return existing as Map<string, RegisteredSlot>;
  const created = new Map<string, RegisteredSlot>();
  Reflect.set(globalThis, REGISTRY_KEY, created);
  return created;
}

function realOrResolved(path: string): string {
  const resolved = nodePath.resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    // A missing or unreadable path has no real form yet; the lexical form is the best key.
    return resolved;
  }
}

function fold(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path;
}

/** A slot became usable (pool states ready, leased, resetting, provisioning). */
export function registerSlot(r: { root: string; managers: readonly string[] }): void {
  const real = realOrResolved(r.root);
  registry().set(fold(real, process.platform), { root: real, managers: [...r.managers] });
}

/** A slot is gone or unusable (pool states broken, retired). */
export function unregisterSlot(root: string): void {
  registry().delete(fold(realOrResolved(root), process.platform));
}

function buildSlotEnv(slot: RegisteredSlot, platform: NodeJS.Platform): SlotEnv {
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const set: Record<string, string> = {};
  const prependPath: string[] = [];
  if (slot.managers.some((m) => PYTHON_MANAGERS.has(m))) {
    const venv = p.join(slot.root, ".venv");
    set.VIRTUAL_ENV = venv;
    prependPath.push(p.join(venv, platform === "win32" ? "Scripts" : "bin"));
  }
  if (slot.managers.some((m) => NODE_MANAGERS.has(m))) {
    prependPath.push(p.join(slot.root, "node_modules", ".bin"));
  }
  return { root: slot.root, set, prependPath, unset: UNSET_NAMES };
}

/**
 * The environment adjustments for `cwd`, or null when `cwd` is not inside a registered slot.
 * cwd -> resolve -> native realpath (fallback: resolve) -> fold on win32; a match is a root
 * itself or a path inside it. The empty registry returns before any disk access.
 */
export function slotEnvFor(cwd: string, platform: NodeJS.Platform = process.platform): SlotEnv | null {
  const slots = registry();
  if (slots.size === 0) return null;
  const here = fold(realOrResolved(cwd), platform);
  for (const [key, slot] of slots) {
    if (here === key || isInside(key, here)) return buildSlotEnv(slot, platform);
  }
  return null;
}

// verify/exec.ts is loaded alone under Node's type stripping and cannot import this module, so
// it finds these two functions on globalThis (the registry above works the same way).
Reflect.set(globalThis, Symbol.for("omr.executor.slotEnvHook"), { slotEnvFor, applySlotEnv });

/**
 * null returns `env` itself (same object). Otherwise a COPY: the unset names are deleted
 * (case-insensitively on win32), `set` is applied, and the slot directories are prepended to
 * the existing PATH key (other-case duplicates deleted).
 */
export function applySlotEnv(env: NodeJS.ProcessEnv, s: SlotEnv | null, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (s === null) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  const win = platform === "win32";
  const named = (name: string): string[] =>
    Object.keys(out).filter((k) => (win ? k.toLowerCase() === name.toLowerCase() : k === name));

  for (const name of s.unset) for (const key of named(name)) delete out[key];
  for (const [name, value] of Object.entries(s.set)) {
    for (const key of named(name)) delete out[key];
    out[name] = value;
  }

  if (s.prependPath.length > 0) {
    const existing = envLookup(out, "PATH");
    const keys = named("PATH");
    const key = keys.find((k) => out[k] === existing) ?? keys[0] ?? "PATH";
    for (const other of keys) if (other !== key) delete out[other];
    const parts = [...s.prependPath, ...(existing === undefined || existing === "" ? [] : [existing])];
    out[key] = parts.join(win ? ";" : ":");
  }
  return out;
}
