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
});

void str;
void MODELS;
