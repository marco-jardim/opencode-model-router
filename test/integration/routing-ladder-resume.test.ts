/**
 * Phase 2.3 (M5 in `delegate`): the ladder resumes the producer child on OpenCode v2.
 *
 * Drives the REAL plugin factory with a fake v2 context: a child runner that records every `run` request (agent,
 * model#variant, resumeSessionID, prompt), a model catalog with variants and limits, and the plugin's own telemetry
 * ingest fed with `session.step.ended` events. No network, no host, no live models. Every directory is a temp
 * directory; HOME is redirected so config files never touch ~/.config/opencode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { ResumeRejectedError, type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, type EnforcementConfig, type TierConfig } from "../../src/router/config";
import { dispatchCount, lookupDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { acquireOutcomes, makeKey, type DecisionRow, type VerdictRow } from "../../src/routing/outcomes";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import type { RunnerCatalogModel } from "../../src/escalate/resume";

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

type Hooks = {
  tool: { delegate: { execute(args: Record<string, unknown>, ctx?: { sessionID?: string }): Promise<string> } };
  dispose(): Promise<void>;
  "chat.params"(input: unknown, output: Record<string, unknown>): Promise<void>;
};

interface Run {
  readonly kind: "producer";
  readonly sid: string;
  readonly agent: string | undefined;
  readonly model: ChildSessionRequest["model"];
  readonly resumeSessionID: string | undefined;
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}

interface Scenario {
  readonly tiers: Record<string, TierConfig>;
  readonly escalate?: EnforcementConfig["escalate"];
  /** `undefined` = no routing block at all (A15). */
  readonly routing?: Record<string, unknown>;
  readonly verify?: Record<string, unknown>;
  /** One verdict per grader call, in order; false once the list is exhausted. */
  readonly verdicts: boolean[];
  /** Context a producer reports on its last step, per attempt (default 5 000 tokens). */
  readonly contextTokens?: (attempt: number) => number;
  readonly catalog?: RunnerCatalogModel[];
  /** The fake host refuses every resume (not a child / gone). */
  readonly rejectResume?: boolean;
  /** Run `fn` while attempt `n` runs (n = 1-based producer attempt). */
  readonly during?: (attempt: number, sid: string) => void;
  /** Never settle the producer of attempt `n` (it only ends when its signal aborts). */
  readonly hangAttempt?: number;
  /**
   * When the host's `session.execution.*` event for a producer reaches the plugin: right after its last step event
   * (default), 300 ms after the producer returned (the runner has to wait for it), or never.
   */
  readonly executionEnd?: "immediate" | "late" | "never";
}

const fullTier = (tier: TierConfig): TierConfig => ({ description: "test tier", whenToUse: ["testing"], ...tier } as TierConfig);

function model(id: string, variants: string[], input: number): RunnerCatalogModel {
  const [providerID, ...rest] = id.split("/");
  return { providerID: providerID!, id: rest.join("/"), variants: variants.map((name) => ({ id: name })), limit: { input, context: input, output: 4_096 } };
}
const defaultCatalog = (): RunnerCatalogModel[] => [
  model(SONNET, ["low", "medium", "high", "xhigh", "max"], 1_000_000),
  model(OPUS, ["low", "medium", "high", "xhigh", "max"], 1_000_000),
];

const OWNER: Record<string, TierConfig> = {
  fast: { model: SONNET, variant: "low", costRatio: 1 },
  medium: { model: SONNET, variant: "medium", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};

describe("delegate ladder: resume on v2 (Phase 2.3, D10/D11)", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Hooks[] = [];
  const dirs: string[] = [];
  /** Delayed `session.execution.*` events still pending; cleared per test so one never lands in the next. */
  const lateEnds: Array<ReturnType<typeof setTimeout>> = [];
  let counter = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ladder-resume-"));
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
  });

  afterEach(async () => {
    for (const timer of lateEnds.splice(0)) clearTimeout(timer);
    for (const hooks of instances.splice(0)) await hooks.dispose();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    resetDispatchRegistry();
    resetIngestState();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function configure(s: Scenario): void {
    mkdirSync(dirname(overridePath()), { recursive: true });
    const presets = { tst: Object.fromEntries(Object.entries(s.tiers).map(([name, tier]) => [name, fullTier(tier)])) };
    writeFileSync(overridePath(), JSON.stringify({
      activePreset: "tst",
      presets,
      ...(s.routing === undefined ? {} : { routing: s.routing }),
      enforcement: { escalate: s.escalate ?? {}, verify: s.verify ?? {} },
    }));
    invalidateConfigCache();
  }

  async function setup(s: Scenario) {
    configure(s);
    const events: string[] = [];
    const runs: Run[] = [];
    const created: string[] = [];
    const disposed: string[] = [];
    const interrupted: string[] = [];
    const verdicts = [...s.verdicts];
    const catalog = s.catalog ?? defaultCatalog();
    let catalogCalls = 0;
    let ingest: Ingest | undefined;
    let hooks!: Hooks;
    let attempt = 0;

    async function params(sessionID: string, agent: string | undefined, m: ChildSessionRequest["model"]): Promise<Record<string, unknown>> {
      const options: Record<string, unknown> = {};
      await hooks["chat.params"]({ sessionID, agent, model: m && { providerID: m.providerID, id: m.modelID } }, options);
      return options;
    }

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
          if (s.rejectResume === true) throw new ResumeRejectedError(resume, "the host refused");
          sid = resume;
        } else {
          sid = `child-${created.length + 1}`;
          created.push(sid);
          events.push(`create:${sid}`);
        }
        await request.onCreated(sid);
        const options = await params(sid, request.agent, request.model);
        runs.push({ kind: "producer", sid, agent: request.agent, model: request.model, resumeSessionID: resume, prompt: request.prompt, options });
        s.during?.(attempt, sid);
        if (s.hangAttempt === attempt) {
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => { interrupted.push(sid); reject(request.signal?.reason ?? new Error("aborted")); }, { once: true });
          });
        }
        // The host publishes the step's usage on the event stream before the tool call returns.
        await ingest?.onStepEnded({
          id: `step-${sid}-${attempt}`,
          type: "session.step.ended",
          data: { sessionID: sid, assistantMessageID: `m${attempt}`, finish: "stop", cost: 0, tokens: { input: (s.contextTokens ?? (() => 5_000))(attempt), output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
        });
        const endMode = s.executionEnd ?? "immediate";
        if (endMode === "immediate") ingest?.onExecutionEnded(sid);
        else if (endMode === "late") lateEnds.push(setTimeout(() => ingest?.onExecutionEnded(sid), 300));
        return { sessionID: sid, text: "producer output" };
      },
      async dispose(sid: string) {
        disposed.push(sid);
        events.push(`dispose:${sid}`);
      },
    };

    const ctx = {
      directory: dir, worktree: dir,
      client: { session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
        create: async () => ({ data: { id: `v1-child-${counter++}` } }),
        prompt: async (request: { path: { id: string }; body: { agent?: string; system?: string; parts: Array<{ text: string }> } }) => {
          if (request.body.system !== undefined) return { data: { parts: [{ type: "text", text: JSON.stringify({ pass: verdicts.shift() ?? false, reasons: ["scripted verdict"] }) }] } };
          events.push(`v1-prompt:${request.path.id}:${request.body.agent}`);
          return { data: { parts: [{ type: "text", text: "producer output" }] } };
        },
        delete: async () => ({}),
      } },
      routerHost: "v2" as const,
      routerChildRunner: childRunner,
      routerCatalog: async () => { catalogCalls += 1; return catalog; },
      routerOnIngest: (created: Ingest) => { ingest = created; },
    };
    hooks = await ModelRouterPlugin(ctx as unknown as RouterPluginInput) as unknown as Hooks;
    instances.push(hooks);
    return {
      hooks, runs, created, disposed, interrupted, events, catalog,
      catalogCalls: () => catalogCalls,
      run: (task = "VERIFY:required\ndo x") => hooks.tool.delegate.execute(
        { tier: "fast", task, acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" },
        { sessionID: "orchestrator" },
      ),
    };
  }

  const FORCING = "[router escalation] previous attempt did not pass verification:\n- scripted verdict\nNEXT: retry with these failures addressed.";

  describe("variant steps", () => {
    it("a failed verification resumes the same child with model#nextVariant and the forcing message as the prompt", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true] });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      expect(t.runs.map((r) => [r.sid, r.agent, r.resumeSessionID, r.model?.variant])).toEqual([
        ["child-1", "fast", undefined, "low"],
        ["child-1", "fast", "child-1", "medium"],
      ]);
      expect(t.runs[1]!.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" });
      expect(t.created).toEqual(["child-1"]); // one child session for both attempts
      expect(t.runs[1]!.prompt).toBe(`${FORCING}\n\ndo x`.replace("do x", "VERIFY:required\ndo x"));
      expect(t.runs[1]!.prompt.split("[router escalation]")).toHaveLength(2); // the forcing message is not duplicated
      expect(t.disposed.filter((sid) => sid === "child-1")).toEqual(["child-1"]); // disposed once, at the end
      expect(t.events.indexOf("dispose:child-1")).toBeGreaterThan(t.events.indexOf("resume:child-1"));
    });

    it("each attempt is its own registration with its step label, model and variant", async () => {
      const seen: Array<{ step: string; variant: string | null; attemptIndex: number; attemptId: string; model: string | null }> = [];
      const t = await setup({
        tiers: OWNER, routing: {}, verdicts: [false, false, true], escalate: { maxTotalAttempts: 8, costCeiling: { multiple: 100 } },
        during: (_attempt, sid) => {
          const record = lookupDispatch(sid);
          if (record !== undefined) seen.push({ step: record.step, variant: record.variant, attemptIndex: record.attemptIndex, attemptId: record.attemptId, model: record.model });
        },
      });
      await t.run();
      expect(t.runs.map((r) => r.model?.variant)).toEqual(["low", "medium", "high"]);
      expect(seen.map((r) => [r.step, r.variant, r.attemptIndex, r.model])).toEqual([
        ["dispatch", "low", 0, SONNET],
        ["variant", "medium", 1, SONNET],
        ["variant", "high", 2, SONNET],
      ]);
      expect(new Set(seen.map((r) => r.attemptId)).size).toBe(3); // distinct attempt ids on one child
    });

    it("walks the variants of one model on one child, then escalates the agent on the same child while under the threshold", async () => {
      const t = await setup({
        tiers: { fast: { model: SONNET, variant: "xhigh", costRatio: 1 }, medium: { model: OPUS, variant: "high", costRatio: 5 }, heavy: { model: OPUS, variant: "xhigh", costRatio: 20 } },
        routing: {}, escalate: { maxTotalAttempts: 6, costCeiling: { multiple: 100 } }, verdicts: [false, false, true],
      });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      // fast@xhigh is the top of sonnet's ladder: one plain retry (maxAttemptsPerTier 1), then medium on opus.
      expect(t.runs.map((r) => [r.agent, r.model?.modelID, r.model?.variant, r.resumeSessionID])).toEqual([
        ["fast", "claude-sonnet-5-5", "xhigh", undefined],
        ["fast", "claude-sonnet-5-5", "xhigh", "child-1"],
        ["medium", "claude-opus-5-5", "high", "child-1"],
      ]);
      expect(t.created).toEqual(["child-1"]);
      expect(lookupDispatch("child-1")).toMatchObject({ step: "escalate", agent: "medium", tier: "medium", model: OPUS, variant: "high" });
    });

    it("A17a: an escalation into a tier whose base the child already covered resumes it at the first rung above, with the new agent", async () => {
      // Default budget (4 attempts, 4x): after two attempts on fast only one remains for the two tiers above, so the
      // ladder escalates; `medium` is sonnet#medium, which fast already ran, so it is entered at `high` (carryVariant).
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, false, true] });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      expect(t.runs.map((r) => [r.sid, r.agent, r.model?.modelID, r.model?.variant, r.resumeSessionID])).toEqual([
        ["child-1", "fast", "claude-sonnet-5-5", "low", undefined],
        ["child-1", "fast", "claude-sonnet-5-5", "medium", "child-1"],
        ["child-1", "medium", "claude-sonnet-5-5", "high", "child-1"],
      ]);
      expect(lookupDispatch("child-1")).toMatchObject({ step: "escalate", agent: "medium", tier: "medium", variant: "high" });
      expect(t.created).toEqual(["child-1"]);
    });
    it("starts a fresh child over the threshold of the next model, and discards the old one before the next attempt", async () => {
      const t = await setup({
        tiers: { fast: { model: SONNET, variant: "xhigh", costRatio: 1 }, medium: { model: OPUS, variant: "high", costRatio: 5 } },
        routing: {}, escalate: { maxAttemptsPerTier: 0, maxTotalAttempts: 6, costCeiling: { multiple: 100 } }, verdicts: [false, true],
        // opus can take 20 000 input tokens: 60 % is 12 000, the child carries 15 000 plus the prompt.
        catalog: [model(SONNET, ["low", "medium", "high", "xhigh"], 1_000_000), model(OPUS, ["low", "medium", "high", "xhigh"], 20_000)],
        contextTokens: () => 15_000,
      });
      await t.run();
      expect(t.runs.map((r) => [r.sid, r.agent, r.resumeSessionID])).toEqual([
        ["child-1", "fast", undefined],
        ["child-2", "medium", undefined],
      ]);
      expect(t.events.indexOf("dispose:child-1")).toBeLessThan(t.events.indexOf("create:child-2"));
      expect(t.runs[1]!.prompt).toContain("[router escalation]");
    });

    it("QA-2.3-2: an execution end that is still queued when the gate finishes is awaited (bounded), then the child resumes", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], executionEnd: "late" });
      await t.run();
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([["child-1", undefined, "low"], ["child-1", "child-1", "medium"]]);
    });

    it("QA-2.3-2: steps recorded but no execution end ever seen: the child is not trusted and the next attempt starts fresh", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], executionEnd: "never" });
      const started = Date.now();
      await t.run();
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([["child-1", undefined, "low"], ["child-2", undefined, "medium"]]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900); // the bounded wait (1 s), not an indefinite one
      expect(t.events.indexOf("dispose:child-1")).toBeLessThan(t.events.indexOf("create:child-2"));
    });

    it("starts fresh when the producer's context is unknown (no step event reached the registry)", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], contextTokens: () => Number.NaN });
      await t.run();
      expect(t.runs.map((r) => r.resumeSessionID)).toEqual([undefined, undefined]);
      expect(t.created).toEqual(["child-1", "child-2"]);
      expect(t.runs[1]!.model?.variant).toBe("medium"); // still the next variant, on a new child
    });
  });

  describe("host behaviour that is unverified (1.5 R1)", () => {
    it("R1: a bare-model escalation after variant steps starts a fresh child instead of resuming with an unknown stored variant", async () => {
      const t = await setup({
        tiers: { fast: { model: SONNET, costRatio: 1 }, medium: { model: OPUS, costRatio: 5 } },
        routing: {}, escalate: { maxTotalAttempts: 8, costCeiling: { multiple: 100 } }, verdicts: [false, false, false, false, true],
      });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      expect(t.runs.map((r) => [r.sid, r.agent, r.model?.variant, r.resumeSessionID])).toEqual([
        ["child-1", "fast", undefined, undefined], // the model's default variant
        ["child-1", "fast", "high", "child-1"], // default steps to the lowest variant at or above high (A9)
        ["child-1", "fast", "xhigh", "child-1"], // capped at effortBumpMax
        ["child-1", "fast", "xhigh", "child-1"], // one plain retry at the reached variant
        ["child-2", "medium", undefined, undefined], // a bare opus sent to a child that stored `xhigh`: fresh
      ]);
      expect(t.events.indexOf("dispose:child-1")).toBeLessThan(t.events.indexOf("create:child-2"));
    });
  });
  describe("no behaviour change without session-aware variant steps", () => {
    for (const [label, scenario] of [
      ["no routing block at all", { routing: undefined }],
      ["routing block with variantSteps none", { routing: {}, escalate: { variantSteps: "none" as const } }],
    ] as const) {
      it(`${label}: fresh child per attempt, tier agent and configured model, no catalog call, nothing registered`, async () => {
        const t = await setup({ tiers: OWNER, verdicts: [false, false, true], escalate: { maxTotalAttempts: 4, costCeiling: { multiple: 100 }, ...("escalate" in scenario ? scenario.escalate : {}) }, ...(scenario.routing === undefined ? {} : { routing: scenario.routing }) });
        const result = await t.run();
        expect(result).toContain("[router ✓ verified:");
        expect(t.runs.map((r) => [r.sid, r.agent, r.model?.variant, r.resumeSessionID])).toEqual([
          ["child-1", "fast", "low", undefined],
          ["child-2", "fast", "low", undefined],
          ["child-3", "medium", "medium", undefined],
        ]);
        expect(t.catalogCalls()).toBe(0);
        expect(dispatchCount()).toBe(0);
        // today's order: each attempt's child is disposed before the next one starts
        expect(t.events.filter((e) => e.startsWith("dispose:child") || e.startsWith("create:"))).toEqual([
          "create:child-1", "dispose:child-1", "create:child-2", "dispose:child-2", "create:child-3", "dispose:child-3",
        ]);
      });
    }

    it("a routing block on a v2 host whose catalog is unavailable keeps today's ladder", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], catalog: [] });
      await t.run();
      expect(t.catalogCalls()).toBe(1);
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([["child-1", undefined, "low"], ["child-2", undefined, "low"]]);
    });
  });

  describe("D10 fallback: an invalid variant", () => {
    it("starts a fresh child on the bare model and delivers the step's effort through the effort override", async () => {
      const catalog = defaultCatalog();
      const t = await setup({
        tiers: OWNER, routing: {}, verdicts: [false, true], catalog,
        // The host's catalog changes under the delegation: `medium` disappears after the policy was built.
        during: (attempt) => { if (attempt === 1) Object.assign(catalog[0]!, { variants: [{ id: "low" }, { id: "high" }, { id: "xhigh" }] }); },
      });
      await t.run();
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([["child-1", undefined, "low"], ["child-2", undefined, undefined]]);
      expect(t.runs[1]!.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
      expect(t.runs[1]!.options.effort).toBe("medium");
      expect(t.runs[0]!.options.effort).toBeUndefined();
      expect(t.disposed).toContain("child-1");
    });
  });

  describe("log levels (QA-2.3-4): warn is for anomalies", () => {
    const ladderLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("[router] ladder "));

    it("a routine resume and a start over the threshold are not logged; unknown context and a refused resume are", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const routine = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true] });
        await routine.run();
        expect(routine.runs[1]!.resumeSessionID).toBe("child-1");
        expect(ladderLines(warn)).toEqual([]);

        warn.mockClear();
        resetDispatchRegistry();
        const over = await setup({
          tiers: { fast: { model: SONNET, variant: "xhigh", costRatio: 1 }, medium: { model: OPUS, variant: "high", costRatio: 5 } },
          routing: {}, escalate: { maxAttemptsPerTier: 0, maxTotalAttempts: 6, costCeiling: { multiple: 100 } }, verdicts: [false, true],
          catalog: [model(SONNET, ["low", "medium", "high", "xhigh"], 1_000_000), model(OPUS, ["low", "medium", "high", "xhigh"], 20_000)],
          contextTokens: () => 15_000,
        });
        await over.run();
        expect(over.runs[1]!.resumeSessionID).toBeUndefined();
        expect(ladderLines(warn)).toEqual([]); // at-or-over-threshold is the ladder doing its job

        warn.mockClear();
        resetDispatchRegistry();
        const unknown = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], contextTokens: () => Number.NaN });
        await unknown.run();
        expect(ladderLines(warn)).toHaveLength(1);
        expect(ladderLines(warn)[0]).toContain("unknown-tokens");

        warn.mockClear();
        resetDispatchRegistry();
        const refused = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], rejectResume: true });
        await refused.run();
        expect(ladderLines(warn).some((line) => line.includes("cannot resume child session child-1"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it("the existing debug flag brings the routine lines back", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      process.env.MODEL_ROUTER_TRAJECTORY_DEBUG = "1";
      try {
        const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true] });
        await t.run();
        const lines = ladderLines(warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("resuming the child session (under-threshold; tokens=");
      } finally {
        delete process.env.MODEL_ROUTER_TRAJECTORY_DEBUG;
        warn.mockRestore();
      }
    });
  });
  describe("host refusal of a resume", () => {
    it("is not a failed attempt: the same attempt starts on a fresh child, and the refused one is disposed", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, true], rejectResume: true });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      expect(t.events.filter((e) => e.startsWith("resume:") || e.startsWith("create:"))).toEqual(["create:child-1", "resume:child-1", "create:child-2"]);
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([["child-1", undefined, "low"], ["child-2", undefined, "medium"]]);
      expect(t.events.indexOf("dispose:child-1")).toBeLessThan(t.events.indexOf("create:child-2"));
      expect(lookupDispatch("child-2")).toMatchObject({ step: "variant", variant: "medium" });
    });
  });

  describe("timeouts, orphans and cost", () => {
    it("a timeout interrupts the resumed child, counts as a failed attempt, and the next attempt starts fresh", async () => {
      const t = await setup({
        tiers: OWNER, routing: {}, verdicts: [false, true], hangAttempt: 2,
        // Real timers: the ceiling only has to be far above attempt 1 (creating a child, loading config) on a loaded machine.
        verify: { delegateTimeoutMs: 1_000 },
        escalate: { maxTotalAttempts: 6, costCeiling: { multiple: 100 } },
      });
      const result = await t.run();
      expect(result).toContain("[router ✓ verified:");
      expect(t.interrupted).toEqual(["child-1"]); // the resumed child, aborted through its signal
      expect(t.runs.map((r) => [r.sid, r.resumeSessionID, r.model?.variant])).toEqual([
        ["child-1", undefined, "low"],
        ["child-1", "child-1", "medium"], // resumed, hung, timed out
        ["child-2", undefined, "high"], // the context of a failed producer is not trusted: fresh, next variant
      ]);
      expect(t.disposed).toContain("child-1");
      expect(t.events.indexOf("dispose:child-1")).toBeLessThan(t.events.indexOf("create:child-2"));
    });

    it("every producer child is disposed when the ladder gives up", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, false, false, false, false], escalate: { maxTotalAttempts: 3, costCeiling: { multiple: 100 } } });
      const result = await t.run();
      expect(result).toContain("status: unmet");
      expect(t.created).toEqual(["child-1"]);
      expect(t.disposed.filter((sid) => sid.startsWith("child-"))).toEqual(["child-1"]);
    });

    it("the cost ceiling counts resumed attempts at the rung's own ratio (A17, F5)", async () => {
      const t = await setup({
        tiers: {
          fast: { model: SONNET, variant: "low", costRatio: 1, candidates: [{ variant: "low", costRatio: 1 }, { variant: "medium", costRatio: 5 }, { variant: "high", costRatio: 8 }] },
          medium: { model: OPUS, variant: "medium", costRatio: 5 },
          heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
        },
        routing: {}, verdicts: [false, false, false, false], escalate: { maxTotalAttempts: 8, costCeiling: { multiple: 6 } },
      });
      const result = await t.run();
      // 1 (low) + 5 (medium) = 6, not above 6x; + 8 (high) = 14 > 6: stop after the third attempt. Charged at the
      // tier's ratio (1 each) the ladder would have run on.
      expect(t.runs.map((r) => r.model?.variant)).toEqual(["low", "medium", "high"]);
      expect(result).toContain("3 attempt(s)");
      expect(result).toContain("cost ceiling exceeded");
      const scorecard = readFileSync(join(tmpdir(), "opencode-model-router-trajectory", "child-1.delegate.log"), "utf8");
      expect(scorecard).toContain("cost=14");
      expect(scorecard).toContain("final_tier=fast#high");
    });

    it("max total attempts bounds a resumed ladder", async () => {
      const t = await setup({ tiers: OWNER, routing: {}, verdicts: [false, false, false], escalate: { maxTotalAttempts: 2, costCeiling: { multiple: 100 } } });
      const result = await t.run();
      expect(t.runs).toHaveLength(2);
      expect(result).toContain("max total attempts (2) reached");
    });
  });

  describe("telemetry (engine shadow)", () => {
    it("writes one decision row per attempt with its step label and resume flag, and scores the variant attempt", async () => {
      const outcomes = mkdtempSync(join(tmpdir(), "ladder-resume-outcomes-"));
      dirs.push(outcomes);
      const t = await setup({ tiers: OWNER, routing: { engine: "shadow", minClassConfidence: 0, outcomes: { path: outcomes } }, verdicts: [false, true] });
      await t.run();
      const bundle = acquireOutcomes({ dir: outcomes, tuning: {}, logger: { warn: () => undefined } });
      try {
        await bundle.flusher.flushNow();
        const rows = (await bundle.persister.readRows()).rows;
        const decisions = rows.filter((r): r is DecisionRow => r.kind === "decision");
        expect(decisions.map((r) => [r.step, r.resume, r.childSessionID, r.chosen.variant, r.mode, r.switched, r.best])).toEqual([
          ["dispatch", false, "child-1", "low", "shadow", false, null],
          ["variant", true, "child-1", "medium", "shadow", false, null],
        ]);
        expect(decisions[1]!.reason).toContain("D11 under-threshold");
        expect(decisions[0]!.decisionID).not.toBe(decisions[1]!.decisionID);
        const verdicts = rows.filter((r): r is VerdictRow => r.kind === "verdict");
        expect(verdicts.map((r) => [r.step, r.verdict, r.decisionID])).toEqual([
          ["dispatch", "fail", decisions[0]!.decisionID],
          ["variant", "pass", decisions[1]!.decisionID],
        ]);
        const cls = decisions[0]!.facts.class;
        const lowKey = makeKey(cls, { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low");
        const mediumKey = makeKey(cls, { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "medium");
        expect(bundle.store.snapshot().entries[lowKey]?.counts).toMatchObject({ fail: 1, pass: 0 });
        expect(bundle.store.snapshot().entries[mediumKey]?.counts).toMatchObject({ pass: 1, variantPass: 1 });
        // distinct attempts: the registry numbered the resume of child-1 as its second attempt
        expect(lookupDispatch("child-1")?.attemptIndex).toBe(1);
      } finally {
        await bundle.release();
      }
    });

    it("engine static with a routing block registers attempts for the resume decision but writes nothing", async () => {
      const outcomes = mkdtempSync(join(tmpdir(), "ladder-resume-outcomes-"));
      dirs.push(outcomes);
      const t = await setup({ tiers: OWNER, routing: { outcomes: { path: outcomes } }, verdicts: [false, true] });
      await t.run();
      expect(t.runs[1]!.resumeSessionID).toBe("child-1");
      expect(readdirSync(outcomes)).toEqual([]);
      expect(existsSync(join(tmpdir(), "opencode-model-router-trajectory", "outcomes.json"))).toBe(false);
    });
  });

  describe("v1 hosts", () => {
    it("never resume: a routing block on v1 changes nothing (engine and variant steps are ignored)", async () => {
      configure({ tiers: OWNER, routing: { engine: "shadow" }, verdicts: [] });
      const events: string[] = [];
      const verdicts = [false, true];
      const hooks = await ModelRouterPlugin({
        directory: dir, worktree: dir,
        client: { session: {
          get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
          create: async () => ({ data: { id: `v1-${counter++}` } }),
          prompt: async (request: { path: { id: string }; body: { agent?: string; system?: string; model?: { providerID: string; modelID: string } } }) => {
            if (request.body.system !== undefined) return { data: { parts: [{ type: "text", text: JSON.stringify({ pass: verdicts.shift(), reasons: ["scripted verdict"] }) }] } };
            events.push(`${request.path.id}:${request.body.agent}:${JSON.stringify(request.body.model)}`);
            return { data: { parts: [{ type: "text", text: "producer output" }] } };
          },
          delete: async () => ({}),
        } },
      } as unknown as RouterPluginInput) as unknown as Hooks;
      instances.push(hooks);
      const result = await hooks.tool.delegate.execute({ tier: "fast", task: "VERIFY:required\ndo x", acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" }, { sessionID: "orchestrator" });
      expect(result).toContain("[router ✓ verified:");
      expect(events).toHaveLength(2);
      expect(new Set(events.map((e) => e.split(":")[0])).size).toBe(2); // two sessions
      expect(events.every((e) => e.includes(":fast:"))).toBe(true);
      expect(dispatchCount()).toBe(0);
    });
  });
});
