/** Process-wide, bounded observations of stale role children. No host sessions are changed. */
export type RoleOrphanAction = "refused" | "lost";

export interface RoleOrphanRecord {
  readonly child: string;
  /** Most recent occurrence of each action (epoch ms). */
  readonly refused?: number;
  readonly lost?: number;
}

interface Registry {
  readonly version: 1;
  readonly children: Map<string, RoleOrphanRecord>;
  readonly counters: { refused: number; lost: number };
  noticed: boolean;
  /** Separate from the first-refusal notice; optional for existing copies of the @1 registry. */
  bindingLookupNoticed?: boolean;
}

export const ROLE_ORPHANS_MAX = 512;
const REGISTRY_KEY = Symbol.for("opencode-model-router.role-orphans@1");

function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Registry>;
  return r.version === 1 && r.children instanceof Map && typeof r.noticed === "boolean"
    && typeof r.counters?.refused === "number" && typeof r.counters?.lost === "number";
}

function registry(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (isRegistry(existing)) return existing;
  const created: Registry = { version: 1, children: new Map(), counters: { refused: 0, lost: 0 }, noticed: false };
  Reflect.set(globalThis, REGISTRY_KEY, created);
  return created;
}

/** Records an action; true only for the first refusal in this process (the adapter logs that one at warn). */
export function recordRoleOrphan(child: string, action: RoleOrphanAction, at = Date.now()): boolean {
  const reg = registry();
  const previous = reg.children.get(child);
  reg.children.delete(child);
  reg.children.set(child, { ...previous, child, [action]: at });
  while (reg.children.size > ROLE_ORPHANS_MAX) reg.children.delete(reg.children.keys().next().value!);
  reg.counters[action]++;
  const notice = action === "refused" && !reg.noticed;
  if (notice) reg.noticed = true;
  return notice;
}

/** True once per process for binding-lookup warnings; later lookup failures are debug-only. */
export function takeRoleBindingLookupNotice(): boolean {
  const reg = registry();
  if (reg.bindingLookupNoticed === true) return false;
  reg.bindingLookupNoticed = true;
  return true;
}

/** Detached snapshot for observability; counters include actions whose child record has aged out. */
export function readRoleOrphans(): { records: readonly RoleOrphanRecord[]; counters: Readonly<{ refused: number; lost: number }>; noticed: boolean } {
  const reg = registry();
  return { records: [...reg.children.values()].map((record) => ({ ...record })), counters: { ...reg.counters }, noticed: reg.noticed };
}

/** Test only: clears the shared observations and notice flag. */
export function resetRoleOrphansForTests(): void {
  Reflect.deleteProperty(globalThis, REGISTRY_KEY);
}
