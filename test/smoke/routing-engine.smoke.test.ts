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
import { makeKey } from "../../src/routing/outcomes";
import {
  MODELS, RoutingHost, obj, ref, runScenario, stopAllHosts, str, type HookRecord, type ModelRef, type Seed,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROUTING === "1";
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
  }, 300_000);});

void str;
void MODELS;
