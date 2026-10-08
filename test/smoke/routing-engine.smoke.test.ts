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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FLOOR_LIFT_REASON, RESUME_PINNED_REASON, RESUME_RUNNING_REASON, makeKey } from "../../src/routing/outcomes";
import { noticeFiles } from "../../src/routing/advisor";
import { scrubReadOnlyEvidence } from "./helpers/readonly-evidence";
import {
  MODELS, ROOT, RoutingHost, seenProjectDirs, seenSessionIDs, inBandEfforts, SMOKE_PRESET, arr, effectiveEffort, obj, ref, runScenario, stopAllHosts, type HookRecord, type ModelRef, type Obj, type Rule, type Seed, type WireRequest,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROUTING === "1";
/** The tip of car/main this phase branched from. */
const BASE_COMMIT = "71815eb";
/**
 * Base of scenario 6 ("v1 untouched"), repinned by #84 P3.1. The Phase 3.2 base 71815eb is stale: later releases changed the v1 suite and
 * package.json on purpose (#67, #77, #83 among them), so "nothing under test/smoke changed since 71815eb" no longer holds and never will
 * again. What must hold is that the v1 entry points do not change across #84 (plan §2.7, I8): the v1 suite files `smoke:keyless` runs,
 * the smoke vitest config, the v1 preflight and the `smoke:keyless` / `smoke:v1` scripts. Base: `bd1ecd1` = master before #84 (`eeab36b`,
 * the #83 merge) plus the one repair #83 had left stale INSIDE the v1 suite (subagent-tiers.smoke.test.ts pinned FAST_MODEL to the old
 * Sonnet fast tier; bd1ecd1 aligned that literal with #83's Haiku fast tier — no v1 behaviour change). Every later #84 change must leave
 * these paths byte-identical; new #84 smoke files (roles, role spikes) and the v2 harness are additions outside the v1 suite.
 */
const V1_BASE_COMMIT = "bd1ecd1";
/** `RESUME_END_WAIT_MS` of `src/index.ts`: the longest the delegate runner waits for a child's execution end after the child returned. */
const RUNNER_END_WAIT_MS = 1_000;
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

// ---- the user's live store and live config: read-only snapshots taken before the first scenario and compared after the last ----
const LIVE_STORE = path.join(process.env.OMR_SMOKE_REAL_TMPDIR ?? tmpdir(), "opencode-model-router-trajectory");
const LIVE_CONFIG = path.join(homedir(), ".config", "opencode");
interface FileStat { size: number; mtimeMs: number }
async function listDir(dir: string): Promise<Record<string, FileStat>> {
  if (!existsSync(dir)) return {};
  const out: Record<string, FileStat> = {};
  const names = await readdir(dir);
  for (let i = 0; i < names.length; i += 200) {
    await Promise.all(names.slice(i, i + 200).map(async name => { try { const st = await stat(path.join(dir, name)); if (st.isFile()) out[name] = { size: st.size, mtimeMs: st.mtimeMs }; } catch { /* removed meanwhile */ } }));
  }
  return out;
}
let liveBefore: { store: Record<string, FileStat>; config: Record<string, FileStat>; at: string } | undefined;
beforeAll(async () => {
  if (RUN) liveBefore = { store: await listDir(LIVE_STORE), config: await listDir(LIVE_CONFIG), at: new Date().toISOString() };
}, 60_000);

const sameModel = (m: ModelRef | undefined, want: { providerID: string; id: string }, variant?: string) =>
  m?.providerID === want.providerID && m.id === want.id && m.variant === variant;
const inputOf = (h: HookRecord | undefined) => obj(h?.input);

d("routing engine on the real OpenCode v2 host (Phase 3.2)", () => {
  it("77 fast read-only: host refuses shell edit execute subagent and permits inspection", async () => {
    const host = await RoutingHost.start("fast-readonly", { routing: null, hostConfig: {
      agents: { fast: { permissions: [{ action: "read", resource: "*readonly-blocked.txt", effect: "deny" }] } },
    } });
    const evidence: Obj[] = [];
    try {
      execFileSync("git", ["init", "-q", host.project], { shell: false, windowsHide: true });
      const target = path.join(host.project, "readonly-probe.txt");
      const blocked = path.join(host.project, "readonly-blocked.txt");
      await writeFile(target, "READ_ONLY_ORIGINAL\n");
      await writeFile(blocked, "BLOCKED_CONTENT\n");
      await writeFile(path.join(host.project, ".env"), "SECRET_GREP_RO\n");
      const probes: Array<{ tool: string; input: Obj; allowed: boolean; parentAllow?: string; blocked?: boolean; sensitive?: boolean }> = [
        { tool: "shell", input: { command: "echo WRITE_ATTEMPT > readonly-probe.txt", workdir: host.project }, allowed: false },
        { tool: "edit", input: { path: target, oldString: "READ_ONLY_ORIGINAL", newString: "WRITE_ATTEMPT" }, allowed: false },
        { tool: "execute", input: { code: "return 'WRITE_ATTEMPT'" }, allowed: false },
        { tool: "subagent", input: { agent: "medium", description: "forbidden child", prompt: "CHILD_DONE" }, allowed: false },
        { tool: "read", input: { path: target }, allowed: true },
        { tool: "grep", input: { pattern: "READ_ONLY_ORIGINAL", path: host.project }, allowed: true },
        { tool: "grep", input: { pattern: ".", path: path.join(host.project, ".env") }, allowed: true, sensitive: true },
        { tool: "glob", input: { pattern: "*.txt", path: host.project }, allowed: true },
        { tool: "router_git_status", input: {}, allowed: true },
        { tool: "router_git_diff", input: { ref: "--output=readonly-probe.txt" }, allowed: false },
        { tool: "shell", input: { command: "echo WRITE_ATTEMPT > readonly-probe.txt", workdir: host.project }, allowed: false, parentAllow: "shell" },
        { tool: "shell", input: { command: "echo WRITE_ATTEMPT > readonly-probe.txt", workdir: host.project }, allowed: false, parentAllow: "*" },
        { tool: "read", input: { path: blocked }, allowed: false, blocked: true, parentAllow: "read" },
      ];
      for (const probe of probes) {
        const root = await host.newRoot(`readonly ${probe.tool}`, undefined, host.project,
          probe.parentAllow ? [{ action: probe.parentAllow, resource: "*", effect: "allow" }] : []);
        const result = await host.dispatch(root, { agent: "fast", description: `readonly ${probe.tool}`, prompt: `READ_ONLY_PROBE=${JSON.stringify({ tool: probe.tool, input: probe.input })}`, background: false });
        const requests = host.requestsOf(result.childID).filter(r => r.kind === "primary");
        const names = requests[0]?.toolNames ?? [];
        const hooks = (await host.hooks()).filter(h => h.sessionID === result.childID && h.tool === probe.tool && h.hook === "after");
        const messages = await host.client.session.context({ sessionID: result.childID });
        const states = messages.flatMap(message => arr(obj(message).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
        const context = JSON.stringify(states);
        const agent = (await host.client.agent.list()).data.find(a => a.id === "fast");
        expect(arr(agent?.permissions).some(rule => obj(rule).action === "*" && obj(rule).resource === "*" && obj(rule).effect === "allow")).toBe(false);
        const child = await host.client.session.get({ sessionID: result.childID });
        const parent = await host.client.session.get({ sessionID: root });
        expect(child.permissions ?? []).toEqual(parent.permissions ?? []);
        evidence.push({ tool: probe.tool, allowed: probe.allowed, parentAllow: probe.parentAllow, advertised: names, permissions: agent?.permissions,
          inheritedGrantsRetained: true, sensitiveWithheld: probe.sensitive === true && !context.includes("SECRET_GREP_RO")
            && context.includes("1 matches in sensitive files withheld; use read (asks for approval)"),
          statuses: hooks.map(h => h.status), hostRefusal: states.some(state => state.status === "error"),
          permissionDenied: states.some(state => /Permission denied/i.test(String(obj(state.error).message))) });
        // Normal runs leave tracked evidence untouched. Opt in deliberately to
        // refresh the redacted artifact after inspecting the probe results.
        const evidencePath = process.env.OMR_UPDATE_READONLY_EVIDENCE === "1"
          ? path.join(ROOT, "docs", "qa", "fast-readonly-smoke.json") : path.join(host.root, "fast-readonly-smoke.json");
        await writeFile(evidencePath, JSON.stringify(scrubReadOnlyEvidence(evidence), null, 2) + "\n");
        if (probe.allowed) {
          expect(names).toContain(probe.tool);
          expect(hooks.some(h => h.status === "completed"), JSON.stringify(hooks)).toBe(true);
          if (probe.sensitive) {
            expect(context).not.toContain("SECRET_GREP_RO");
            expect(context).toContain("1 matches in sensitive files withheld; use read (asks for approval)");
          }
        } else if (probe.blocked) {
          // Advertised read, but denied resource: this reaches the host's
          // Permission.assert / BlockedError path, not the missing-tool path.
          expect(names).toContain("read");
          expect(states.some(state => state.status === "error" && /Permission denied/i.test(String(obj(state.error).message))), context).toBe(true);
          expect(hooks.some(h => h.status === "completed")).toBe(false);
        } else if (probe.tool === "router_git_diff") {
          // QA-77-G12: the tool reports its refusal as output instead of throwing
          // into the session, so the host state holds the redacted error text.
          expect(context).toContain("[router_git] error: Invalid git ref");
        } else {
          expect(names).not.toContain(probe.tool);
          expect(hooks.some(h => h.status === "completed")).toBe(false);
          // Host-filtered tools are unknown; tools removed from a merged
          // request snapshot are registered but unavailable for that request.
          const refusals = [`No tool named "${probe.tool}"`, `Tool is not available for this request: ${probe.tool}`];
          expect(states.some(state => state.status === "error" && refusals.some(refusal => String(obj(state.error).message).includes(refusal))), context).toBe(true);
        }
        expect(await readFile(target, "utf8")).toBe("READ_ONLY_ORIGINAL\n");
        expect(await host.children(result.childID)).toHaveLength(0);
      }
      expect(host.provider.errors).toEqual([]);
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);

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
      await runScenario("H1-events-and-hooks-enforce-host", "Host events for a subagent child: session.created carries parentID/agent/title; session.execution.* events carry an id (verified) and their delivery to the plugin is asserted against the product's own bound, the runner's 1 s wait after the call returns (RESUME_END_WAIT_MS: a later end means a fresh start); the delta against the probe's execute.after hook is recorded as an OBSERVATION (one sample per run, a few tens of ms before it), not asserted; the plugin's execute.before hook ran for the model-emitted subagent call.", async s => {
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
        // QA-3.2-R2-4: what the runner needs is that the end event arrives within its bounded wait after the call returns (`RESUME_END_WAIT_MS`, src/index.ts); how early it arrives is one observation per run, recorded here, not asserted
        s.observed.runnerEndWaitMs = RUNNER_END_WAIT_MS;
        s.observed.endDeliveryDeltaMs = execution.map(e => ({ type: e.type, deltaMsVsProbeAfterHook: (e.__t ?? Number.NaN) - afterT }));
        const createdData = obj(created[0]?.data);
        const ended = execution.filter(e => /succeeded|failed|interrupted|ended/.test(e.type));
        const ok = created.length === 1 && createdData.parentID === firstRoot.id && createdData.agent === "fast" && createdData.title === "Find usages"
          && execution.length >= 2 && execution.every(e => typeof e.id === "string" && e.id !== "") && ended.length >= 1 && ended.every(e => (e.__t ?? Infinity) <= afterT + RUNNER_END_WAIT_MS) // QA-3.2-R2-4: the product's own bound (below); the delta itself is only an observation
          && hooks.some(h => h.hook === "before") && hooks.some(h => h.hook === "after");
        s.verdict(ok, `session.created data keys=${Object.keys(createdData).join(",")} parentID=${String(createdData.parentID)} agent=${String(createdData.agent)} title=${String(createdData.title)}; execution events ${execution.map(e => e.type).join(",")} ids present=${execution.every(e => typeof e.id === "string")}; end observed ${ended.map(e => (e.__t ?? 0) - afterT).join(",")} ms before the probe's after-hook (one sample)`);
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
        // each of the three fast children (scenario 3's, this one and the base-location one) is ONE attempt in the store, and its tokens were added once although two instances saw its step events
        const firstHostChild = await host.client.session.get({ sessionID: firstChild.id });
        const hostInputTotal = [firstHostChild, child, baseChild].reduce((sum, c) => sum + (c.tokens?.input ?? 0), 0);
        const keyed = await host.waitForEntries("three fast attempts folded", e => (e[key.searchFast]?.cost.tokens.n ?? 0) >= 3);
        await new Promise(resolve => setTimeout(resolve, 3_000)); // a late duplicate, if any
        const keyedFinal = await host.outcomeEntries();
        const fastCost = keyedFinal[key.searchFast]?.cost;
        s.observed.storeCountedOnce = { fastAttempts: fastCost?.tokens.n, fastInputMeanTimesN: fastCost === undefined ? undefined : Math.round(fastCost.tokens.input * fastCost.tokens.n), hostChildrenInputTotal: hostInputTotal, heavyAttempts: keyedFinal[key.searchHeavy]?.cost.tokens.n, firstSnapshotN: keyed[key.searchFast]?.cost.tokens.n };
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
          && baseIids.length === 1 && baseIids[0] !== iidsBefore[0] && rowsFinal.length === rows0 + 2 && child.agent === "fast" && baseChild.agent === "fast" && host.routerLogLines().length === 0
          && fastCost?.tokens.n === 3 && Math.abs(fastCost.tokens.input * fastCost.tokens.n - hostInputTotal) < 1 && keyedFinal[key.searchHeavy]?.cost.tokens.n === 0;
        s.verdict(ok, `execute.before delivered to ${iidsBefore.length} of 2 instances (after: ${iidsAfter.length}); step.ended delivered to ${new Set(raw.map(e => e.__iid)).size} instance(s) with ${new Set(raw.map(e => e.id)).size} event id; from the base-location session the hook went to a different single instance (${baseIids.length}); rows ${rows0} -> ${rowsFinal.length} for two dispatches; both children fast; store: fast key ${fastCost?.tokens.n} attempts, input ${fastCost === undefined ? "?" : Math.round(fastCost.tokens.input * fastCost.tokens.n)} = the hosts' ${hostInputTotal} (counted once), heavy key ${keyedFinal[key.searchHeavy]?.cost.tokens.n} attempts`);
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
        const ok = /Cost doctor/.test(withHaiku) && !/title-model-unset|agents\.title\.model/.test(withHaiku) && /\[saving\] title-model-unset/.test(withoutSmall) && /anthropic\/claude-haiku-4-5/.test(withoutSmall) && host.routerLogLines().length === 0 && host.errorLines().length === 0
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
  it("6 v1 untouched: the v1 smoke suite, its config, its preflight and the smoke:keyless / smoke:v1 scripts are byte-identical to the v1 base (V1_BASE_COMMIT)", async () => {
    await runScenario("6-v1-untouched", `The v1 entry points are unchanged since ${V1_BASE_COMMIT} (master before #84 plus the #83 literal repair of the v1 suite, see V1_BASE_COMMIT): the v1 suite smoke:keyless runs (registration, subagent-tiers, deferred-catalog, depth-effort, the scripted-provider helper and its test, fetch-safe-port), vitest.smoke.config.ts, scripts/smoke-v1-preflight.mjs, and the package.json scripts smoke:keyless and smoke:v1 (the alias of smoke:keyless behind a preflight that fails clearly when \`opencode\` on PATH is not 1.x, QA-3.2-11, QA-3.2-R2-2). Repinned by #84 P3.1 from the stale Phase 3.2 base ${BASE_COMMIT}. Every other test/smoke change since the v1 base is recorded, not asserted.`, async s => {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
      const v1Files = ["registration.smoke.test.ts", "subagent-tiers.smoke.test.ts", "deferred-catalog.smoke.test.ts", "depth-effort.smoke.test.ts", "helpers/scripted-provider.ts", "helpers/scripted-provider.test.ts", "helpers/fetch-safe-port.ts"];
      const v1Paths = [...v1Files.map(file => `test/smoke/${file}`), "vitest.smoke.config.ts", "scripts/smoke-v1-preflight.mjs"];
      const changedV1 = v1Paths.filter(file => git("diff", "--name-only", V1_BASE_COMMIT, "--", file) !== "");
      const scriptsOf = (json: string): Record<string, unknown> => (JSON.parse(json) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const baseScripts = scriptsOf(git("show", `${V1_BASE_COMMIT}:package.json`));
      const nowScripts = scriptsOf(await readFile(path.join(ROOT, "package.json"), "utf8"));
      const v1Scripts = ["smoke:keyless", "smoke:v1"].map(name => ({ name, base: baseScripts[name], now: nowScripts[name] }));
      s.observed.v1BaseCommit = V1_BASE_COMMIT;
      s.observed.phase32BaseCommit = BASE_COMMIT;
      s.observed.v1Paths = v1Paths.map(file => ({ file, changed: changedV1.includes(file) }));
      s.observed.v1Scripts = v1Scripts;
      s.observed.otherSmokeChangesSinceV1Base = git("diff", "--name-status", V1_BASE_COMMIT, "--", "test/smoke").split(/\r?\n/).filter(Boolean);
      s.observed.externalRun = "npm run smoke:v1 (= preflight + smoke:keyless) with OpenCode 1.18.35 first on PATH: exit 0 (#84 P3.1, docs/qa/role-tier/phase-p31.md); earlier: smoke:keyless with OpenCode 1.18.34, 5 files passed (phase-3.2.md)";
      const scriptsKept = v1Scripts.every(x => typeof x.base === "string" && x.base === x.now)
        && nowScripts["smoke:v1"] === "node scripts/smoke-v1-preflight.mjs && npm run smoke:keyless";
      const ok = changedV1.length === 0 && scriptsKept;
      s.verdict(ok, `v1 paths changed since ${V1_BASE_COMMIT}: ${changedV1.length === 0 ? "none" : changedV1.join(", ")}; smoke:keyless/smoke:v1 unchanged: ${scriptsKept}`);
    });
  }, 60_000);
  it("7 openai responses: effort delivery of a same-model variant change on the OpenAI Responses route (A7 / QA-0P-26)", async () => {
    const host = await RoutingHost.start("responses", {
      routing: { engine: "shadow" },
      providers: { openai: { settings: { baseURL: "$BASE_URL", apiKey: "keyless-smoke-fake" } } },
    });
    try {
      await runScenario("7-openai-responses", "(HOST EMISSION ONLY: what the host sends to a scripted Responses provider; acceptance by api.openai.com is not verified.) The scripted provider speaks the OpenAI Responses protocol (/v1/responses, SSE response.* events) for a gpt-6-class model with variants. A child started at #low and resumed at a higher variant of the SAME model: the host keeps the top-level reasoning.effort of the first request and delivers the change as an in-band configuration_update input item; the EFFECTIVE effort (last in-band value, else top-level) follows the stored variant. A `default` (bare model) start resumed at #high behaves the same (F9). A model change together with a variant is recorded, not asserted.", async s => {
        const catalog = (await host.client.model.list({ location: { directory: host.project } })).data.filter(m => m.providerID === "openai" && m.enabled);
        const luna = catalog.find(m => m.id === "gpt-6-luna");
        const sol = catalog.find(m => m.id === "gpt-6-sol");
        s.observed.openaiModelsWithVariants = catalog.filter(m => m.variants.length >= 2).map(m => `${m.id}: ${m.variants.map(v => v.id).join("/")}`);
        s.observed.providerList = arr(obj(await host.getJson("/api/provider")).data).map(p => ({ id: obj(p).id, package: obj(p).package, activation: obj(p).activation }));
        if (!luna || !sol) { s.verdict(false, "the isolated catalog has no gpt-6-luna / gpt-6-sol"); return; }
        const rootID = await host.newRoot("responses root");
        const inBand = (r: WireRequest) => r.messages.filter(m => m.type === "configuration_update").map(m => obj(m.reasoning).effort).filter(e => e !== undefined);
        const topLevel = (r: WireRequest) => obj(r.payload.reasoning).effort;
        const effective = (r: WireRequest) => inBand(r).at(-1) ?? topLevel(r);
        type Row = { case: string; asked: string; storedModel: string | undefined; catalogModel: string | undefined; wireModel: string | undefined; topLevel: unknown; inBandAllHistory: unknown[]; effective: unknown; reasoningField: unknown };
        const table: Row[] = [];
        const step = async (name: string, call: Obj) => {
          const mark = host.provider.requests.length;
          const d = await host.dispatch(rootID, { agent: "general", description: `R7 ${name}`, ...call });
          const stored = await host.client.session.get({ sessionID: d.childID });
          const requests = host.provider.requests.slice(mark).filter(r => r.session === d.childID && r.kind === "primary");
          for (const r of requests) table.push({ case: name, asked: String(call.model), storedModel: stored.model ? ref(stored.model) : undefined, catalogModel: r.catalogModel, wireModel: r.model, topLevel: topLevel(r), inBandAllHistory: inBand(r), effective: effective(r), reasoningField: r.payload.reasoning });
          return { childID: d.childID, requests };
        };
        const l = "openai/gpt-6-luna";
        const a = await step("A same-model bump (low)", { prompt: "R7 A start", model: `${l}#low` });
        await step("A same-model bump (high)", { prompt: "R7 A resume", sessionID: a.childID, model: `${l}#high` });
        await step("A same-model bump (max)", { prompt: "R7 A resume 2", sessionID: a.childID, model: `${l}#max` });
        const f = await step("F default then high (bare)", { prompt: "R7 F start", model: l });
        await step("F default then high (high)", { prompt: "R7 F resume", sessionID: f.childID, model: `${l}#high` });
        const m = await step("M model and variant together (luna low)", { prompt: "R7 M start", model: `${l}#low` });
        await step("M model and variant together (sol high)", { prompt: "R7 M resume", sessionID: m.childID, model: "openai/gpt-6-sol#high" });
        const r1 = await step("R1 bare model after a variant (luna high)", { prompt: "R7 R1 start", model: `${l}#high` });
        await step("R1 bare model after a variant (bare luna)", { prompt: "R7 R1 resume", sessionID: r1.childID, model: l });
        const rows = (name: string) => table.filter(r => r.case.startsWith(name));
        s.observed.table = table;
        s.observed.firstConfigurationUpdateItem = host.provider.requests.flatMap(r => r.messages.filter(item => item.type === "configuration_update")).at(0);
        s.observed.providerErrors = host.provider.errors;
        s.observed.hostErrors = host.errorLines();
        s.observed.protocolNote = "Scripted Responses fixture: SSE response.created / output_item.added / output_text.delta / output_item.done / response.completed (message item), or a function_call item for tool calls. The host accepted it for every request (no provider or host errors). Whether api.openai.com honours an in-band configuration_update was NOT verified.";
        const A = rows("A same-model");
        const F = rows("F default");
        const stepsOk = A.map(r => String(r.effective)).join() === "low,high,max" && A.every(r => r.topLevel === "low") && A.slice(1).every(r => r.inBandAllHistory.length > 0)
          && F.length === 2 && F[1]!.effective === "high" && F[1]!.inBandAllHistory.at(-1) === "high"
          // the bare (default) start sends NO reasoning field at all; `{summary: "auto"}` is what the RESUMED request carries
          && F[0]!.reasoningField === undefined && JSON.stringify(F[1]!.reasoningField) === JSON.stringify({ summary: "auto" });
        const M = rows("M model");
        const R = rows("R1 bare");
        s.observed.derived = {
          sameModelBumpEffective: A.map(r => r.effective), sameModelBumpTopLevel: A.map(r => r.topLevel),
          defaultThenHigh: F.map(r => ({ topLevel: r.topLevel, effective: r.effective, reasoningField: r.reasoningField })),
          modelAndVariantTogether: M.map(r => ({ wireModel: r.wireModel, topLevel: r.topLevel, inBand: r.inBandAllHistory, effective: r.effective })),
          bareModelAfterVariant: R.map(r => ({ storedModel: r.storedModel, topLevel: r.topLevel, inBand: r.inBandAllHistory, effective: r.effective })),
        };
        s.verdict(stepsOk && host.errorLines().length === 0 && host.provider.errors.length === 0, `(host emission only) same-model luna low->high->max: effective ${A.map(r => String(r.effective)).join("->")} (top-level ${A.map(r => String(r.topLevel)).join("->")}); default->high: ${F.map(r => String(r.effective)).join("->")}; luna low -> sol high: ${M.map(r => String(r.effective)).join("->")}; bare luna after #high: ${R.map(r => String(r.effective)).join("->")} (stored ${R.map(r => r.storedModel).join(" / ")})`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
  it("H6 resume: floor lift, kept:resume:running, an honoured agent switch, a pinned resume, a non-child resume and a denied agent (A30 amended)", async () => {
    const host = await RoutingHost.start("resume", { routing: { engine: "enforce" }, overrides: { enforcement: { escalate: { floorTier: "medium" } } } });
    try {
      await runScenario("H6-resume-rules-on-the-host", "On a real host with escalate.floorTier=medium in enforce: (1) a fast dispatch is lifted to medium and the host's child runs medium/sonnet#medium; (2) a resume naming the original pick `fast` is rewritten to `medium` (row reason kept:resume:running) and the host's child STAYS medium; (3) a resume naming `heavy` on purpose is honoured: the host's switchAgent moves the child to heavy AND to heavy's model; (4) a resume naming `fast` is lifted to the floor (medium), never below it; (5) a resume of another root's child is rejected by the host AFTER the plugin's hooks ran, and the next resume naming the pick is still corrected (R2-1: the rejected call did not take the registration); a PINNED resume naming `fast` is not rewritten and the host moves the child to fast/sonnet#low (the behaviour the rule protects against); (6) an agent the session's permissions deny is refused by the host (`Subagent denied`) and the child stays where it was.", async s => {
        const rootID = await host.newRoot("resume root");
        const state = async (childID: string) => { const c = await host.client.session.get({ sessionID: childID }); return { agent: c.agent, model: c.model ? ref(c.model) : undefined, parentID: c.parentID }; };
        const steps: Obj[] = [];
        const record = async (name: string, input: Obj, childID?: string) => {
          const d = await host.dispatch(rootID, { description: `H6 ${name}`, background: false, ...input, ...(childID ? { sessionID: childID } : {}) });
          const after = await state(d.childID);
          steps.push({ name, asked: { agent: input.agent, sessionID: childID }, hookInput: { agent: obj(d.before.input).agent, model: obj(d.before.input).model, sessionID: obj(d.before.input).sessionID }, status: d.after.status, hostChild: after, childID: d.childID });
          return { d, after };
        };
        const first = await record("1 fresh fast (lifted)", { agent: "fast", prompt: SEARCH_PROMPT });
        const childID = first.d.childID;
        const keep = await record("2 resume naming the original pick", { agent: "fast", prompt: SEARCH_PROMPT }, childID);
        const up = await record("3 resume naming heavy on purpose", { agent: "heavy", prompt: SEARCH_PROMPT }, childID);
        const down = await record("4 resume naming fast after heavy", { agent: "fast", prompt: SEARCH_PROMPT }, childID);
        // a session that is not a child of the caller: the host rejects it AFTER the plugin's hooks ran (R2-1)
        const otherRoot = await host.newRoot("resume root 2");
        const foreign = await host.call(otherRoot, "subagent", { agent: "medium", description: "H6 foreign resume", prompt: SEARCH_PROMPT, sessionID: childID, background: false });
        const afterForeign = await state(childID);
        steps.push({ name: "5a resume of another root's child (rejected by the host)", status: foreign.after.status, error: foreign.after.error, resultSessionID: foreign.childID, hostChildAfter: afterForeign });
        // R2-1: the rejected call must not have taken the child's registration away from its own orchestrator: the next resume naming the pick is still corrected
        const again = await record("5b resume naming fast after the rejected foreign resume (R2-1)", { agent: "fast", prompt: SEARCH_PROMPT }, childID);
        const pinned = await record("5c pinned resume naming fast", { agent: "fast", prompt: "[route class=search risk=low scope=single pin]\nFind it again." }, childID);        // an agent the session's permissions deny
        const denyRoot = await host.newRoot("resume root 3", undefined, undefined, [{ action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "heavy", effect: "deny" }]);
        const denyFirst = await host.dispatch(denyRoot, { agent: "fast", description: "H6 deny start", prompt: SEARCH_PROMPT, background: false });
        const denied = await host.call(denyRoot, "subagent", { agent: "heavy", description: "H6 deny resume", prompt: SEARCH_PROMPT, sessionID: denyFirst.childID, background: false });
        const afterDenied = await state(denyFirst.childID);
        steps.push({ name: "6 resume naming an agent the session denies", status: denied.after.status, error: denied.after.error, hookInput: { agent: obj(denied.before.input).agent, model: obj(denied.before.input).model }, hostChildAfter: afterDenied });
        const rows = await host.waitForRows("every decision row", r => r.length >= 9, 90_000);
        s.observed.steps = steps;
        s.observed.rows = rows.map(r => ({ session: r.sessionID === rootID ? "root1" : r.sessionID === otherRoot ? "root2" : "root3", resume: r.resume, childSessionID: r.childSessionID === childID ? "child1" : r.childSessionID, chosen: r.chosen.agent, best: r.best?.agent, switched: r.switched, pinned: r.pinned, reason: r.reason.slice(0, 260) }));
        s.observed.hostErrors = host.errorLines();
        s.observed.routerLogLines = host.routerLogLines();
        const rootRows = rows.filter(r => r.sessionID === rootID);
        const medium = `${MODELS.sonnet}#medium`;
        const ok = first.after.agent === "medium" && first.after.model === medium && rootRows[0]?.reason.startsWith(FLOOR_LIFT_REASON) === true
          && keep.after.agent === "medium" && keep.after.model === medium && obj(keep.d.before.input).agent === "medium" && rootRows[1]?.reason.startsWith(RESUME_RUNNING_REASON) === true
          && up.after.agent === "heavy" && up.after.model === `${MODELS.opus}#xhigh`
          && down.after.agent === "medium" && down.after.model === medium && rootRows[3]?.reason.startsWith(FLOOR_LIFT_REASON) === true
          && foreign.after.status === "error" && String(obj(foreign.after.error).string).includes("is not a child of the current session") && afterForeign.agent === "medium"
          && again.after.agent === "medium" && again.after.model === medium && obj(again.d.before.input).agent === "medium" && rootRows[4]?.reason.startsWith(RESUME_RUNNING_REASON) === true && rootRows[4]?.reason.includes("sent to @medium") === true
          && pinned.after.agent === "fast" && pinned.after.model === `${MODELS.sonnet}#low` && rootRows[5]?.pinned === true && rootRows[5]?.reason.startsWith(RESUME_PINNED_REASON) === true && rootRows[5]?.reason.includes("NOT rewritten") === true && !rootRows[5]?.reason.includes("sent to @medium")
          && String(obj(denied.after.error).string).includes("Subagent denied: heavy") && afterDenied.agent === "medium"
          && host.errorLines().length === 0;
        s.verdict(ok, `fresh fast -> ${first.after.agent}; resume naming fast -> ${keep.after.agent}; resume naming heavy -> ${up.after.agent}/${up.after.model}; resume naming fast after heavy -> ${down.after.agent}; pinned resume naming fast -> ${pinned.after.agent}/${pinned.after.model}; foreign resume status ${String(foreign.after.status)}; denied resume status ${String(denied.after.status)}`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 400_000);
  it("H9 permissions: enforce with the host's native permission rules (no allow-all) swaps only to agents the session may start", async () => {
    const host = await RoutingHost.start("permissions", { routing: { engine: "enforce" }, seed: SEARCH_SEED });
    try {
      await runScenario("H9-enforce-real-permission-set", "With a root session that only carries `subagent * allow` (so the native `build` agent's own rules decide everything else) the heavy -> fast swap still happens; with `subagent fast` denied for the session the engine does NOT swap to fast (the host would refuse the dispatch): the child runs a permitted agent and no `Subagent denied` error occurs. The host's evaluated permissions of build/fast/heavy/explore are recorded.", async s => {
        const narrow: Rule[] = [{ action: "subagent", resource: "*", effect: "allow" }];
        const open = await host.newRoot("permissions root (subagent allow only)", undefined, undefined, narrow);
        const swapped = await host.dispatch(open, { agent: "heavy", description: "Find usages", prompt: SEARCH_PROMPT, background: false });
        const swappedChild = await host.client.session.get({ sessionID: swapped.childID });
        const closed = await host.newRoot("permissions root (fast denied)", undefined, undefined, [...narrow, { action: "subagent", resource: "fast", effect: "deny" }]);
        const denied = await host.call(closed, "subagent", { agent: "heavy", description: "Find usages, fast denied", prompt: SEARCH_PROMPT, background: false });
        const deniedChild = denied.childID === undefined ? undefined : await host.client.session.get({ sessionID: denied.childID });
        const records = (await host.client.agent.list()).data.filter(a => ["build", "fast", "medium", "heavy", "explore"].includes(a.id));
        const rows = await host.waitForRows("both decision rows", r => r.length >= 2, 70_000);
        s.observed.agentPermissions = records.map(a => ({ id: a.id, mode: a.mode, permissions: a.permissions }));
        s.observed.openSession = { rootID: open, rules: narrow, childID: swapped.childID, hostChild: { agent: swappedChild.agent, model: swappedChild.model ? ref(swappedChild.model) : undefined } };
        s.observed.deniedSession = { rootID: closed, status: denied.after.status, error: denied.after.error, hookInput: { agent: obj(denied.before.input).agent, model: obj(denied.before.input).model }, childID: denied.childID, hostChild: deniedChild && { agent: deniedChild.agent, model: deniedChild.model ? ref(deniedChild.model) : undefined } };
        s.observed.rows = rows.map(r => ({ session: r.sessionID === open ? "open" : "fast-denied", chosen: r.chosen.agent, best: r.best?.agent, switched: r.switched, reason: r.reason.slice(0, 220) }));
        s.observed.hostErrors = host.errorLines();
        s.observed.routerLogLines = host.routerLogLines();
        const deniedRow = rows.find(r => r.sessionID === closed);
        const ok = swappedChild.agent === "fast" && sameModel(swappedChild.model, SONNET, "low")
          && denied.after.status === "completed" && deniedChild !== undefined && deniedChild.agent !== "fast" && obj(denied.before.input).agent !== "fast"
          && deniedRow !== undefined && deniedRow.switched === false && host.errorLines().length === 0 && host.routerLogLines().length === 0;
        s.verdict(ok, `subagent-allow-only session: heavy -> ${swappedChild.agent}/${swappedChild.model ? ref(swappedChild.model) : "?"}; fast-denied session: dispatch ${String(denied.after.status)}, child agent ${String(deniedChild?.agent)}, row switched=${String(deniedRow?.switched)} (${deniedRow?.reason.slice(0, 80)})`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
  it("H7 effort: bare-model resume (R1), the effort options of a resumed child after an agent switch (QA-1.5-22) and a default -> high step (F9) on the Anthropic route", async () => {
    const effortPreset = {
      fast: { ...SMOKE_PRESET.fast, effort: "low" },
      medium: { ...SMOKE_PRESET.medium, effort: "medium" },
      heavy: { ...SMOKE_PRESET.heavy, effort: "xhigh" },
    };
    const host = await RoutingHost.start("effort", { routing: null, overrides: { presets: { smoke: effortPreset } } });
    try {
      await runScenario("H7-effort-r1-qa1522-f9", "Effort-configured tiers (variant AND effort per tier, like the shipped anthropic preset), no routing block: (QA-1.5-22) after a resume that switches the agent fast -> medium -> heavy -> fast the request carries the TARGET agent's effort once and not the previous agent's: on a same-model switch the previous agent's effort stays at the top level and the target's goes in-band (one entry), taking effect only if the provider honours in-band effort; on a model change the top level carries it and nothing is in-band; (R1) a bare-model resume after a variant stores what the host stores and sends what it sends; (F9) a default (bare) start resumed at #high delivers high. All recorded as a table; the verdict asserts the two safety properties that let the runner stop starting fresh (target effort once; effective effort equals the stored variant's).", async s => {
        const rootID = await host.newRoot("effort root");
        type Row = { case: string; asked: string; storedModel: string | undefined; storedAgent: string | undefined; catalogModel: string | undefined; wireModel: string | undefined; topLevelEffort: unknown; thinking: unknown; outputConfig: unknown; inBandAllHistory: unknown[]; effective: unknown };
        const table: Row[] = [];
        const step = async (name: string, call: Obj) => {
          const mark = host.provider.requests.length;
          const d = await host.dispatch(rootID, { description: `H7 ${name}`, background: false, ...call });
          const stored = await host.client.session.get({ sessionID: d.childID });
          for (const r of host.provider.requests.slice(mark).filter(q => q.session === d.childID && q.kind === "primary")) {
            table.push({ case: name, asked: JSON.stringify({ agent: call.agent, model: call.model }), storedModel: stored.model ? ref(stored.model) : undefined, storedAgent: stored.agent, catalogModel: r.catalogModel, wireModel: r.model, topLevelEffort: obj(r.payload.output_config).effort, thinking: r.payload.thinking, outputConfig: r.payload.output_config, inBandAllHistory: inBandEfforts(r), effective: effectiveEffort(r) });
          }
          return d.childID;
        };
        // QA-1.5-22: agent switches on one child (no model named: the host moves the child to the new agent's model)
        const a = await step("A agent switch (fast)", { agent: "fast", prompt: "H7 A start" });
        await step("A agent switch (medium)", { agent: "medium", prompt: "H7 A resume medium", sessionID: a });
        await step("A agent switch (heavy)", { agent: "heavy", prompt: "H7 A resume heavy", sessionID: a });
        await step("A agent switch (back to fast)", { agent: "fast", prompt: "H7 A resume fast", sessionID: a });
        // R1: bare model after a variant, same model and another model
        const sonnet = MODELS.sonnet;
        const r1 = await step("R1 bare model (sonnet#low)", { agent: "general", prompt: "H7 R1 start", model: `${sonnet}#low` });
        await step("R1 bare model (bare sonnet)", { agent: "general", prompt: "H7 R1 resume same model bare", sessionID: r1, model: sonnet });
        const r1b = await step("R1b bare other model (sonnet#low)", { agent: "general", prompt: "H7 R1b start", model: `${sonnet}#low` });
        await step("R1b bare other model (bare opus)", { agent: "general", prompt: "H7 R1b resume other model bare", sessionID: r1b, model: MODELS.opus });
        // F9: default (bare) start, then #high
        const f9 = await step("F9 default then high (bare)", { agent: "general", prompt: "H7 F9 start", model: sonnet });
        await step("F9 default then high (high)", { agent: "general", prompt: "H7 F9 resume", sessionID: f9, model: `${sonnet}#high` });
        s.observed.table = table;
        s.observed.agentRecords = (await host.client.agent.list()).data.filter(x => ["fast", "medium", "heavy"].includes(x.id)).map(x => ({ id: x.id, model: x.model }));
        s.observed.providerErrors = host.provider.errors;
        s.observed.hostErrors = host.errorLines();
        const rowsOf = (name: string) => table.filter(r => r.case.startsWith(name));
        const A = rowsOf("A agent switch");
        const R1 = rowsOf("R1 bare");
        const R1b = rowsOf("R1b");
        const F9 = rowsOf("F9");
        s.observed.derived = {
          agentSwitchEffective: A.map(r => ({ agent: r.storedAgent, stored: r.storedModel, topLevel: r.topLevelEffort, inBand: r.inBandAllHistory, thinking: r.thinking, effective: r.effective })),
          bareSameModelAfterVariant: R1.map(r => ({ stored: r.storedModel, topLevel: r.topLevelEffort, inBand: r.inBandAllHistory, effective: r.effective })),
          bareOtherModelAfterVariant: R1b.map(r => ({ stored: r.storedModel, wireModel: r.wireModel, topLevel: r.topLevelEffort, inBand: r.inBandAllHistory, effective: r.effective })),
          defaultThenHigh: F9.map(r => ({ stored: r.storedModel, topLevel: r.topLevelEffort, thinking: r.thinking, inBand: r.inBandAllHistory, effective: r.effective })),
        };
        const stored = (r: Row) => r.storedModel?.split("#")[1];
        // The two properties the runner needs: the effective effort of every agent-switch request is the TARGET tier's configured effort (low, medium, xhigh, low) and the in-band list never grows past one entry per change.
        const targetEfforts = ["low", "medium", "xhigh", "low"];
        const effortOk = A.length === 4 && A.every((r, i) => r.effective === targetEfforts[i] || (r.effective === stored(r) && stored(r) === targetEfforts[i]))
          // the in-band list: nothing on the first request and on the two model changes, exactly one entry (the target's) on the same-model switch
          && A.map(r => r.inBandAllHistory.join(",")).join("|") === "|medium||" && A.map(r => String(r.topLevelEffort)).join() === "low,low,xhigh,low";
        s.verdict(effortOk && host.errorLines().length === 0 && host.provider.errors.length === 0, `agent switch effective efforts ${A.map(r => String(r.effective)).join("->")} (stored ${A.map(stored).join("->")}); bare sonnet after #low: stored ${R1.map(stored).join("->")} effective ${R1.map(r => String(r.effective)).join("->")}; bare opus after sonnet#low: stored ${R1b.map(stored).join("->")} effective ${R1b.map(r => String(r.effective)).join("->")}; default->high effective ${F9.map(r => String(r.effective)).join("->")}`);
      });

      // QA-1.5-22, distinguishing: the tier's `effort` differs from its `variant`, so the wire shows which of the two the request follows.
      const distinct = await RoutingHost.start("effort-distinct", { routing: null, overrides: { presets: { smoke: {
        fast: { ...SMOKE_PRESET.fast, effort: "low" },
        medium: { ...SMOKE_PRESET.medium, variant: "medium", effort: "xhigh" },
        heavy: { ...SMOKE_PRESET.heavy, effort: "xhigh" },
      } } } });
      try {
        await runScenario("H7b-effort-option-vs-variant", "MEASUREMENT (the verdict asserts only that the three requests were observed): with medium configured as variant=medium but effort=xhigh, a child started on fast and resumed on medium: the wire shows whether the request follows the agent's effort OPTION (xhigh) or the stored VARIANT (medium), and that the previous agent's option (low) is not carried.", async s => {
          const rootID = await distinct.newRoot("effort root distinct");
          const rows: Obj[] = [];
          const step = async (name: string, call: Obj) => {
            const mark = distinct.provider.requests.length;
            const d = await distinct.dispatch(rootID, { description: `H7b ${name}`, background: false, ...call });
            const stored = await distinct.client.session.get({ sessionID: d.childID });
            for (const r of distinct.provider.requests.slice(mark).filter(q => q.session === d.childID && q.kind === "primary")) {
              rows.push({ case: name, storedAgent: stored.agent, storedModel: stored.model ? ref(stored.model) : undefined, catalogModel: r.catalogModel, topLevelEffort: obj(r.payload.output_config).effort, outputConfig: r.payload.output_config, thinking: r.payload.thinking, inBand: inBandEfforts(r), effective: effectiveEffort(r), options: Object.keys(r.payload).filter(k => !["model", "max_tokens", "stream", "thinking", "output_config", "metadata", "temperature"].includes(k)) });
            }
            return d.childID;
          };
          const child = await step("fast start", { agent: "fast", prompt: "H7b start" });
          await step("resume on medium", { agent: "medium", prompt: "H7b resume", sessionID: child });
          const control = await step("fresh medium (control)", { agent: "medium", prompt: "H7b fresh medium" });
          s.observed.rows = rows;
          s.observed.controlChild = control;
          s.observed.providerErrors = distinct.provider.errors;
          const [first, resumed, fresh] = rows;
          const followsVariant = resumed?.effective === "medium" && fresh?.effective === "xhigh" ? "resumed request follows the stored variant (medium) while a FRESH medium child follows the agent's effort option (xhigh)" : `resumed effective ${String(resumed?.effective)}, fresh medium effective ${String(fresh?.effective)}`;
          s.observed.reading = followsVariant;
          s.verdict(first !== undefined && resumed !== undefined && fresh !== undefined && distinct.errorLines().length === 0, `fast start effective ${String(first?.effective)}; resumed on medium effective ${String(resumed?.effective)} (top-level ${String(resumed?.topLevelEffort)}, in-band ${JSON.stringify(resumed?.inBand)}); fresh medium effective ${String(fresh?.effective)}; ${followsVariant}`);
        });
      } finally {
        expect((await distinct.stop()).hostPortClosed).toBe(true);
      }
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 400_000);
  it("H8 notice and annotate-plan: the cost-doctor notice reaches a real orchestrator as one synthetic entry; /annotate-plan hands the model route lines with a live engine", async () => {
    const host = await RoutingHost.start("notice", {
      routing: { engine: "advise" },
      providers: { smallless: { name: "Smallless", package: "@opencode/ai/providers/anthropic", settings: { baseURL: "$BASE_URL", apiKey: "keyless-smoke-fake" }, models: { "big-1": { name: "Big One", limit: { context: 200_000, output: 8_000 } } } } },
    });
    try {
      await runScenario("H8a-advisor-notice-synthetic-entry", "In advise, a saving finding (title-model-unset, session on a provider without a small model) is delivered to the orchestrator as ONE synthetic transcript entry (resume:false, so it starts no turn), once, not repeated on later turns; the router's notice state file appears in the outcomes directory. Not exercised: a restart keeping the notice state (the file is keyed by the project path hash and each isolated host has a fresh path).", async s => {
        const rootID = await host.newRoot("notice root", { providerID: "smallless", id: "big-1" });
        const snapshots: Obj[] = [];
        for (const turn of ["turn one", "turn two", "turn three", "turn four"]) {
          await host.prompt(rootID, turn);
          await new Promise(resolve => setTimeout(resolve, 1_000)); // the notice is handed over off the hot path
          const messages = await host.client.session.context({ sessionID: rootID });
          snapshots.push({ turn, types: messages.map(m => String(m.type)) });
        }
        const messages = await host.client.session.context({ sessionID: rootID });
        const notices = messages.map((m, index) => ({ index, type: String(m.type), text: String(m.text ?? ""), description: m.description, metadata: m.metadata })).filter(m => m.type === "synthetic" && /Cost doctor notice/.test(m.text));
        const listing = await host.storeListing();
        s.observed.typesAfterEachTurn = snapshots;
        s.observed.notices = notices.map(n => ({ index: n.index, description: n.description, text: n.text.slice(0, 700) }));
        s.observed.allTypes = messages.map((m, index) => `${index}:${String(m.type)}`);
        s.observed.storeFiles = listing;
        s.observed.hostErrors = host.errorLines();
        const lastIndex = messages.length - 1;
        // positive control for the live-store check (QA-3.2-R2-7): the file this host wrote is exactly the `noticeFiles()` name of one of its project directories
        const expectedNames = (await host.projectDirs()).map(dir => noticeFiles(dir).state);
        s.observed.noticeNameControl = { projectDirs: (await host.projectDirs()).length, expectedNames, written: listing.filter(f => /^advisor-notice\./.test(f.name)).map(f => f.name) };
        const ok = notices.length === 1 && /title-model-unset|agents\.title\.model|title/.test(notices[0]!.text) && notices[0]!.index < lastIndex && listing.some(f => /^advisor-notice\..+\.json$/.test(f.name) && expectedNames.includes(f.name)) && host.errorLines().length === 0;
        s.verdict(ok, `${notices.length} synthetic cost-doctor entr${notices.length === 1 ? "y" : "ies"} after 4 turns (at index ${notices.map(n => n.index).join(",")} of ${messages.length}); notice state files: ${listing.filter(f => /^advisor-notice/.test(f.name)).map(f => f.name).join(",")}`);
      });
      const plan = ["# Plan", "", "1. Find every usage of parseThing in the repository and list the files.", "2. Implement the retry logic in src/client.ts with unit tests.", "3. Review the security of the token handling in src/auth.ts.", "", "```bash", "1. this is shell output, not a step", "```", ""].join("\n");
      await writeFile(path.join(host.project, "plan.md"), plan);
      await runScenario("H8b-annotate-plan-live-engine", "With a live engine /annotate-plan hands the model, in the command's own prompt, the exact [route …] lines to insert for each step of the plan file; a numbered line inside a fenced block is not a step and gets none.", async s => {
        const rootID = await host.newRoot("annotate root");
        await host.client.session.command({ sessionID: rootID, name: "annotate-plan", text: "plan.md" });
        await host.settle(rootID);
        const request = host.requestsOf(rootID).find(r => r.kind === "primary");
        const text = request?.lastText ?? "";
        s.observed.promptChars = text.length;
        s.observed.routeLines = text.split(/\r?\n/).filter(l => /\[route /.test(l));
        s.observed.promptHead = text.split(/\r?\n/).slice(0, 8);
        s.observed.promptRouterPart = text.split(/\r?\n/).filter(l => /route|step|fence|code block/i.test(l)).slice(0, 40);
        s.observed.planFileUnchanged = (await readFile(path.join(host.project, "plan.md"), "utf8")) === plan;
        s.observed.hostErrors = host.errorLines();
        const routeLines = text.split(/\r?\n/).filter(l => /^- line \d+ /.test(l) && /\[route class=/.test(l));
        const inserted = routeLines.map(l => /the line "(\[route [^"]*\])"/.exec(l)?.[1] ?? "");
        s.observed.insertedRouteLines = inserted;
        const ok = routeLines.length === 3 && /3 steps found/.test(text) && /class=recon/.test(inserted[0] ?? "") && /class=implement/.test(inserted[1] ?? "") && /class=design .*pin\]$/.test(inserted[2] ?? "") && !routeLines.some(l => /shell output/.test(l)) && s.observed.planFileUnchanged === true && host.errorLines().length === 0;
        s.verdict(ok, `${routeLines.length} step(s) annotated in the command prompt: ${inserted.join(" | ")}; the plan file is not written by the hook: ${String(s.observed.planFileUnchanged)}`);
      });
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 400_000);
  it("8 live store and live config: nothing of this run reached the user's outcomes store or OpenCode config", async () => {
    await runScenario("8-live-store-untouched", "The user's live outcomes store (<tmpdir>/opencode-model-router-trajectory) and OpenCode config (~/.config/opencode) are read only here. Every isolated host used its own HOME/TEMP and a temp outcomes path, so the only growth of the live store comes from the user's own running host: new files are `ses_` scorecards (or the live host's own files), and no row appended to the live decisions.jsonl and no `ses_<id>.scorecard.log` it gained or grew names a session of this run (ids from every host's own session.created events), and no `advisor-notice.<hash>` file it gained or changed is the hash of a project directory of this run (`noticeFiles()`). The user's config files are unchanged.", async s => {
      const before = liveBefore!;
      const after = { store: await listDir(LIVE_STORE), config: await listDir(LIVE_CONFIG) };
      const added = Object.keys(after.store).filter(n => !(n in before.store));
      const removed = Object.keys(before.store).filter(n => !(n in after.store));
      const grown = Object.keys(after.store).filter(n => n in before.store && after.store[n]!.size !== before.store[n]!.size);
      const addedNonSession = added.filter(n => !/^ses_/.test(n));
      // rows appended to the live decisions.jsonl since the snapshot: none may belong to a session of this run
      let appended = 0;
      let foreignRows = 0;
      const decisions = after.store["decisions.jsonl"];
      if (decisions && before.store["decisions.jsonl"] && decisions.size > before.store["decisions.jsonl"].size) {
        const handle = await open(path.join(LIVE_STORE, "decisions.jsonl"), "r");
        try {
          const length = decisions.size - before.store["decisions.jsonl"].size;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, before.store["decisions.jsonl"].size);
          for (const line of buffer.toString("utf8").split(/\r?\n/).filter(Boolean)) {
            appended += 1;
            try { if (seenSessionIDs.has(String(JSON.parse(line).sessionID))) foreignRows += 1; } catch { /* a partial last line */ }
          }
        } finally { await handle.close(); }
      }
      // QA-3.2-2: a `ses_<id>.scorecard.log` the live store gained or grew must not be named after a session this run created (ids come from every host's own session.created events)
      const scorecardIds = [...added, ...grown].filter(n => /^ses_.+\.scorecard\.log$/.test(n)).map(n => n.replace(/\.scorecard\.log$/, ""));
      const scorecardsNamingRun = scorecardIds.filter(id => seenSessionIDs.has(id));
      // QA-3.2-R2-7: an `advisor-notice.<hash>.json` (or `.lock`) the live store gained or changed must not be the one of a project directory of this run: the name is the hash of the project path (`noticeFiles`)
      const runNoticeNames = new Set([...seenProjectDirs].flatMap(dir => { const names = noticeFiles(dir); return [names.state, names.lock]; }));
      const noticeAddedOrChanged = [...added, ...grown].filter(n => /^advisor-notice\..+\.(json|lock)$/.test(n));
      const noticesNamingRun = noticeAddedOrChanged.filter(n => runNoticeNames.has(n));
      const configChanged = Object.keys(after.config).filter(n => !(n in before.config) || after.config[n]!.size !== before.config[n]!.size || after.config[n]!.mtimeMs !== before.config[n]!.mtimeMs);
      const routerFiles = ["opencode.json", "opencode-model-router.overrides.jsonc", "opencode-model-router.state.json"].filter(n => n in before.config || n in after.config);
      s.observed.snapshotTakenAt = before.at;
      s.observed.liveStore = { dir: "<tmpdir>/opencode-model-router-trajectory", filesBefore: Object.keys(before.store).length, filesAfter: Object.keys(after.store).length, bytesBefore: Object.values(before.store).reduce((n, f) => n + f.size, 0), bytesAfter: Object.values(after.store).reduce((n, f) => n + f.size, 0), added: added.length, addedNonSession, removed, grownFiles: grown.filter(n => !/^ses_/.test(n)), grownSessionFiles: grown.filter(n => /^ses_/.test(n)).length };
      s.observed.liveNoticeFiles = { addedOrChanged: noticeAddedOrChanged.length, namingAProjectOfThisRun: noticesNamingRun.length, projectDirsOfThisRunChecked: seenProjectDirs.size };
      s.observed.liveScorecards = { addedOrGrown: scorecardIds.length, namingASessionOfThisRun: scorecardsNamingRun.length };
      s.observed.liveDecisionsLog = { appendedRows: appended, rowsNamingASessionOfThisRun: foreignRows, sessionsOfThisRunSeen: seenSessionIDs.size };
      s.observed.liveConfig = { dir: "~/.config/opencode", fileCount: Object.keys(after.config).length, changedSinceSnapshot: configChanged, routerFilesUnchanged: routerFiles.filter(n => !configChanged.includes(n)) };
      const ok = foreignRows === 0 && scorecardsNamingRun.length === 0 && noticesNamingRun.length === 0 && seenProjectDirs.size > 0 && seenSessionIDs.size > 0 && routerFiles.every(n => !configChanged.includes(n));
      s.verdict(ok, `live store ${Object.keys(before.store).length} -> ${Object.keys(after.store).length} files (+${added.length} new, ${added.length - addedNonSession.length} of them ses_ scorecards, non-ses_ new: ${addedNonSession.join(",") || "none"}); ${appended} row(s) appended to the live decisions.jsonl, ${foreignRows} naming a session of this run, ${scorecardIds.length} scorecard(s) added or grown, ${scorecardsNamingRun.length} naming one (${seenSessionIDs.size} sessions of this run seen); ${noticeAddedOrChanged.length} notice file(s) added or changed, ${noticesNamingRun.length} named after one of the ${seenProjectDirs.size} project directories of this run; config files changed: ${configChanged.join(",") || "none"}`);
    });
  }, 120_000);
});
