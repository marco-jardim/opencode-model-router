/** Issue #84, plan P0.1: role spikes S1-S12 on a REAL OpenCode v2 host (2.0.24 live, 2.0.22 source).
 *
 *   RUN_OC_SMOKE_ROLE_SPIKES=1 [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/role-spikes.smoke.test.ts
 *
 * - Without RUN_OC_SMOKE_ROLE_SPIKES=1 every test is skipped (the normal `vitest run` excludes test/smoke anyway).
 * - Every spike starts its OWN isolated host (see helpers/routing-host.ts: allow-listed environment, private HOME, scripted keyless
 *   Anthropic + OpenAI Responses provider, the router loaded from THIS checkout next to the probe plugin) and tears it down.
 * - The assertions PIN WHAT THE HOST DID (provider wire requests, host session API, probe hooks/events), never the scripted
 *   provider's own echo. If a host upgrade changes the behaviour, the matching spike fails loudly.
 * - Raw observations of each spike are written (redacted) to <OMR_SMOKE_REAL_TMPDIR>/omr-role-spikes/<spike>.json so they can be
 *   cited; nothing is written to the repository.
 * - Shared helpers (`startSpikeHost`, `wire`, `save`, `childReport`, `lifecycle`) sit at the top; each spike is one `it`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENAI_PROVIDER, RoutingHost, agentWithoutModel, arr, effectiveEffort, obj, redact, ref, stopAllHosts, str,
  type EventRecord, type HostOptions, type Obj, type WireRequest,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROLE_SPIKES === "1";
const d = RUN ? describe : describe.skip;
afterAll(async () => { await stopAllHosts(); }, 60_000);

// ------------------------------------------------------------------ shared setup ----
/** The smoke temp guard removes the per-run TEMP at the end, so the observations go to the real temp directory it recorded. */
const OUT = path.join(process.env.OMR_SMOKE_REAL_TMPDIR ?? tmpdir(), "omr-role-spikes");
const NO_MODEL = "role-nomodel";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const LUNA = "openai/gpt-6-luna";
const SOL = "openai/gpt-6-sol";

/** Starts an isolated host with `agents` registered in the host's own opencode.json (they carry exactly the fields given) and the lifecycle probe on. */
async function startSpikeHost(name: string, agents: Record<string, Obj>, extra: Partial<HostOptions> = {}): Promise<RoutingHost> {
  const { probe, ...rest } = extra;
  return RoutingHost.start(name, {
    routing: { engine: "shadow" }, providers: OPENAI_PROVIDER, hostConfig: { agents }, ...rest,
    probe: { lifecycle: true, ...probe }, // lifecycle logging is always on; a spike adds its own options on top
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

// ---- tool-call and child-report helpers ----
const toolStatesOf = (context: Obj[]): Obj[] => context.flatMap(m => arr(obj(m).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
const stateView = (s: Obj) => ({ status: s.status, errorType: obj(s.error).type, errorMessage: obj(s.error).message, text: typeof s.content === "string" ? s.content : (arr(s.content).map(c => str(obj(c).text)).join("\n") || (s.output === undefined ? "" : JSON.stringify(s.output).slice(0, 600))) });
/** What the PARENT model was given for one of its tool calls: the tool_result block (matched by tool_use_id) of its own later provider request. */
function parentView(host: RoutingHost, root: string, callID: string): { found: boolean; isError: unknown; parts: string[]; text: string } {
  for (const r of [...host.requestsOf(root)].reverse()) {
    if (r.kind !== "primary" || !r.toolResult) continue;
    const blocks = r.messages.flatMap(m => arr(m.content).map(obj)).filter(b => b.type === "tool_result" && b.tool_use_id === callID);
    if (blocks.length === 0) continue;
    const parts = blocks.flatMap(b => (typeof b.content === "string" ? [b.content] : arr(b.content).map(c => str(obj(c).text) ?? "")));
    return { found: true, isError: blocks.at(-1)!.is_error, parts, text: parts.join("\n") };
  }
  return { found: false, isError: undefined, parts: [], text: "" };
}
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
    callID: call.callID, parentToolStatus: call.after.status, parentToolError: call.after.error, parentOutput: str(obj(obj(call.after.result).output).output),
    parentSeen: parentView(host, root, call.callID),
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
// ---- S11 helpers: a git repo (the host's project = the main checkout) with sibling worktrees and unrelated directories ----
async function s11World(host: RoutingHost) {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: host.project, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  for (const name of ["m.txt", "e0.txt", "e1.txt", "e2.txt", "e3.txt"]) await writeFile(path.join(host.project, name), "main\n");
  git("add", "."); git("commit", "-q", "-m", "init");
  const wt1 = path.join(host.root, "wt-1");
  const wt2 = path.join(host.root, "wt-2");
  const other = path.join(host.root, "other");
  const evil = path.join(host.root, "wt-evil"); // matches the glob `wt-*` but is a plain directory, not a worktree
  git("worktree", "add", "-q", wt1, "-b", "wt1");
  for (const dir of [other, evil, path.join(wt1, "sub", "deep")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(other, "x.txt"), "other\n");
  await writeFile(path.join(evil, "x.txt"), "evil\n");
  await writeFile(path.join(wt1, "sub", "deep", "n.txt"), "nested\n"); // untracked in wt-1
  await writeFile(path.join(host.project, "main-only-dirty.txt"), "dirty\n"); // untracked in the main checkout only
  return { git, wt1, wt2, other, evil, addLaterWorktree: async () => { git("worktree", "add", "-q", wt2, "-b", "wt2"); return path.join(wt2, "e3.txt"); } };
}
/** One scripted tool call by a child of `agent`, dispatched from a root session in the main checkout (rootPerms: no inherited grants, or the allow-all default of newRoot). */
async function s11Op(host: RoutingHost, agent: string, label: string, tool: string, input: Obj, rootPerms: "none" | "allow-all" = "none") {
  const root = await host.newRoot(`s11 ${agent} ${label}`, undefined, host.project, rootPerms === "allow-all" ? undefined : []);
  const r = await childReport(host, root, { agent, description: `S11 ${agent} ${label}`, prompt: `READ_ONLY_PROBE=${JSON.stringify({ tool, input })}` });
  const norm = (value: unknown) => String(value).replaceAll("\\", "/").toLowerCase();
  const evaluates = (await lifecycle(host, r.childID)).evaluates.map(e => ({ action: e.action, resources: arr(e.resources).map(norm), effectIn: e.effectIn, effectOut: e.effectOut }));
  return { agent, label, state: r.toolStates[0], evaluates, sessionAgent: r.child.agent, childTitle: r.child.title, toolNames: r.requests[0]?.toolNames ?? [] };
}
// ------------------------------------------------------------------------------------------------ the spikes ----
d("role spikes on the real OpenCode v2 host (issue #84, P0.1)", () => {
  it("S1 agent registered without a model: the per-call model and variant reach the provider (Anthropic and OpenAI Responses)", async () => {
    const host = await startSpikeHost("s1", { [NO_MODEL]: agentWithoutModel() });
    try {
      const onDisk = obj(obj((await host.hostConfigOnDisk()).agents)[NO_MODEL]);
      const hostAgent = (await host.client.agent.list()).data.find(a => a.id === NO_MODEL);
      // The root runs on a model AND variant that no dispatch below asks for (opus-5-5#medium; the per-call models are sonnet#medium,
      // opus#xhigh and luna#high) and that is not the host default (anthropic/claude-opus-4-7), so what the child without a per-call
      // model gets can only come from the parent session.
      const rootModel = { providerID: "anthropic", id: "claude-opus-5-5", variant: "medium" };
      const root = await host.newRoot("s1 root", rootModel);
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
      expect(hostAgent, "the model-less agent is registered").toBeDefined();
      expect(hostAgent?.model).toBeUndefined();
      expect(parent.model).toEqual(rootModel);
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
      // Without a per-call model the model-less agent INHERITS the PARENT SESSION's model AND variant (opus-5-5#medium: neither the host
      // default opus-4-7 nor any earlier dispatch's model) and the parent's effort is what the provider is told.
      expect(bare).toMatchObject({ storedModel: `${OPUS}#medium`, wire: [{ wireModel: "claude-opus-5-5", catalogModel: `${OPUS}#medium`, effort: "medium", topLevelEffort: "medium", inBandEfforts: [] }] });
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);

  it("S2 serialised samples: child session as seen from the first context build and first permission evaluation (parentID / agent / title / model), session.created order", async () => {
    const host = await startSpikeHost("s2", { [NO_MODEL]: agentWithoutModel() });
    try {
      const rootA = await host.newRoot("s2 root A");
      const rootB = await host.newRoot("s2 root B");
      const probeFile = path.join(host.project, "s2-read.txt");
      await writeFile(probeFile, "S2\n");
      const TITLE = "S2 same title";
      const input = (prompt: string): Obj => ({ agent: NO_MODEL, description: TITLE, prompt, model: `${SONNET}#low`, background: false });
      // (1) two roots dispatch the same agent with the same title, started together (NOT proven to overlap: see the next test).
      const parallel = await Promise.all([host.dispatch(rootA, input("S2 parallel A")), host.dispatch(rootB, input("S2 parallel B"))]);
      // (2) the same root dispatches twice in successive turns, flagged background:true (separate turns, each settled before the next). With the
      //     default enforcement (not off) the router rewrites every subagent call to background:false before the host sees it (asserted
      //     below from the probe's before record), so these are foreground children in practice.
      const bg1 = await host.call(rootA, "subagent", { ...input("S2 background 1"), background: true });
      const bg2 = await host.call(rootA, "subagent", { ...input("S2 background 2"), background: true });
      const kids = (await host.children(rootA)).map(k => k.id);
      const bgIDs = [bg1.childID, bg2.childID].filter((id): id is string => id !== undefined);
      expect([obj(bg1.before.input).background, obj(bg2.before.input).background]).toEqual([false, false]);
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
          sameProbeInstance: life.created !== undefined && life.context !== undefined && life.created.__iid === life.context.__iid,
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
        // observed in these serialised samples (NOT a host guarantee: the probe receives events through a detached loop): the probe sees
        // session.created before the child's first context hook. Both records come from the same probe instance (same process, so the
        // shared sequence counter is comparable), and the event payload already carries parentID / agent / title / model.
        expect(row.sameProbeInstance, `${String(row.label)} created and context seen by one probe instance`).toBe(true);
        expect(row.createdBeforeContext, `${String(row.label)} session.created seen before context`).toBe(true);
        expect(obj(obj(row.createdEvent).data)).toMatchObject({ parentID: row.expectedParent, agent: NO_MODEL, title: TITLE, model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" } });
        // pinned: no permission evaluation happens for a child that calls no tool.
        if (row.label !== "reader") expect(row.evaluateActions).toEqual([]);
      }
      // pinned: the three children of rootA (2 background + 1 parallel) all carry the identical title and the same agent.
      expect(kids.sort()).toEqual([parallel[0].childID, ...bgIDs].sort());
      const reading = rows.find(r => r.label === "reader")!;
      expect((reading.evaluateActions as string[]).length).toBeGreaterThan(0);
      expect(obj(reading.atFirstEvaluate)).toMatchObject({ parentID: rootB, agent: NO_MODEL, title: TITLE });
      // these two (different roots, same agent, same title, dispatched together) are told apart only by parentID.
      expect(new Set(rows.slice(0, 2).map(r => obj(r.atContext).title)).size).toBe(1);
      expect(rows[0]!.childID).not.toBe(rows[1]!.childID);
    } finally { await finish(host); }
  }, 300_000);

  it("S2 siblings spawned by ONE parent turn with their first requests held in flight: overlap, creation/context order, nonce binding", async () => {
    const run = async (name: string, nonce: boolean) => {
      const host = await startSpikeHost(name, { [NO_MODEL]: agentWithoutModel() }, { probe: { nonce } });
      try {
        host.provider.holdUntilOverlap("S2_HOLD", 2);
        const root = await host.newRoot(`${name} root`);
        const TITLE = "S2 twin";
        const input = { agent: NO_MODEL, description: TITLE, prompt: "S2_HOLD twin", model: `${SONNET}#low`, background: false };
        const calls = await host.callMany(root, [input, input]);
        const events = await host.events();
        const rows = await Promise.all(calls.map(async (call, index) => {
          const life = await lifecycle(host, call.childID!);
          return {
            index, callID: call.callID, childID: call.childID, beforeN: call.before.__n,
            created: life.created ? { n: life.created.__n, iid: life.created.__iid, data: life.created.data } : undefined,
            context: life.context ? { n: life.context.enteredN, iid: life.context.__iid, got: life.context.got, agent: life.context.agent, messages: life.context.messages } : undefined,
          };
        }));
        const order = rows.flatMap(r => [{ what: "before", child: r.index, n: Number(r.beforeN) }, { what: "created", child: r.index, n: Number(r.created?.n) }, { what: "context", child: r.index, n: Number(r.context?.n) }]).sort((a, b) => a.n - b.n).map(x => `${x.what}:${x.child}`);
        const barrier = host.provider.barrier!;
        return {
          root, rows, order, barrier: { arrivals: barrier.arrivals.length, releasedByArrival: barrier.releasedByArrival, timedOut: barrier.timedOut },
          parentBeforeOrder: calls.map(c => c.callID), firstContextOrder: [...rows].sort((a, b) => Number(a.context?.n) - Number(b.context?.n)).map(r => r.callID),
          instances: new Set(events.filter(e => e.type === "probe.instance.started").map(e => e.__iid)).size,
          rootChildren: (await host.children(root)).map(c => c.id), nonceDecisions: events.filter(e => e.type === "probe.decision" && e.decision === "nonce").map(e => e.callID),
          hostErrors: host.errorLines(),
        };
      } finally { await finish(host); }
    };
    const plain = await run("s2-twins", false);
    const tagged = await run("s2-nonce", true);
    await save("S2-overlap", { plain, tagged });

    const text = (messages: unknown): string => arr(messages).map(m => arr(obj(JSON.parse(String(m))).content).map(c => str(obj(c).text) ?? "").join("")).join("\n");
    for (const [label, r] of [["plain", plain], ["tagged", tagged]] as const) {
      // Overlap: the first model requests of BOTH siblings were in flight at the same time (the scripted provider held each one until both
      // had arrived; released by arrival, not by timeout), so the host runs the children of one parent turn concurrently.
      expect(r.barrier, label).toEqual({ arrivals: 2, releasedByArrival: true, timedOut: false });
      expect(r.instances, `${label}: one probe instance (one process, comparable sequence numbers)`).toBe(1);
      expect(r.hostErrors).toEqual([]);
      expect(r.rootChildren.sort()).toEqual(r.rows.map(x => x.childID).sort());
      for (const row of r.rows) expect(row.created?.iid === row.context?.iid && row.created?.iid !== undefined, label).toBe(true);
      // The full interleaving of the parent's execute.before records, session.created and first context hooks is RECORDED (S2-overlap.json,
      // `order`) and not asserted: it is an observation of this host, not a contract. What is asserted: every child has its records, and the
      // order of the first context hooks equals the order of the parent's execute.before records.
      for (const row of r.rows) { expect(row.created, label).toBeDefined(); expect(row.context, label).toBeDefined(); expect(Number.isFinite(Number(row.beforeN)), label).toBe(true); }
      expect(r.order, label).toHaveLength(6);
      expect(r.firstContextOrder, label).toEqual(r.parentBeforeOrder);
      for (const row of r.rows) expect(obj(row.context?.got), label).toMatchObject({ parentID: r.root, agent: NO_MODEL, model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" } });
    }
    // Without a nonce the siblings are indistinguishable at the first context hook: same parentID, agent, title, model and the same
    // first-message text; only the child session id differs.
    const [p0, p1] = plain.rows;
    expect(plain.nonceDecisions).toEqual([]);
    expect(p0!.context!.got).toEqual(p1!.context!.got);
    expect(obj(p0!.context!.got).title).toBe("S2 twin");
    expect(text(p0!.context!.messages)).toBe(text(p1!.context!.messages));
    expect(p0!.childID).not.toBe(p1!.childID);
    // With a per-dispatch nonce (the probe's execute.before adds the call id to description and prompt) each child shows ITS dispatch's call
    // id in the title (session.get) and in the first context message, and that id maps to the child the parent's own tool result names.
    expect(tagged.nonceDecisions).toEqual(tagged.parentBeforeOrder);
    for (const row of tagged.rows) {
      expect(obj(row.context!.got).title).toBe(`S2 twin [nonce ${row.callID}]`);
      expect(text(row.context!.messages)).toContain(`OMR_NONCE=${row.callID}`);
      expect(row.created!.data).toMatchObject({ title: `S2 twin [nonce ${row.callID}]` });
    }
    const boundByNonce = Object.fromEntries(tagged.rows.map(row => [/OMR_NONCE=(\S+)/.exec(text(row.context!.messages))![1], row.childID]));
    expect(boundByNonce).toEqual(Object.fromEntries(tagged.rows.map(row => [row.callID, row.childID])));
  }, 600_000);

  it("S4 how the parent sees a child that hits its step limit (agent steps) and a child whose tool call a plugin guard denies", async () => {
    const host = await startSpikeHost("s4", { "role-steps": agentWithoutModel({ steps: 2 }), "role-steps3": agentWithoutModel({ steps: 3 }), "role-guard": agentWithoutModel(), [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, deny: { agent: "role-guard", actions: ["read"] } } });
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
        const childToolHooks = (await host.hooks()).filter(h => h.sessionID === call.childID && h.hook === "after").map(h => ({ tool: h.tool, status: h.status, result: h.result, error: h.error }));
        // What the PARENT model was actually given: the tool_result of its own NEXT provider request (not the probe's execute.after record).
        const parentRequest = host.requestsOf(root).find(r => r.kind === "primary" && r.toolResult);
        const parentSaw = (parentRequest?.messages ?? []).flatMap(m => arr(m.content).map(obj)).filter(b => b.type === "tool_result")
          .flatMap(b => (typeof b.content === "string" ? [b.content] : arr(b.content).map(c => str(obj(c).text) ?? ""))).join("\n");
        return {
          label, parentToolStatus: call.after.status, parentToolResult: call.after.result, parentToolError: call.after.error,
          child: { outcome: child.outcome, agent: child.agent, tokens: child.tokens },
          childRequests: requests.map(r => ({ ...wire(r), toolNames: r.toolNames, toolResult: r.toolResult, reply: r.reply, systemHasMaxSteps: r.system.includes("MAXIMUM STEPS REACHED") || JSON.stringify(r.messages).includes("MAXIMUM STEPS REACHED"), toolChoice: r.payload.tool_choice })),
          childToolHooks, parentSaw, childEvents, childContext: context,
          lifecycleEvaluate: (await lifecycle(host, call.childID)).evaluates.map(e => ({ action: e.action, denied: e.denied })),
        };
      };
      const steps = await report("step limit, scripted model answers with text on the last step", "role-steps", probe);
      host.provider.loopProbe = true; // a scripted model that keeps calling tools although the host told it that tools are disabled
      const steps3 = await report("steps 3, scripted model keeps calling tools", "role-steps3", probe);
      const stepsLoop = await report("steps 2, scripted model keeps calling tools", "role-steps", probe);
      host.provider.loopProbe = false;
      const guard = await report("guard denial", "role-guard", probe);
      const control = await report("control: no limit no denial", NO_MODEL, probe);
      await save("S4", { steps, steps3, stepsLoop, guard, control, hostErrors: host.errorLines(), providerErrors: host.provider.errors });
      const toolStates = (r: typeof steps) => r.childContext.flatMap(m => arr(obj(m).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
      const finishes = (r: typeof steps) => r.childContext.filter(m => obj(m).type === "assistant").map(m => ({ finish: obj(m).finish, rawFinish: obj(m).rawFinish }));
      // The parent's view = its next provider request's tool_result text (the session id attribute is removed before looking for words).
      // The parent's tool_result is EXACTLY the host envelope around the child's text: nothing else (no step, budget or denial wording).
      const envelope = (text: string) => new RegExp(`^<subagent sessionID="ses_[A-Za-z0-9]+" state="completed">\\n${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n</subagent>$`);
      const MAX = "Tools are disabled after the maximum agent steps";
      // (a) step limit, scripted model that answers with text on the last step: the host appends its MAX-STEPS note and sends
      // tool_choice none on the LAST step; the PARENT's next request carries an ordinary completed child with that text and nothing
      // that marks the budget exhaustion.
      expect(steps.childRequests.map(r => ({ reply: r.reply, maxSteps: r.systemHasMaxSteps, toolChoice: r.toolChoice }))).toEqual([
        { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "text", maxSteps: true, toolChoice: { type: "none" } },
      ]);
      expect(steps.parentSaw).toMatch(envelope("CHILD_OK"));
      expect(steps.child.outcome).toBe("succeeded");
      expect(finishes(steps)).toEqual([{ finish: "tool-calls", rawFinish: "tool_use" }, { finish: "stop", rawFinish: "end_turn" }]);
      expect(steps.childEvents.at(-1)?.type).toBe("session.execution.succeeded");
      // (b) step limit, scripted model that keeps calling a tool although tool_choice is none (a real provider would normally honour it, so
      // this path needs a provider that ignores it): the HOST answers the call on the last step with an error to the child model ("Tools are
      // disabled after the maximum agent steps"), the session ends `succeeded` with finish tool-calls and no text, and the parent's next
      // request carries the host's placeholder text.
      expect(stepsLoop.childRequests.map(r => ({ reply: r.reply, maxSteps: r.systemHasMaxSteps, toolChoice: r.toolChoice }))).toEqual([
        { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "tool", maxSteps: true, toolChoice: { type: "none" } },
      ]);
      expect(toolStates(stepsLoop).map(s => ({ status: s.status, message: obj(s.error).message }))).toEqual([{ status: "completed", message: undefined }, { status: "error", message: MAX }]);
      expect(stepsLoop.childEvents.map(e => e.type)).toContain("session.tool.failed");
      expect(stepsLoop.parentSaw).toMatch(envelope("Subagent completed without a text response."));
      expect(stepsLoop.child.outcome).toBe("succeeded");
      expect(finishes(stepsLoop)).toEqual([{ finish: "tool-calls", rawFinish: "tool_use" }, { finish: "tool-calls", rawFinish: "tool_use" }]);
      // (c) steps 3: the same scripted loop gets TWO tool-capable steps and the third (last) one is tool-less: steps N = N-1 tool steps
      // + 1 final step (observed for N = 2 and N = 3).
      expect(steps3.childRequests.map(r => ({ reply: r.reply, maxSteps: r.systemHasMaxSteps, toolChoice: r.toolChoice }))).toEqual([
        { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "tool", maxSteps: false, toolChoice: undefined }, { reply: "tool", maxSteps: true, toolChoice: { type: "none" } },
      ]);
      expect(toolStates(steps3).map(s => ({ status: s.status, message: obj(s.error).message }))).toEqual([{ status: "completed", message: undefined }, { status: "completed", message: undefined }, { status: "error", message: MAX }]);
      // (d) plugin-guard denial (permission.hook("evaluate") sets effect deny): the child's tool call fails with permission.rejected
      // carrying the plugin's message and the tool hook sees Permission.BlockedError (child-side signals); the scripted child then ends with its
      // fixed reply; the PARENT's next request carries a plain completed child and no trace of the denial.
      expect(guard.lifecycleEvaluate).toEqual([{ action: "read", denied: true }]);
      expect(toolStates(guard).map(s => ({ status: s.status, type: obj(s.error).type, message: obj(s.error).message }))).toEqual([{ status: "error", type: "permission.rejected", message: "PLUGIN_GUARD_DENIED: read" }]);
      expect(guard.childToolHooks.map(h => h.status)).toEqual(["error"]);
      expect(JSON.stringify(guard.childToolHooks[0]?.error)).toContain("Permission.BlockedError");
      expect(guard.parentSaw).toMatch(envelope("ROOT_DONE")); // ROOT_DONE = the scripted provider's fixed reply after a tool result
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
        const childID = call.childID; // taken from the call's own result: a resume must name the same child, not echo the input
        const stored = childID ? await host.client.session.get({ sessionID: childID }) : undefined;
        const requests = host.provider.requests.slice(mark).filter(r => r.session === childID && r.kind === "primary");
        const row = {
          label, asked: model, resumed: sessionID !== undefined, childID, sameChildAsResumed: sessionID === undefined ? undefined : call.childID === sessionID,
          toolStatus: call.after.status, toolError: call.after.error, storedModel: stored?.model ? ref(stored.model) : undefined, storedAgent: stored?.agent, storedParent: stored?.parentID,
          totalInputTokens: stored?.tokens?.input, wire: requests.map(wire),
          history: JSON.stringify(requests[0]?.messages ?? []),
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
      await save("S7", { table: table.map(({ history, ...row }) => ({ ...row, historyChars: String(history).length })), rootChildren: children, hostErrors: host.errorLines(), providerErrors: host.provider.errors });

      for (const row of [a0, a1, a2, o0, o1, o2, x0, x1]) expect(row.childID, `${String(row.label)}: the result names a child`).toMatch(/^ses_/);
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
      // The resumed request carries the child's earlier turns: every earlier prompt and the earlier replies are in the messages the provider
      // received (so the context is kept across a model/variant/provider change), and a fresh start carries none of them.
      const hist = (row: { history: unknown }) => String(row.history);
      expect(hist(a0)).not.toContain("S7 anthropic resume");
      // x0 is a NEW child created after a0..o2: it carries none of their prompts or replies of those children
      expect(hist(x0)).not.toContain("S7 anthropic start");
      expect(hist(x0)).not.toContain("S7 anthropic resume");
      expect(hist(x0)).not.toContain("S7 responses");
      expect(hist(a1)).toContain("S7 anthropic start sonnet#low");
      expect(hist(a1)).toContain("CHILD_OK");
      expect(hist(a2)).toContain("S7 anthropic start sonnet#low");
      expect(hist(a2)).toContain("S7 anthropic resume 1 opus#xhigh");
      expect(hist(a2).split("CHILD_OK").length - 1).toBeGreaterThanOrEqual(2);
      expect(hist(o1)).toContain("S7 responses start luna#low");
      expect(hist(o2)).toContain("S7 responses start luna#low");
      expect(hist(o2)).toContain("S7 responses resume 1 sol#high");
      expect(hist(o2).split("CHILD_OK").length - 1).toBeGreaterThanOrEqual(2);
      expect(hist(x1)).toContain("S7 cross start sonnet#low");
      expect(hist(x1)).toContain("CHILD_OK");
      // one child per start, no child created by a resume.
      expect(children.sort()).toEqual([a0.childID, o0.childID, x0.childID].sort());
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 300_000);

    it("S3 per-session narrowing: evaluate and context hooks keyed by event.sessionID affect ONE child of an agent only", async () => {
    const host = await startSpikeHost("s3", { [NO_MODEL]: agentWithoutModel() }, {
      probe: { lifecycle: true, bySession: { denyTitle: "S3 A", denyActions: ["read"], stripTitle: "S3 C", stripTools: ["shell", "write"] } },
    });
    try {
      const file = path.join(host.project, "s3-read.txt");
      await writeFile(file, "S3\n");
      const [rootA, rootB, rootC, rootD] = await Promise.all([1, 2, 3, 4].map(i => host.newRoot(`s3 root ${i}`)));
      const input = (title: string, prompt: string): Obj => ({ agent: NO_MODEL, description: title, prompt });
      // permission evaluate: two children of the SAME agent whose first model requests are held until both are in flight (so they overlap
      // in the host), `read` denied for the child titled "S3 A" only.
      host.provider.holdUntilOverlap("S3_HOLD_AB", 2);
      const [a, b] = await Promise.all([childReport(host, rootA!, input("S3 A", `S3_HOLD_AB ${readProbe(file)}`)), childReport(host, rootB!, input("S3 B", `S3_HOLD_AB ${readProbe(file)}`))]);
      const barrierAB = { arrivals: host.provider.barrier!.arrivals.length, releasedByArrival: host.provider.barrier!.releasedByArrival, timedOut: host.provider.barrier!.timedOut };
      // context hook: two overlapping children of the same agent, `shell` and `write` removed from the catalog of "S3 C" only.
      host.provider.holdUntilOverlap("S3_HOLD_CD", 2);
      const [c, d] = await Promise.all([childReport(host, rootC!, input("S3 C", `S3_HOLD_CD ${readProbe(file)}`)), childReport(host, rootD!, input("S3 D", `S3_HOLD_CD ${readProbe(file)}`))]);
      const barrierCD = { arrivals: host.provider.barrier!.arrivals.length, releasedByArrival: host.provider.barrier!.releasedByArrival, timedOut: host.provider.barrier!.timedOut };
      await save("S3", { a, b, c, d, barrierAB, barrierCD, hostErrors: host.errorLines() });

      // The pairs really overlapped: each child's first request was held until the other had also arrived (released by arrival, not timeout).
      expect(barrierAB).toEqual({ arrivals: 2, releasedByArrival: true, timedOut: false });
      expect(barrierCD).toEqual({ arrivals: 2, releasedByArrival: true, timedOut: false });
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
    const observe = async (hook: "evaluate" | "context") => {
      const host = await startSpikeHost(`s3t-${hook}`, { [NO_MODEL]: agentWithoutModel() }, { probe: { lifecycle: true, bySession: { throwTitle: "S3 T", throwHook: hook } } });
      try {
        const readFileP = path.join(host.project, "s3-throw.txt");
        const editFile = path.join(host.project, "s3-edit.txt");
        const writeFileP = path.join(host.project, "s3-written.txt");
        await writeFile(readFileP, "S3\n");
        await writeFile(editFile, "ORIGINAL\n");
        const bytes = async (file: string) => (await readFile(file)).toString("hex");
        const before = await bytes(editFile);
        const call = (title: string, tool: string, input: Obj) => host.newRoot(`s3 throw root ${title}`).then(root => childReport(host, root, { agent: NO_MODEL, description: title, prompt: `READ_ONLY_PROBE=${JSON.stringify({ tool, input })}` }));
        const report = await call("S3 T", "read", { path: readFileP });
        const editThrown = await call("S3 T", "edit", { path: editFile, oldString: "ORIGINAL", newString: "CHANGED" });
        const writeThrown = await call("S3 T", "write", { path: writeFileP, content: "WRITTEN\n" });
        const afterThrown = { edit: await bytes(editFile), writeExists: existsSync(writeFileP) };
        // the next children of the same agent (other title) are evaluated and run normally, and may now mutate.
        const stillWorks = await call("S3 ok", "read", { path: readFileP });
        const editOk = await call("S3 ok", "edit", { path: editFile, oldString: "ORIGINAL", newString: "CHANGED" });
        const afterOk = await readFile(editFile, "utf8");
        return { hook, report, editThrown, writeThrown, before, afterThrown, stillWorks, editOk, afterOk, hostErrors: host.errorLines(), providerErrors: host.provider.errors };
      } finally { await finish(host); }
    };
    const evaluate = await observe("evaluate");
    const context = await observe("context");
    await save("S3-throw", { evaluate, context });
    expect(evaluate.report.decisions.some(d => d.decision === "throw")).toBe(true);
    expect(context.report.decisions.some(d => d.decision === "throw")).toBe(true);
    // evaluate throws: every mutating call of the throwing session errors with the thrown message (error type "unknown", child side only)
    // and the mutation did NOT happen: the edited file is byte-identical and the written file does not exist. So for read, edit and write
    // the call is refused, not allowed (the host does not fail open on a throwing evaluate hook).
    for (const r of [evaluate.report, evaluate.editThrown, evaluate.writeThrown]) {
      expect(r.toolStates).toEqual([expect.objectContaining({ status: "error", errorType: "unknown", errorMessage: "PROBE_HOOK_THROWN evaluate" })]);
      expect(r.events).toContain("session.tool.failed");
      expect(r.child.outcome).toBe("succeeded");
      expect(r.parentToolStatus).toBe("completed");
    }
    expect(evaluate.afterThrown).toEqual({ edit: evaluate.before, writeExists: false });
    // the hook stays registered and does not poison later sessions: the next children are evaluated (the probe logs an evaluate record
    // with the action) and run; the edit of the non-throwing session goes through.
    expect(evaluate.stillWorks.toolStates.map(s => s.status)).toEqual(["completed"]);
    expect(evaluate.stillWorks.evaluates).toEqual([{ action: "read", denied: false }]);
    expect(evaluate.stillWorks.decisions.filter(d => d.point === "evaluate").map(d => d.decision)).toEqual(["pass"]);
    expect(evaluate.editOk.toolStates.map(s => s.status)).toEqual(["completed"]);
    expect(evaluate.editOk.evaluates).toEqual([{ action: "edit", denied: false }]);
    expect(evaluate.afterOk).toBe("CHANGED\n");
    expect(evaluate.hostErrors).toEqual([]);
    // context throws: the child's very first model request is never made (0 provider requests); the child execution FAILS
    // (session.execution.failed, outcome failed, no step started) and the error reaches the PARENT: its next provider request carries the
    // tool_result of that call as an error ("Subagent failed (sessionID: ...): <message>"), one host ERROR log line "Failed to drain Session".
    expect(context.report.requests).toHaveLength(0);
    expect(context.report.events.at(-1)).toBe("session.execution.failed");
    expect(context.report.events).not.toContain("session.step.started");
    expect(context.report.child.outcome).toBe("failed");
    expect(context.report.parentToolStatus).toBe("error");
    expect(String(obj(context.report.parentToolError).string)).toMatch(/^Tool\.Error: Subagent failed \(sessionID: ses_[A-Za-z0-9]+\): PROBE_HOOK_THROWN context$/);
    expect(context.report.parentSeen.found).toBe(true);
    expect(context.report.parentSeen.isError).toBe(true);
    expect(context.report.parentSeen.text).toMatch(/Subagent failed \(sessionID: ses_[A-Za-z0-9]+\): PROBE_HOOK_THROWN context/);
    // three children of the throwing title (read, edit, write) = three failed sessions = three host ERROR lines; none ran its tool.
    expect(context.hostErrors).toHaveLength(3);
    for (const line of context.hostErrors) { expect(line).toContain("Failed to drain Session"); expect(line).toContain("PROBE_HOOK_THROWN context"); }
    for (const r of [context.editThrown, context.writeThrown]) { expect(r.child.outcome).toBe("failed"); expect(r.requests).toHaveLength(0); }
    expect(context.afterThrown).toEqual({ edit: context.before, writeExists: false });
    // the failed child does not poison the agent: the next child of the same agent runs.
    expect(context.stillWorks.toolStates.map(s => s.status)).toEqual(["completed"]);
  }, 600_000);

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
      const seen = parentView(host, root, call.callID);
      // exactly two text parts: the host's envelope with the child's text, then the appended note.
      expect(seen.parts).toHaveLength(2);
      expect(seen.parts[0]).toMatch(/^<subagent sessionID="ses_[A-Za-z0-9]+" state="completed">\nCHILD_OK\n<\/subagent>$/);
      expect(seen.parts[1]).toBe(NOTE);
      // the note exists only in the parent's view: the child's own requests never carry it.
      expect(childRequests.some(r => JSON.stringify(r.messages).includes(NOTE))).toBe(false);
      expect((await host.events()).filter(e => e.type === "probe.decision" && e.point === "execute.after")).toHaveLength(1);
    } finally { await finish(host); }
  }, 300_000);

  it("S6 order against the router's own after-hook, and a background-flagged dispatch with verification on and off", async () => {
    const NOTE = "S6B_APPENDED_NOTE";
    const OK = "[router \u2713 verified: deterministic]";
    const run = async (mode: "enforced" | "off") => {
      const host = await startSpikeHost(`s6b-${mode}`, { [NO_MODEL]: agentWithoutModel() }, { probe: { afterAppend: { tool: "subagent", text: NOTE } }, overrides: { enforcement: { mode } } });
      try {
        const present = path.join(host.project, "s6b-present.txt");
        await writeFile(present, "x\n");
        const accept = `\n[acceptance]\ncheck: fileExists path=${present}\n[/acceptance]`;
        const root = await host.newRoot(`s6b ${mode} root`);
        const fg = await host.dispatch(root, { agent: NO_MODEL, description: "S6B fg", prompt: `S6B fg${accept}`, model: `${SONNET}#low`, background: false });
        const fgSeen = parentView(host, root, fg.callID);
        // A dispatch flagged background:true whose child's first request is held for 4 s.
        host.provider.holdUntilOverlap("S6B_HOLD", 99, 4_000);
        const root2 = await host.newRoot(`s6b ${mode} root bg`);
        const bg = await host.call(root2, "subagent", { agent: NO_MODEL, description: "S6B bg", prompt: `S6B_HOLD S6B bg${accept}`, model: `${SONNET}#low`, background: true });
        const bgSeen = parentView(host, root2, bg.callID);
        // the child may still be running after the call returned: wait for it, then give the parent one more turn and look at everything it received
        if (bg.childID) await host.settle(bg.childID).catch(() => undefined);
        await host.prompt(root2, "S6B follow-up");
        const later = host.requestsOf(root2).filter(r => r.kind === "primary").map(r => ({ toolResult: r.toolResult, hasChildText: JSON.stringify(r.messages).includes("CHILD_OK"), hasNote: JSON.stringify(r.messages).includes(NOTE), hasVerdict: JSON.stringify(r.messages).includes("verified: deterministic") || JSON.stringify(r.messages).includes("NOT ACCEPTED") }));
        const afters = (await host.hooks()).filter(h => h.hook === "after" && h.sessionID === root2 && h.tool === "subagent");
        // how the child's final text reached the parent after a running ack: the first non-assistant parent message that carries it
        const carrying = host.requestsOf(root2).filter(r => r.kind === "primary").flatMap(r => r.messages).filter(m => m.role !== "assistant" && JSON.stringify(m).includes("CHILD_OK"));
        const delivery = carrying.at(0);
        const deliverySnippet = delivery ? JSON.stringify(delivery).slice(0, 400) : undefined;
        return {
          delivery: { found: delivery !== undefined, isToolResult: delivery ? JSON.stringify(delivery).includes("tool_result") : undefined, hasNote: delivery ? JSON.stringify(delivery).includes(NOTE) : undefined, snippet: deliverySnippet },
          fgParts: fgSeen.parts, bgParts: bgSeen.parts, bgInputBackground: obj(bg.before.input).background, bgBlockedMs: bg.after.__t - bg.before.__t,
          bgAckStatus: obj(obj(bg.after.result).output).status, bgAfterRecords: afters.length, later, hostErrors: host.errorLines(),
        };
      } finally { await finish(host); }
    };
    const enforced = await run("enforced");
    const off = await run("off");
    await save("S6-order-background", { enforced, off });

    // Order: within the parent's tool_result the router's own execute.after text (the verification line, appended by the router plugin
    // loaded FIRST) comes before the probe's note (the probe plugin is loaded second): plugin load order, observed on the host's output.
    expect(enforced.fgParts).toHaveLength(3);
    expect(enforced.fgParts[0]).toMatch(/^<subagent sessionID="ses_[A-Za-z0-9]+" state="completed">\nCHILD_OK\n<\/subagent>$/);
    expect(enforced.fgParts[1]).toBe(`\n\n${OK}`);
    expect(enforced.fgParts[2]).toBe(NOTE);
    // Background WITH verification on (mode enforced): the ROUTER turns the call into a foreground one before the host sees it - the probe's
    // execute.before record (the probe loads after the router) shows background:false although the model sent true (src/index.ts:1663-1665 flags
    // the call as verifying, v2-hooks.ts:513/:528/:60 write background:false). The call returns the completed result with the verification line.
    expect(enforced.bgInputBackground).toBe(false);
    expect(enforced.bgAckStatus).toBe("completed");
    expect(enforced.bgBlockedMs).toBeGreaterThanOrEqual(3_500);
    expect(enforced.bgParts.at(-1)).toBe(NOTE);
    expect(enforced.bgParts.join("\n")).toContain(OK);
    // Background with verification OFF (mode off): the call reaches the host with background:true (asserted from the probe's before record).
    expect(off.bgInputBackground).toBe(true);
    expect(off.hostErrors).toEqual([]);
    expect(enforced.hostErrors).toEqual([]);
    // ... and the host answers at once with a RUNNING acknowledgement (no wait for the held child), whose text the probe's execute.after
    // extended with its note; there is exactly ONE execute.after record for the call.
    expect(off.bgAckStatus).toBe("running");
    expect(off.bgBlockedMs).toBeLessThan(3_000);
    expect(off.bgParts[0]).toMatch(/^The subagent is working in the background \(sessionID: ses_[A-Za-z0-9]+/);
    expect(off.bgParts.at(-1)).toBe(NOTE);
    expect(off.bgAfterRecords).toBe(1);
    // The child's FINAL text reaches the parent later in a message that is not a tool_result and does not pass through execute.after: it
    // carries no appended note (the note is only in the acknowledgement). So without verification the after-hook channel exists only for the ack.
    expect(off.delivery.found).toBe(true);
    expect(off.delivery.isToolResult).toBe(false);
    expect(off.delivery.hasNote).toBe(false);
    expect(off.delivery.snippet).toContain('state=\\"completed\\" description=\\"S6B bg\\"'); // a host-made completion notification to the parent
  }, 600_000);

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
      // ---- permissions of the rewritten agent, exercised: the child ATTEMPTS an edit.
      // Root session WITHOUT inherited grants (permissions []): the rewritten child (explorer, `edit` denied) has no `edit` tool at all in
      // its provider request, the call fails with "No tool named edit", and the file is unchanged; the control agent edits normally.
      const strict = await host.newRoot("s9 strict root", undefined, host.project, []);
      const fileA = path.join(host.project, "s9-a.txt");
      const fileB = path.join(host.project, "s9-b.txt");
      const fileC = path.join(host.project, "s9-c.txt");
      for (const f of [fileA, fileB, fileC]) await writeFile(f, "main\n");
      const editProbe = (f: string) => `READ_ONLY_PROBE=${JSON.stringify({ tool: "edit", input: { path: f, oldString: "main", newString: "edited" } })}`;
      const rewrittenEdit = await childReport(host, strict, { agent: "explore", description: "S9 rewritten edit", prompt: editProbe(fileA) });
      const controlEdit = await childReport(host, strict, { agent: NO_MODEL, description: "S9 control edit", prompt: editProbe(fileB) });
      expect(rewrittenEdit.child.agent).toBe("explorer");
      expect(rewrittenEdit.requests[0]?.toolNames).not.toContain("edit");
      expect(rewrittenEdit.toolStates).toEqual([expect.objectContaining({ status: "error", errorType: "tool.execution", errorMessage: 'No tool named "edit" is currently available. Please use a tool from the available tool list.' })]);
      expect(await readFile(fileA, "utf8")).toBe("main\n");
      expect(controlEdit.requests[0]?.toolNames).toContain("edit");
      expect(controlEdit.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(await readFile(fileB, "utf8")).toBe("edited\n");
      // Root session WITH an inherited allow-all (`newRoot`'s default): the same rewritten agent's `edit: deny` is NOT enforced - the edit tool
      // is advertised and the edit is applied. The agent's own max policy only binds a child whose session grants nothing broader.
      const open = await childReport(host, root, { agent: "explore", description: "S9 rewritten edit open", prompt: editProbe(fileC) });
      expect(open.child.agent).toBe("explorer");
      expect(open.requests[0]?.toolNames).toContain("edit");
      expect(open.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(await readFile(fileC, "utf8")).toBe("edited\n");
    } finally { await finish(host); }
  }, 300_000);


    it("S10 the router's verification gate treats a non-tier custom agent exactly like fast/medium (it is gated by tool + mode, not by agent name)", async () => {
    const agents = { explorer: agentWithoutModel({ description: "S10 custom explorer role" }), implementer: agentWithoutModel({ description: "S10 custom implementer role" }) };
    const OK = "[router \u2713 verified: deterministic]";
    const run = async (name: string, overrides: Obj, subjects: string[]) => {
      const host = await startSpikeHost(name, agents, { overrides });
      try {
        const present = path.join(host.project, "s10-present.txt");
        const absent = path.join(host.project, "s10-absent.txt");
        await writeFile(present, "x\n");
        const rows: Record<string, { output: string; content: string; status: unknown; parentSaw: string }> = {};
        for (const agent of subjects) {
          for (const [label, file] of [["present", present], ["absent", absent]] as const) {
            const root = await host.newRoot(`${name} ${agent} ${label}`);
            const call = await host.dispatch(root, { agent, description: `S10 ${agent} ${label}`, prompt: `S10 do the work\n[acceptance]\ncheck: fileExists path=${file}\n[/acceptance]`, model: `${SONNET}#low`, background: false });
            const res = obj(call.after.result);
            rows[`${agent}/${label}`] = { status: call.after.status, output: String(obj(res.output).output), content: arr(res.content).map(c => str(obj(c).text)).join(""), parentSaw: parentView(host, root, call.callID).text };
          }
        }
        return { rows, graders: host.provider.graders, hostErrors: host.errorLines() };
      } finally { await finish(host); }
    };
    const enforced = await run("s10-enforced", { enforcement: { mode: "enforced" } }, ["fast", "medium", "explorer", "implementer"]);
    const standard = await run("s10-default", {}, ["explorer"]);
    const off = await run("s10-off", { enforcement: { mode: "off" } }, ["explorer", "fast"]);
    const never = await run("s10-never", { enforcement: { mode: "enforced", verify: { require: "never" } } }, ["explorer", "fast"]);
    await save("S10", { enforced, standard, off, never });

    const rejected = (r: { output: string }) => r.output.includes("[router \u26a0 NOT ACCEPTED]") && r.output.includes("file not found:") && r.output.includes("s10-absent.txt");
    for (const agent of ["fast", "medium", "explorer", "implementer"]) {
      const present = enforced.rows[`${agent}/present`]!;
      const absent = enforced.rows[`${agent}/absent`]!;
      expect(present.status).toBe("completed");
      // pass: the deterministic fileExists checker ran for EVERY agent (no grader: graders stay 0) and appended the verified line.
      expect(present.output, agent).toBe(`CHILD_OK\n\n${OK}`);
      expect(present.content, agent).toContain(OK);
      // fail: NOT ACCEPTED with the checker's reason, appended to the text the parent receives.
      expect(rejected(absent), agent).toBe(true);
      expect(absent.content, agent).toContain("NOT ACCEPTED");
      // and what the PARENT model was given (its next provider request's tool_result) carries the same verdict lines.
      expect(present.parentSaw, agent).toContain(OK);
      expect(absent.parentSaw, agent).toContain("[router \u26a0 NOT ACCEPTED]");
      expect(absent.parentSaw, agent).toContain("s10-absent.txt");
    }
    expect(enforced.graders).toBe(0);
    // The ONLY difference is the escalation hint: ladder names (fast/medium) get "re-run via subagent(agent=\"next\") (escalated from X)",
    // any other agent gets the generic "re-run the delegation" (index.ts:2023-2026: ladder.indexOf(producerTier) < 0 -> nextTier null).
    expect(enforced.rows["fast/absent"]!.output).toContain("`subagent(agent=\"medium\")` (escalated from fast)");
    expect(enforced.rows["medium/absent"]!.output).toContain("`subagent(agent=\"heavy\")` (escalated from medium)");
    for (const agent of ["explorer", "implementer"]) {
      expect(enforced.rows[`${agent}/absent`]!.output).toContain("NEXT: address the above and re-run the delegation; do not treat the prior result as complete.");
      expect(enforced.rows[`${agent}/absent`]!.output).not.toContain("escalated from");
    }
    // The gate also runs with the default (advisory) enforcement mode; it is switched off only by mode "off" or verify.require "never".
    expect(standard.rows["explorer/present"]!.output).toBe(`CHILD_OK\n\n${OK}`);
    expect(rejected(standard.rows["explorer/absent"]!)).toBe(true);
    for (const result of [off, never]) for (const row of Object.values(result.rows)) expect(row.output).toBe("CHILD_OK");
    for (const result of [enforced, standard, off, never]) expect(result.hostErrors).toEqual([]);
  }, 900_000);


  it("S11 work root in a sibling worktree (agents defined in the HOST's opencode.json): external_directory defaults, per-path allowance, glob over-match, spelling variants, later worktrees, plugin tool cwd, tool catalog", async () => {
    const host = await RoutingHost.start("s11", {
      routing: { engine: "shadow" }, providers: OPENAI_PROVIDER,
      probe: { lifecycle: true, denyAsk: true, cwdTool: true, bySession: { denyTitle: "S11 role-wt1 narrowed", denyActions: ["external_directory"] } },
      hostConfig: (root: string) => {
        const base: Obj[] = [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }, { action: "wt_probe", resource: "*", effect: "allow" }, { action: "router_git_status", resource: "*", effect: "allow" }];
        const rule = (resource: string): Obj => ({ action: "external_directory", resource, effect: "allow" });
        return { agents: {
          // deny-by-default like `base` but WITHOUT the explicit allow for the plugin tool wt_probe
          "role-notool": agentWithoutModel({ permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }] }),
          "role-base": agentWithoutModel(), // the host defaults: external_directory = ask
          "role-deny": agentWithoutModel({ permissions: base }), // deny-by-default, explicit allows, no external_directory rule
          "role-wt1": agentWithoutModel({ permissions: [...base, rule(`${root}\\wt-1\\*`)] }),
          "role-glob": agentWithoutModel({ permissions: [...base, rule(`${root}\\wt-*`)] }),
          "role-case": agentWithoutModel({ permissions: [...base, rule(`${root.toUpperCase()}\\WT-1\\*`)] }), // same rule, different letter case
          "role-long": agentWithoutModel({ permissions: [...base, rule(`${realpathSync.native(root)}\\wt-1\\*`)] }), // same rule, long (non-8.3) spelling of the root
          "role-exec-deny": agentWithoutModel({ permissions: [{ action: "execute", resource: "*", effect: "deny" }] }), // otherwise the host defaults
          "role-research": agentWithoutModel({ permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }, { action: "webfetch", resource: "*", effect: "allow" }, { action: "websearch", resource: "*", effect: "allow" }] }),
        } };
      },
    });
    try {
      const world = await s11World(host);
      const { wt1, wt2, other, evil } = world;
      const norm = (value: unknown) => String(value).replaceAll("\\", "/").toLowerCase();
      const op = (agent: string, label: string, tool: string, input: Obj, rootPerms: "none" | "allow-all" = "none") => s11Op(host, agent, label, tool, input, rootPerms);
      const edit = (file: string): Obj => ({ path: file, oldString: "main", newString: "edited" });
      const wtFile = (name: string) => path.join(wt1, name);
      const longWt1 = realpathSync.native(wt1);
      // -- the worktree that existed when the host started
      const base = { read: await op("role-base", "read wt1", "read", { path: wtFile("m.txt") }), edit: await op("role-base", "edit wt1", "edit", edit(wtFile("e0.txt"))) };
      const deny = { read: await op("role-deny", "read wt1", "read", { path: wtFile("m.txt") }), edit: await op("role-deny", "edit wt1", "edit", edit(wtFile("e0.txt"))) };
      const exact = {
        read: await op("role-wt1", "read wt1", "read", { path: wtFile("m.txt") }), edit: await op("role-wt1", "edit wt1", "edit", edit(wtFile("e1.txt"))),
        other: await op("role-wt1", "read other", "read", { path: path.join(other, "x.txt") }),
        otherEdit: await op("role-wt1", "edit other", "edit", edit(path.join(other, "x.txt"))),
        nested: await op("role-wt1", "read nested", "read", { path: path.join(wt1, "sub", "deep", "n.txt") }),
        evil: await op("role-wt1", "read wt-evil", "read", { path: path.join(evil, "x.txt") }),
        dotdot: await op("role-wt1", "read wt1/../other", "read", { path: `${wt1}\\..\\other\\x.txt` }),
        longPath: await op("role-wt1", "read via long path spelling", "read", { path: path.join(longWt1, "m.txt") }),
        tool: await op("role-wt1", "tool wt1", "wt_probe", { path: wtFile("m.txt") }),
        gitStatus: await op("role-wt1", "router_git_status", "router_git_status", {}),
      };
      const glob = {
        read: await op("role-glob", "read wt1", "read", { path: wtFile("m.txt") }), edit: await op("role-glob", "edit wt1", "edit", edit(wtFile("e2.txt"))),
        other: await op("role-glob", "read other", "read", { path: path.join(other, "x.txt") }),
        otherEdit: await op("role-glob", "edit other", "edit", edit(path.join(other, "x.txt"))),
        nested: await op("role-glob", "read nested", "read", { path: path.join(wt1, "sub", "deep", "n.txt") }),
        evil: await op("role-glob", "read wt-evil (a plain directory that is NOT a worktree)", "read", { path: path.join(evil, "x.txt") }),
      };
      const spelling = {
        upperRule: await op("role-case", "read wt1 (rule in upper case)", "read", { path: wtFile("m.txt") }),
        longRule: await op("role-long", "read wt1 (rule in long spelling, path in the harness spelling)", "read", { path: wtFile("m.txt") }),
      };
      // -- (a) a plugin tool NOT in the agent's allows, under deny-by-default; (b) the evaluate hook narrows an ALLOWED external path per session
      const notool = await op("role-notool", "tool not allowed", "wt_probe", { path: wtFile("m.txt") });
      const narrowed = await op("role-wt1", "narrowed", "read", { path: wtFile("m.txt") });
      // -- the tool catalog (Code Mode `execute` and the researcher's egress tools)
      const exec = {
        base: await op("role-base", "catalog", "read", { path: path.join(host.project, "m.txt") }),
        denyByDefault: await op("role-deny", "catalog", "read", { path: path.join(host.project, "m.txt") }),
        explicitDeny: await op("role-exec-deny", "catalog", "read", { path: path.join(host.project, "m.txt") }),
        research: await op("role-research", "catalog", "read", { path: path.join(host.project, "m.txt") }),
        probeNotool: await op("role-notool", "execute probe", "execute", { code: "return await tools.opencode.session_rename({ title: 'S11 renamed by execute' })" }),
        probeExplicitDeny: await op("role-exec-deny", "execute probe", "execute", { code: "return await tools.opencode.session_rename({ title: 'S11 renamed by execute' })" }),
      };
      // -- the session-level grant: the same deny-by-default agent under a parent session that grants everything
      const openRoot = await op("role-deny", "read wt1 under an allow-all session", "read", { path: wtFile("m.txt") }, "allow-all");
      // -- a SECOND worktree created after the host started and the agents were registered
      const wt2File = await world.addLaterWorktree();
      const later = {
        noPattern: await op("role-deny", "read wt2", "read", { path: path.join(wt2, "m.txt") }),
        exactPattern: await op("role-wt1", "read wt2", "read", { path: path.join(wt2, "m.txt") }),
        globRead: await op("role-glob", "read wt2", "read", { path: path.join(wt2, "m.txt") }),
        globEdit: await op("role-glob", "edit wt2", "edit", edit(wt2File)),
        globOther: await op("role-glob", "read other again", "read", { path: path.join(other, "x.txt") }),
      };
      const toolReport = (await host.events()).filter(e => e.type === "probe.tool").map(e => obj(e.report));
      const disk = {
        wt1E0: await readFile(wtFile("e0.txt"), "utf8"), wt1E1: await readFile(wtFile("e1.txt"), "utf8"), wt1E2: await readFile(wtFile("e2.txt"), "utf8"),
        wt2E3: await readFile(wt2File, "utf8"), mainE1: await readFile(path.join(host.project, "e1.txt"), "utf8"), mainE3: await readFile(path.join(host.project, "e3.txt"), "utf8"), other: await readFile(path.join(other, "x.txt"), "utf8"),
      };
      const titles = { exec: exec.probeNotool.childTitle, execDeny: exec.probeExplicitDeny.childTitle };
      await save("S11", { base, deny, exact, glob, spelling, later, notool, narrowed, exec, openRoot, toolReport, disk, titles, hostErrors: host.errorLines() });

      const rejected = (o: { state?: Obj }, message: string) => expect(o.state).toMatchObject({ status: "error", errorType: "permission.rejected", errorMessage: message });
      const denied = "Permission denied: external_directory";
      // (1) default agent: external_directory is ASKED for the sibling worktree (resource "<worktree>/*"); the probe turned the ask into a deny so nothing hangs.
      for (const o of [base.read, base.edit]) {
        rejected(o, "PROBE_ASK_AS_DENY: external_directory");
        expect(o.evaluates[0]).toMatchObject({ action: "external_directory", effectIn: "ask" });
        expect(o.evaluates[0]!.resources).toEqual([`${norm(wt1)}/*`]);
      }
      // (2) deny-by-default role agent without an external_directory rule: refused by the host itself (no evaluate event reaches plugins).
      for (const o of [deny.read, deny.edit]) { rejected(o, denied); expect(o.evaluates).toEqual([]); }
      // (3) an external_directory rule for the worktree root only: read and edit inside it run (external_directory allow, then the action's own allow)...
      expect(exact.read.state).toMatchObject({ status: "completed" });
      expect(exact.edit.state).toMatchObject({ status: "completed" });
      expect(exact.read.evaluates.map(e => [e.action, e.effectIn])).toEqual([["external_directory", "allow"], ["read", "allow"]]);
      expect(exact.edit.evaluates.map(e => [e.action, e.effectIn])).toEqual([["external_directory", "allow"], ["edit", "allow"]]);
      expect(disk.wt1E1).toBe("edited\n");
      expect(disk.mainE1).toBe("main\n");
      // ... while a path in a third, unrelated directory stays denied for read AND edit, and the file is untouched.
      rejected(exact.other, denied);
      rejected(exact.otherEdit, denied);
      // refused edits get their own files: the refused edits of the default and the deny-by-default agent left wt-1/e0.txt untouched.
      expect(disk.wt1E0).toBe("main\n");
      // (4) the glob rule `<root>\wt-*` covers wt-1 too, and refuses the unrelated directory for read and edit.
      expect(glob.read.state).toMatchObject({ status: "completed" });
      expect(glob.edit.state).toMatchObject({ status: "completed" });
      expect(disk.wt1E2).toBe("edited\n");
      rejected(glob.other, denied);
      rejected(glob.otherEdit, denied);
      expect(disk.other).toBe("other\n");
      // (5) a worktree created AFTER the host started: (a) no pattern -> denied; exact pattern for the old worktree -> denied;
      //     (b) glob `wt-*` registered at start -> covered (read and edit), the unrelated directory is still denied.
      rejected(later.noPattern, denied);
      rejected(later.exactPattern, denied);
      expect(later.globRead.state).toMatchObject({ status: "completed" });
      expect(later.globEdit.state).toMatchObject({ status: "completed" });
      expect(disk.wt2E3).toBe("edited\n");
      expect(disk.mainE3).toBe("main\n");
      rejected(later.globOther, denied);
      // (6) a plugin tool is neither permission-evaluated (no evaluate event, even for the sibling path) nor moved: it runs in the MAIN
      //     checkout (process.cwd() = the host project = the session location); its context carries no directory/worktree field.
      expect(exact.tool.state).toMatchObject({ status: "completed" });
      expect(exact.tool.evaluates).toEqual([]);
      expect(toolReport).toHaveLength(1);
      const reported = toolReport[0]!;
      expect(norm(reported.cwd)).toBe(norm(host.project));
      expect(norm(obj(reported.sessionLocation).directory)).toBe(norm(host.project));
      expect(norm(obj(reported.pluginLocation).directory)).toBe(norm(host.project));
      expect(reported.contextKeys).toEqual(["sessionID", "agent", "messageID", "id", "progress", "signal"]);
      expect(reported.pathExists).toBe(true);
      // (7) a plugin tool is bounded by the agent's MAX policy at the host's catalog: under deny-by-default WITHOUT an explicit allow for it,
      //     the host does not advertise it (absent from the provider request's tools) and refuses a call to it ("No tool named ... is
      //     currently available", tool.execution), the tool never runs and no evaluate event fires. With the explicit allow it is advertised.
      expect(notool.toolNames).not.toContain("wt_probe");
      expect(exact.tool.toolNames).toContain("wt_probe");
      expect(notool.state).toMatchObject({ status: "error", errorType: "tool.execution", errorMessage: 'No tool named "wt_probe" is currently available. Please use a tool from the available tool list.' });
      expect(notool.evaluates).toEqual([]);
      // (8) the plugin evaluate hook DOES fire for an external_directory the max policy allows (effectIn "allow") and can narrow it for ONE session:
      //     the session titled "S11 role-wt1 narrowed" is refused by the plugin although its agent's policy allows the path, while the same agent's
      //     other children (exact.read above) read it. (effectIn / effectOut are positional: the lifecycle record is written BEFORE the
      //     session-keyed hook runs, so effectOut "allow" is not the final decision; the tool state is.)
      expect(narrowed.evaluates).toHaveLength(1);
      expect(narrowed.evaluates[0]).toMatchObject({ action: "external_directory", effectIn: "allow" });
      rejected(narrowed, "PROBE_SESSION_DENIED: external_directory");
      // (9) OBSERVED, see S11.json: nested files, the `wt-evil` sibling, `..`, case and spelling variants.
      //     - a file nested below the allowed root is covered (the rule `<root>\\wt-1\\*` crosses separators);
      expect(exact.nested.state).toMatchObject({ status: "completed" });
      expect(glob.nested.state).toMatchObject({ status: "completed" });
      //     - the glob `<root>\\wt-*` OVER-MATCHES: a plain directory `wt-evil` that is not a worktree is granted too (the exact rule refuses it);
      expect(glob.evil.state).toMatchObject({ status: "completed" });
      rejected(exact.evil, denied);
      //     - `..` is normalised before matching (wt-1\..\other resolves to the unrelated directory and is refused);
      rejected(exact.dotdot, denied);
      //     - letter case does not matter on this Windows host (a rule written in upper case still grants the path) ...
      expect(spelling.upperRule.state).toMatchObject({ status: "completed" });
      //     - ... but the 8.3 / long spelling of the root DOES: a rule in the long spelling does not grant a path in the short spelling,
      //       and a rule in the short spelling does not grant a path in the long spelling (both refused).
      expect(norm(realpathSync.native(host.root))).not.toBe(norm(host.root));
      rejected(spelling.longRule, denied);
      rejected(exact.longPath, denied);
      // (10) the session-level grant decides before the agent's policy: the SAME deny-by-default agent without an external_directory rule
      //      reads the sibling worktree when the parent session grants everything (newRoot's default), and is refused when it grants nothing (2).
      expect(openRoot.state).toMatchObject({ status: "completed" });
      // (11) router_git_status of a child whose session lives in the main checkout reports the MAIN checkout's status, not the sibling worktree's
      //      (the compat layer resolves router_git_* against the session location, v2-hooks.ts:356-358).
      expect(exact.gitStatus.state).toMatchObject({ status: "completed" });
      expect(exact.gitStatus.state?.text).toContain("main-only-dirty.txt"); // untracked in the main checkout only
      expect(exact.gitStatus.state?.text).not.toContain("sub"); // wt-1's own untracked directory is not reported
      // (12) tool catalog: Code Mode `execute` is advertised to the host-default agent and to NO deny-by-default role agent; an explicit
      //      `execute: deny` on an otherwise default agent removes it too; a call to it fails with "No tool named execute" and does not
      //      run (the session title is unchanged by the scripted inner session_rename).
      expect(exec.base.toolNames).toContain("execute");
      for (const r of [exec.denyByDefault, exec.explicitDeny, exec.research]) expect(r.toolNames).not.toContain("execute");
      for (const r of [exec.probeNotool, exec.probeExplicitDeny]) expect(r.state).toMatchObject({ status: "error", errorType: "tool.execution", errorMessage: 'No tool named "execute" is currently available. Please use a tool from the available tool list.' });
      expect(titles).toEqual({ exec: "S11 role-notool execute probe", execDeny: "S11 role-exec-deny execute probe" });
      expect(exec.probeNotool.evaluates).toEqual([]);
      // (13) researcher egress as the host advertises it: webfetch and websearch are advertised natively to the default agent, kept by an
      //      explicit allow under deny-by-default (catalog exactly [read, webfetch, websearch]) and absent without it; no context7_* or
      //      brave_* tool is advertised by the isolated host (no MCP server is configured in it).
      for (const name of ["webfetch", "websearch"]) { expect(exec.base.toolNames).toContain(name); expect(exec.research.toolNames).toContain(name); expect(exec.denyByDefault.toolNames).not.toContain(name); }
      expect([...exec.research.toolNames].sort()).toEqual(["read", "webfetch", "websearch"]);
      for (const r of [exec.base, exec.denyByDefault, exec.research]) expect(r.toolNames.filter(n => /^(context7|brave)/.test(n))).toEqual([]);
      expect(host.errorLines()).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("S11 repeated with agents defined in the ROUTER override (the production registration path)", async () => {
    const host = await RoutingHost.start("s11r", {
      routing: { engine: "shadow" }, providers: OPENAI_PROVIDER, probe: { lifecycle: true, denyAsk: true }, hostConfig: {},
      overrides: (root: string) => {
        const agent = (description: string, externalDirectory?: string): Obj => ({ tier: "fast", description, permission: { read: "allow", edit: "allow", ...(externalDirectory ? { external_directory: { [externalDirectory]: "allow" } } : {}) } });
        return { agents: {
          "r-deny": agent("S11r deny-by-default, no external_directory rule"),
          "r-wt1": agent("S11r exact worktree rule", `${root}\\wt-1\\*`),
          "r-glob": agent("S11r glob rule", `${root}\\wt-*`),
        } };
      },
    });
    try {
      const world = await s11World(host);
      const { wt1, wt2, other, evil } = world;
      const op = (agent: string, label: string, tool: string, input: Obj, rootPerms: "none" | "allow-all" = "none") => s11Op(host, agent, label, tool, input, rootPerms);
      const edit = (file: string): Obj => ({ path: file, oldString: "main", newString: "edited" });
      const agentList = (await host.client.agent.list()).data.filter(a => a.id.startsWith("r-")).map(a => ({ id: a.id, model: a.model, mode: a.mode }));
      const deny = { read: await op("r-deny", "read wt1", "read", { path: path.join(wt1, "m.txt") }), edit: await op("r-deny", "edit wt1", "edit", edit(path.join(wt1, "e0.txt"))) };
      const exact = {
        read: await op("r-wt1", "read wt1", "read", { path: path.join(wt1, "m.txt") }), edit: await op("r-wt1", "edit wt1", "edit", edit(path.join(wt1, "e1.txt"))),
        other: await op("r-wt1", "read other", "read", { path: path.join(other, "x.txt") }), otherEdit: await op("r-wt1", "edit other", "edit", edit(path.join(other, "x.txt"))),
        evil: await op("r-wt1", "read wt-evil", "read", { path: path.join(evil, "x.txt") }),
      };
      const glob = { read: await op("r-glob", "read wt1", "read", { path: path.join(wt1, "m.txt") }), evil: await op("r-glob", "read wt-evil", "read", { path: path.join(evil, "x.txt") }), other: await op("r-glob", "read other", "read", { path: path.join(other, "x.txt") }) };
      const openRoot = { deny: await op("r-deny", "read wt1 under an allow-all session", "read", { path: path.join(wt1, "m.txt") }, "allow-all"), other: await op("r-wt1", "read other under an allow-all session", "read", { path: path.join(other, "x.txt") }, "allow-all") };
      const wt2File = await world.addLaterWorktree();
      const later = { noPattern: await op("r-deny", "read wt2", "read", { path: path.join(wt2, "m.txt") }), exact: await op("r-wt1", "read wt2", "read", { path: path.join(wt2, "m.txt") }), glob: await op("r-glob", "read wt2", "read", { path: path.join(wt2, "m.txt") }), globEdit: await op("r-glob", "edit wt2", "edit", edit(wt2File)) };
      const disk = { wt1E0: await readFile(path.join(wt1, "e0.txt"), "utf8"), wt1E1: await readFile(path.join(wt1, "e1.txt"), "utf8"), wt2E3: await readFile(wt2File, "utf8"), other: await readFile(path.join(other, "x.txt"), "utf8") };
      await save("S11-router", { agentList, deny, exact, glob, openRoot, later, disk, routerWarnings: host.routerLogLines(), hostErrors: host.errorLines() });
      // Registration path: the router override's `agents` block (tier fast -> the host agent record carries the tier's model), with explicit
      // `permission` maps; the router publishes the policy and its own evaluate hook re-evaluates it. Same outcomes as for host-defined agents:
      expect(agentList.map(a => a.id).sort()).toEqual(["r-deny", "r-glob", "r-wt1"]);
      expect(agentList.every(a => a.model?.id === "claude-sonnet-5-5" && a.model.variant === "low")).toBe(true);
      const denied = "Permission denied: external_directory";
      const rejected = (o: { state?: Obj }, message: string) => expect(o.state).toMatchObject({ status: "error", errorType: "permission.rejected", errorMessage: message });
      rejected(deny.read, denied); rejected(deny.edit, denied);
      expect(exact.read.state).toMatchObject({ status: "completed" });
      expect(exact.edit.state).toMatchObject({ status: "completed" });
      expect(exact.read.evaluates.map(e => [e.action, e.effectIn])).toEqual([["external_directory", "allow"], ["read", "allow"]]);
      rejected(exact.other, denied); rejected(exact.otherEdit, denied); rejected(exact.evil, denied);
      expect(glob.read.state).toMatchObject({ status: "completed" });
      expect(glob.evil.state).toMatchObject({ status: "completed" }); // the same over-match of `wt-*`
      rejected(glob.other, denied);
      rejected(later.noPattern, denied); rejected(later.exact, denied);
      expect(later.glob.state).toMatchObject({ status: "completed" });
      expect(later.globEdit.state).toMatchObject({ status: "completed" });
      expect(disk).toEqual({ wt1E0: "main\n", wt1E1: "edited\n", wt2E3: "edited\n", other: "other\n" });
      // DIFFERENCE from host-defined agents: under a parent session that grants everything, a router-registered agent is still refused its
      // missing external_directory rule - by the router's own evaluate hook ("Permission denied by plugin agent <name>", the event already
      // arrives as a deny) - whereas the host-defined deny-by-default agent was allowed (S11 test above, section 10).
      rejected(openRoot.deny, "Permission denied by plugin agent r-deny: external_directory");
      rejected(openRoot.other, "Permission denied by plugin agent r-wt1: external_directory");
      expect(openRoot.deny.evaluates[0]).toMatchObject({ action: "external_directory", effectIn: "deny" });
      expect(host.routerLogLines()).toEqual([]);
      expect(host.errorLines()).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("S12 the router override's agents block changed WITHOUT restarting the host: when the host agent list and the orchestrator's subagent catalog follow", async () => {
    const AGENT = (description: string) => ({ tier: "fast", description, readOnly: true });
    const NEXT = { agents: { reviewer: AGENT("S12 reviewer description TWO"), newbie: AGENT("S12 newbie description") } };
    const subagentDescription = (r: WireRequest | undefined) => JSON.stringify(r?.toolDefs.find(t => t.name === "subagent") ?? null);
    const scenario = async (name: string, change: (host: RoutingHost) => Promise<Obj>) => {
      const host = await startSpikeHost(name, {}, { hostConfig: {}, overrides: { agents: { reviewer: AGENT("S12 reviewer description ONE") } } });
      try {
        const view = async () => {
          const list = (await host.client.agent.list()).data.filter(a => ["reviewer", "newbie"].includes(a.id)).map(a => `${a.id}=${a.description}`);
          const api = arr(obj(await host.getJson("/api/agent")).data).map(a => obj(a)).filter(a => ["reviewer", "newbie"].includes(String(a.id))).map(a => `${a.id}=${a.description}`);
          return { list, api };
        };
        const ping = async (label: string) => {
          const root = await host.newRoot(`${name} ${label}`);
          const mark = host.provider.requests.length;
          await host.prompt(root, `S12 ping ${label}`);
          const description = subagentDescription(host.provider.requests.slice(mark).find(r => r.session === root && r.kind === "primary"));
          return { one: description.includes("description ONE"), two: description.includes("description TWO"), newbie: description.includes("newbie") };
        };
        const before = { view: await view(), ping: await ping("before") };
        await host.writeOverrides(NEXT);
        const afterWrite = await view();
        // bounded wait: does anything change on its own?
        const started = Date.now();
        let changedByItselfAfterMs: number | undefined;
        while (Date.now() - started < 30_000 && changedByItselfAfterMs === undefined) {
          if (JSON.stringify(await view()).includes("TWO")) changedByItselfAfterMs = Date.now() - started; else await delay(1_000);
        }
        const changed = await change(host);
        return { before, afterWrite, changedByItselfAfterMs, extra: changed, view: await view(), hostErrors: host.errorLines() };
      } finally { await finish(host); }
    };
    const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    // (A) the next ordinary prompt
    const viaPrompt = await scenario("s12-prompt", async host => {
      const ping = async (label: string) => {
        const root = await host.newRoot(`s12 ${label}`);
        const mark = host.provider.requests.length;
        await host.prompt(root, `S12 ping ${label}`);
        const d = subagentDescription(host.provider.requests.slice(mark).find(r => r.session === root && r.kind === "primary"));
        return { one: d.includes("description ONE"), two: d.includes("description TWO"), newbie: d.includes("newbie") };
      };
      const first = await ping("first prompt after the change");
      return { first, second: await ping("second prompt") };
    });
    // (B) /router-reload without any other prompt
    const viaReload = await scenario("s12-reload", async host => {
      const root = await host.newRoot("s12 reload");
      await host.client.session.command({ sessionID: root, name: "router-reload", text: "" });
      await host.settle(root).catch(() => undefined);
      const afterCommand = (await host.client.agent.list()).data.filter(a => ["reviewer", "newbie"].includes(a.id)).map(a => `${a.id}=${a.description}`);
      return { afterCommand };
    });
    await save("S12", { viaPrompt, viaReload });

    const ONE = ["reviewer=S12 reviewer description ONE"];
    const TWO = ["reviewer=S12 reviewer description TWO", "newbie=S12 newbie description"];
    for (const run of [viaPrompt, viaReload]) {
      // before: the first description everywhere (host list, /api/agent, and the orchestrator's `subagent` tool description).
      expect(run.before.view).toEqual({ list: ONE, api: ONE });
      expect(run.before.ping).toEqual({ one: true, two: false, newbie: false });
      // writing the file changes nothing by itself: not immediately, and not within the 30 s we waited.
      expect(run.afterWrite).toEqual({ list: ONE, api: ONE });
      expect(run.changedByItselfAfterMs).toBeUndefined();
      expect(run.hostErrors).toEqual([]);
    }
    // (A) the FIRST prompt after the change already carries the new catalog in its own provider request (the router refreshes in the
    // session "prompt" hook, before the model request), the host list and /api/agent follow, and it stays that way.
    expect(obj(viaPrompt.extra).first).toEqual({ one: false, two: true, newbie: true });
    expect(obj(viaPrompt.extra).second).toEqual({ one: false, two: true, newbie: true });
    expect(viaPrompt.view).toEqual({ list: TWO, api: TWO });
    // (B) the /router-reload command alone (no ordinary prompt) also brings both the host list and /api/agent to the new block.
    expect(obj(viaReload.extra).afterCommand).toEqual(TWO);
    expect(viaReload.view).toEqual({ list: TWO, api: TWO });
  }, 900_000);
  it("S12 beyond a description: dispatch a new agent, tighten a permission, remove an agent, resume an old child - all without restarting the host", async () => {
    const agent = (description: string, permission: Obj): Obj => ({ tier: "fast", description, permission });
    const host = await RoutingHost.start("s12b", {
      routing: { engine: "shadow" }, providers: OPENAI_PROVIDER, probe: { lifecycle: true }, hostConfig: {},
      overrides: { agents: { worker: agent("S12 worker", { read: "allow", edit: "allow" }), doomed: agent("S12 doomed", { read: "allow" }) } },
    });
    try {
      const files = Object.fromEntries(["f1", "f2", "f3", "f4"].map(n => [n, path.join(host.project, `s12-${n}.txt`)]));
      for (const f of Object.values(files)) await writeFile(f, "main\n");
      const editProbe = (f: string) => `READ_ONLY_PROBE=${JSON.stringify({ tool: "edit", input: { path: f, oldString: "main", newString: "edited" } })}`;
      const ids = async () => (await host.client.agent.list()).data.map(a => a.id).filter(id => ["worker", "doomed", "newbie"].includes(id)).sort();
      const root = await host.newRoot("s12b root", undefined, host.project, []);
      const first = await childReport(host, root, { agent: "worker", description: "S12b first", prompt: editProbe(files.f1!) });
      const diskBefore = await readFile(files.f1!, "utf8");
      const listBefore = await ids();
      await host.writeOverrides({ agents: { worker: agent("S12 worker", { read: "allow", edit: "deny" }), newbie: agent("S12 newbie", { read: "allow", edit: "allow" }) } });
      const listAfterWrite = await ids();
      // the next dispatch is the next prompt of the root: it refreshes the router's agents before its own model request
      const fresh = await childReport(host, root, { agent: "worker", description: "S12b fresh", prompt: editProbe(files.f2!) });
      const listAfterPrompt = await ids();
      const resumed = await childReport(host, root, { agent: "worker", description: "S12b resumed", prompt: editProbe(files.f3!), sessionID: first.childID });
      const newbie = await childReport(host, root, { agent: "newbie", description: "S12b newbie", prompt: editProbe(files.f4!) });
      const removedCall = await host.call(root, "subagent", { agent: "doomed", description: "S12b doomed", prompt: "S12b child", model: `${SONNET}#low`, background: false });
      const disk = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await readFile(f, "utf8")])));
      await save("S12-beyond", { first, diskBefore, listBefore, listAfterWrite, fresh, listAfterPrompt, resumed, newbie, removedCall: { status: removedCall.after.status, error: removedCall.after.error, result: removedCall.after.result, childID: removedCall.childID }, disk, hostErrors: host.errorLines() });
      const noEdit = { status: "error", errorType: "tool.execution", errorMessage: 'No tool named "edit" is currently available. Please use a tool from the available tool list.' };
      // before the change the worker edits (f1 edited); writing the override changes neither agent list at once.
      expect(first.child.agent).toBe("worker");
      expect(first.requests[0]?.toolNames).toContain("edit");
      expect(first.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(diskBefore).toBe("edited\n");
      expect(listBefore).toEqual(["doomed", "worker"]);
      expect(listAfterWrite).toEqual(["doomed", "worker"]);
      // the next dispatch (= the next prompt of the root) applies the whole change: agent list now has newbie and no doomed ...
      expect(listAfterPrompt).toEqual(["newbie", "worker"]);
      // ... a FRESH worker child no longer has `edit` in its catalog and its edit is refused with the file untouched ...
      expect(fresh.child.agent).toBe("worker");
      expect(fresh.requests[0]?.toolNames).not.toContain("edit");
      expect(fresh.toolStates).toEqual([expect.objectContaining(noEdit)]);
      expect(disk.f2).toBe("main\n");
      // ... the OLD child, resumed after the change, keeps its history (its first edit stays completed) but its new request has no `edit` tool
      // and the new edit is refused (f3 untouched): the tightened permission applies to a resumed session too ...
      expect(resumed.childID).toBe(first.childID);
      expect(resumed.requests.at(-1)?.toolNames).not.toContain("edit");
      expect(resumed.toolStates.map(s => s.status)).toEqual(["completed", "error"]);
      expect(resumed.toolStates.at(-1)).toEqual(expect.objectContaining(noEdit));
      expect(disk.f3).toBe("main\n");
      // ... a NEW agent is dispatchable at once (child agent newbie, its edit runs), and a REMOVED agent is refused by the host before any child exists.
      expect(newbie.child.agent).toBe("newbie");
      expect(newbie.toolStates.map(s => s.status)).toEqual(["completed"]);
      expect(disk.f4).toBe("edited\n");
      expect(removedCall.after.status).toBe("error");
      expect(String(obj(removedCall.after.error).string)).toBe("Tool.Error: Unknown agent: doomed");
      expect(removedCall.childID).toBeUndefined();
      expect((await host.children(root)).map(c => c.id).sort()).toEqual([first.childID, fresh.childID, newbie.childID].sort());
      expect(host.errorLines()).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

});
