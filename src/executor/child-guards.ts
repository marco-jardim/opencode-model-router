/** Executor children move between plugin locations. Publish rounds process-wide, including across module copies. */
export interface ExecutorChildRound {
  readonly round: number;
  readonly agent: string;
  readonly cap: number | "none" | null;
}

interface Registry {
  version: 1;
  sequence: number;
  children: Map<string, ExecutorChildRound>;
}
const KEY = Symbol.for("opencode-model-router.executor-child-guards@1");

function registry(): Registry {
  const value: unknown = Reflect.get(globalThis, KEY);
  if (typeof value === "object" && value !== null) {
    const existing = value as Partial<Registry>;
    if (existing.version === 1 && typeof existing.sequence === "number" && existing.children instanceof Map) return existing as Registry;
  }
  const created: Registry = { version: 1, sequence: 0, children: new Map() };
  Reflect.set(globalThis, KEY, created);
  return created;
}

export function publishExecutorChildRound(child: string, agent: string, cap: ExecutorChildRound["cap"], resume: boolean): void {
  const reg = registry();
  const previous = reg.children.get(child);
  reg.children.delete(child);
  reg.children.set(child, { round: ++reg.sequence, agent, cap: resume ? cap ?? previous?.cap ?? null : cap });
  while (reg.children.size > 4096) reg.children.delete(reg.children.keys().next().value!);
}

export function executorChildRound(child: string): ExecutorChildRound | undefined {
  return registry().children.get(child);
}

export function forgetExecutorChildRound(child: string): void {
  registry().children.delete(child);
}
