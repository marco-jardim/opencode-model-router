/** Issue #84, plan P0.1: role spikes on a REAL OpenCode v2 host (2.0.24 live, 2.0.22 source), group A: S1, S2, S4, S7.
 *
 *   RUN_OC_SMOKE_ROLE_SPIKES=1 [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/role-spikes.smoke.test.ts
 *
 * - Without RUN_OC_SMOKE_ROLE_SPIKES=1 every test is skipped (the normal `vitest run` excludes test/smoke anyway).
 * - Every spike starts its OWN isolated host (see helpers/routing-host.ts: allow-listed environment, private HOME, scripted keyless
 *   Anthropic + OpenAI Responses provider, the router loaded from THIS checkout next to the probe plugin) and tears it down.
 * - The assertions PIN WHAT THE HOST DID (provider wire requests, host session API, probe hooks/events), never the scripted
 *   provider's own echo. If a host upgrade changes the behaviour, the matching spike fails loudly.
 * - Raw observations of each spike are written (redacted) to <tmpdir>/omr-role-spikes/<spike>.json so they can be cited; nothing
 *   is written to the repository.
 * - Groups B (S3, S6, S8, S9) and C (S10, S11, S12) extend this file: reuse `startSpikeHost`, `wire`, `save` below.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENAI_PROVIDER, RoutingHost, agentWithoutModel, arr, effectiveEffort, obj, redact, ref, stopAllHosts, str,
  type EventRecord, type HostOptions, type Obj, type WireRequest,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROLE_SPIKES === "1";
const d = RUN ? describe : describe.skip;
afterAll(async () => { await stopAllHosts(); }, 60_000);

// ------------------------------------------------------------------ shared setup (extend here for groups B and C) ----
/** The smoke temp guard removes the per-run TEMP at the end, so the observations go to the real temp directory it recorded. */
const OUT = path.join(process.env.OMR_SMOKE_REAL_TMPDIR ?? tmpdir(), "omr-role-spikes");
const NO_MODEL = "role-nomodel";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const LUNA = "openai/gpt-6-luna";
const SOL = "openai/gpt-6-sol";

/** Starts an isolated host with `agents` registered in the host's own opencode.json (they carry exactly the fields given) and the lifecycle probe on. */
async function startSpikeHost(name: string, agents: Record<string, Obj>, extra: Partial<HostOptions> = {}): Promise<RoutingHost> {
  return RoutingHost.start(name, {
    routing: { engine: "shadow" }, providers: OPENAI_PROVIDER, probe: { lifecycle: true },
    hostConfig: { agents }, ...extra,
  });
}
/** Writes the raw (redacted) observations of one spike. */
async function save(spike: string, observed: Obj): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${spike}.json`);
  await writeFile(file, `${JSON.stringify(redact({ spike, recordedAt: new Date().toISOString(), observed }), null, 2)}\n`);
  console.log(`[role-spikes] observations written to ${file}`);
}
async function finish(host: RoutingHost): Promise<void> {
  const teardown = await host.stop();
  expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
}

/** What the provider was actually told, per request: the wire model, the catalog ref the host's http.request hook saw, and the effort. */
interface Wire { protocol: string; kind?: string; wireModel?: string; catalogModel?: string; effort: unknown; topLevelEffort: unknown; inBandEfforts: unknown[]; thinking?: unknown }
function wire(r: WireRequest): Wire {
  if (r.protocol === "anthropic") {
    const inBand = r.messages.map(m => obj(m.output_config).effort).filter(e => e !== undefined);
    return { protocol: r.protocol, kind: r.kind, wireModel: r.model, catalogModel: r.catalogModel, effort: effectiveEffort(r), topLevelEffort: obj(r.payload.output_config).effort, inBandEfforts: inBand, thinking: r.payload.thinking };
  }
  const inBand = r.messages.filter(m => m.type === "configuration_update").map(m => obj(m.reasoning).effort).filter(e => e !== undefined);
  const top = obj(r.payload.reasoning).effort;
  return { protocol: r.protocol, kind: r.kind, wireModel: r.model, catalogModel: r.catalogModel, effort: inBand.at(-1) ?? top, topLevelEffort: top, inBandEfforts: inBand };
}
const primary = (host: RoutingHost, sessionID: string) => host.requestsOf(sessionID).filter(r => r.kind === "primary");

/** The probe's lifecycle records (first context build / permission evaluation per session) and the session.created events. */
async function lifecycle(host: RoutingHost, sessionID: string): Promise<{ context?: EventRecord; evaluates: EventRecord[]; firstEvaluate?: EventRecord; created?: EventRecord }> {
  const events = await host.events();
  const mine = events.filter(e => e.type === "probe.lifecycle" && e.sessionID === sessionID);
  const evaluates = mine.filter(e => e.point === "evaluate");
  return {
    context: mine.find(e => e.point === "context"), evaluates, firstEvaluate: evaluates.find(e => e.first === true),
    created: events.find(e => e.type === "session.created" && obj(e.data).sessionID === sessionID),
  };
}
const sessionView = (s: Obj | undefined) => (s ? { parentID: s.parentID, agent: s.agent, title: s.title, model: s.model } : undefined);

// ---- group B helpers ----
const toolStatesOf = (context: Obj[]): Obj[] => context.flatMap(m => arr(obj(m).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
const stateView = (s: Obj) => ({ status: s.status, errorType: obj(s.error).type, errorMessage: obj(s.error).message, text: arr(s.content).map(c => str(obj(c).text)).join("\n") });
/** Dispatches one child (foreground) and reports what the host recorded about it and what the parent was told. */
async function childReport(host: RoutingHost, root: string, input: Obj) {
  const started = Date.now();
  const call = await host.dispatch(root, { background: false, model: `${SONNET}#low`, ...input });
  const child = await host.client.session.get({ sessionID: call.childID });
  const context = await host.client.session.context({ sessionID: call.childID });
  const events = (await host.eventsOf(call.childID)).filter(e => typeof e.type === "string" && e.type.startsWith("session.")).map(e => e.type);
  const decisions = (await host.events()).filter(e => e.type === "probe.decision" && e.sessionID === call.childID);
  return {
    childID: call.childID, startedAt: started, endedAt: Date.now(),
    parentToolStatus: call.after.status, parentToolError: call.after.error, parentOutput: str(obj(obj(call.after.result).output).output),
    child: { agent: child.agent, title: child.title, outcome: child.outcome, parentID: child.parentID },
    toolStates: toolStatesOf(context).map(stateView), events, decisions,
    requests: primary(host, call.childID).map(r => ({ ...wire(r), toolNames: r.toolNames, system: r.system })),
    evaluates: (await lifecycle(host, call.childID)).evaluates.map(e => ({ action: e.action, denied: e.denied })),
  };
}
type ChildReport = Awaited<ReturnType<typeof childReport>>;
const readProbe = (file: string) => `READ_ONLY_PROBE=${JSON.stringify({ tool: "read", input: { path: file } })}`;
const executeProbe = (code: string) => `READ_ONLY_PROBE=${JSON.stringify({ tool: "execute", input: { code } })}`;
const decisionsOf = (r: ChildReport, point: string) => r.decisions.filter(d => d.point === point).map(d => ({ decision: d.decision, action: d.action, removed: d.removed }));
// ------------------------------------------------------------------------------------------------ the spikes ----
d("role spikes on the real OpenCode v2 host (issue #84, P0.1 group A)", () => {
  it("S1 agent registered without a model: the per-call model and variant reach the provider (Anthropic and OpenAI Responses)", async () => {
    const host = await startSpikeHost("s1", { [NO_MODEL]: agentWithoutModel() });
    try {
      const onDisk = obj(obj((await host.hostConfigOnDisk()).agents)[NO_MODEL]);
      const hostAgent = (await host.client.agent.list()).data.find(a => a.id === NO_MODEL);
      const root = await host.newRoot("s1 root");
      const rows: Obj[] = [];
      const step = async (label: string, model: string | undefined) => {
        const mark = host.provider.requests.length;
        const call = await host.dispatch(root, { agent: NO_MODEL, description: `S1 ${label}`, prompt: `S1 ${label}`, ...(model ? { model } : {}) });
        const stored = await host.client.session.get({ sessionID: call.childID });
        const requests = host.provider.requests.slice(mark).filter(r => r.session === call.childID && r.kind === "primary");
        const row = { label, asked: model, storedModel: stored.model ? ref(stored.model) : undefined, storedAgent: stored.agent, wire: requests.map(wire), toolStatus: call.after.status, toolError: call.after.error };
        rows.push(row);
        return row;
      };
      const anthropic = await step("anthropic sonnet#medium", `${SONNET}#medium`);
      const anthropicOpus = await step("anthropic opus#xhigh", `${OPUS}#xhigh`);
      const responses = await step("responses luna#high", `${LUNA}#high`);
      const bare = await step("no per-call model", undefined);
      const parent = await host.client.session.get({ sessionID: root });
      await save("S1", { configAgentEntry: onDisk, hostAgentRecord: hostAgent, rootModel: parent.model, rows, hostErrors: host.errorLines(), providerErrors: host.provider.errors });

      // The generated opencode.json really has no model for the agent, and the host's own agent record has none either.
      expect("model" in onDisk).toBe(false);
      expect("variant" in onDisk).toBe(false);
      expect(hostAgent?.model).toBeUndefined();
      // Observed (host 2.0.24): the model-less agent is accepted by the host and the per-call model wins outright.
      for (const row of [anthropic, anthropicOpus, responses, bare]) {
        expect(row.toolStatus).toBe("completed");
        expect(row.storedAgent).toBe(NO_MODEL);
        expect(row.wire).toHaveLength(1);
      }
      // Anthropic Messages: provider model, catalog ref and top-level output_config.effort all follow the per-call model#variant.
      expect(anthropic).toMatchObject({ storedModel: `${SONNET}#medium`, wire: [{ wireModel: "claude-sonnet-5-5", catalogModel: `${SONNET}#medium`, effort: "medium", topLevelEffort: "medium", inBandEfforts: [] }] });
      expect(anthropicOpus).toMatchObject({ storedModel: `${OPUS}#xhigh`, wire: [{ wireModel: "claude-opus-5-5", catalogModel: `${OPUS}#xhigh`, effort: "xhigh", topLevelEffort: "xhigh", inBandEfforts: [] }] });
      // OpenAI Responses: model and top-level reasoning.effort follow the per-call model#variant.
      expect(responses).toMatchObject({ storedModel: `${LUNA}#high`, wire: [{ protocol: "responses", wireModel: "gpt-6-luna", catalogModel: `${LUNA}#high`, effort: "high", topLevelEffort: "high", inBandEfforts: [] }] });
      // Without a per-call model the model-less agent INHERITS the parent's model with variant "default" and no effort is sent.
      expect(bare).toMatchObject({ storedModel: "anthropic/claude-opus-4-7#default", wire: [{ wireModel: "claude-opus-4-7", catalogModel: "anthropic/claude-opus-4-7#default", inBandEfforts: [] }] });
      expect(bare.wire[0]?.effort).toBeUndefined();
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);

  it("S2 child session as seen from the first context build and first permission evaluation (parentID / agent / title), ordering vs session.created, same-title parallel children", async () => {
    const host = await startSpikeHost("s2", { [NO_MODEL]: agentWithoutModel() });
    try {
      const rootA = await host.newRoot("s2 root A");
      const rootB = await host.newRoot("s2 root B");
      const probeFile = path.join(host.project, "s2-read.txt");
      await writeFile(probeFile, "S2\n");
      const TITLE = "S2 same title";
      const input = (prompt: string): Obj => ({ agent: NO_MODEL, description: TITLE, prompt, model: `${SONNET}#low`, background: false });
      // (1) two roots dispatch the same agent with the same title at the same time.
      const parallel = await Promise.all([host.dispatch(rootA, input("S2 parallel A")), host.dispatch(rootB, input("S2 parallel B"))]);
      // (2) the same root dispatches twice in a row, in the background (the children overlap).
      const bg1 = await host.call(rootA, "subagent", { ...input("S2 background 1"), background: true });
      const bg2 = await host.call(rootA, "subagent", { ...input("S2 background 2"), background: true });
      const kids = (await host.children(rootA)).map(k => k.id);
      const bgIDs = [bg1.childID, bg2.childID].filter((id): id is string => id !== undefined);
      // a permission evaluation needs a tool call in the child: one child that reads a file.
      const reader = await host.dispatch(rootB, { agent: NO_MODEL, description: TITLE, prompt: `READ_ONLY_PROBE=${JSON.stringify({ tool: "read", input: { path: probeFile } })}`, model: `${SONNET}#low`, background: false });
      await host.settle(rootA);
      const subjects = [
        { label: "parallel A", childID: parallel[0].childID, parent: rootA },
        { label: "parallel B", childID: parallel[1].childID, parent: rootB },
        ...bgIDs.map((id, i) => ({ label: `background ${i + 1}`, childID: id, parent: rootA })),
        { label: "reader", childID: reader.childID, parent: rootB },
      ];
      const rows: Obj[] = [];
      for (const s of subjects) {
        const life = await lifecycle(host, s.childID);
        rows.push({
          label: s.label, childID: s.childID, expectedParent: s.parent,
          atContext: sessionView(obj(life.context?.got)), contextAgent: life.context?.agent, contextModel: life.context?.model,
          atFirstEvaluate: sessionView(obj(life.firstEvaluate?.got)), evaluateAgent: life.firstEvaluate?.agent, evaluateActions: life.evaluates.map(e => e.action),
          createdEvent: life.created ? { type: life.created.type, created: life.created.created, data: life.created.data, seenAtN: life.created.__n, seenAtT: life.created.__t } : undefined,
          contextEnteredN: life.context?.enteredN, contextEnteredT: life.context?.entered, firstEvaluateEnteredN: life.firstEvaluate?.enteredN,
          createdBeforeContext: life.created && life.context ? (life.created.__n as number) < (life.context.enteredN as number) : undefined,
          createdEventTimeVsContext: life.created && life.context ? { created: life.created.created, contextEntered: life.context.entered } : undefined,
          now: sessionView(obj(await host.client.session.get({ sessionID: s.childID }))),
        });
      }
      await save("S2", { rows, rootChildren: { rootA: kids }, titles: TITLE });

      for (const row of rows) {
        const at = obj(row.atContext);
        // pinned: at the child's FIRST context build session.get already answers parentID, agent and title.
        expect(at.parentID, `${String(row.label)} parentID at context`).toBe(row.expectedParent);
        expect(at.agent, `${String(row.label)} agent at context`).toBe(NO_MODEL);
        expect(at.title, `${String(row.label)} title at context`).toBe(TITLE);
        expect(row.contextAgent).toBe(NO_MODEL);
        // pinned: the model of the child is already the per-call one at the first context build.
        expect(obj(row.atContext).model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" });
        // pinned ordering: session.created is emitted (and reaches the probe subscriber) BEFORE the child's first context hook,
        // and its payload already carries parentID / agent / title / model.
        expect(row.createdBeforeContext, `${String(row.label)} session.created before context`).toBe(true);
        expect(obj(obj(row.createdEvent).data)).toMatchObject({ parentID: row.expectedParent, agent: NO_MODEL, title: TITLE, model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" } });
        expect(Number(obj(row.createdEvent).created)).toBeLessThanOrEqual(Number(row.contextEnteredT));
        // pinned: no permission evaluation happens for a child that calls no tool.
        if (row.label !== "reader") expect(row.evaluateActions).toEqual([]);
      }
      // pinned: the three children of rootA (2 background + 1 parallel) all carry the identical title and the same agent.
      expect(kids.sort()).toEqual([parallel[0].childID, ...bgIDs].sort());
      const reading = rows.find(r => r.label === "reader")!;
      expect((reading.evaluateActions as string[]).length).toBeGreaterThan(0);
      expect(obj(reading.atFirstEvaluate)).toMatchObject({ parentID: rootB, agent: NO_MODEL, title: TITLE });
      // both parallel children (different parents, same agent, same title) are told apart ONLY by parentID.
      expect(new Set(rows.slice(0, 2).map(r => obj(r.atContext).title)).size).toBe(1);
      expect(rows[0]!.childID).not.toBe(rows[1]!.childID);
    } finally { await finish(host); }
  }, 300_000);

  it("S4 how the parent sees a child that hits its step limit (agent steps) and a child whose tool call a plugin guard denies", async () => {
    const host = await startSpikeHost("s4", { "role-steps": agentWithoutModel({ steps: 2 }), "role-guard": agentWithoutModel(), [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, deny: { agent: "role-guard", actions: ["read"] } } });
    try {
      const file = path.join(host.project, "s4-read.txt");
      await writeFile(file, "S4\n");
      const probe = `READ_ONLY_PROBE=${JSON.stringify({ tool: "read", input: { path: file } })}`;
      const report = async (label: string, agent: string, prompt: string) => {
        const root = await host.newRoot(`s4 ${label}`);
        const mark = host.provider.requests.length;
        const call = await host.dispatch(root, { agent, description: `S4 ${label}`, prompt, model: `${SONNET}#low`, background: false });
        const child = await host.client.session.get({ sessionID: call.childID });
        const requests = host.provider.requests.slice(mark).filter(r => r.session === call.childID && r.kind === "primary");
        const context = await host.client.session.context({ sessionID: call.childID });
        const childEvents = (await host.eventsOf(call.childID)).filter(e => typeof e.type === "string" && e.type.startsWith("session.")).map(e => ({ type: e.type, data: e.data }));
        const parentHooks = (await host.hooks()).filter(h => h.sessionID === call.childID && h.hook === "after").map(h => ({ tool: h.tool, status: h.status, result: h.result, error: h.error }));
        return {
          label, parentToolStatus: call.after.status, parentToolResult: call.after.result, parentToolError: call.after.error,
          child: { outcome: child.outcome, agent: child.agent, tokens: child.tokens },
          childRequests: requests.map(r => ({ ...wire(r), toolNames: r.toolNames, toolResult: r.toolResult, reply: r.reply, systemHasMaxSteps: r.system.includes("MAXIMUM STEPS REACHED") || JSON.stringify(r.messages).includes("MAXIMUM STEPS REACHED"), toolChoice: r.payload.tool_choice })),
          childToolHooks: parentHooks, childEvents, childContext: context,
          lifecycleEvaluate: (await lifecycle(host, call.childID)).evaluates.map(e => ({ action: e.action, denied: e.denied })),
        };
      };
      const steps = await report("step limit, cooperative model", "role-steps", probe);
      host.provider.loopProbe = true; // a model that keeps calling tools after the host told it that tools are disabled
      const stepsLoop = await report("step limit, model keeps calling tools", "role-steps", probe);
      host.provider.loopProbe = false;
      const guard = await report("guard denial", "role-guard", probe);
      const control = await report("control: no limit no denial", NO_MODEL, probe);
      await save("S4", { steps, stepsLoop, guard, control, hostErrors: host.errorLines(), providerErrors: host.provider.errors });
      const toolStates = (r: typeof steps) => r.childContext.flatMap(m => arr(obj(m).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
      const finishes = (r: typeof steps) => r.childContext.filter(m => obj(m).type === "assistant").map(m => ({ finish: obj(m).finish, rawFinish: obj(m).rawFinish }));
      const parentText = (r: typeof steps) => str(obj(obj(r.parentToolResult).output).output);
      const MAX = "Tools are disabled after the maximum agent steps";
      // (a) step limit, cooperative model: the host appends its MAX-STEPS note and forces tool_choice none on the LAST step; the model
      // answers with text; the PARENT sees an ordinary completed child with that text. Nothing marks the budget exhaustion for the parent.
      expect(steps.childRequests.map(r => ({ reply: r.reply, maxSteps: r.systemHasMaxSteps, toolChoice: r.toolChoice }))).toEqual([
        { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "text", maxSteps: true, toolChoice: { type: "none" } },
      ]);
      expect(steps.parentToolStatus).toBe("completed");
      expect(obj(obj(steps.parentToolResult).output).status).toBe("completed");
      expect(parentText(steps)).toBe("CHILD_OK");
      expect(JSON.stringify(steps.parentToolResult)).not.toMatch(/step|maximum|MAXIMUM/i);
      expect(steps.child.outcome).toBe("succeeded");
      expect(finishes(steps)).toEqual([{ finish: "tool-calls", rawFinish: "tool_use" }, { finish: "stop", rawFinish: "end_turn" }]);
      expect(steps.childEvents.at(-1)?.type).toBe("session.execution.succeeded");
      // (b) step limit, model that keeps calling a tool: the call on the last step FAILS in the child ("Tools are disabled after the
      // maximum agent steps"), the child still ends `succeeded` with finish tool-calls and NO text, and the parent sees a completed child
      // whose text is the host's placeholder.
      expect(stepsLoop.childRequests.map(r => ({ reply: r.reply, maxSteps: r.systemHasMaxSteps, toolChoice: r.toolChoice }))).toEqual([
        { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "tool", maxSteps: true, toolChoice: { type: "none" } },
      ]);
      expect(toolStates(stepsLoop).map(s => ({ status: s.status, message: obj(s.error).message }))).toEqual([{ status: "completed", message: undefined }, { status: "error", message: MAX }]);
      expect(stepsLoop.childEvents.map(e => e.type)).toContain("session.tool.failed");
      expect(stepsLoop.parentToolStatus).toBe("completed");
      expect(obj(obj(stepsLoop.parentToolResult).output).status).toBe("completed");
      expect(parentText(stepsLoop)).toBe("Subagent completed without a text response.");
      expect(stepsLoop.child.outcome).toBe("succeeded");
      expect(finishes(stepsLoop)).toEqual([{ finish: "tool-calls", rawFinish: "tool_use" }, { finish: "tool-calls", rawFinish: "tool_use" }]);
      // (c) plugin-guard denial (permission.hook("evaluate") sets effect deny): the child's tool call fails with permission.rejected
      // carrying the plugin's message; the hook sees an error; the child recovers and ends `succeeded`; the PARENT sees a plain completed
      // child with the child's final text and no trace of the denial.
      expect(guard.lifecycleEvaluate).toEqual([{ action: "read", denied: true }]);
      expect(toolStates(guard).map(s => ({ status: s.status, type: obj(s.error).type, message: obj(s.error).message }))).toEqual([{ status: "error", type: "permission.rejected", message: "PLUGIN_GUARD_DENIED: read" }]);
      expect(guard.childToolHooks.map(h => h.status)).toEqual(["error"]);
      expect(JSON.stringify(guard.childToolHooks[0]?.error)).toContain("Permission.BlockedError");
      expect(guard.parentToolStatus).toBe("completed");
      expect(parentText(guard)).toBe("ROOT_DONE");
      expect(JSON.stringify(guard.parentToolResult)).not.toMatch(/PLUGIN_GUARD_DENIED|denied|Permission/i);
      expect(guard.child.outcome).toBe("succeeded");
      expect(finishes(guard)).toEqual([{ finish: "tool-calls", rawFinish: "tool_use" }, { finish: "stop", rawFinish: "end_turn" }]);
      // control: the same call without limit or denial completes the read.
      expect(toolStates(control).map(s => s.status)).toEqual(["completed"]);
      expect(control.lifecycleEvaluate).toEqual([{ action: "read", denied: false }]);
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);
  it("S7 resuming a child with a different per-call model and variant (twice): which model and effort reach the provider", async () => {
    const host = await startSpikeHost("s7", { [NO_MODEL]: agentWithoutModel() });
    try {
      const root = await host.newRoot("s7 root");
      const table: Obj[] = [];
      const step = async (label: string, model: string, sessionID?: string) => {
        const mark = host.provider.requests.length;
        const call = await host.call(root, "subagent", { agent: NO_MODEL, description: `S7 ${label}`, prompt: `S7 ${label}`, model, background: false, ...(sessionID ? { sessionID } : {}) });
        const childID = call.childID ?? sessionID;
        const stored = childID ? await host.client.session.get({ sessionID: childID }) : undefined;
        const requests = host.provider.requests.slice(mark).filter(r => r.session === childID && r.kind === "primary");
        const row = {
          label, asked: model, resumed: sessionID !== undefined, childID, sameChildAsResumed: sessionID === undefined ? undefined : childID === sessionID,
          toolStatus: call.after.status, toolError: call.after.error, storedModel: stored?.model ? ref(stored.model) : undefined, storedAgent: stored?.agent, storedParent: stored?.parentID,
          totalInputTokens: stored?.tokens?.input, wire: requests.map(wire),
        };
        table.push(row);
        return row;
      };
      // Anthropic Messages: start low on sonnet, resume on opus xhigh, resume again on sonnet medium.
      const a0 = await step("anthropic start sonnet#low", `${SONNET}#low`);
      const a1 = await step("anthropic resume 1 opus#xhigh", `${OPUS}#xhigh`, a0.childID);
      const a2 = await step("anthropic resume 2 sonnet#medium", `${SONNET}#medium`, a0.childID);
      // OpenAI Responses: luna low, resume on sol high, resume again on luna max.
      const o0 = await step("responses start luna#low", `${LUNA}#low`);
      const o1 = await step("responses resume 1 sol#high", `${SOL}#high`, o0.childID);
      const o2 = await step("responses resume 2 luna#max", `${LUNA}#max`, o0.childID);
      // Cross-provider: an Anthropic child resumed on an OpenAI model.
      const x0 = await step("cross start sonnet#low", `${SONNET}#low`);
      const x1 = await step("cross resume luna#high", `${LUNA}#high`, x0.childID);
      const children = (await host.children(root)).map(c => c.id);
      await save("S7", { table, rootChildren: children, hostErrors: host.errorLines(), providerErrors: host.provider.errors });

      for (const row of [a1, a2, o1, o2, x1]) {
        expect(row.toolStatus, String(row.label)).toBe("completed");
        expect(row.sameChildAsResumed, String(row.label)).toBe(true);
        expect(row.wire, String(row.label)).toHaveLength(1);
      }
      // Anthropic: every resume reaches the provider with the PER-CALL model (wire model and catalog ref) and the stored model follows it.
      expect(a0).toMatchObject({ storedModel: `${SONNET}#low`, wire: [{ wireModel: "claude-sonnet-5-5", effort: "low" }] });
      expect(a1).toMatchObject({ storedModel: `${OPUS}#xhigh`, wire: [{ wireModel: "claude-opus-5-5", catalogModel: `${OPUS}#xhigh` }] });
      expect(a2).toMatchObject({ storedModel: `${SONNET}#medium`, wire: [{ wireModel: "claude-sonnet-5-5", catalogModel: `${SONNET}#medium` }] });
      // The effort the provider is told to use follows the resumed variant (the last in-band effort, else the top-level one).
      expect(a1.wire[0]).toMatchObject({ effort: "xhigh" });
      expect(a2.wire[0]).toMatchObject({ effort: "medium" });
      // OpenAI Responses: same, for the model; the effort follows the stored variant (the host sends the change in-band).
      expect(o0).toMatchObject({ storedModel: `${LUNA}#low`, wire: [{ protocol: "responses", wireModel: "gpt-6-luna", effort: "low", topLevelEffort: "low" }] });
      expect(o1).toMatchObject({ storedModel: `${SOL}#high`, wire: [{ wireModel: "gpt-6-sol", catalogModel: `${SOL}#high`, effort: "high" }] });
      expect(o2).toMatchObject({ storedModel: `${LUNA}#max`, wire: [{ wireModel: "gpt-6-luna", catalogModel: `${LUNA}#max`, effort: "max" }] });
      // Cross-provider resume: the child moves to the OpenAI model.
      expect(x1).toMatchObject({ storedModel: `${LUNA}#high`, wire: [{ protocol: "responses", wireModel: "gpt-6-luna", effort: "high" }] });
      // When the MODEL changes with the resume, the new effort is the TOP-LEVEL one (no in-band configuration change), on both protocols.
      for (const row of [a1, a2, o1, o2, x1]) {
        expect(row.wire[0]?.inBandEfforts, String(row.label)).toEqual([]);
        expect(row.wire[0]?.topLevelEffort, String(row.label)).toBe(row.wire[0]?.effort);
      }
      // one child per start, no child created by a resume.
      expect(children.sort()).toEqual([a0.childID, o0.childID, x0.childID].sort());
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);

  // ---------------------------------------------------------------------------------------------- group B ----
  it("S3 per-session narrowing: evaluate and context hooks keyed by event.sessionID affect ONE child of an agent only", async () => {
    const host = await startSpikeHost("s3", { [NO_MODEL]: agentWithoutModel() }, {
      probe: { lifecycle: true, bySession: { denyTitle: "S3 A", denyActions: ["read"], stripTitle: "S3 C", stripTools: ["shell", "write"] } },
    });
    try {
      const file = path.join(host.project, "s3-read.txt");
      await writeFile(file, "S3\n");
      const [rootA, rootB, rootC, rootD] = await Promise.all([1, 2, 3, 4].map(i => host.newRoot(`s3 root ${i}`)));
      const input = (title: string, prompt: string): Obj => ({ agent: NO_MODEL, description: title, prompt });
      // permission evaluate: two concurrent children of the SAME agent, `read` denied for the child titled "S3 A" only.
      const [a, b] = await Promise.all([childReport(host, rootA!, input("S3 A", readProbe(file))), childReport(host, rootB!, input("S3 B", readProbe(file)))]);
      // context hook: two concurrent children of the same agent, `shell` and `write` removed from the catalog of "S3 C" only.
      const [c, d] = await Promise.all([childReport(host, rootC!, input("S3 C", readProbe(file))), childReport(host, rootD!, input("S3 D", readProbe(file)))]);
      await save("S3", { a, b, c, d, overlap: { ab: a.startedAt < b.endedAt && b.startedAt < a.endedAt, cd: c.startedAt < d.endedAt && d.startedAt < c.endedAt }, hostErrors: host.errorLines() });

      expect(a.child.agent).toBe(NO_MODEL);
      expect(b.child.agent).toBe(NO_MODEL);
      // A: refused, with the plugin's message; B: the read ran. Decided from event.sessionID (title resolved through session.get).
      expect(a.toolStates).toEqual([expect.objectContaining({ status: "error", errorType: "permission.rejected", errorMessage: "PROBE_SESSION_DENIED: read" })]);
      expect(b.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(decisionsOf(a, "evaluate")).toEqual([{ decision: "deny", action: "read" }].map(x => expect.objectContaining(x)));
      expect(decisionsOf(b, "evaluate")).toEqual([{ decision: "pass", action: "read" }].map(x => expect.objectContaining(x)));
      // the parents see two plain completed children; the refusal is only in A's own session.
      expect(a.parentToolStatus).toBe("completed");
      expect(b.parentToolStatus).toBe("completed");
      expect(a.child.outcome).toBe("succeeded");
      // context hook: the provider request of C has no shell/write, the request of D has them; read and the rest are untouched.
      const names = (r: ChildReport) => r.requests.map(x => x.toolNames);
      expect(names(c)).toHaveLength(2);
      for (const list of names(c)) {
        expect(list).not.toContain("shell");
        expect(list).not.toContain("write");
        expect(list).toContain("read");
        expect(list).toContain("edit");
      }
      for (const list of names(d)) {
        expect(list).toContain("shell");
        expect(list).toContain("write");
        expect(list).toContain("read");
      }
      expect(c.decisions.filter(x => x.point === "context").every(x => x.decision === "strip" && JSON.stringify(x.removed) === JSON.stringify(["shell", "write"]))).toBe(true);
      expect(d.decisions.filter(x => x.point === "context").every(x => x.decision === "pass")).toBe(true);
      // the stripped tools come from event.tools of that session only: A and B (not stripped) still advertise them.
      expect(a.requests[0]?.toolNames).toContain("shell");
      expect(b.requests[0]?.toolNames).toContain("write");
    } finally { await finish(host); }
  }, 300_000);

  it("S3 edge: a plugin hook that throws (evaluate / context) - the host's reaction", async () => {
    const file = "s3-throw.txt";
    const observe = async (hook: "evaluate" | "context") => {
      const host = await startSpikeHost(`s3t-${hook}`, { [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, bySession: { throwTitle: "S3 T", throwHook: hook } } });
      try {
        await writeFile(path.join(host.project, file), "S3\n");
        const root = await host.newRoot("s3 throw root");
        const report = await childReport(host, root, { agent: NO_MODEL, description: "S3 T", prompt: readProbe(path.join(host.project, file)) });
        const stillWorks = await childReport(host, root, { agent: NO_MODEL, description: "S3 ok", prompt: readProbe(path.join(host.project, file)) });
        return { hook, report, stillWorks, hostErrors: host.errorLines(), providerErrors: host.provider.errors };
      } finally { await finish(host); }
    };
    const evaluate = await observe("evaluate");
    const context = await observe("context");
    await save("S3-throw", { evaluate, context });
    expect(evaluate.report.decisions.some(d => d.decision === "throw")).toBe(true);
    expect(context.report.decisions.some(d => d.decision === "throw")).toBe(true);
    // evaluate throws: the host does not fail open. The single tool call is refused with the thrown message (error type "unknown", surfaced
    // in the CHILD's tool state only); the child recovers and ends `succeeded`; the parent sees a plain completed child; the hook stays
    // registered and the next child of the same agent is evaluated normally.
    expect(evaluate.report.toolStates).toEqual([expect.objectContaining({ status: "error", errorType: "unknown", errorMessage: "PROBE_HOOK_THROWN evaluate" })]);
    expect(evaluate.report.events).toContain("session.tool.failed");
    expect(evaluate.report.child.outcome).toBe("succeeded");
    expect(evaluate.report.parentToolStatus).toBe("completed");
    expect(evaluate.stillWorks.toolStates.map(s => s.status)).toEqual(["completed"]);
    expect(evaluate.hostErrors).toEqual([]);
    // context throws: the child's very first model request is never made (0 provider requests); the child execution FAILS
    // (session.execution.failed, outcome failed, no step started) and the error is surfaced in the PARENT's subagent tool call
    // ("Subagent failed (sessionID: ...): <message>", status error) and as one host ERROR log line "Failed to drain Session".
    expect(context.report.requests).toHaveLength(0);
    expect(context.report.events.at(-1)).toBe("session.execution.failed");
    expect(context.report.events).not.toContain("session.step.started");
    expect(context.report.child.outcome).toBe("failed");
    expect(context.report.parentToolStatus).toBe("error");
    expect(String(obj(context.report.parentToolError).string)).toMatch(/^Tool\.Error: Subagent failed \(sessionID: ses_[A-Za-z0-9]+\): PROBE_HOOK_THROWN context$/);
    expect(context.hostErrors).toHaveLength(1);
    expect(context.hostErrors[0]).toContain("Failed to drain Session");
    expect(context.hostErrors[0]).toContain("PROBE_HOOK_THROWN context");
    // the failed child does not poison the agent: the next child of the same agent runs.
    expect(context.stillWorks.toolStates.map(s => s.status)).toEqual(["completed"]);
  }, 300_000);

  it("S6 tool.hook execute.after on the parent's subagent call appends text the PARENT model sees on its next request", async () => {
    const NOTE = "S6_APPENDED_NOTE_FOR_THE_PARENT";
    const host = await startSpikeHost("s6", { [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, afterAppend: { tool: "subagent", text: NOTE } } });
    try {
      const root = await host.newRoot("s6 root");
      const call = await host.dispatch(root, { agent: NO_MODEL, description: "S6", prompt: "S6 child", model: `${SONNET}#low`, background: false });
      const parentRequests = host.requestsOf(root).filter(r => r.kind === "primary");
      const withResult = parentRequests.filter(r => r.toolResult);
      const next = withResult[0];
      const toolResultBlocks = (next?.messages ?? []).flatMap(m => arr(m.content).map(obj)).filter(b => b.type === "tool_result");
      const childRequests = primary(host, call.childID);
      const afterRecord = call.after;
      await save("S6", { parentRequestCount: parentRequests.length, withResultCount: withResult.length, toolResultBlocks, afterHookResult: afterRecord.result, childMessagesContainNote: childRequests.some(r => JSON.stringify(r.messages).includes(NOTE)), decisions: (await host.events()).filter(e => e.type === "probe.decision") });

      expect(next, "the parent's next provider request after the subagent call").toBeDefined();
      // the parent's tool_result block (what the parent MODEL receives) carries both the child's text and the appended note.
      expect(toolResultBlocks).toHaveLength(1);
      const received = JSON.stringify(toolResultBlocks[0]);
      expect(received).toContain("CHILD_OK");
      expect(received).toContain(NOTE);
      expect(received.indexOf(NOTE)).toBeGreaterThan(received.indexOf("CHILD_OK"));
      // the note exists only in the parent's view: the child's own requests never carry it.
      expect(childRequests.some(r => JSON.stringify(r.messages).includes(NOTE))).toBe(false);
      expect((await host.events()).filter(e => e.type === "probe.decision" && e.point === "execute.after")).toHaveLength(1);
    } finally { await finish(host); }
  }, 300_000);

  it("S8 Code Mode execute: inner tools.* calls bypass the permission evaluate hook and the per-session context filter", async () => {
    const host = await startSpikeHost("s8", { [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, bySession: { keepOnlyTitle: "S8 keep", keepOnly: ["execute", "subagent"] } } });
    try {
      const root = await host.newRoot("s8 root");
      const run = (title: string, code: string) => childReport(host, root, { agent: NO_MODEL, description: title, prompt: executeProbe(code) });
      const text = (r: ChildReport) => r.toolStates[0]?.text ?? "";
      await writeFile(path.join(host.project, "s8-native.txt"), "S8\n");
      const plainKeys = await run("S8 plain", "return { ns: Object.keys(tools), opencode: Object.keys(tools.opencode), browser: Object.keys(tools.browser) }");
      const plainModels = await run("S8 plain models", "return await tools.opencode.models({})");
      const plainBrowser = await run("S8 plain browser", "return await tools.browser.tabs({})");
      const plainRename = await run("S8 plain rename", "return await tools.opencode.session_rename({ title: 'S8 renamed by execute' })");
      const plainSearch = await run("S8 plain search", "return search({ query: 'rename session', limit: 3 })");
      const native = await childReport(host, root, { agent: NO_MODEL, description: "S8 native", prompt: readProbe(path.join(host.project, "s8-native.txt")) });
      const keepKeys = await run("S8 keep", "return { ns: Object.keys(tools), opencode: Object.keys(tools.opencode) }");
      const keepOutside = await run("S8 keep", "return await tools.opencode.session_rename({ title: 'S8 keep renamed' })");
      const keepSearch = await run("S8 keep", "return search({ query: 'rename session', limit: 3 })");
      const renamed = await host.client.session.get({ sessionID: plainRename.childID });
      const keepRenamed = await host.client.session.get({ sessionID: keepOutside.childID });
      await save("S8", { plainKeys, plainModels, plainBrowser, plainRename, plainSearch, native, keepKeys, keepOutside, keepSearch, renamedTitle: renamed.title, keepRenamedTitle: keepRenamed.title, hostErrors: host.errorLines() });

      // Code Mode is on by default in the isolated host: `execute` is advertised to the child and runs.
      expect(plainKeys.requests[0]?.toolNames).toContain("execute");
      expect(plainKeys.toolStates.map(s => s.status)).toEqual(["completed"]);
      // The INNER catalog is NOT the agent's tool list: two namespaces, `opencode` (5 host API operations) and `browser` (inert here).
      const inner = JSON.parse(text(plainKeys)) as { ns: string[]; opencode: string[]; browser: string[] };
      expect(inner.ns).toEqual(["opencode", "browser"]);
      expect(inner.opencode).toEqual(["session_rename", "session_move", "models", "list_mcp_resources", "read_mcp_resource"]);
      expect(inner.browser).toHaveLength(30);
      expect(inner.browser).toEqual(expect.arrayContaining(["tabs", "navigate", "lighthouse"]));
      // Inner calls run WITHOUT any permission.hook("evaluate") event: not for `execute` itself, nor for the inner calls (including
      // the mutating `session_rename`, which really renamed the child's session on the host), nor for search.
      for (const r of [plainKeys, plainModels, plainBrowser, plainRename, plainSearch, keepKeys, keepOutside, keepSearch]) expect(r.evaluates).toEqual([]);
      expect(plainModels.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(text(plainModels)).toContain("anthropic/claude-sonnet-5-5");
      expect(renamed.title).toBe("S8 renamed by execute");
      expect(plainRename.toolStates[0]?.text).toContain("S8 renamed by execute");
      // the browser namespace is listed but its operations are not callable.
      expect(text(plainBrowser)).toBe("Tool 'browser.tabs' is not callable.");
      // search() sees the inner catalog (and only the inner catalog): it finds the rename operation, not agent tools.
      expect(text(plainSearch)).toContain("tools.opencode.session_rename");
      // Control: a NATIVE tool call of the same kind of child does produce an evaluate event.
      expect(native.evaluates).toEqual([{ action: "read", denied: false }]);
      // The per-session context hook CAN cut the agent-level catalog (provider request: exactly [subagent, execute]) ...
      expect(keepKeys.requests.map(r => r.toolNames)).toEqual([["subagent", "execute"], ["subagent", "execute"]]);
      expect(keepKeys.decisions.filter(d => d.point === "context").every(d => d.decision === "strip" && !(d.after as string[]).includes("read"))).toBe(true);
      // ... but event.tools has no inner entries, so the Code Mode catalog is unchanged by it (same namespaces, same operations,
      // search still finds them) and an inner call OUTSIDE the allowlist still runs and mutates host state.
      const keepInner = JSON.parse(text(keepKeys)) as { ns: string[]; opencode: string[] };
      expect(keepInner).toEqual({ ns: inner.ns, opencode: inner.opencode });
      expect(text(keepSearch)).toContain("tools.opencode.session_rename");
      expect(keepOutside.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(keepRenamed.title).toBe("S8 keep renamed");
      expect(host.errorLines()).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);

  it("S9 rewriting args.agent explore -> explorer in tool.hook execute.before: the child runs as the rewritten agent", async () => {
    const MARK = "S9_EXPLORER_PROMPT_MARKER";
    const host = await startSpikeHost("s9", {
      explorer: agentWithoutModel({ system: MARK, description: "S9 custom explorer", permissions: [{ action: "edit", resource: "*", effect: "deny" }] }),
      [NO_MODEL]: agentWithoutModel(),
    }, { probe: { lifecycle: true, rewriteAgent: { from: "explore", to: "explorer" } } });
    try {
      const root = await host.newRoot("s9 root");
      const hostAgents = (await host.client.agent.list()).data.map(a => ({ id: a.id, mode: a.mode, model: a.model, hidden: a.hidden }));
      const rewritten = await childReport(host, root, { agent: "explore", description: "S9 rewritten", prompt: "S9 child" });
      const control = await childReport(host, root, { agent: NO_MODEL, description: "S9 control", prompt: "S9 child" });
      const before = (await host.hooks()).filter(h => h.hook === "before" && h.callID !== undefined && h.sessionID === root && h.tool === "subagent").map(h => obj(h.input));
      const decision = (await host.events()).find(e => e.type === "probe.decision" && e.point === "execute.before");
      const view = await host.client.session.get({ sessionID: rewritten.childID });
      const life = await lifecycle(host, rewritten.childID);
      const agentRecords = (await host.client.agent.list()).data;
      const explorerRecord = agentRecords.find(a => a.id === "explorer");
      const exploreRecord = agentRecords.find(a => a.id === "explore");
      await save("S9", { explorerPermissions: explorerRecord?.permissions, explorePermissions: exploreRecord?.permissions, hostAgents, rewritten, control, probeBeforeInputs: before, decision, childSession: sessionView(obj(view)), lifecycle: (await lifecycle(host, rewritten.childID)).context });

      // The rewrite is honoured by the host: the child session is created and runs as `explorer`, not `explore`.
      expect(rewritten.child).toMatchObject({ agent: "explorer", title: "S9 rewritten", outcome: "succeeded" });
      expect(view.agent).toBe("explorer");
      expect(obj(decision).inputBefore).toMatchObject({ agent: "explore" });
      expect(obj(decision).inputAfter).toMatchObject({ agent: "explorer" });
      // The provider request is the rewritten agent's: its prompt (system) carries the custom marker, the control agent's does not.
      expect(rewritten.requests).toHaveLength(1);
      expect(rewritten.requests[0]?.system.startsWith(MARK)).toBe(true);
      expect(control.requests[0]?.system.includes(MARK)).toBe(false);
      // The permissions are the rewritten agent's too (the host's own agent record), and the session context hook saw `explorer`.
      expect(explorerRecord?.permissions).toEqual(expect.arrayContaining([{ action: "edit", resource: "*", effect: "deny" }]));
      expect(exploreRecord?.permissions).not.toEqual(expect.arrayContaining([{ action: "edit", resource: "*", effect: "deny" }]));
      expect(obj(life.context).agent).toBe("explorer");
      expect(sessionView(obj(obj(life.context).got))).toMatchObject({ parentID: root, agent: "explorer", title: "S9 rewritten" });
      // The parent's call completes as usual; the host's tool-call record shows the pre-rewrite input only to hooks that ran BEFORE the rewrite.
      expect(rewritten.parentToolStatus).toBe("completed");
      expect(before[0]).toMatchObject({ agent: "explore" });
      expect(control.child.agent).toBe(NO_MODEL);
    } finally { await finish(host); }
  }, 300_000);
});