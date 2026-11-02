import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { ResumeRejectedError, type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { configSourcesFingerprint, invalidateConfigCache, overridePath, type TierConfig } from "../../src/router/config";
import { emptyAdaptiveSnapshot } from "../../src/router/adaptive";
import { adaptiveStatePath, resetAdaptiveViewCache } from "../../src/router/adaptive-store";
import { lookupDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import type { RunnerCatalogModel } from "../../src/escalate/resume";

// ---------------------------------------------------------------------------
// Causal RED on the DELEGATE TASK-START MODEL BINDING (slice A2), driven
// through the REAL delegate tool of the real plugin factory (the harness of
// test/integration/routing-ladder-resume.test.ts, reduced to this scenario).
//
// Confirmed defect (src/index.ts delegate, ~1800): the weekly overlay is a
// per-child-exec override computed right before runChild, so
//   * a RESUMED attempt falls back to attemptPlan.model (the planned file
//     model G) and the registry/attribution records G, while only the first
//     fresh child ever saw the assignment A, and
//   * a weekly snapshot that lands BETWEEN attempts re-binds later fresh
//     attempts of the SAME task to the new assignment B.
//
// The fix must bind ONE immutable effective config at TASK START, BEFORE the
// ladder plan is generated: every attempt (fresh or resumed), the attribution
// rows and the producer registration keep the models the task started with;
// the ladder's EXPLICIT effort/tier escalation still runs the escalated tier's
// own assignment; the global config object is never mutated.
//
// No network, no host, no live models; HOME and every directory are temp.
// ---------------------------------------------------------------------------

const BASE = "base/g";
const MED_BASE = "base/gm";
const A_MODEL = "cand/a-model";
const M_MODEL = "cand/m-model";
const B_MODEL = "cand/b-model";

const fullTier = (tier: TierConfig): TierConfig => ({ description: "test tier", whenToUse: ["testing"], ...tier } as TierConfig);

function model(id: string, variants: string[]): RunnerCatalogModel {
  const [providerID, ...rest] = id.split("/");
  return {
    providerID: providerID!,
    id: rest.join("/"),
    variants: variants.map((name) => ({ id: name })),
    limit: { input: 1_000_000, context: 1_000_000, output: 4_096 },
  };
}
const CATALOG = (): RunnerCatalogModel[] => [
  model(BASE, ["low", "medium", "high", "xhigh", "max"]),
  model(MED_BASE, ["low", "medium", "high", "xhigh", "max"]),
  model(A_MODEL, ["low", "medium", "high", "xhigh", "max"]),
  model(M_MODEL, ["low", "medium", "high", "xhigh", "max"]),
  model(B_MODEL, ["low", "medium", "high", "xhigh", "max"]),
];

interface Run {
  readonly sid: string;
  readonly agent: string | undefined;
  readonly model: ChildSessionRequest["model"];
  readonly resumeSessionID: string | undefined;
}

describe("delegate: one immutable adaptive binding per task (slice A2)", { timeout: 20_000 }, () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adaptive-bind-"));
    dirs.push(dir);
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    resetDispatchRegistry();
    resetIngestState();
    invalidateConfigCache();
    resetAdaptiveViewCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const dispose of instances.splice(0)) await dispose();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    resetDispatchRegistry();
    resetIngestState();
    resetAdaptiveViewCache();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function writeConfig(): void {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(
      overridePath(),
      JSON.stringify({
        activePreset: "tst",
        presets: {
          tst: {
            fast: fullTier({ model: BASE, variant: "low", costRatio: 1 }),
            medium: fullTier({ model: MED_BASE, variant: "high", costRatio: 5 }),
          },
        },
        routing: {},
        adaptiveRouting: { managedTiers: { tst: ["fast", "medium"] }, local: false },
        enforcement: { escalate: { maxTotalAttempts: 6, costCeiling: { multiple: 100 } }, verify: {} },
      }),
      "utf-8",
    );
    invalidateConfigCache();
  }

  /** Write the fingerprint-current weekly snapshot. `fast` gets `fastModel#fastVariant`. */
  function writeSnapshot(fastModel: string, fastVariant: string, mediumModel = M_MODEL): void {
    const path = adaptiveStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const snapshot = {
      ...emptyAdaptiveSnapshot(1, configSourcesFingerprint(dir), new Date().toISOString()),
      assignments: {
        tst: {
          fast: { model: fastModel, variant: fastVariant },
          medium: { model: mediumModel, variant: "high" },
        },
      },
    };
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
    resetAdaptiveViewCache();
  }

  async function setup(opts: { verdicts: boolean[]; rejectResume?: boolean; during?: (attempt: number) => void }) {
    writeConfig();
    // The assignment sits at the TOP of the candidate model's variant ladder, so a
    // failed gate walks: fresh run -> plain retry on the SAME child -> explicit
    // medium escalation (the harness shape of routing-ladder-resume.test.ts).
    writeSnapshot(A_MODEL, "xhigh");

    const runs: Run[] = [];
    const events: string[] = [];
    const verdicts = [...opts.verdicts];
    let ingest: Ingest | undefined;
    let attempt = 0;
    let counter = 0;

    const childRunner = {
      async run(request: ChildSessionRequest) {
        if (request.system !== undefined) {
          const sid = `grader-${counter++}`;
          await request.onCreated(sid);
          return { sessionID: sid, text: JSON.stringify({ pass: verdicts.shift() ?? false, reasons: ["scripted verdict"] }) };
        }
        attempt += 1;
        const resume = request.resumeSessionID;
        let sid: string;
        if (resume !== undefined) {
          events.push(`resume:${resume}`);
          if (opts.rejectResume === true) throw new ResumeRejectedError(resume, "the host refused");
          sid = resume;
        } else {
          sid = `child-${events.filter((e) => e.startsWith("create:")).length + 1}`;
          events.push(`create:${sid}`);
        }
        await request.onCreated(sid);
        await request.onConfirmed?.(sid);
        runs.push({ sid, agent: request.agent, model: request.model, resumeSessionID: resume });
        opts.during?.(attempt);
        await ingest?.onStepEnded({
          id: `step-${sid}-${attempt}`,
          type: "session.step.ended",
          data: {
            sessionID: sid,
            assistantMessageID: `m${attempt}`,
            finish: "stop",
            cost: 0,
            tokens: { input: 5_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        });
        ingest?.onExecutionEnded(sid);
        return { sessionID: sid, text: "producer output" };
      },
      async dispose(sid: string) {
        events.push(`dispose:${sid}`);
      },
    };

    const ctx = {
      directory: dir,
      worktree: dir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
          create: async () => ({ data: { id: `v1-child-${counter++}` } }),
          prompt: async () => ({ data: { parts: [{ type: "text", text: "producer output" }] } }),
          delete: async () => ({}),
        },
      },
      routerHost: "v2" as const,
      routerChildRunner: childRunner,
      routerCatalog: async () => CATALOG(),
      routerOnIngest: (created: Ingest) => { ingest = created; },
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as {
      tool: { delegate: { execute(args: Record<string, unknown>, ctx?: { sessionID?: string }): Promise<string> } };
      "chat.params"(input: unknown, output: Record<string, unknown>): Promise<void>;
      dispose(): Promise<void>;
    };
    instances.push(() => hooks.dispose());
    return {
      runs,
      run: () =>
        hooks.tool.delegate.execute(
          { tier: "fast", task: "VERIFY:required\ndo x", acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" },
          { sessionID: "orchestrator" },
        ),
    };
  }

  it("binds the snapshot assignment at task start: resumes, escalations, attribution and mid-task snapshot changes keep it", async () => {
    const attributed: Array<string | null> = [];
    const t = await setup({
      verdicts: [false, false, true],
      during: (attempt) => {
        const sid = `child-1`;
        const record = lookupDispatch(sid);
        if (record !== undefined) attributed.push(record.model ?? null);
        // The weekly snapshot changes A -> B between attempts of THIS task.
        if (attempt === 1) writeSnapshot(B_MODEL, "xhigh");
      },
    });
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");

    // One immutable binding: the fresh attempt, the resumed variant step and the
    // explicit medium escalation all run the models the task started with.
    expect(t.runs.map((r) => [r.sid, r.agent, r.resumeSessionID, r.model?.providerID, r.model?.modelID, r.model?.variant])).toEqual([
      ["child-1", "fast", undefined, "cand", "a-model", "xhigh"],
      ["child-1", "fast", "child-1", "cand", "a-model", "xhigh"],
      ["child-1", "medium", "child-1", "cand", "m-model", "high"],
    ]);
    // The registry/attribution rows carry the actual bound models, not the file fallback G.
    expect(attributed).toEqual([A_MODEL, A_MODEL, M_MODEL]);
  });

  it("a resume the host refuses starts a fresh child that still keeps the task-start binding, not the mid-task snapshot", async () => {
    const t = await setup({
      verdicts: [false, true],
      rejectResume: true,
      during: (attempt) => {
        if (attempt === 1) writeSnapshot(B_MODEL, "xhigh");
      },
    });
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs.map((r) => [r.sid, r.agent, r.resumeSessionID, r.model?.modelID, r.model?.variant])).toEqual([
      ["child-1", "fast", undefined, "a-model", "xhigh"],
      ["child-2", "fast", undefined, "a-model", "xhigh"],
    ]);
  });
});
