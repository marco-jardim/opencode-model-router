/** Phase 3.2 (#74): end-to-end proof of the cost-aware routing engine on a REAL OpenCode v2 host (2.0.22).
 *
 *   RUN_OC_SMOKE_ROUTING=1 [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/routing-engine.smoke.test.ts      (npm run smoke:routing)
 *
 * - Without RUN_OC_SMOKE_ROUTING=1 every test is skipped (the normal `vitest run` excludes test/smoke anyway).
 * - Every scenario starts its OWN isolated `opencode serve` (allow-listed environment, private HOME/XDG/TEMP, random port,
 *   a scripted keyless Anthropic/OpenAI provider, the router loaded from THIS checkout next to a probe plugin) and tears its
 *   process tree down at the end. Nothing here reads or writes the user's OpenCode config, the live outcomes store
 *   (<tmpdir>/opencode-model-router-trajectory) or the user's running service: the outcomes path is a temp directory per host.
 * - Scenarios run serially (§0.6.9; vitest.smoke.config.ts has fileParallelism: false and `it` blocks of one file run in order).
 * - Every scenario asserts HOST state: the session records the host holds (agent, model/variant, tokens, children), the host's
 *   own session context, the requests the provider received, and the files the plugin inside the host wrote; never only the
 *   plugin's own variables or logs. Evidence is written to docs/qa/cost-aware-routing/evidence-3.2/ BEFORE each assertion.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { makeKey } from "../../src/routing/outcomes";
import { catalogFromModels, hostConfigFromAgents, runAdvisor } from "../../src/routing/advisor";
import type { RouterConfig } from "../../src/router/config";
import {
  MODELS, ROOT, RoutingHost, SMOKE_PRESET, arr, effectiveEffort, obj, ref, runScenario, stopAllHosts, str, type HookRecord, type ModelRef, type Seed,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROUTING === "1";
/** The tip of car/main this phase branched from. */
const BASE_COMMIT = "71815eb";
const d = RUN ? describe : describe.skip;

const SONNET = { providerID: "anthropic", id: "claude-sonnet-5-5" } as const;
const OPUS = { providerID: "anthropic", id: "claude-opus-5-5" } as const;
const key = {
  searchFast: makeKey("search", { origin: "router", id: "fast" }, SONNET.providerID, SONNET.id, "low"),
  searchHeavy: makeKey("search", { origin: "router", id: "heavy" }, OPUS.providerID, OPUS.id, "xhigh"),
};
const ROOT_PARENT = { providerID: "anthropic", id: "claude-opus-4-7" } as const;
/** `fast` keeps failing `search` and the read-only host agent `explore` (on the orchestrator's own model) keeps passing it: the class MOVES to explore. */
const MOVE_SEED: readonly Seed[] = [
  { key: key.searchFast, pass: 0, fail: 20 },
  { key: makeKey("search", { origin: "host", id: "explore" }, ROOT_PARENT.providerID, ROOT_PARENT.id, "default"), pass: 20, fail: 0 },
];
const SEARCH_ASK = "Find every usage of parseThing in the repository and list the files.";
/** Both tiers have passed `search` 20 times: the cheaper one wins on cost alone (evidence on both sides). */
const SEARCH_SEED: readonly Seed[] = [{ key: key.searchFast, pass: 20, fail: 0 }, { key: key.searchHeavy, pass: 20, fail: 0 }];
const SEARCH_PROMPT = "[route class=search risk=low scope=single]\nFind every usage of parseThing in the repository and list the files.";

afterAll(async () => { await stopAllHosts(); }, 60_000);

const sameModel = (m: ModelRef | undefined, want: { providerID: string; id: string }, variant?: string) =>
  m?.providerID === want.providerID && m.id === want.id && m.variant === variant;
const inputOf = (h: HookRecord | undefined) => obj(h?.input);

d("routing engine on the real OpenCode v2 host (Phase 3.2)", () => {
  it("1 shadow: a dispatch writes a decision row and a step record, and the host runs the orchestrator's pick untouched", async () => {
    const host = await RoutingHost.start("shadow", { routing: { engine: "shadow" }, seed: SEARCH_SEED });
    try {
      await runScenario("1-shadow", "engine=shadow: the orchestrator's heavy pick on a search task runs unchanged on the host (agent heavy, opus xhigh), the [route …] line is stripped from the child's prompt, decisions.jsonl gets one decision row that says it WOULD switch (switched=true, best=fast) and outcomes.json gets a step record for the heavy key.", async s => {
        const rootID = await host.newRoot("shadow root");
        const dispatched = await host.dispatch(rootID, { agent: "heavy", description: "Find usages", prompt: SEARCH_PROMPT, background: false });
        const child = await host.client.session.get({ sessionID: dispatched.childID });
        const childContext = await host.userTexts(dispatched.childID);
        const childRequests = host.requestsOf(dispatched.childID);
        s.observed.rootID = rootID;
        s.observed.childID = dispatched.childID;
        s.observed.hookBeforeInput = dispatched.before.input;
        s.observed.hostChild = { agent: child.agent, model: child.model, parentID: child.parentID, tokens: child.tokens, cost: child.cost, title: child.title };
        s.observed.childUserMessages = childContext;
        s.observed.childWire = childRequests.map(r => ({ catalogModel: r.catalogModel, wireModel: r.model, agent: r.agent, kind: r.kind, effort: obj(r.payload.output_config).effort, inputTokens: r.inputTokens }));
        const rows = await host.waitForRows("the decision row", r => r.length >= 1);
        const entries = await host.waitForEntries("a step record for the heavy key", e => (e[key.searchHeavy]?.cost.tokens.n ?? 0) >= 1);
        s.observed.rows = rows;
        s.observed.storeFiles = await host.storeListing();
        s.observed.entryHeavy = entries[key.searchHeavy];
        s.observed.routerLogLines = host.routerLogLines();
        const row = rows[0]!;
        const heavyEntry = entries[key.searchHeavy];
        const ok = child.agent === "heavy" && sameModel(child.model, OPUS, "xhigh") && child.parentID === rootID
          && childContext.every(t => !t.includes("[route class")) && childContext.some(t => t.includes("Find every usage"))
          && row.mode === "shadow" && row.switched === true && row.best?.agent === "fast" && row.chosen.agent === "heavy" && row.childSessionID === null && row.resume === false && row.step === "dispatch"
          && heavyEntry !== undefined && heavyEntry.cost.tokens.n >= 1 && heavyEntry.cost.tokens.input > 0
          && host.routerLogLines().length === 0;
        s.verdict(ok, `host child agent=${child.agent} model=${child.model ? ref(child.model) : "?"}; row mode=${row.mode} switched=${row.switched} chosen=${row.chosen.agent} best=${row.best?.agent}; heavy step record n=${heavyEntry?.cost.tokens.n} input=${heavyEntry?.cost.tokens.input}`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);

  it("3 enforce: the engine swaps heavy -> fast on a search task and the host's child session runs the swapped agent and model", async () => {
    const host = await RoutingHost.start("enforce", { routing: { engine: "enforce" }, seed: SEARCH_SEED });
    try {
      await runScenario("3-enforce", "engine=enforce: the orchestrator asks for heavy on a search task with no acceptance block; the engine swaps it to fast (sonnet-5-5#low). The CHILD SESSION held by the host has agent fast and model sonnet-5-5 variant low, the provider received that model with effort low, the row says switched=true, and the step record lands under the fast key.", async s => {
        const rootID = await host.newRoot("enforce root");
        const dispatched = await host.dispatch(rootID, { agent: "heavy", description: "Find usages", prompt: SEARCH_PROMPT, background: false });
        const child = await host.client.session.get({ sessionID: dispatched.childID });
        const listed = (await host.client.session.list({ parentID: rootID })).data;
        const wire = host.requestsOf(dispatched.childID).filter(r => r.kind === "primary");
        const rows = await host.waitForRows("the decision row", r => r.length >= 1);
        const entries = await host.waitForEntries("a step record for the fast key", e => (e[key.searchFast]?.cost.tokens.n ?? 0) >= 1);
        s.observed.rootID = rootID;
        s.observed.childID = dispatched.childID;
        s.observed.hookBeforeInput = dispatched.before.input;
        s.observed.hostChild = { agent: child.agent, model: child.model, parentID: child.parentID, tokens: child.tokens };
        s.observed.hostListedChildren = listed.map(c => ({ id: c.id, agent: c.agent, model: c.model }));
        s.observed.childWire = wire.map(r => ({ catalogModel: r.catalogModel, wireModel: r.model, agent: r.agent, effort: obj(r.payload.output_config).effort }));
        s.observed.row = rows[0];
        s.observed.entryFast = entries[key.searchFast]?.cost;
        s.observed.entryHeavyStepSamples = entries[key.searchHeavy]?.cost.tokens.n;
        s.observed.routerLogLines = host.routerLogLines();
        const row = rows[0]!;
        const input = inputOf(dispatched.before);
        const ok = child.agent === "fast" && sameModel(child.model, SONNET, "low") && listed.length === 1 && listed[0]!.agent === "fast"
          && input.agent === "fast" && input.model === `${MODELS.sonnet}#low`
          && wire.length === 1 && wire[0]!.catalogModel === `${MODELS.sonnet}#low` && wire[0]!.model === SONNET.id && obj(wire[0]!.payload.output_config).effort === "low" && wire[0]!.agent === "fast"
          && rows.length === 1 && row.mode === "enforce" && row.switched === true && row.chosen.agent === "heavy" && row.best?.agent === "fast" && row.reason.startsWith("switched")
          && (entries[key.searchFast]?.cost.tokens.n ?? 0) >= 1 && (entries[key.searchHeavy]?.cost.tokens.n ?? 0) === 0
          && host.routerLogLines().length === 0;
        s.verdict(ok, `host child agent=${child.agent} model=${child.model ? ref(child.model) : "?"} (asked heavy); wire ${wire[0]?.catalogModel} effort ${String(obj(wire[0]?.payload.output_config).effort)}; row switched=${row.switched} best=${row.best?.agent}; step records fast n=${entries[key.searchFast]?.cost.tokens.n} heavy n=${entries[key.searchHeavy]?.cost.tokens.n}`);
      });

      // ---- handoffs (phase-2.2/2.3 "to 3.2"): host events and tool hooks, read from the same host ----
      const firstRoot = (await host.client.session.list()).data.find(r => !r.parentID)!;
      const firstChild = (await host.client.session.list({ parentID: firstRoot.id })).data[0]!;
      await runScenario("H1-events-and-hooks-enforce-host", "Host events for a subagent child: session.created carries parentID/agent/title; session.execution.* events carry an id and are delivered for the child before the tool call returns; the plugin's execute.before hook ran for the model-emitted subagent call.", async s => {
        const events = await host.eventsOf(firstChild.id);
        const created = (await host.events()).filter(e => e.type === "session.created" && obj(e.data).sessionID === firstChild.id);
        const execution = events.filter(e => e.type.startsWith("session.execution"));
        const hooks = (await host.hooks()).filter(h => h.sessionID === firstRoot.id && h.tool === "subagent");
        const afterT = hooks.find(h => h.hook === "after")?.__t ?? 0;
        s.observed.childEventTypes = events.map(e => ({ type: e.type, id: e.id, created: e.created, deliveredAt: e.__t }));
        s.observed.sessionCreated = created.map(e => ({ id: e.id, type: e.type, data: e.data, location: e.location }));
        s.observed.executionEvents = execution.map(e => ({ id: e.id, type: e.type, data: e.data, deliveredAt: e.__t }));
        s.observed.subagentHookRecords = hooks.map(h => ({ hook: h.hook, iid: h.iid, callID: h.callID, agent: h.agent, at: h.__t }));
        s.observed.toolReturnedAt = afterT;
        const createdData = obj(created[0]?.data);
        const ended = execution.filter(e => /succeeded|failed|interrupted|ended/.test(e.type));
        const ok = created.length === 1 && createdData.parentID === firstRoot.id && createdData.agent === "fast" && createdData.title === "Find usages"
          && execution.length >= 2 && execution.every(e => typeof e.id === "string" && e.id !== "") && ended.length >= 1 && ended.every(e => (e.__t ?? Infinity) <= afterT + 1000)
          && hooks.some(h => h.hook === "before") && hooks.some(h => h.hook === "after");
        s.verdict(ok, `session.created data keys=${Object.keys(createdData).join(",")} parentID=${String(createdData.parentID)} agent=${String(createdData.agent)} title=${String(createdData.title)}; execution events ${execution.map(e => e.type).join(",")} ids present=${execution.every(e => typeof e.id === "string")}; end delivered ${ended.map(e => (e.__t ?? 0) - afterT).join(",")} ms vs the tool return`);
      });
      await runScenario("H2-tool-hooks-per-instance", "With a second live plugin instance (the server base-configuration location made live) the host delivers EVENTS to every instance but the TOOL HOOKS of a call only to the instance of the session's location (open question of 2.2 R2-2); the router acts once per call (one decision row per dispatch, A3), from a session of either location.", async s => {
        const base = await host.makeBaseLocationLive();
        const rows0 = (await host.decisionRows()).length;
        const rootID = await host.newRoot("enforce root 2");
        const dispatched = await host.dispatch(rootID, { agent: "heavy", description: "Find usages again", prompt: SEARCH_PROMPT, background: false });
        const hooks = (await host.hooks()).filter(h => h.callID === dispatched.callID);
        const iidsBefore = [...new Set(hooks.filter(h => h.hook === "before").map(h => h.iid))];
        const iidsAfter = [...new Set(hooks.filter(h => h.hook === "after").map(h => h.iid))];
        const raw = (await host.rawEvents()).filter(e => obj(e.data).sessionID === dispatched.childID && e.type === "session.step.ended");
        await host.waitForRows("the second decision row", r => r.length >= rows0 + 1);
        const child = await host.client.session.get({ sessionID: dispatched.childID });
        // The same dispatch from a session that lives in the OTHER location (the base configuration directory).
        const baseRoot = await host.newRoot("enforce root at the base location", undefined, base);
        const fromBase = await host.dispatch(baseRoot, { agent: "heavy", description: "Find usages from base", prompt: SEARCH_PROMPT, background: false });
        const baseHooks = (await host.hooks()).filter(h => h.callID === fromBase.callID);
        const baseIids = [...new Set(baseHooks.filter(h => h.hook === "before").map(h => h.iid))];
        const rowsAfter = await host.waitForRows("the third decision row", r => r.length >= rows0 + 2);
        await new Promise(resolve => setTimeout(resolve, 3_000)); // late duplicates, if any
        const rowsFinal = await host.decisionRows();
        const baseChild = await host.client.session.get({ sessionID: fromBase.childID });
        s.observed.baseLocation = base;
        s.observed.liveLocations = await host.client.debug.location.list();
        s.observed.projectSession = { rootID, beforeHookInstances: iidsBefore, afterHookInstances: iidsAfter, hookInstanceDirectories: [...new Set(hooks.map(h => h.instance))] };
        s.observed.stepEndedLinesPerInstance = raw.map(e => ({ id: e.id, iid: e.__iid, instance: e.__instance }));
        s.observed.baseSession = { rootID: baseRoot, beforeHookInstances: baseIids, hookInstanceDirectories: [...new Set(baseHooks.map(h => h.instance))], child: { agent: baseChild.agent, model: baseChild.model } };
        s.observed.rowCounts = { before: rows0, afterFirst: rowsAfter.length - 1, final: rowsFinal.length };
        s.observed.rowsOfTheTwoDispatches = rowsFinal.slice(rows0).map(r => ({ sessionID: r.sessionID, mode: r.mode, switched: r.switched }));
        s.observed.hostChild = { agent: child.agent, model: child.model };
        s.observed.routerLogLines = host.routerLogLines();
        const ok = iidsBefore.length === 1 && iidsAfter.length === 1 && new Set(raw.map(e => e.__iid)).size >= 2 && new Set(raw.map(e => e.id)).size === 1
          && baseIids.length === 1 && baseIids[0] !== iidsBefore[0] && rowsFinal.length === rows0 + 2 && child.agent === "fast" && baseChild.agent === "fast" && host.routerLogLines().length === 0;
        s.verdict(ok, `execute.before delivered to ${iidsBefore.length} of 2 instances (after: ${iidsAfter.length}); step.ended delivered to ${new Set(raw.map(e => e.__iid)).size} instance(s) with ${new Set(raw.map(e => e.id)).size} event id; from the base-location session the hook went to a different single instance (${baseIids.length}); rows ${rows0} -> ${rowsFinal.length} for two dispatches; both children fast`);
      });    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
  it("2 advise: the generated R: line and the route hint reach the orchestrator's request after seeding the store; dispatches are left alone", async () => {
    const control = await RoutingHost.start("advise-control", { routing: { engine: "advise" } });
    let controlSystem = "";
    let controlRootID = "";
    try {
      controlRootID = await control.newRoot("advise control root");
      await control.prompt(controlRootID, SEARCH_ASK);
      controlSystem = control.requestsOf(controlRootID).find(r => r.kind === "primary")?.system ?? "";
    } finally {
      expect((await control.stop()).hostPortClosed).toBe(true);
    }
    const host = await RoutingHost.start("advise", { routing: { engine: "advise" }, seed: MOVE_SEED });
    try {
      await runScenario("2-advise", "engine=advise: after the store is seeded (fast fails search, explore passes it) the system prompt the host sends for the orchestrator carries a generated R: line that moves search to @explore plus a 'Route hint' for the search turn; with no evidence (control host) neither is there and the R: line is the shipped one. A dispatch in advise is logged (would switch) but the host's child still runs the orchestrator's pick.", async s => {
        const rootID = await host.newRoot("advise root");
        await host.prompt(rootID, SEARCH_ASK);
        const request = host.requestsOf(rootID).find(r => r.kind === "primary");
        const system = request?.system ?? "";
        const rLines = (text: string) => text.split(/\r?\n/).filter(line => /^R:/.test(line.trim()) || line.includes("by class:"));
        const hintLines = system.split(/\r?\n/).filter(line => /Route hint: for |^Why:/.test(line));
        // advise never changes a dispatch: the orchestrator asks for fast and the host's child is fast, while the row says it would move to explore
        const dispatched = await host.dispatch(rootID, { agent: "fast", description: "Find usages", prompt: SEARCH_PROMPT, background: false });
        const child = await host.client.session.get({ sessionID: dispatched.childID });
        const rows = await host.waitForRows("the decision row", r => r.length >= 1);
        s.observed.rootID = rootID;
        s.observed.controlRootID = controlRootID;
        s.observed.rootRequest = { catalogModel: request?.catalogModel, agent: request?.agent, systemChars: system.length, rLines: rLines(system), hintLines };
        s.observed.controlRLines = rLines(controlSystem);
        s.observed.controlHasHint = /Route hint: for /.test(controlSystem);
        s.observed.routeLineParagraphPresent = /\[route class=/.test(system);
        s.observed.hostChild = { id: dispatched.childID, agent: child.agent, model: child.model };
        s.observed.row = rows[0];
        s.observed.routerLogLines = host.routerLogLines();
        const row = rows[0]!;
        const seededLine = rLines(system).join("\n");
        const controlLine = rLines(controlSystem).join("\n");
        const ok = request !== undefined && /Route hint: for search work like this turn, prefer @explore/.test(system) && !/Route hint: for /.test(controlSystem)
          && seededLine !== controlLine && /search.{0,4}@explore/.test(seededLine) && !/@explore/.test(controlLine)
          && child.agent === "fast" && sameModel(child.model, SONNET, "low")
          && row.mode === "advise" && row.switched === true && row.chosen.agent === "fast" && row.best?.agent === "explore"
          && host.routerLogLines().length === 0;
        s.verdict(ok, `R: line seeded=${JSON.stringify(seededLine.slice(-160))} control=${JSON.stringify(controlLine.slice(-160))}; hint=${JSON.stringify(hintLines[0] ?? null)}; advise dispatch: child agent=${child.agent}, row switched=${row.switched} best=${row.best?.agent}`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
  it("4 ladder: a failing verification resumes the SAME child with the next variant and passes; one producer session, tokens grow", async () => {
    const host = await RoutingHost.start("ladder", {
      routing: { engine: "advise" },
      overrides: {
        experimental: { verifiedDelegateTool: true },
        enforcement: {
          mode: "advisory",
          verify: { require: "always", defaultVerify: "required", minGraderTier: "heavy", preferDeterministic: false, background: false },
          escalate: { maxAttemptsPerTier: 2, maxTotalAttempts: 4, costCeiling: { multiple: 100 } },
        },
      },
    });
    try {
      host.provider.graderDelayMs = 1_500;
      const acceptance = "[acceptance]\ncriteria: the reply says CHILD_DONE\n[/acceptance]";
      /** One delegation whose first verification fails and the second passes; the host's sessions are sampled while it runs. */
      const delegation = async (label: string, filler: number) => {
        host.provider.graderVerdicts.push(false);
        const rootID = await host.newRoot(`ladder root ${label}`);
        const mark = host.provider.requests.length;
        const hookMark = (await host.hooks()).length;
        const watcher = host.watchSessions();
        const delegated = await host.call(rootID, "delegate", { tier: "fast", task: `[route class=search risk=low scope=single]\nVERIFY:required\nCHILD_DONE ${"x".repeat(filler)}`, acceptance }, 180_000);
        const timeline = await watcher.stop();
        const sessions = [...timeline.values()].filter(t => t.id !== rootID && t.parentID === rootID);
        const producer = sessions.find(t => t.snapshots.some(x => x.agent === "fast"));
        const graders = sessions.filter(t => t !== producer);
        const requests = host.provider.requests.slice(mark);
        const producerRequests = requests.filter(r => r.session === producer?.id && r.kind === "primary");
        const events = (await host.events()).filter(e => e.__t !== undefined && ((obj(e.data).sessionID === producer?.id) || (e.type === "session.created" && obj(e.data).parentID === rootID)));
        return { label, rootID, delegated, timeline, sessions, producer, graders, requests, producerRequests, events, hooks: (await host.hooks()).slice(hookMark) };
      };
      await runScenario("4-ladder", "delegate with a scripted verification that fails once then passes: the runner resumes the SAME child session (the host created ONE producer child, a second decision row has resume=true and the same childSessionID) with the next variant of the same model; the host's stored variant for that child moves low -> medium, its token totals and the context the provider receives grow, and the orchestrator gets the verified result.", async s => {
        const short = await delegation("short", 0);
        const producerID = short.producer?.id ?? "";
        const created = short.events.filter(e => e.type === "session.created" && obj(e.data).parentID === short.rootID).map(e => ({ sessionID: obj(e.data).sessionID, agent: obj(e.data).agent, title: obj(e.data).title }));
        const snapshots = short.producer?.snapshots ?? [];
        const variants = snapshots.map(x => x.model).filter((m, i, all) => m !== undefined && m !== all[i - 1]);
        const rows = await host.waitForRows("both attempt rows", r => r.filter(x => x.childSessionID === producerID).length >= 2, 70_000);
        const logRows = await host.waitForLogRows("both verdict rows", r => r.filter(x => x.kind === "verdict").length >= 2).catch(() => host.logRows());
        s.observed.storeAfterWait = { files: await host.storeListing(), entries: await host.outcomeEntries() };
        const [first, second] = short.producerRequests;
        s.observed.shortRun = {
          rootID: short.rootID, delegateResult: obj(short.delegated.after.result).content,
          sessionsCreatedUnderRoot: created,
          producerTimeline: snapshots, graderTimelines: short.graders.map(g => ({ id: g.id, snapshots: g.snapshots })),
          producerEvents: short.events.filter(e => obj(e.data).sessionID === producerID).map(e => ({ type: e.type, id: e.id, at: e.__t })),
          producerRequests: short.producerRequests.map(r => ({ catalogModel: r.catalogModel, effort: effectiveEffort(r), messages: r.messages.length, inputTokens: r.inputTokens, lastText: r.lastText.slice(0, 400) })),
          graderRequests: short.requests.filter(r => r.reply === "grader").map(r => ({ session: r.session, agent: r.agent, catalogModel: r.catalogModel })),
          providerErrors: host.provider.errors,
        };
        s.observed.rows = rows.map(r => ({ decisionID: r.decisionID, step: r.step, resume: r.resume, childSessionID: r.childSessionID, chosen: r.chosen.key, switched: r.switched, mode: r.mode, reason: r.reason.slice(0, 220) }));
        s.observed.logRowKinds = logRows.map(r => ({ kind: r.kind, step: r.step, verdict: r.kind === "verdict" ? r.verdict : undefined, key: r.kind === "verdict" ? r.key : undefined }));
        s.observed.allHooksDuringDelegation = short.hooks.map(h => ({ hook: h.hook, tool: h.tool, sessionID: h.sessionID === short.rootID ? "<root>" : h.sessionID, agent: h.agent, callID: h.callID }));
        s.observed.routerLogLines = host.routerLogLines();
        const text = JSON.stringify(obj(short.delegated.after.result).content);
        const ok = producerID !== "" && created.filter(c => c.agent === "fast").length === 1
          && variants.length >= 2 && variants[0] === `${MODELS.sonnet}#low` && variants.at(-1) !== variants[0] && variants.every(v => v?.startsWith(`${MODELS.sonnet}#`))
          && snapshots.at(-1)!.input > snapshots[0]!.input && short.producerRequests.length === 2
          && second!.messages.length > first!.messages.length && second!.inputTokens > first!.inputTokens
          && rows.filter(r => r.childSessionID === producerID).length === 2 && rows[0]!.step === "dispatch" && rows[0]!.resume === false && rows[1]!.resume === true && rows[1]!.step === "variant"
          && logRows.filter(r => r.kind === "verdict").map(r => r.kind === "verdict" ? r.verdict : "").join() === "fail,pass" && text.includes("verified")
          && host.routerLogLines().length === 0;
        s.verdict(ok, `producer sessions=${created.filter(c => c.agent === "fast").length}; stored model timeline ${variants.join(" -> ")}; session input tokens ${snapshots.map(x => x.input).join(" -> ")}; provider messages ${first?.messages.length}->${second?.messages.length}, est. input ${first?.inputTokens}->${second?.inputTokens}; rows ${rows.map(r => `${r.step}${r.resume ? "(resume)" : ""}`).join(", ")}; verdicts ${logRows.filter(r => r.kind === "verdict").map(r => r.kind === "verdict" ? r.verdict : "").join(",")}`);
      });

      // ---- handoff (QA-2.3-R2-7): the growth of a resumed attempt against the length of its task, same host ----
      let handoff: { short: Awaited<ReturnType<typeof delegation>>; long: Awaited<ReturnType<typeof delegation>> } | undefined;
      await runScenario("H3-resume-growth-vs-task-length", "The context a resumed attempt sends grows by about the forcing message plus the task prompt again (chars/4): with a 4 000-character task the second request is ~1 000 tokens larger than with an empty task, both against the first request. Token numbers are the scripted provider's own estimate (request body length / 4), not a real tokenizer; whether a real producer repeats its earlier work is NOT observable with a scripted model.", async s => {
        const short = await delegation("short-2", 0);
        const long = await delegation("long", 4_000);
        handoff = { short, long };
        const delta = (d: { producerRequests: { inputTokens: number }[] }) => d.producerRequests.length === 2 ? d.producerRequests[1]!.inputTokens - d.producerRequests[0]!.inputTokens : Number.NaN;
        const rows = await host.waitForRows("the attempt rows of the long run", r => r.filter(x => x.childSessionID === long.producer?.id).length >= 2, 70_000);
        const d11 = (id: string | undefined) => rows.filter(r => r.childSessionID === id).map(r => /tokens=(\d+) budget=(\d+) threshold=(\d+)/.exec(r.reason)?.slice(1).map(Number));
        s.observed.short = { requests: short.producerRequests.map(r => ({ inputTokens: r.inputTokens, messages: r.messages.length, lastTextChars: r.lastText.length })), delta: delta(short), d11: d11(short.producer?.id), sessionInputTotals: short.producer?.snapshots.map(x => x.input) };
        s.observed.long = { requests: long.producerRequests.map(r => ({ inputTokens: r.inputTokens, messages: r.messages.length, lastTextChars: r.lastText.length })), delta: delta(long), d11: d11(long.producer?.id), sessionInputTotals: long.producer?.snapshots.map(x => x.input) };
        s.observed.expectedExtraFromTask = 4_000 / 4;
        s.observed.measuredExtra = delta(long) - delta(short);
        s.observed.starterOver = "unverifiable with a scripted model: the producer's replies are fixed, so whether a real model repeats its earlier work and tool calls cannot be observed here";
        const extra = delta(long) - delta(short);
        const predicted = d11(long.producer?.id)[1]?.[0];
        s.observed.routerEstimateOfNextContext = predicted;
        s.observed.wireSecondRequest = long.producerRequests[1]?.inputTokens;
        const ok = Number.isFinite(extra) && extra > 800 && extra < 1_300 && predicted !== undefined && long.producerRequests[1] !== undefined && predicted <= long.producerRequests[1].inputTokens;
        s.verdict(ok, `second-request growth short=${delta(short)} long=${delta(long)} (+${extra} for a 4 000-char task, expected about ${4_000 / 4}); router's D11 estimate of the next context ${String(predicted)} vs ${long.producerRequests[1]?.inputTokens} on the wire`);
      });

      // ---- handoff (2.2 / 2.3): hooks for the runner's native.execute, and execution events before the resume ----
      await runScenario("H4-runner-hooks-and-execution-events", "(a) the plugin's execute.before/after hooks do NOT fire for the subagent calls the delegate runner makes through ctx.tool.list() (only the model-emitted delegate call is hooked); (b) session.execution.succeeded of the producer child, with an event id, reaches the plugin before the runner's second dispatch (the resume), and the runner's calls leave no decision row of the dispatch router (only the attempt recorder's two rows).", async s => {
        const { long } = handoff!;
        const producerID = long.producer?.id ?? "";
        const producerEvents = long.events.filter(e => obj(e.data).sessionID === producerID);
        const succeeded = producerEvents.filter(e => e.type === "session.execution.succeeded");
        const selected = producerEvents.find(e => e.type === "session.model.selected");
        const subagentHooks = long.hooks.filter(h => h.tool === "subagent");
        const toolsHooked = [...new Set(long.hooks.map(h => `${h.hook}:${h.tool}`))];
        const rows = (await host.decisionRows()).filter(r => r.childSessionID === producerID);
        s.observed.toolsHookedDuringDelegation = toolsHooked;
        s.observed.subagentHookCount = subagentHooks.length;
        s.observed.executionSucceeded = succeeded.map(e => ({ id: e.id, deliveredAt: e.__t }));
        s.observed.secondAttemptStartedAt = selected?.__t;
        s.observed.rowsForProducer = rows.map(r => ({ step: r.step, resume: r.resume, mode: r.mode }));
        s.observed.modelEmittedToolCalls = long.requests.filter(r => r.session === long.rootID).map(r => ({ lastText: r.lastText.slice(0, 60), toolResult: r.toolResult }));
        const ok = subagentHooks.length === 0 && toolsHooked.every(h => h.endsWith(":delegate")) && succeeded.length === 2 && succeeded.every(e => typeof e.id === "string")
          && selected !== undefined && succeeded[0]!.__t! <= selected.__t! && rows.length === 2;
        s.verdict(ok, `hooked tools during the delegation: ${toolsHooked.join(", ")} (subagent hooks: ${subagentHooks.length}); execution.succeeded ids ${succeeded.map(e => e.id).join(",")} delivered ${succeeded.map(e => e.__t).join(",")} before the resume's model.selected ${String(selected?.__t)}; producer rows ${rows.length}`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 400_000);

  it("5 advisor: /router reports the title finding only when the host finds no small model for the session's provider", async () => {
    const host = await RoutingHost.start("advisor", {
      routing: { engine: "advise" },
      providers: { smallless: { name: "Smallless", package: "@opencode/ai/providers/anthropic", settings: { baseURL: "$BASE_URL", apiKey: "keyless-smoke-fake" }, models: { "big-1": { name: "Big One", limit: { context: 200_000, output: 8_000 } } } } },
    });
    try {
      await runScenario("5-advisor", "After QA-2.4-1 the summary finding is gone and `title-model-unset` fires only when agents.title.model is unset AND the host's Model.small pick finds nothing for the SESSION'S provider while a cheaper title-eligible model exists elsewhere. On the real host: /router from a session of the anthropic provider (which has a claude-haiku) has NO title finding; from a session of a provider without a small model it HAS one. (Divergence from plan 3.2 scenario 5, which still says 'title/summary'.)", async s => {
        const router = async (rootID: string) => {
          const before = (await host.client.session.context({ sessionID: rootID })).length;
          await host.client.session.command({ sessionID: rootID, name: "router", text: "" });
          await host.settle(rootID);
          const messages = await host.client.session.context({ sessionID: rootID });
          const added = messages.slice(before).filter(m => m.type === "user").map(m => String(m.text ?? JSON.stringify(m)));
          return added.join("\n");
        };
        const anthropicRoot = await host.newRoot("advisor root anthropic");
        await host.prompt(anthropicRoot, "hello");
        const withHaiku = await router(anthropicRoot);
        const smallRoot = await host.newRoot("advisor root smallless", { providerID: "smallless", id: "big-1" });
        await host.prompt(smallRoot, "hello");
        const withoutSmall = await router(smallRoot);
        const dump = await host.dump();
        const agents = arr(dump?.agents).map(obj);
        const models = arr(dump?.models).map(obj);
        s.observed.anthropicSession = { rootID: anthropicRoot, commandLines: withHaiku.split(/\r?\n/).slice(0, 80) };
        s.observed.smalllessSession = { rootID: smallRoot, commandLines: withoutSmall.split(/\r?\n/).slice(0, 80) };
        s.observed.hostAgentRecords = agents.map(a => ({ id: a.id, mode: a.mode, hidden: a.hidden, model: a.model, keys: Object.keys(a) }));
        s.observed.hostModelRecordSample = models.filter(m => m.id === "claude-haiku-4-5" || m.providerID === "smallless").map(m => ({ providerID: m.providerID, id: m.id, enabled: m.enabled, status: m.status, family: m.family, capabilities: m.capabilities, keys: m.keys }));
        s.observed.providerList = arr(obj(await host.getJson("/api/provider")).data).map(p => ({ id: obj(p).id, package: obj(p).package, activation: obj(p).activation }));
        s.observed.hostErrorLines = host.errorLines();
        s.observed.harnessNote = "A custom provider with package @opencode/ai/providers/anthropic-compatible does NOT initialize in the standalone host (\"Cannot find package @opencode/ai\"; only packages a built-in provider uses are bundled); the fixture therefore uses the bundled @opencode/ai/providers/anthropic under a custom provider id.";
        s.observed.routerLogLines = host.routerLogLines();
        const ok = !/title-model-unset|agents\.title\.model/.test(withHaiku) && /\[saving\] title-model-unset/.test(withoutSmall) && /anthropic\/claude-haiku-4-5/.test(withoutSmall) && host.routerLogLines().length === 0 && host.errorLines().length === 0
          && agents.some(a => a.id === "title" && a.hidden === true && a.model === undefined) && models.some(m => m.id === "claude-haiku-4-5" && m.enabled === true && m.status === "active" && m.family === "claude-haiku" && obj(m.capabilities).tools === true);
        s.verdict(ok, `anthropic session (haiku available): title finding ${/agents\.title\.model/.test(withHaiku)}; smallless session: title finding ${/agents\.title\.model/.test(withoutSmall)}`);
      });

      // The same session on a host whose title agent HAS a model: no finding (2.4 handoff "and not when set").
      const configured = await RoutingHost.start("advisor-title-set", {
        routing: { engine: "advise" },
        providers: { smallless: { name: "Smallless", package: "@opencode/ai/providers/anthropic", settings: { baseURL: "$BASE_URL", apiKey: "keyless-smoke-fake" }, models: { "big-1": { name: "Big One", limit: { context: 200_000, output: 8_000 } } } } },
        hostConfig: { agents: { title: { model: "anthropic/claude-haiku-4-5" } } },
      });
      try {
        await runScenario("5b-advisor-title-model-set", "With agents.title.model set in the host config the real title agent record carries that model and /router has NO title finding, even from a session of the provider without a small model.", async s => {
          const rootID = await configured.newRoot("advisor root smallless (title set)", { providerID: "smallless", id: "big-1" });
          await configured.prompt(rootID, "hello");
          const before = (await configured.client.session.context({ sessionID: rootID })).length;
          await configured.client.session.command({ sessionID: rootID, name: "router", text: "" });
          await configured.settle(rootID);
          const text = (await configured.client.session.context({ sessionID: rootID })).slice(before).filter(m => m.type === "user").map(m => String(m.text ?? "")).join("\n");
          const agentList = (await configured.client.agent.list()).data.filter(a => a.id === "title");
          s.observed.titleAgentRecord = agentList.map(a => ({ id: a.id, hidden: a.hidden, model: (a as { model?: unknown }).model }));
          s.observed.doctorLines = text.split(/\r?\n/).filter(l => /Cost doctor|\[(info|saving|warning)\]/.test(l));
          s.observed.hostErrorLines = configured.errorLines();
          const ok = !/title-model-unset/.test(text) && /Cost doctor/.test(text) && agentList.some(a => obj(a.model).id === "claude-haiku-4-5") && configured.errorLines().length === 0;
          s.verdict(ok, `title agent model=${JSON.stringify(agentList[0]?.model)}; title finding present=${/title-model-unset/.test(text)}`);
        });
      } finally {
        expect((await configured.stop()).hostPortClosed).toBe(true);
      }
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
  it("6 v1 untouched: the files of the existing v1 smoke suite and the smoke:keyless script are byte-identical to the base commit", async () => {
    await runScenario("6-v1-untouched", "Phase 3.2 adds files only: no existing test/smoke file (the v1 suite smoke:keyless runs registration, subagent-tiers, deferred-catalog, depth-effort and the scripted-provider helper test) changed since the base commit 71815eb, and package.json gained exactly the smoke:routing line. The suite itself was run unchanged against OpenCode 1.18.34 (see phase-3.2.md and 6-smoke-keyless.log.txt).", async s => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
      const changed = git("diff", "--name-status", BASE_COMMIT, "--", "test/smoke", "vitest.smoke.config.ts").split(/\r?\n/).filter(Boolean);
      const modified = changed.filter(line => !line.startsWith("A\t"));
      const packageDiff = git("diff", "-U0", BASE_COMMIT, "--", "package.json").split(/\r?\n/).filter(line => /^[+-](?![+-])/.test(line));
      const v1Files = ["registration.smoke.test.ts", "subagent-tiers.smoke.test.ts", "deferred-catalog.smoke.test.ts", "depth-effort.smoke.test.ts", "helpers/scripted-provider.ts", "helpers/scripted-provider.test.ts", "helpers/fetch-safe-port.ts"];
      s.observed.baseCommit = BASE_COMMIT;
      s.observed.changedSinceBase = changed;
      s.observed.modifiedOrDeleted = modified;
      s.observed.packageJsonChangedLines = packageDiff;
      s.observed.v1SuiteFiles = v1Files.map(file => ({ file, changed: git("diff", "--name-only", BASE_COMMIT, "--", `test/smoke/${file}`) !== "" }));
      s.observed.externalRun = "npm run smoke:keyless with OpenCode 1.18.34 first on PATH: 5 files passed, 27 tests passed, 11 skipped (the v2 describes); log in 6-smoke-keyless.log.txt";
      const ok = modified.length === 0 && packageDiff.length === 1 && packageDiff[0]!.startsWith("+") && packageDiff[0]!.includes("smoke:routing") && v1Files.every(file => git("diff", "--name-only", BASE_COMMIT, "--", `test/smoke/${file}`) === "");
      s.verdict(ok, `${changed.length} path(s) changed under test/smoke since ${BASE_COMMIT} (all added: ${modified.length === 0}); package.json changed lines: ${packageDiff.join(" | ")}`);
    });
  });});

void str;
void MODELS;
