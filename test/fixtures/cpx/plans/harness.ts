import { SHIPPED_ROLE_SPECS, type RoleSpec } from "../../../../src/router/roles";
import type { RouteLine } from "../../../../src/routing/classify/types";
import type { AnnotatedPlan, PlanStep } from "../../../../src/routing/engine";
import { CLASS_ROLE_KIND } from "../../../../src/routing/engine/roles-taxonomy";
import type { DurationEstimate, DurationModel } from "../../../../src/routing/outcomes/durations";
import { createPlanCompiler, type CompilerDeps } from "../../../../src/executor/compile/index";
import { repoViewFrom, type RepoView } from "../../../../src/executor/compile/footprint";
import { executorDefaults, type ExecutorConfig, type LedgerV1, type PlanCompiler, type Tier } from "../../../../src/executor/types";
import { readFixture, readRepoViewFixture, stubGit, type RepoViewFixture } from "./loader";

// Shared stubs for the plan-compiler tests: git, fs, annotate, roleOf and durations are all fakes.

export const NOW = "2026-10-11T10:00:00.000Z";
export const FAKE_ROOT = "D:\\fake\\plans";
export const ROUTE_LINE = "[route class=implement risk=low scope=single d=none tier=medium]";

export function planPathOf(name: string): string {
  return `${FAKE_ROOT}\\${name.replace(/\//g, "\\")}`;
}

export function fixtureNameOf(absPath: string): string {
  const prefix = `${FAKE_ROOT}\\`;
  if (!absPath.startsWith(prefix)) throw new Error(`not a fake plan path: ${absPath}`);
  return absPath.slice(prefix.length).replace(/\\/g, "/");
}

export function constantDurations(p50 = 600_000, p90 = 900_000): DurationModel {
  const e: DurationEstimate = { p50, p90, n: 0, source: "prior", p90Source: "prior", p90N: 0 };
  return { estimate: () => e, observe: () => undefined, load: async () => undefined };
}

/** Annotate stub: every step gets the same engine route line; the rest of `AnnotatedStep` is not read by the compiler. */
export function stubAnnotate(calls?: PlanStep[][]): CompilerDeps["annotate"] {
  return async (steps) => {
    calls?.push([...steps]);
    const list = steps.map((s) => ({ id: s.id, tier: "medium", routeLine: ROUTE_LINE, text: s.text, pin: false }));
    return Object.assign(list, { pinnedCount: 0 }) as unknown as AnnotatedPlan;
  };
}

export function stubRoleOf(route: RouteLine | null, tier: Tier | null): RoleSpec {
  const kind = tier === "heavy" && route?.class === undefined ? "review" : CLASS_ROLE_KIND[route?.class ?? "other"];
  const spec = SHIPPED_ROLE_SPECS.find((role) => role.kind === kind)!;
  return { ...spec, agent: `role-${tier ?? "medium"}` };
}

export interface Harness {
  compiler: PlanCompiler;
  deps: CompilerDeps;
  view: RepoViewFixture;
  repoView: RepoView;
  annotateCalls: PlanStep[][];
  config: ExecutorConfig;
}

export interface HarnessOptions {
  /** Extra in-memory plans, keyed by the name used with `planPathOf`. */
  inline?: Record<string, string>;
  view?: Partial<RepoViewFixture>;
}

export function makeHarness(o: HarnessOptions = {}): Harness {
  const view: RepoViewFixture = { ...readRepoViewFixture(), ...o.view };
  const annotateCalls: PlanStep[][] = [];
  const deps: CompilerDeps = {
    fs: {
      readText: async (abs) => {
        const name = fixtureNameOf(abs);
        const inline = o.inline?.[name];
        return inline !== undefined ? inline : readFixture(name);
      },
    },
    git: stubGit(view),
    durations: constantDurations(),
    annotate: stubAnnotate(annotateCalls),
    roleOf: stubRoleOf,
    integrationWorktree: (planId) => `D:\\slots\\${planId}\\integration`,
  };
  return {
    compiler: createPlanCompiler(deps),
    deps,
    view,
    repoView: repoViewFrom({ toplevel: view.toplevel, worktrees: view.worktrees, files: view.files, caseInsensitive: view.caseInsensitive }),
    annotateCalls,
    config: executorDefaults(),
  };
}

export function compileOpts(h: Harness, extra: { phases?: string[]; doneBefore?: string; config?: ExecutorConfig } = {}): {
  phases?: string[];
  doneBefore?: string;
  config: ExecutorConfig;
  orchestratorSessionID: string;
  now: string;
} {
  const base = { config: extra.config ?? h.config, orchestratorSessionID: "ses_test", now: NOW };
  return {
    ...base,
    ...(extra.phases !== undefined ? { phases: extra.phases } : {}),
    ...(extra.doneBefore !== undefined ? { doneBefore: extra.doneBefore } : {}),
  };
}

export function taskIds(l: LedgerV1): string[] {
  return Object.keys(l.tasks);
}

export function edgeKeys(l: LedgerV1): string[] {
  return l.edges.map((e) => `${e.from}>${e.to}`);
}
