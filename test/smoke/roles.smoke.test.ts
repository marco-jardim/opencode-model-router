/** Issue #84, plan P3.1 T3.1.1: the role invariants (plan §2.8 I2, I3, I4, I5, I9), the authority ladder, `router_run`, role budgets,
 * outcome signals and exploration, proven on a REAL, isolated OpenCode v2 host with scripted providers.
 *
 *   RUN_OC_SMOKE_ROLES=1 [OPENCODE_V2_BIN=<abs path to opencode 2>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/roles.smoke.test.ts
 *
 * - Without RUN_OC_SMOKE_ROLES=1 every test is skipped (the normal `vitest run` excludes test/smoke anyway).
 * - Every test starts its OWN isolated host (helpers/routing-host.ts: allow-listed environment, private HOME, keyless scripted Anthropic
 *   provider, the router loaded from THIS checkout next to the probe plugin) in roles mode (`routing.delegation: "roles"`,
 *   `routing.engine: "enforce"`). BEFORE the host starts, the project becomes a git repository (the main checkout) with a sibling
 *   `git worktree add` (`wt-1`): the router lists the worktrees when it registers the role agents (plugin start) and writes their
 *   `external_directory` rules into the role max policies. `routing.workRoots` holds a glob that covers a worktree created AFTER the
 *   host started. Temp roots use their long (non-8.3) spelling.
 * - The scripted root dispatches role agents with `SPIKE_CALL` / `SPIKE_CALLS` and route lines; a role child follows a
 *   `CHILD_SCRIPT64` (base64, so the router's classifier never sees the script's tool names or paths): it ATTEMPTS every scripted
 *   call, forbidden ones included, and then answers the scripted text.
 * - Assertions are on HOST state only: the provider's wire requests (model, variant, advertised tools), the host's session / agent /
 *   context API, files on disk, the probe's hook and event records, and the decision rows the router wrote into the isolated store.
 *   Every tool-status assertion prints the host's tool error text, so a failure names the refusal.
 * - Observations of each test are written (redacted) to <OMR_SMOKE_REAL_TMPDIR>/omr-roles-smoke/<test>.json; never into the repository.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ROOT, RoutingHost, SMOKE_PRESET, agentWithoutModel, arr, clip, obj, redact, ref, scriptLine, stopAllHosts, str,
  type Dispatched, type HostOptions, type Obj, type ScriptStep,
} from "./helpers/routing-host";
import { SHIPPED_ROLE_SPECS, classifyAction, separationProblem } from "../../src/router/roles";
import type { DecisionRow } from "../../src/routing/outcomes/types";

const RUN = process.env.RUN_OC_SMOKE_ROLES === "1";
const d = RUN ? describe : describe.skip;
afterAll(async () => { await stopAllHosts(); }, 60_000);

// ------------------------------------------------------------------------------------------------------- shared setup ----
/** The smoke temp guard removes the per-run TEMP at the end, so the observations go to the real temp directory it recorded. */
const OUT = path.join(process.env.OMR_SMOKE_REAL_TMPDIR ?? tmpdir(), "omr-roles-smoke");
const TIERS = ["fast", "medium", "heavy"] as const;
type Tier = (typeof TIERS)[number];
/** `provider/model#variant` the provider is told (catalog ref of the http.request hook) → the smoke preset tier it is. */
const TIER_OF_WIRE: Readonly<Record<string, Tier>> = Object.fromEntries(TIERS.map(t => [`${SMOKE_PRESET[t].model}#${SMOKE_PRESET[t].variant}`, t]));
const rankOf = (tier: string | undefined): number => (tier === undefined ? -1 : (TIERS as readonly string[]).indexOf(tier));
const wireTier = (catalogModel: string | undefined): Tier | undefined => (catalogModel === undefined ? undefined : TIER_OF_WIRE[catalogModel]);
/**
 * Like {@link wireTier}, but a variant that is no preset rung (run 3: the grader ran on `anthropic/claude-opus-5-5#default`) maps by
 * MODEL: the highest preset tier on that model (opus → heavy; sonnet → medium, its fast and medium rungs differ only by variant).
 */
function modelTier(catalogModel: string | undefined): Tier | undefined {
  const exact = wireTier(catalogModel);
  if (exact !== undefined || catalogModel === undefined) return exact;
  const model = catalogModel.split("#")[0];
  return [...TIERS].reverse().find(t => SMOKE_PRESET[t].model === model);
}
const maxTier = (a: string, b: string): string => (rankOf(a) >= rankOf(b) ? a : b);
const SPEC = new Map(SHIPPED_ROLE_SPECS.map(s => [s.agent, s] as const));
const norm = (value: unknown): string => String(value).replaceAll("\\", "/").toLowerCase();
const VERIFIED = "[router \u2713 verified: deterministic]";
/** Every way the host or the router refuses a tool call of a role child (catalog absence, router catalog stripping, router execute.before, a permission deny). */
const REFUSAL_RE = /No tool named "[^"]+" is currently available|Tool is not available for this request|\[router\] Refused for role agent|Permission denied/;
const EXECUTE_BEFORE_REFUSAL = /\[router\] Refused for role agent explorer in this dispatch/;

// ---- the repository world: main checkout = the host project, one sibling worktree, an unrelated directory ----
interface World { main: string; wt1: string; other: string; addWorktree(name: string): Promise<string> }
/** Built in HostOptions.prepare, i.e. BEFORE the host (and the router's role-agent registration) starts. */
async function makeWorld(root: string, project: string): Promise<World> {
  const main = project;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd: main, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "main");
  const files: Record<string, string> = {
    "m.txt": "main\n",
    "parser.ts": "export function parse(text: string): string[] {\n  return text.split(' ');\n}\n",
    "package.json": `${JSON.stringify({ name: "roles-smoke-world", version: "1.0.0", private: true, scripts: { "smoke-marker": "node smoke-marker.js" } }, null, 2)}\n`,
    "smoke-marker.js": "require('fs').writeFileSync(require('path').join(process.cwd(), 'smoke-marker.txt'), 'ran\\n');\n",
  };
  for (let i = 0; i < 8; i++) files[`e${i}.txt`] = "main\n";
  // A tracked file the roots test rewrites in wt-1, so `router_git_diff` returns ~64 KiB / 10 000+ lines (above the host's truncation bound).
  files["big.txt"] = `${Array.from({ length: 6000 }, (_, i) => `l${i}`).join("\n")}\n`;
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(main, name), text);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const wt1 = path.join(root, "wt-1");
  git("worktree", "add", "-q", wt1, "-b", "wt-1");
  const other = path.join(root, "other");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "x.txt"), "OTHER_SECRET\n");
  await writeFile(path.join(main, "main-only-dirty.txt"), "dirty\n"); // untracked in the main checkout only
  await writeFile(path.join(wt1, "wt1-only-untracked.txt"), "wt1\n"); // untracked in wt-1 only
  return {
    main, wt1, other,
    addWorktree: async (name: string) => { const dir = path.join(root, name); git("worktree", "add", "-q", dir, "-b", name); return dir; },
  };
}

interface RolesHostOptions {
  readonly routing?: Obj;
  readonly overrides?: Obj;
  readonly probe?: HostOptions["probe"];
  readonly preProbe?: HostOptions["preProbe"];
  readonly agents?: Record<string, Obj>;
}
/**
 * An isolated host in roles mode with engine enforce, its repository world prepared before it starts; `routing.workRoots` covers
 * `<root>\wt-late-*` (worktrees created later), `routing.run` allows `smoke-marker`.
 */
async function startRolesHost(name: string, extra: RolesHostOptions = {}): Promise<{ host: RoutingHost; w: World }> {
  let world: World | undefined;
  const host = await RoutingHost.start(`roles-${name}`, {
    longPaths: true,
    prepare: async ({ root, project }) => { world = await makeWorld(root, project); },
    routing: (root: string) => ({
      engine: "enforce", delegation: "roles",
      workRoots: [path.join(root, "wt-late-*")],
      run: { scripts: ["smoke-marker"], timeoutMs: 120_000 },
      ...extra.routing,
    }),
    ...(extra.overrides ? { overrides: extra.overrides } : {}),
    probe: { lifecycle: true, ...extra.probe },
    ...(extra.preProbe ? { preProbe: extra.preProbe } : {}),
    hostConfig: extra.agents ? { agents: extra.agents } : {},
  });
  if (world === undefined) throw new Error("the repository world was not prepared");
  return { host, w: world };
}
async function save(name: string, observed: Obj): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.json`);
  await writeFile(file, `${JSON.stringify(redact(clip({ test: name, recordedAt: new Date().toISOString(), observed }, 4000)), null, 2)}\n`);
  console.log(`[roles-smoke] observations written to ${file}`);
}
async function finish(host: RoutingHost): Promise<void> {
  const teardown = await host.stop();
  expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
}

// ---- dispatches and what the host recorded about them ----
const rootField = (dir: string): string => `root="${dir}"`;
/** A `subagent` input: the route line first, then the body lines; never a `model` (the router sets it). */
function roleInput(agent: string, description: string, routeFields: string | null, body: readonly string[], extra: Obj = {}): Obj {
  return { agent, description, prompt: [...(routeFields === null ? [] : [`[route ${routeFields}]`]), ...body].join("\n"), background: false, ...extra };
}
interface StateView { tool?: string; status?: string; errorType?: string; errorMessage?: string; text: string; input?: unknown }
interface RequestView { seq: number; catalogModel?: string; tier?: Tier; toolNames: string[]; reply: string }
interface EvaluateView { action?: string; resources: string[]; effectIn?: unknown; effectOut?: unknown }
interface ChildView {
  label: string; callID: string; childID: string; parentStatus?: string; parentText: string;
  agent?: string; title?: string; model?: string; parentID?: string; firstUser: string;
  states: StateView[]; requests: RequestView[]; evaluates: EvaluateView[];
}
const toolParts = (context: Obj[]): Obj[] => context.flatMap(m => arr(obj(m).content).map(obj)).filter(part => part.type === "tool");
function stateOf(part: Obj): StateView {
  const s = obj(part.state);
  const content = typeof s.content === "string" ? s.content : arr(s.content).map(c => str(obj(c).text) ?? "").join("\n");
  const output = s.output === undefined ? "" : typeof s.output === "string" ? s.output : JSON.stringify(s.output);
  const view: StateView = { text: content || output, input: s.input };
  const tool = str(part.tool) ?? str(part.name);
  if (tool !== undefined) view.tool = tool;
  if (str(s.status) !== undefined) view.status = str(s.status);
  if (str(obj(s.error).type) !== undefined) view.errorType = str(obj(s.error).type);
  if (str(obj(s.error).message) !== undefined) view.errorMessage = str(obj(s.error).message);
  return view;
}
/** One line per tool state with the host's error type and message (or the start of its output): every status assertion prints it. */
const describeState = (s: StateView | undefined): string =>
  (s === undefined ? "<no tool state>" : `${s.tool ?? "?"} ${s.status ?? "?"}${s.errorType ? ` [${s.errorType}]` : ""}: ${(s.errorMessage ?? s.text).slice(0, 400)}`);
const describeStates = (states: readonly StateView[]): string => (states.length === 0 ? "<no tool states>" : states.map((s, i) => `#${i} ${describeState(s)}`).join(" | "));
function expectStatuses(states: readonly StateView[], expected: readonly string[], label: string): void {
  expect(states.map(s => s.status), `${label}: ${describeStates(states)}`).toEqual(expected);
}
function expectCompleted(state: StateView | undefined, label: string): void {
  expect(state?.status, `${label}: ${describeState(state)}`).toBe("completed");
}
function expectText(state: StateView | undefined, pattern: RegExp, label: string): void {
  expect(state?.text ?? "", `${label}: ${describeState(state)}`).toMatch(pattern);
}
function expectRefused(state: StateView | undefined, label: string): void {
  expect(state, `${label}: the scripted call was attempted (a tool state exists)`).toBeDefined();
  expect(state!.status, `${label}: ${describeState(state)}`).toBe("error");
  expect(state!.errorMessage ?? "", `${label}: ${describeState(state)}`).toMatch(REFUSAL_RE);
}
/** What the PARENT model was given for one of its tool calls: the tool_result block (by tool_use_id) of its own later provider request. */
function parentView(host: RoutingHost, root: string, callID: string): string {
  for (const r of [...host.requestsOf(root)].reverse()) {
    if (r.kind !== "primary" || !r.toolResult) continue;
    const blocks = r.messages.flatMap(m => arr(m.content).map(obj)).filter(b => b.type === "tool_result" && b.tool_use_id === callID);
    if (blocks.length === 0) continue;
    return blocks.flatMap(b => (typeof b.content === "string" ? [b.content] : arr(b.content).map(c => str(obj(c).text) ?? ""))).join("\n");
  }
  return "";
}
async function viewOf(host: RoutingHost, root: string, call: Dispatched, label: string, since: { states: number; requests: number } = { states: 0, requests: 0 }): Promise<ChildView> {
  const childID = call.childID;
  if (childID === undefined) throw new Error(`${label}: the subagent call named no child (${JSON.stringify(call.after.error ?? call.after.result)})`);
  const session = await host.client.session.get({ sessionID: childID });
  const context = await host.client.session.context({ sessionID: childID });
  const firstUser = context.find(m => obj(m).type === "user" || obj(m).role === "user");
  const evaluates = (await host.events()).filter(e => e.type === "probe.lifecycle" && e.point === "evaluate" && e.sessionID === childID)
    .map(e => ({ action: str(e.action), resources: arr(e.resources).map(String), effectIn: e.effectIn, effectOut: e.effectOut }));
  const output = str(obj(obj(call.after.result).output).output) ?? "";
  const view: ChildView = {
    label, callID: call.callID, childID, parentText: [parentView(host, root, call.callID), output].join("\n"),
    firstUser: firstUser === undefined ? "" : JSON.stringify(firstUser),
    states: toolParts(context).slice(since.states).map(stateOf),
    requests: host.requestsOf(childID).filter(r => r.kind === "primary").slice(since.requests).map(r => {
      const request: RequestView = { seq: r.seq, toolNames: r.toolNames, reply: r.reply };
      if (r.catalogModel !== undefined) request.catalogModel = r.catalogModel;
      const tier = wireTier(r.catalogModel);
      if (tier !== undefined) request.tier = tier;
      return request;
    }),
    evaluates,
  };
  if (call.after.status !== undefined) view.parentStatus = call.after.status;
  if (session.agent !== undefined) view.agent = session.agent;
  if (session.title !== undefined) view.title = session.title;
  if (session.model !== undefined) view.model = ref(session.model);
  if (session.parentID !== undefined) view.parentID = session.parentID;
  return view;
}
async function runChild(host: RoutingHost, root: string, input: Obj, label: string): Promise<ChildView> {
  return viewOf(host, root, await host.dispatch(root, input), label);
}
/** Resumes `childID` (same session) from `root`; the view holds only what the resume added (tool states, provider requests). */
async function resumeChild(host: RoutingHost, root: string, childID: string, input: Obj, label: string): Promise<ChildView> {
  const since = {
    states: toolParts(await host.client.session.context({ sessionID: childID })).length,
    requests: host.requestsOf(childID).filter(r => r.kind === "primary").length,
  };
  return viewOf(host, root, await host.call(root, "subagent", { ...input, sessionID: childID }), label, since);
}
const titleNonce = (title: string | undefined): string | undefined => /\[nonce ([A-Za-z0-9_-]+)\]$/.exec(title ?? "")?.[1];
const promptNonce = (text: string): string | undefined => [...text.matchAll(/OMR_NONCE=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
/** The `external_directory` rules of a role agent's host record (the max policy the router registered). */
async function externalDirectoryRules(host: RoutingHost, agent: string): Promise<Obj[]> {
  const record = (await host.client.agent.list()).data.find(a => a.id === agent);
  return arr(record?.permissions).map(obj).filter(r => r.action === "external_directory");
}

// ---- the isolated decision log ----
const isNote = (r: DecisionRow): boolean => r.reason.startsWith("note:");
const bindingNote = (rows: readonly DecisionRow[], child: string): DecisionRow | undefined => rows.find(r => r.childSessionID === child && r.reason.startsWith("note:binding:"));
/** The fresh dispatch row of a child: the row that shares the decision id of the child's binding note (fresh rows know no child). */
function dispatchRowOf(rows: readonly DecisionRow[], child: string): DecisionRow | undefined {
  const note = bindingNote(rows, child);
  return note === undefined ? undefined : rows.find(r => r.decisionID === note.decisionID && !isNote(r));
}
const resumeRowsOf = (rows: readonly DecisionRow[], child: string): DecisionRow[] => rows.filter(r => r.resume && r.childSessionID === child && !isNote(r));
const signalRows = (rows: readonly DecisionRow[]): DecisionRow[] => rows.filter(r => r.reason.startsWith("note:signal:"));
const unknownBindings = (rows: readonly DecisionRow[]): (string | null)[] => rows.filter(r => r.reason === "note:binding:unknown").map(r => r.childSessionID);
/** Waits (the persister flushes at most every 30 s) until `predicate` holds; on a timeout returns what is there so the assertions say what is missing. */
async function waitRows(host: RoutingHost, label: string, predicate: (rows: DecisionRow[]) => boolean, timeoutMs = 90_000): Promise<DecisionRow[]> {
  return host.waitForRows(label, predicate, timeoutMs).catch(() => host.decisionRows());
}
const everyBound = (children: readonly string[]) => (rows: DecisionRow[]): boolean => children.every(c => dispatchRowOf(rows, c) !== undefined);
const rowView = (r: DecisionRow | undefined) => (r === undefined ? undefined : {
  decisionID: r.decisionID, reason: r.reason, role: r.role, tier: r.tier, grant: r.grant, binding: r.binding, boundsReasons: r.boundsReasons, detection: r.detection,
  facts: r.facts, resume: r.resume, childSessionID: r.childSessionID, signal: r.signal, explore: r.explore, propensity: r.propensity, pinned: r.pinned, switched: r.switched,
});
const rowLine = (r: DecisionRow | undefined): string => (r === undefined ? "<no row>" : JSON.stringify({ tier: r.tier, reason: r.reason, boundsReasons: r.boundsReasons, switched: r.switched, detection: r.detection }));

// --------------------------------------------------------------------------------------------------------- the tests ----
d("roles mode on the real OpenCode v2 host (issue #84, P3.1)", () => {
  it("I2: per role and class the per-call model is inside [floor, ceiling]; a tier=heavy pin reaches the heavy model; a resume never runs below the running rung; the router raises the tier after a verification FAIL", async () => {
    const { host, w } = await startRolesHost("i2");
    try {
      const root = await host.newRoot("i2 root", undefined, host.project, []);
      // minFloor: the authority floor (plan §2.3) computed from the ROUTE LINE; the classifier can only raise risk/scope, so it is a lower bound.
      const cases: { agent: string; fields: string; minFloor: Tier; task: string }[] = [
        { agent: "explorer", fields: "class=search risk=low scope=single", minFloor: "fast", task: "find where parse is exported" },
        { agent: "explorer", fields: "class=design risk=low scope=single", minFloor: "fast", task: "outline how the modules relate" },
        { agent: "researcher", fields: "class=search risk=low scope=single", minFloor: "fast", task: "look up the split semantics online" },
        { agent: "runner", fields: `class=mechanical risk=low scope=single ${rootField(w.wt1)}`, minFloor: "fast", task: "run the smoke marker script" },
        { agent: "implementer", fields: `class=mechanical risk=low scope=single needs=edit ${rootField(w.wt1)}`, minFloor: "medium", task: "rename one local variable in parser.ts" },
        { agent: "implementer", fields: `class=implement risk=high scope=single needs=edit ${rootField(w.wt1)}`, minFloor: "heavy", task: "rework the tokenizer of parser.ts" },
        { agent: "reviewer", fields: "class=review risk=low scope=single", minFloor: "heavy", task: "review parser.ts for defects" },
        { agent: "architect", fields: "class=search risk=low scope=single", minFloor: "medium", task: "find the module boundaries" },
        { agent: "architect", fields: "class=design risk=low scope=single", minFloor: "medium", task: "propose a structure for the parser" },
        { agent: "general", fields: "class=search risk=low scope=single", minFloor: "fast", task: "find the callers of parse" },
        { agent: "general", fields: `class=implement risk=low scope=single needs=edit,shell ${rootField(w.wt1)}`, minFloor: "heavy", task: "change parse and run the checks" },
      ];
      const views: { c: (typeof cases)[number]; v: ChildView }[] = [];
      for (const [i, c] of cases.entries()) {
        const label = `I2 ${c.agent} ${i}`;
        views.push({ c, v: await runChild(host, root, roleInput(c.agent, label, c.fields, [`TASK: ${c.task}`]), label) });
      }
      // Pin, then a resume that asks for fast: the running rung (heavy) is kept.
      const pinned = await runChild(host, root, roleInput("implementer", "I2 pin heavy", `class=implement risk=low scope=single needs=edit tier=heavy pin ${rootField(w.wt1)}`, ["TASK: rename the parse helper"]), "pin heavy");
      const keptRung = await resumeChild(host, root, pinned.childID, roleInput("implementer", "I2 pin heavy resume", `class=mechanical risk=low scope=single needs=edit tier=fast ${rootField(w.wt1)}`, ["TASK: continue"]), "resume asks for fast");
      // A verification FAIL (deterministic fileExists on a file that never exists), then a resume WITHOUT tier=: the router raises the floor itself.
      // The fresh dispatch is pinned to fast (honoured inside [fast, medium]): unpinned, the enforce kernel may already pick medium, the
      // explorer's ceiling, and a raise above the ceiling cannot be observed (run 1: the unpinned dispatch went out on medium).
      const absent = path.join(host.project, "i2-never-created.txt");
      const failed = await runChild(host, root, roleInput("explorer", "I2 fail then raise", "class=search risk=low scope=single tier=fast", ["TASK: find where parse is exported", "[acceptance]", `check: fileExists path=${absent}`, "[/acceptance]"]), "verification FAIL");
      const raised = await resumeChild(host, root, failed.childID, roleInput("explorer", "I2 fail then raise resume", "class=search risk=low scope=single", ["TASK: address the findings and finish"]), "resume after FAIL");
      const children = [...views.map(x => x.v.childID), pinned.childID, failed.childID];
      const rows = await waitRows(host, "I2 rows", rs => everyBound(children)(rs) && resumeRowsOf(rs, pinned.childID).length > 0 && resumeRowsOf(rs, failed.childID).length > 0);
      await save("I2", {
        cases: views.map(({ c, v }) => ({ ...c, child: v.agent, requests: v.requests, row: rowView(dispatchRowOf(rows, v.childID)), binding: bindingNote(rows, v.childID)?.binding })),
        pinned: { requests: pinned.requests, row: rowView(dispatchRowOf(rows, pinned.childID)) }, keptRung: { childID: keptRung.childID, requests: keptRung.requests, rows: resumeRowsOf(rows, pinned.childID).map(rowView) },
        failed: { requests: failed.requests, parentText: failed.parentText, row: rowView(dispatchRowOf(rows, failed.childID)) }, raised: { childID: raised.childID, requests: raised.requests, rows: resumeRowsOf(rows, failed.childID).map(rowView) },
        unknownBindings: unknownBindings(rows), routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      for (const { c, v } of views) {
        const spec = SPEC.get(c.agent)!;
        const floor = maxTier(spec.tierRange.floor, c.minFloor);
        const row = dispatchRowOf(rows, v.childID);
        expect(v.agent, v.label).toBe(c.agent);
        expect(v.requests.length, `${v.label}: the child reached the provider`).toBeGreaterThan(0);
        for (const r of v.requests) {
          expect(r.tier, `${v.label}: the wire model ${r.catalogModel} is a preset tier`).toBeDefined();
          expect(rankOf(r.tier), `${v.label}: ${r.catalogModel} >= floor ${floor}; row ${rowLine(row)}`).toBeGreaterThanOrEqual(rankOf(floor));
          expect(rankOf(r.tier), `${v.label}: ${r.catalogModel} <= ceiling ${spec.tierRange.ceiling}; row ${rowLine(row)}`).toBeLessThanOrEqual(rankOf(spec.tierRange.ceiling));
        }
        expect(row, `${v.label}: a dispatch row joined by the child's binding note`).toBeDefined();
        expect(row!.role, v.label).toBe(c.agent);
        expect(row!.tier, `${v.label}: the row's tier is the tier that reached the provider`).toBe(v.requests[0]!.tier);
        expect(bindingNote(rows, v.childID)?.binding, v.label).toBe("exact");
        expect(separationProblem(row!.grant ?? []), `${v.label}: the dispatch grant (I4)`).toBeUndefined();
      }
      // tier=heavy pin: the heavy model reaches the provider; the resume asking for fast stays on the running rung (heavy).
      expect(pinned.requests.map(r => r.tier), `pin: ${rowLine(dispatchRowOf(rows, pinned.childID))}`).toEqual(["heavy"]);
      expect(keptRung.childID).toBe(pinned.childID);
      expect(keptRung.requests.length).toBeGreaterThan(0);
      for (const r of keptRung.requests) expect(r.tier, `resume below the running rung: ${r.catalogModel}`).toBe("heavy");
      expect(resumeRowsOf(rows, pinned.childID).map(r => r.tier)).toContain("heavy");
      // Verification FAIL at fast, the parent told the router raises it; the resumed child runs on medium (raise-only floor).
      expect(failed.requests[0]?.tier, `fresh FAIL dispatch pinned to fast: ${rowLine(dispatchRowOf(rows, failed.childID))}`).toBe("fast");
      expect(failed.parentText).toContain("NOT ACCEPTED");
      expect(failed.parentText).toMatch(/the router raises it to medium/);
      expect(raised.childID).toBe(failed.childID);
      expect(raised.requests.length).toBeGreaterThan(0);
      for (const r of raised.requests) expect(r.tier, `resume after FAIL: ${r.catalogModel}; ${resumeRowsOf(rows, failed.childID).map(rowLine).join(" ")}`).toBe("medium");
      expect(resumeRowsOf(rows, failed.childID).map(r => r.tier)).toContain("medium");
      // zero unknown bindings in normal dispatches
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.errorLines()).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("I3 + I4: forbidden calls ATTEMPTED by role children are refused or absent under a parent without grants AND under an allow-all parent; files on disk unchanged; router_run refuses a foreign cwd; shipped grants never mix local/exec/write with egress", async () => {
    const { host, w } = await startRolesHost("i3", { agents: { "smoke-control": agentWithoutModel({ description: "non-role control agent (host defaults)" }) } });
    try {
      const forbidden = (label: string): ScriptStep[] => [
        { tool: "edit", input: { path: path.join(w.wt1, "e0.txt"), oldString: "main", newString: "edited" } }, // 0 edit by explorer
        { tool: "execute", input: { code: `return await tools.opencode.session_rename({ title: 'I3 renamed by execute ${label}' })` } }, // 1 Code Mode
        { tool: "subagent", input: { agent: "explorer", description: `I3 nested ${label}`, prompt: "nested" } }, // 2 subagent
        { tool: "shell", input: { command: `node -e "require('fs').writeFileSync('shell-${label}.txt','x')"`, description: "smoke shell attempt" } }, // 3 shell
        { tool: "read", input: { path: path.join(w.other, "x.txt") } }, // 4 outside the repository
        { tool: "read", input: { path: path.join(host.project, "m.txt") } }, // 5 the main checkout is not this dispatch's work root
        { tool: "router_run", input: { script: "smoke-marker", cwd: w.wt1 } }, // 6 exec is not in the explorer's grant
        { tool: "read", input: { path: path.join(w.wt1, "m.txt") } }, // 7 control: inside the work root
      ];
      const runnerSteps: ScriptStep[] = [
        { tool: "router_run", input: { script: "smoke-marker", cwd: host.project } }, // foreign cwd
        { tool: "router_run", input: { script: "smoke-marker", cwd: w.wt1 } }, // its own work root
      ];
      const researcherSteps: ScriptStep[] = [
        { tool: "read", input: { path: path.join(host.project, "m.txt") } },
        { tool: "glob", input: { pattern: "*.txt", path: host.project } },
        { tool: "edit", input: { path: path.join(host.project, "e1.txt"), oldString: "main", newString: "edited" } },
      ];
      const implementerSteps: ScriptStep[] = [
        { tool: "webfetch", input: { url: "https://example.com/", format: "text" } },
        { tool: "websearch", input: { query: "opencode roles" } },
        { tool: "execute", input: { code: "return 1" } },
      ];
      const perParent: {
        parent: "none" | "allow-all"; explorer: ChildView; runner: ChildView; researcher: ChildView; implementer: ChildView;
        grandchildren: string[]; titleAfter: string | undefined; secretReachedProvider: boolean;
        disk: { e0: string; e1Main: string; shellRan: boolean; wt1Marker: boolean; mainMarker: boolean };
      }[] = [];
      for (const parent of ["none", "allow-all"] as const) {
        const root = await host.newRoot(`i3 root ${parent}`, undefined, host.project, parent === "none" ? [] : undefined);
        const explorer = await runChild(host, root, roleInput("explorer", `I3 explorer ${parent}`, `class=search risk=low scope=single ${rootField(w.wt1)}`, ["TASK: look around the work root", scriptLine(forbidden(parent), "DONE: attempted the scripted calls")]), `I3 explorer (${parent})`);
        const runner = await runChild(host, root, roleInput("runner", `I3 runner ${parent}`, `class=mechanical risk=low scope=single ${rootField(w.wt1)}`, ["TASK: run the smoke marker", scriptLine(runnerSteps, "DONE: ran")]), `I3 runner (${parent})`);
        const researcher = await runChild(host, root, roleInput("researcher", `I3 researcher ${parent}`, "class=search risk=low scope=single", ["TASK: look up the split semantics", scriptLine(researcherSteps, "DONE: attempted")]), `I4 researcher (${parent})`);
        const implementer = await runChild(host, root, roleInput("implementer", `I3 implementer ${parent}`, `class=mechanical risk=low scope=single needs=edit ${rootField(w.wt1)}`, ["TASK: tidy parser.ts", scriptLine(implementerSteps, "DONE: attempted")]), `I4 implementer (${parent})`);
        perParent.push({
          parent, explorer, runner, researcher, implementer,
          grandchildren: (await host.children(explorer.childID)).map(s => s.id),
          titleAfter: (await host.client.session.get({ sessionID: explorer.childID })).title,
          secretReachedProvider: host.requestsOf(explorer.childID).some(r => JSON.stringify(r.messages).includes("OTHER_SECRET")),
          disk: {
            e0: await readFile(path.join(w.wt1, "e0.txt"), "utf8"), e1Main: await readFile(path.join(host.project, "e1.txt"), "utf8"),
            shellRan: existsSync(path.join(host.project, `shell-${parent}.txt`)),
            wt1Marker: existsSync(path.join(w.wt1, "smoke-marker.txt")), mainMarker: existsSync(path.join(host.project, "smoke-marker.txt")),
          },
        });
        await rm(path.join(w.wt1, "smoke-marker.txt"), { force: true }); // the next parent's run must create it again
      }
      // Control (non-role host agent under an allow-all parent): the same shell and execute inputs DO run, so the refusals above are not input errors.
      const controlRoot = await host.newRoot("i3 control root", undefined, host.project, undefined);
      const control = await runChild(host, controlRoot, roleInput("smoke-control", "I3 control", "class=mechanical risk=low scope=single pin", ["TASK: run the scripted calls", scriptLine([
        { tool: "shell", input: { command: "node -e \"require('fs').writeFileSync('shell-control.txt','x')\"", description: "smoke shell control" } },
        { tool: "execute", input: { code: "return await tools.opencode.session_rename({ title: 'I3 control renamed by execute' })" } },
      ], "DONE: control")]), "I3 control");
      const controlTitle = (await host.client.session.get({ sessionID: control.childID })).title;
      // I4 on the host's own agent records: the actions each shipped role is allowed for every resource.
      const records = (await host.client.agent.list()).data.filter(a => SPEC.has(a.id)).map(a => {
        const rules = arr(a.permissions).map(obj);
        const allowed = new Set<string>();
        rules.forEach((r, i) => {
          if (r.effect !== "allow" || r.resource !== "*" || typeof r.action !== "string" || r.action.includes("*")) return;
          if (!rules.slice(i + 1).some(l => l.effect === "deny" && l.resource === "*" && (l.action === r.action || l.action === "*"))) allowed.add(r.action);
        });
        allowed.delete("router_request_authority"); // the ladder tool of dynamic roles is no action class
        const classes = [...allowed].map(action => [action, classifyAction(action)] as const);
        return { agent: a.id, allowed: [...allowed].sort(), classes, problem: separationProblem(allowed) };
      });
      const explorerExternal = await externalDirectoryRules(host, "explorer");
      const children = perParent.flatMap(p => [p.explorer, p.runner, p.researcher, p.implementer].map(v => v.childID));
      const rows = await waitRows(host, "I3 rows", everyBound(children));
      await save("I3-I4", {
        perParent: perParent.map(p => ({ ...p, explorer: { ...p.explorer, toolNames: p.explorer.requests[0]?.toolNames } })),
        control: { agent: control.agent, states: control.states, title: controlTitle, shellControlRan: existsSync(path.join(host.project, "shell-control.txt")) },
        records, explorerExternal, grants: children.map(c => ({ child: c, row: rowView(dispatchRowOf(rows, c)) })),
        unknownBindings: unknownBindings(rows), routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      for (const p of perParent) {
        const at = (label: string) => `${label} (parent: ${p.parent})`;
        // I3 catalog: the explorer is never advertised a forbidden tool.
        for (const name of ["edit", "write", "patch", "apply_patch", "execute", "subagent", "shell", "router_run", "webfetch", "websearch"]) {
          for (const r of p.explorer.requests) expect(r.toolNames, at(`explorer catalog has no ${name}`)).not.toContain(name);
        }
        // I3 refusals: every forbidden call was attempted and refused; the in-root read ran.
        expect(p.explorer.states.length, at(`explorer attempted every scripted call: ${describeStates(p.explorer.states)}`)).toBe(forbidden(p.parent).length);
        ["edit", "execute", "subagent", "shell", "read outside the repository", "read of the main checkout", "router_run"].forEach((label, i) => expectRefused(p.explorer.states[i], at(`explorer ${label}`)));
        expectCompleted(p.explorer.states[7], at(`explorer read inside its work root (registered external_directory rules: ${JSON.stringify(explorerExternal)})`));
        // ... and nothing happened on the host: file unchanged, no shell file, no nested child, title not renamed, the secret never reached the provider.
        expect(p.disk.e0, at("wt-1/e0.txt unchanged")).toBe("main\n");
        expect(p.disk.shellRan, at("shell did not run")).toBe(false);
        expect(p.grandchildren, at("no nested child")).toEqual([]);
        expect(p.titleAfter ?? "", at("execute did not rename the child")).not.toContain("renamed by execute");
        expect(p.secretReachedProvider, at("the outside file's content never reached the provider")).toBe(false);
        // router_run: the foreign cwd is refused by the tool itself (no marker in the main checkout); its own work root runs (exit 0, marker in wt-1).
        expect(p.runner.states.length, at(`runner attempted both runs: ${describeStates(p.runner.states)}`)).toBe(2);
        expectText(p.runner.states[0], /\[router_run\] error: refused: cwd is not this dispatch's work root/, at("router_run foreign cwd"));
        expectText(p.runner.states[1], /\[router_run\] package\.json script "smoke-marker": exit code: 0/, at("router_run own work root"));
        expect(p.disk.mainMarker, at("no marker in the main checkout")).toBe(false);
        expect(p.disk.wt1Marker, at("marker in wt-1")).toBe(true);
        // I4 catalogs: the researcher has no local/exec/write tool; the implementer no egress tool; each forbidden call refused.
        for (const r of p.researcher.requests) {
          for (const name of ["read", "glob", "grep", "list", "edit", "write", "router_run", "router_git_status", "router_git_diff", "execute", "shell"]) expect(r.toolNames, at(`researcher catalog has no ${name}`)).not.toContain(name);
        }
        for (const r of p.implementer.requests) {
          for (const name of ["webfetch", "websearch", "execute", "shell"]) expect(r.toolNames, at(`implementer catalog has no ${name}`)).not.toContain(name);
          expect(r.toolNames, at("implementer catalog has edit")).toContain("edit");
        }
        ["read", "glob", "edit"].forEach((label, i) => expectRefused(p.researcher.states[i], at(`researcher ${label}`)));
        ["webfetch", "websearch", "execute"].forEach((label, i) => expectRefused(p.implementer.states[i], at(`implementer ${label}`)));
        expect(p.disk.e1Main, at("main e1.txt unchanged")).toBe("main\n");
      }
      // The control proves the attempted inputs are well-formed: the same shell and execute calls run for a non-role agent.
      expect(control.agent).toBe("smoke-control");
      expectStatuses(control.states, ["completed", "completed"], "control (non-role agent)");
      expect(existsSync(path.join(host.project, "shell-control.txt"))).toBe(true);
      expect(controlTitle).toBe("I3 control renamed by execute");
      // I4: every shipped role registered on the host (all seven), none mixing local/exec/write with egress.
      expect(records.map(r => r.agent).sort()).toEqual([...SPEC.keys()].sort());
      for (const r of records) {
        expect(r.allowed.length, `${r.agent}: the host record lists allow rules (non-vacuous check)`).toBeGreaterThan(0);
        expect(r.problem, `${r.agent} allows ${r.allowed.join(", ")}`).toBeUndefined();
      }
      const researcherRecord = records.find(r => r.agent === "researcher")!;
      const implementerRecord = records.find(r => r.agent === "implementer")!;
      expect(researcherRecord.classes.filter(([, cls]) => cls === "local" || cls === "exec" || cls === "write")).toEqual([]);
      expect(implementerRecord.classes.filter(([, cls]) => cls === "egress")).toEqual([]);
      for (const c of children) expect(separationProblem(dispatchRowOf(rows, c)?.grant ?? []), `grant of ${c}`).toBeUndefined();
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("I5 + I9: identical parallel dispatches bind exactly by their own nonces; a child carrying two dispatches' markers is unknown (max ∩ local, external_directory denied); a router context-hook error empties the catalog and annotates the parent", async () => {
    const { host, w } = await startRolesHost("i5", {
      probe: { mixNonce: { descriptionContains: "I5 MIX" } },
      preProbe: { breakSystemTitleContains: "I9 BREAK", routerStackNeedle: path.basename(ROOT).toLowerCase() },
    });
    try {
      const root = await host.newRoot("i5 root", undefined, host.project, []);
      // (1) Two IDENTICAL dispatches in ONE parent turn; their first requests are held until both are in flight.
      host.provider.holdUntilOverlap("I5_HOLD", 2);
      const twin = roleInput("general", "I5 twin", `class=implement risk=low scope=single needs=edit ${rootField(w.wt1)}`, ["TASK: I5_HOLD look at m.txt in the work root", scriptLine([{ tool: "read", input: { path: path.join(w.wt1, "m.txt") } }], "DONE: m.txt:1")]);
      const twinCalls = await host.callMany(root, [twin, twin]);
      const barrier = { arrivals: host.provider.barrier!.arrivals.length, releasedByArrival: host.provider.barrier!.releasedByArrival, timedOut: host.provider.barrier!.timedOut };
      host.provider.barrier = undefined;
      const twins = await Promise.all(twinCalls.map((call, i) => viewOf(host, root, call, `I5 twin ${i}`)));
      // (2) One parent turn with a normal dispatch and one whose prompt nonce line the probe swaps for the other's (after the router's hook).
      const pairSteps = (file: string): ScriptStep[] => [
        { tool: "edit", input: { path: path.join(w.wt1, file), oldString: "main", newString: "edited" } },
        { tool: "read", input: { path: path.join(w.wt1, "m.txt") } },
        { tool: "read", input: { path: path.join(host.project, "m.txt") } },
      ];
      const pairCalls = await host.callMany(root, [
        roleInput("general", "I5 pair", `class=implement risk=low scope=single needs=edit ${rootField(w.wt1)}`, ["TASK: update e2.txt", scriptLine(pairSteps("e2.txt"), "DONE: e2.txt:1")]),
        roleInput("general", "I5 MIX", `class=implement risk=low scope=single needs=edit ${rootField(w.wt1)}`, ["TASK: update e3.txt", scriptLine(pairSteps("e3.txt"), "DONE: e3.txt:1")]),
      ]);
      const pair = await Promise.all(pairCalls.map((call, i) => viewOf(host, root, call, `I5 pair ${i}`)));
      const normal = pair.find(v => !(v.title ?? "").includes("I5 MIX"))!;
      const mixed = pair.find(v => (v.title ?? "").includes("I5 MIX"))!;
      const mixDecision = (await host.events()).find(e => e.type === "probe.decision" && e.decision === "mix-nonce");
      // (3) I9: the pre-probe makes the router's context hook throw on this child's first step.
      const broken = await runChild(host, root, roleInput("explorer", "I9 BREAK context", "class=search risk=low scope=single", ["TASK: read m.txt", scriptLine([{ tool: "read", input: { path: path.join(host.project, "m.txt") } }], "DONE: m.txt:1")]), "I9 context error");
      const preprobe = (await host.events()).filter(e => e.type === "preprobe.decision" && e.sessionID === broken.childID).map(e => e.decision);
      const disk = { e2: await readFile(path.join(w.wt1, "e2.txt"), "utf8"), e3: await readFile(path.join(w.wt1, "e3.txt"), "utf8") };
      const generalExternal = await externalDirectoryRules(host, "general");
      const children = [...twins, normal, mixed, broken].map(v => v.childID);
      const rows = await waitRows(host, "I5 rows", rs => children.every(c => bindingNote(rs, c) !== undefined));
      await save("I5-I9", {
        barrier, twins: twins.map(v => ({ ...v, titleNonce: titleNonce(v.title), promptNonce: promptNonce(v.firstUser), binding: rowView(bindingNote(rows, v.childID)) })),
        normal: { ...normal, binding: rowView(bindingNote(rows, normal.childID)) }, mixed: { ...mixed, titleNonce: titleNonce(mixed.title), promptNonce: promptNonce(mixed.firstUser), binding: rowView(bindingNote(rows, mixed.childID)) },
        mixDecision, broken, preprobe, disk, generalExternal, unknownBindings: unknownBindings(rows),
        routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      // I5 (1): both twins overlapped, each child carries ITS dispatch's nonce in its title and its first message, the two differ, both bind exactly.
      expect(barrier).toEqual({ arrivals: 2, releasedByArrival: true, timedOut: false });
      expect(twins.map(v => v.agent)).toEqual(["general", "general"]);
      for (const v of twins) {
        expect(titleNonce(v.title), `${v.label}: title nonce`).toBeDefined();
        expect(promptNonce(v.firstUser), `${v.label}: the first message carries the title's nonce`).toBe(titleNonce(v.title));
        expect(bindingNote(rows, v.childID)?.binding, v.label).toBe("exact");
        expectStatuses(v.states, ["completed"], `${v.label}: the exact grant reads the work root (registered external_directory rules: ${JSON.stringify(generalExternal)})`);
      }
      expect(titleNonce(twins[0]!.title)).not.toBe(titleNonce(twins[1]!.title));
      expect(new Set(twins.map(v => dispatchRowOf(rows, v.childID)?.decisionID)).size).toBe(2);
      // I5 (2): the probe swapped the mixed child's prompt marker; its title names its own dispatch, its first message another one → unknown.
      expect(mixDecision, "the probe swapped the nonce line").toBeDefined();
      expect(promptNonce(mixed.firstUser)).toBeDefined();
      expect(promptNonce(mixed.firstUser)).not.toBe(titleNonce(mixed.title));
      expect(bindingNote(rows, mixed.childID)?.binding).toBe("unknown");
      expect(bindingNote(rows, normal.childID)?.binding).toBe("exact");
      // I9 unknown binding = role max ∩ local (+ the ladder for the dynamic role): no edit, no router_run; external_directory denied; local inside the session directory still works.
      for (const r of mixed.requests) {
        for (const name of ["edit", "write", "patch", "apply_patch", "router_run", "execute", "subagent", "shell"]) expect(r.toolNames, `unknown binding catalog has no ${name}`).not.toContain(name);
        expect(r.toolNames).toContain("read");
        expect(r.toolNames).toContain("router_request_authority");
      }
      expectRefused(mixed.states[0], "unknown binding: edit");
      expectRefused(mixed.states[1], "unknown binding: read in the sibling worktree (external_directory)");
      expectCompleted(mixed.states[2], "unknown binding: read inside the session directory");
      expect(disk.e3).toBe("main\n");
      // ... while the exact sibling of the same turn edits and reads its work root.
      expect(normal.requests[0]?.toolNames).toContain("edit");
      // Its third call reads the MAIN checkout: outside its work root wt-1, so refused (run 2: by the router's execute.before) — the mirror
      // image of the unknown child, which may read the session directory but not wt-1.
      expectStatuses(normal.states, ["completed", "completed", "error"], "exact sibling of the mixed child");
      expectRefused(normal.states[2], "exact binding: read of the main checkout (outside its work root)");
      expect(normal.states[2]?.errorMessage, describeState(normal.states[2])).toMatch(/outside this dispatch's work root/);
      expect(disk.e2).toBe("edited\n");
      expect(unknownBindings(rows), "the only unknown binding is the mixed child").toEqual([mixed.childID]);
      // I9 hook error: the router's context hook failed for the first step (the pre-probe's trap fired inside the router), the catalog of that step was empty,
      // the call of that step was refused, and the PARENT's result carries the router's annotation.
      expect(preprobe, "the injected error fired inside the router's context hook").toEqual(["armed", "threw-in-router-iteration"]);
      expect(broken.requests[0]?.toolNames, "the failed step's catalog is empty").toEqual([]);
      expect(broken.states[0]?.status, `I9 first call: ${describeState(broken.states[0])}`).toBe("error");
      expect(broken.parentText).toContain(`[router] @explorer had no tools for at least one step`);
      expect(broken.parentText).toContain(broken.childID);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("ladder: general without an edit need → edit refused → router_request_authority → ESCALATE: authority annotation → resume of the SAME session → edit allowed, floor recomputed", async () => {
    const { host, w } = await startRolesHost("ladder");
    try {
      const root = await host.newRoot("ladder root", undefined, host.project, []);
      const target = path.join(w.wt1, "e1.txt");
      const edit: ScriptStep = { tool: "edit", input: { path: target, oldString: "main", newString: "edited" } };
      const first = await runChild(host, root, roleInput("general", "ladder general", `class=search risk=low scope=single ${rootField(w.wt1)}`, [
        "Look at the parser module and report its entry points",
        scriptLine([edit, { tool: "router_request_authority", input: { actions: ["edit"], reason: "the entry points must be written into e1.txt" } }], "ESCALATE: authority\nedit is needed to write the entry points into e1.txt"),
      ]), "ladder fresh");
      const afterFirst = await readFile(target, "utf8");
      const resumed = await resumeChild(host, root, first.childID, { agent: "general", description: "ladder general resume", prompt: ["continue", scriptLine([edit], "DONE: e1.txt:1 edited")].join("\n"), background: false }, "ladder resume");
      const afterResume = await readFile(target, "utf8");
      const generalExternal = await externalDirectoryRules(host, "general");
      const rows = await waitRows(host, "ladder rows", rs => everyBound([first.childID])(rs) && resumeRowsOf(rs, first.childID).length > 0 && signalRows(rs).some(r => r.signal === "authority"));
      const fresh = dispatchRowOf(rows, first.childID);
      const resumeRow = resumeRowsOf(rows, first.childID).at(-1);
      await save("ladder", {
        first, resumed, afterFirst, afterResume, generalExternal, fresh: rowView(fresh), resumeRow: rowView(resumeRow), signals: signalRows(rows).map(rowView),
        unknownBindings: unknownBindings(rows), routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      // The classifier gave the task no edit need: the decision row's facts and grant hold none, the catalog is local + the ladder tool.
      expect(fresh, "the fresh dispatch row").toBeDefined();
      expect(arr(obj(fresh!.facts).needs)).not.toContain("edit");
      expect(fresh!.grant ?? []).not.toContain("edit");
      expect(first.requests[0]?.toolNames).toContain("router_request_authority");
      for (const name of ["edit", "write", "patch", "apply_patch"]) expect(first.requests[0]?.toolNames).not.toContain(name);
      expect(rankOf(first.requests[0]?.tier)).toBeGreaterThanOrEqual(rankOf("fast"));
      // edit refused, the request recorded, the child ESCALATEs, nothing written, the parent annotated.
      expectRefused(first.states[0], "edit before the authority request");
      expectCompleted(first.states[1], "router_request_authority");
      expectText(first.states[1], /Authority request recorded: edit/, "router_request_authority");
      expect(afterFirst).toBe("main\n");
      expect(first.parentText).toContain("[router] @general asked for more authority: edit.");
      expect(first.parentText).toContain(first.childID);
      // The resume of the SAME session: edit is advertised and runs; the floor is recomputed (write without exec, no detection → medium).
      expect(resumed.childID).toBe(first.childID);
      expect(resumed.requests.length).toBeGreaterThan(0);
      expect(resumed.requests[0]?.toolNames).toContain("edit");
      for (const r of resumed.requests) expect(rankOf(r.tier), `resumed on ${r.catalogModel}`).toBeGreaterThanOrEqual(rankOf("medium"));
      expectCompleted(resumed.states[0], `edit after the widening (registered external_directory rules: ${JSON.stringify(generalExternal)})`);
      expect(afterResume).toBe("edited\n");
      expect(resumeRow, "the resume's decision row").toBeDefined();
      expect(resumeRow!.grant).toContain("edit");
      expect(resumeRow!.reason).toContain("authority widened on resume: edit");
      expect(rankOf(resumeRow!.tier)).toBeGreaterThanOrEqual(rankOf("medium"));
      expect(signalRows(rows).filter(r => r.signal === "authority").map(r => r.childSessionID)).toContain(first.childID);
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 600_000);

  it("work roots and host handoffs: path resource formats, execute.before refusals surfaced to the child, glob/grep search roots, own truncated outputs (2.0.24: unreadable, fail closed), router_git_* and router_run in worktrees (one created after start), DF2-F1 fixed", async () => {
    const { host, w } = await startRolesHost("roots");
    try {
      const root = await host.newRoot("roots root", undefined, host.project, []);
      const explorerIn = (dir: string) => `class=search risk=low scope=single ${rootField(dir)}`;
      const explorerExternal = await externalDirectoryRules(host, "explorer");
      // (a) path resource formats (the probe logs every evaluate it receives, with the host's resources).
      const fmtWorktree = await runChild(host, root, roleInput("explorer", "roots read worktree", explorerIn(w.wt1), ["TASK: read m.txt", scriptLine([{ tool: "read", input: { path: path.join(w.wt1, "m.txt") } }], "DONE: m.txt:1")]), "read in the worktree");
      const fmtSession = await runChild(host, root, roleInput("explorer", "roots read session dir", "class=search risk=low scope=single", ["TASK: read m.txt", scriptLine([{ tool: "read", input: { path: path.join(host.project, "m.txt") } }], "DONE: m.txt:1")]), "read in the session directory");
      const fmtEdit = await runChild(host, root, roleInput("implementer", "roots edit worktree", `class=mechanical risk=low scope=single needs=edit ${rootField(w.wt1)}`, ["TASK: update e1.txt", scriptLine([{ tool: "edit", input: { path: path.join(w.wt1, "e1.txt"), oldString: "main", newString: "edited" } }], "DONE: e1.txt:1")]), "edit in the worktree");
      // (b) + (c) search roots, a grep include that leaves the root (only execute.before can see it), the main checkout, router_git_status's bound root.
      const search = await runChild(host, root, roleInput("explorer", "roots search", explorerIn(w.wt1), ["TASK: list the text files", scriptLine([
        { tool: "glob", input: { pattern: "*.txt", path: w.wt1 } }, // 0 inside
        { tool: "glob", input: { pattern: "*.txt", path: w.other } }, // 1 search root outside
        { tool: "glob", input: { pattern: "*.txt" } }, // 2 default search root = the session directory (main checkout)
        { tool: "grep", input: { pattern: "main", path: w.wt1, include: `${w.other.replaceAll("\\", "/")}/*.txt` } }, // 3 include leaves the root
        { tool: "read", input: { path: path.join(host.project, "m.txt") } }, // 4 main checkout
        { tool: "router_git_status", input: {} }, // 5 the bound work root
      ], "DONE: listed")]), "search roots");
      // (d) own truncated output. Run 2: the host's grep caps itself at 100 matches ("Found 100 matches") and nothing was truncated. Now the
      //     child also calls `router_git_diff` on a rewritten tracked file: the router bounds that plugin tool's text at 64 KiB (git-tools.ts
      //     MAX_BYTES), i.e. ~10 000 lines, above the host's tool-output bound in lines and bytes, so the HOST must truncate and save it.
      await writeFile(path.join(w.wt1, "needles.txt"), `${Array.from({ length: 400 }, (_, i) => `needle ${i} ${"x".repeat(1900)}`).join("\n")}\n`);
      await writeFile(path.join(w.wt1, "big.txt"), `${Array.from({ length: 6000 }, (_, i) => `L${i}`).join("\n")}\n`);
      const big = await runChild(host, root, roleInput("explorer", "roots big output", explorerIn(w.wt1), ["TASK: find every needle and show the changes", scriptLine([
        { tool: "grep", input: { pattern: "needle", path: w.wt1 } },
        { tool: "router_git_diff", input: {} },
      ], "DONE: needles.txt:1 big.txt:1")]), "big output");
      const events = await host.events();
      const successTypes = [...new Set(events.filter(e => /tool\.success/.test(e.type)).map(e => e.type))];
      const withPaths = events.filter(e => /^session\.(next\.)?tool\.success(\.\d+)?$/.test(e.type) && arr(obj(e.data).outputPaths).length > 0);
      /** Any event of the big child that carries outputPaths, whatever its type (the plugin stream may name it differently). */
      const anyWithPaths = events.filter(e => obj(e.data).sessionID === big.childID && arr(obj(e.data).outputPaths).length > 0).map(e => ({ type: e.type, outputPaths: obj(e.data).outputPaths }));
      const ownPaths = withPaths.filter(e => obj(e.data).sessionID === big.childID).flatMap(e => arr(obj(e.data).outputPaths).map(String));
      // The saved-output path the host names in the text the CHILD model received (its next provider request's tool_result) or in the tool state.
      const toolResultTexts = host.requestsOf(big.childID).filter(r => r.kind === "primary").flatMap(r => r.messages.flatMap(m => arr(m.content).map(obj)))
        .filter(b => b.type === "tool_result").map(b => (typeof b.content === "string" ? b.content : arr(b.content).map(c => str(obj(c).text) ?? "").join("\n")));
      const savedPaths = [...new Set([...toolResultTexts, ...big.states.map(s => s.text)].flatMap(text => [...text.matchAll(/[A-Za-z]:[\\/][^\s"'<>|*?]*?tool-output[\\/][A-Za-z0-9_.-]+/g)].map(m => m[0])))];
      const outputView = {
        successTypes, anyWithPaths, ownPaths, savedPaths, toolResultLengths: toolResultTexts.map(t => t.length),
        truncationNotices: toolResultTexts.map(t => /truncat/i.exec(t) ? t.slice(Math.max(0, t.search(/truncat/i) - 200), t.search(/truncat/i) + 400) : null).filter(Boolean),
        states: big.states.map(s => ({ tool: s.tool, status: s.status, length: s.text.length, tail: s.text.slice(-400) })),
      };
      // The saved file is named only in the text the child model got: 2.0.24 puts no outputPaths on any event a plugin receives (run 3).
      const savedPath = savedPaths[0] ?? ownPaths[0];
      console.log(`[roles-smoke] OBSERVATION (host 2.0.24): the host truncated a role child's tool output (saved to ${savedPath ?? "<no saved path found>"}) but the plugin event stream carried no outputPaths (tool-success event types: ${successTypes.join(", ") || "<none>"}; events with outputPaths: ${anyWithPaths.length}); the router attributes saved outputs from outputPaths only, so the child's own read is refused (fail closed): role children cannot read their truncated outputs on this host.`);
      const ownRead = savedPath === undefined ? undefined
        : await resumeChild(host, root, big.childID, { agent: "explorer", description: "roots big output resume", prompt: ["continue", scriptLine([{ tool: "read", input: { path: savedPath } }], "DONE: read my saved output")].join("\n"), background: false }, "own output read");
      const foreignRead = savedPath === undefined ? undefined
        : await runChild(host, root, roleInput("explorer", "roots foreign output", explorerIn(w.wt1), ["TASK: read a saved output", scriptLine([{ tool: "read", input: { path: savedPath } }], "DONE: tried")]), "another child's output");
      // (e) worktrees created AFTER the host started: one covered by the `routing.workRoots` glob, one not; router_run in the covered one.
      const late = await w.addWorktree("wt-late-1");
      const uncovered = await w.addWorktree("wt-uncovered-1");
      const lateRead = await runChild(host, root, roleInput("explorer", "roots late read", explorerIn(late), ["TASK: read m.txt", scriptLine([{ tool: "read", input: { path: path.join(late, "m.txt") } }], "DONE: m.txt:1")]), "later worktree (glob)");
      const uncoveredRead = await runChild(host, root, roleInput("explorer", "roots uncovered read", explorerIn(uncovered), ["TASK: read m.txt", scriptLine([{ tool: "read", input: { path: path.join(uncovered, "m.txt") } }], "DONE: m.txt:1")]), "later worktree (no pattern)");
      const lateRun = await runChild(host, root, roleInput("runner", "roots late run", `class=mechanical risk=low scope=single ${rootField(late)}`, ["TASK: run the smoke marker", scriptLine([
        { tool: "router_run", input: { script: "smoke-marker", cwd: late } },
        { tool: "router_run", input: { script: "smoke-marker", cwd: w.wt1 } },
      ], "DONE: exit code 0")]), "router_run in the later worktree");
      // (f) DF2-F1 FIXED (P3.3, `verifyRoot`, merged at 9cfae27): the router's gate verifies a role dispatch in its work root.
      //     - an existing file in the worktree, without `cwd:` and with `cwd: <work root>`: verified, detection deterministic;
      //     - the live DF2-F1 shape: the CHILD writes a new file in its worktree and `fileExists` on it is verified without `cwd:`;
      //     - a `cwd:` OUTSIDE the work root (the main checkout) is refused by the gate (unverifiable) and the dispatch is not
      //       decided as deterministic (routing/wire/dispatch.ts roleGateOutsideWorkRoot).
      const accept = (file: string, cwd?: string) => ["[acceptance]", ...(cwd === undefined ? [] : [`cwd: ${cwd}`]), `check: fileExists path=${file}`, "[/acceptance]"];
      const existing = path.join(w.wt1, "m.txt");
      const df2NoCwd = await runChild(host, root, roleInput("explorer", "DF2-F1 without cwd", explorerIn(w.wt1), ["TASK: confirm that m.txt exists", ...accept(existing)]), "DF2-F1 without cwd");
      const df2WithCwd = await runChild(host, root, roleInput("explorer", "DF2-F1 with cwd", explorerIn(w.wt1), ["TASK: confirm that m.txt exists", ...accept(existing, w.wt1)]), "DF2-F1 with cwd");
      const created = path.join(w.wt1, "df2-live-created.txt");
      const df2Live = await runChild(host, root, roleInput("implementer", "DF2-F1 live shape", `class=mechanical risk=low scope=single needs=edit ${rootField(w.wt1)}`, [
        "TASK: create the throwaway file df2-live-created.txt in the work root",
        scriptLine([{ tool: "write", input: { path: created, content: "created by the role child\n" } }], "DONE: df2-live-created.txt:1 created"),
        ...accept(created),
      ]), "DF2-F1 live shape (child writes, no cwd)");
      const createdOnDisk = existsSync(created);
      const df2Outside = await runChild(host, root, roleInput("explorer", "DF2-F1 cwd outside", explorerIn(w.wt1), ["TASK: confirm that m.txt exists", ...accept(existing, host.project)]), "DF2-F1 cwd outside the work root");
      const disk = {
        wt1E1: await readFile(path.join(w.wt1, "e1.txt"), "utf8"), lateMarker: existsSync(path.join(late, "smoke-marker.txt")),
        wt1Marker: existsSync(path.join(w.wt1, "smoke-marker.txt")), mainMarker: existsSync(path.join(host.project, "smoke-marker.txt")),
      };
      const fresh = [fmtWorktree, fmtSession, fmtEdit, search, big, lateRead, uncoveredRead, lateRun, df2NoCwd, df2WithCwd, df2Live, df2Outside, ...(foreignRead ? [foreignRead] : [])];
      const rows = await waitRows(host, "roots rows", everyBound(fresh.map(v => v.childID)));
      const df2 = (v: ChildView) => ({
        parentText: v.parentText, verified: v.parentText.includes(VERIFIED), notAccepted: v.parentText.includes("NOT ACCEPTED"),
        cwdRefused: v.parentText.includes("is outside this role dispatch's work root"), detection: dispatchRowOf(rows, v.childID)?.detection?.effective,
        row: rowView(dispatchRowOf(rows, v.childID)),
      });
      await save("roots-handoffs", {
        explorerExternal,
        formats: { worktree: fmtWorktree.evaluates, session: fmtSession.evaluates, edit: fmtEdit.evaluates, states: [fmtWorktree, fmtSession, fmtEdit].map(v => v.states) },
        search: search.states, searchEvaluates: search.evaluates, withPaths: withPaths.map(e => ({ type: e.type, data: e.data })), outputView, savedPath,
        big: big.states.map(s => ({ ...s, text: s.text.slice(0, 800) })), ownRead, foreignRead, lateRead, uncoveredRead, lateRun, disk,
        df2NoCwd: df2(df2NoCwd), df2WithCwd: df2(df2WithCwd), df2Live: { ...df2(df2Live), states: df2Live.states, createdOnDisk }, df2Outside: df2(df2Outside),
        bindings: fresh.map(v => ({ label: v.label, binding: bindingNote(rows, v.childID)?.binding })), unknownBindings: unknownBindings(rows),
        routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      // (a) resource formats on the real host: external_directory `<canonical dir>/*` and a canonical absolute read path outside the
      //     Location; a Location-relative read path inside it; an edit outside the Location is canonical absolute.
      const evaluated = (v: ChildView) => JSON.stringify(v.evaluates);
      expectStatuses(fmtWorktree.states, ["completed"], `read in the worktree (registered external_directory rules: ${JSON.stringify(explorerExternal)}; evaluates: ${evaluated(fmtWorktree)})`);
      const extDir = fmtWorktree.evaluates.find(e => e.action === "external_directory");
      expect(extDir?.resources.map(norm), evaluated(fmtWorktree)).toEqual([`${norm(w.wt1)}/*`]);
      expect(fmtWorktree.evaluates.find(e => e.action === "read")?.resources.map(norm), evaluated(fmtWorktree)).toEqual([norm(path.join(w.wt1, "m.txt"))]);
      expectStatuses(fmtSession.states, ["completed"], "read in the session directory");
      expect(fmtSession.evaluates.find(e => e.action === "read")?.resources.map(norm), evaluated(fmtSession)).toEqual(["m.txt"]);
      expect(fmtSession.evaluates.some(e => e.action === "external_directory"), evaluated(fmtSession)).toBe(false);
      expectStatuses(fmtEdit.states, ["completed"], `edit in the worktree (evaluates: ${evaluated(fmtEdit)})`);
      expect(fmtEdit.evaluates.find(e => e.action === "edit")?.resources.map(norm), evaluated(fmtEdit)).toEqual([norm(path.join(w.wt1, "e1.txt"))]);
      expect(disk.wt1E1).toBe("edited\n");
      // (b) glob search roots: inside runs; another directory and the default (the main checkout) are refused.
      expect(search.states.length, describeStates(search.states)).toBe(6);
      expectCompleted(search.states[0], "glob inside the root");
      expectRefused(search.states[1], "glob outside the root");
      expectRefused(search.states[2], "glob with the default search root (main checkout)");
      // (c) refusal by throwing in execute.before reaches the CHILD as the tool's error (the grep include is visible to execute.before only).
      expectRefused(search.states[3], "grep include outside the root");
      expect(search.states[3]?.errorMessage, describeState(search.states[3])).toMatch(EXECUTE_BEFORE_REFUSAL);
      expectRefused(search.states[4], "read of the main checkout");
      // router_git_status answers for the bound work root (wt-1's untracked file), not the session directory.
      expectCompleted(search.states[5], "router_git_status");
      expectText(search.states[5], /wt1-only-untracked\.txt/, "router_git_status names wt-1's untracked file");
      expect(search.states[5]?.text, describeState(search.states[5])).not.toContain("main-only-dirty.txt");
      // (d) OBSERVATION (host 2.0.24, pinned, runs 2-3): the host truncates and saves the 64 KiB router_git_diff output (the saved path is in the
      //     text the child got), emits `session.tool.success` — and no event a plugin receives carries outputPaths. The router attributes saved
      //     outputs from outputPaths only (v2-hooks.ts HOST_TOOL_SUCCESS_EVENT, phase-p23 QA-P23-3-1), so EVEN THE OWNING CHILD is refused:
      //     fail closed. Consequence: role children cannot read their truncated outputs on 2.0.24. Another child is refused too.
      expectStatuses(big.states, ["completed", "completed"], "grep and router_git_diff of the big-output child");
      expect(savedPath, `the host truncated no output of the child: ${JSON.stringify(outputView)}`).toBeDefined();
      expect(successTypes, JSON.stringify(outputView)).toContain("session.tool.success");
      expect(anyWithPaths, `no event of the child carries outputPaths: ${JSON.stringify(outputView)}`).toEqual([]);
      expect(ownPaths).toEqual([]);
      expect(ownRead?.childID).toBe(big.childID);
      expectRefused(ownRead?.states[0], `own saved output without outputPaths (${savedPath}): fail closed`);
      expectRefused(foreignRead?.states[0], "another child reading the saved output");
      // (e) the later worktree is covered by the workRoots glob; one outside the glob is not; router_run runs in the later root and refuses wt-1.
      expectStatuses(lateRead.states, ["completed"], `later worktree under the workRoots glob (evaluates: ${evaluated(lateRead)})`);
      expectRefused(uncoveredRead.states[0], "worktree created after start without a pattern");
      expectText(lateRun.states[0], /\[router_run\] package\.json script "smoke-marker": exit code: 0/, "router_run in the later worktree");
      expectText(lateRun.states[1], /\[router_run\] error: refused: cwd is not this dispatch's work root/, "router_run with wt-1 as a foreign cwd");
      expect(disk.lateMarker).toBe(true);
      expect(disk.wt1Marker).toBe(false);
      expect(disk.mainMarker).toBe(false);
      // (f) DF2-F1 fixed: verified in the work root with and without `cwd:`, detection deterministic.
      for (const v of [df2NoCwd, df2WithCwd]) {
        expect(df2(v).verified, `${v.label}: ${v.parentText}`).toBe(true);
        expect(df2(v).detection, `${v.label}: ${rowLine(dispatchRowOf(rows, v.childID))}`).toBe("deterministic");
      }
      //     The live shape: the child's write landed in the worktree and the check on it, without `cwd:`, is verified (deterministic).
      expectStatuses(df2Live.states, ["completed"], "DF2-F1 live shape: the child writes the file in its worktree");
      expect(createdOnDisk, "the written file exists in the worktree").toBe(true);
      expect(df2(df2Live).verified, `DF2-F1 live shape: ${df2Live.parentText}`).toBe(true);
      expect(df2(df2Live).detection, rowLine(dispatchRowOf(rows, df2Live.childID))).toBe("deterministic");
      //     A `cwd:` outside the work root: refused by the gate (unverifiable, never verified) and not decided as deterministic.
      expect(df2(df2Outside).cwdRefused, `DF2-F1 cwd outside: ${df2Outside.parentText}`).toBe(true);
      expect(df2(df2Outside).verified, df2Outside.parentText).toBe(false);
      expect(df2(df2Outside).detection, rowLine(dispatchRowOf(rows, df2Outside.childID))).not.toBe("deterministic");
      for (const v of fresh) expect(bindingNote(rows, v.childID)?.binding, v.label).toBe("exact");
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("budget exhaustion and resume; signal rows of every kind (verdict, run, grader, incomplete, budget, authority, redispatch) in the isolated decision log; a grader verdict is a grader row, never a verdict row", async () => {
    // Enforcement mode `enforced`: the default `advisory` never blocks a call (src/guard/enforce.ts:241-248 only appends a banner), so no
    // budget stop exists in it and the parent gets no `[router budget]` note (run 1: the 4th read of a 3-call budget completed).
    const { host, w } = await startRolesHost("signals", {
      overrides: { roleAgents: { explorer: { budget: { fast: 3 } } }, enforcement: { mode: "enforced", verify: { minGraderTier: "heavy" } } },
    });
    try {
      const root = await host.newRoot("signals root", undefined, host.project, []);
      const read = (file: string): ScriptStep => ({ tool: "read", input: { path: path.join(host.project, file) } });
      // budget: explorer at fast with a role budget of 3 calls attempts 5 reads, returns NEED MORE: budget; the resume continues.
      const reads = ["e0.txt", "e1.txt", "e2.txt", "e3.txt", "e4.txt"].map(read);
      const budget = await runChild(host, root, roleInput("explorer", "signals budget", "class=search risk=low scope=single tier=fast", ["TASK: read the five e files", scriptLine(reads, "NEED MORE: budget\nread e0.txt to e2.txt; e3.txt and e4.txt remain")]), "budget");
      const budgetResume = await resumeChild(host, root, budget.childID, { agent: "explorer", description: "signals budget resume", prompt: ["continue and finish", scriptLine(reads.slice(3), "DONE: e3.txt:1 e4.txt:1")].join("\n"), background: false }, "budget resume");
      // verdict pass / fail (deterministic fileExists).
      const acceptFile = (file: string) => ["[acceptance]", `check: fileExists path=${file}`, "[/acceptance]"];
      const verdictPass = await runChild(host, root, roleInput("architect", "signals verdict pass", "class=design risk=low scope=single", ["TASK: confirm the parser exists", ...acceptFile(path.join(host.project, "parser.ts"))]), "verdict pass");
      const verdictFail = await runChild(host, root, roleInput("architect", "signals verdict fail", "class=design risk=low scope=single", ["TASK: confirm the lexer exists", ...acceptFile(path.join(host.project, "lexer-never-created.ts"))]), "verdict fail");
      // run: an edit, then router_run of the acceptance script AFTER it, exit 0.
      const run = await runChild(host, root, roleInput("implementer", "signals run", "class=implement risk=low scope=single needs=edit,shell", [
        "TASK: update e5.txt and run the smoke-marker script",
        scriptLine([{ tool: "edit", input: { path: path.join(host.project, "e5.txt"), oldString: "main", newString: "edited" } }, { tool: "router_run", input: { script: "smoke-marker", cwd: host.project } }], "DONE: e5.txt:1 edited; smoke-marker exit code 0"),
        "[acceptance]", "check: run command=\"npm run smoke-marker\"", "[/acceptance]",
      ]), "run");
      // grader: criteria only, VERIFY required; the scripted grader passes (producer fast, grader heavy on another model).
      const gradersBefore = host.provider.graders;
      const graderMark = host.provider.requests.length;
      const grader = await runChild(host, root, roleInput("explorer", "signals grader", "class=search risk=low scope=single tier=fast", ["VERIFY: required", "TASK: say where parse is defined", "[acceptance]", "criteria: the reply names where parse is defined", "[/acceptance]"]), "grader");
      const gradersRan = host.provider.graders - gradersBefore;
      /** The grader's own provider requests (the router's grader system prompt): which model and tier judged the producer. */
      const graderRequests = host.provider.requests.slice(graderMark).filter(r => r.reply === "grader").map(r => ({ session: r.session, agent: r.agent, catalogModel: r.catalogModel, tier: modelTier(r.catalogModel) }));
      // incomplete: NEED MORE without budget exhaustion or an authority request.
      const incomplete = await runChild(host, root, roleInput("architect", "signals incomplete", "class=design risk=low scope=single", ["TASK: sketch the parser design", scriptLine([read("parser.ts")], "NEED MORE: the lexer module is missing from the context")]), "incomplete");
      // authority: the ladder request.
      const authority = await runChild(host, root, roleInput("general", "signals authority", "class=search risk=low scope=single", ["Look at the parser module and report its entry points", scriptLine([{ tool: "router_request_authority", input: { actions: ["edit"], reason: "the result must be written to a file" } }], "ESCALATE: authority\nedit is needed")]), "authority");
      // redispatch: the same TASK again on a higher tier after a finished attempt.
      const task = "TASK: find the exported entry points of parser.ts and list them with file:line";
      const first = await runChild(host, root, roleInput("explorer", "signals redispatch first", "class=search risk=low scope=single tier=fast", [task, scriptLine([], "DONE: parser.ts:1 parse")]), "redispatch first");
      const again = await runChild(host, root, roleInput("explorer", "signals redispatch again", "class=search risk=low scope=single tier=medium", [task, scriptLine([], "DONE: parser.ts:1 parse")]), "redispatch again");
      // Plan §2.6 (the P3.3 fix on rta/p33-fix-2 for the run-2 finding: graderSignal had no call site and a role's grader verdict was
      // written as a `verdict` row of deterministic weight): a role dispatch's GRADER verdict lands as `note:signal:grader:<pass|fail>`
      // (weight 0.5, only when the grader's tier >= the producer's and its model differs) and never as a `verdict` row; deterministic
      // verdicts stay `verdict` rows. This test expects the FIXED behaviour; on code before that fix it fails here on purpose.
      const expected: Record<string, { child: string; reason: RegExp }> = {
        verdictPass: { child: verdictPass.childID, reason: /^note:signal:verdict:pass$/ },
        verdictFail: { child: verdictFail.childID, reason: /^note:signal:verdict:fail$/ },
        run: { child: run.childID, reason: /^note:signal:run:pass$/ },
        grader: { child: grader.childID, reason: /^note:signal:grader:pass$/ },
        incomplete: { child: incomplete.childID, reason: /^note:signal:incomplete:fail$/ },
        budget: { child: budget.childID, reason: /^note:signal:budget:/ },
        authority: { child: authority.childID, reason: /^note:signal:authority:/ },
        redispatch: { child: first.childID, reason: /^note:signal:redispatch:fail$/ },
      };
      const has = (rs: readonly DecisionRow[], e: { child: string; reason: RegExp }) => signalRows(rs).some(r => r.childSessionID === e.child && e.reason.test(r.reason));
      const children = [budget, verdictPass, verdictFail, run, grader, incomplete, authority, first, again].map(v => v.childID);
      const rows = await waitRows(host, "every signal row", rs => everyBound(children)(rs) && Object.values(expected).every(e => has(rs, e)), 120_000);
      const kinds = [...new Set(signalRows(rows).map(r => r.signal))].sort();
      await save("budget-signals", {
        budget, budgetResume, verdictPass: verdictPass.parentText, verdictFail: verdictFail.parentText, run, grader: { ...grader, gradersRan, graderRequests }, incomplete, authority, first, again,
        found: Object.fromEntries(Object.entries(expected).map(([k, e]) => [k, has(rows, e)])), kinds, signals: signalRows(rows).map(rowView),
        disk: { e5: await readFile(path.join(host.project, "e5.txt"), "utf8"), marker: existsSync(path.join(host.project, "smoke-marker.txt")), wt1: w.wt1 },
        unknownBindings: unknownBindings(rows), routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors,
      });

      // Budget: three reads ran on fast, the rest were refused with the NEED MORE: budget instruction; the parent got the [router budget] note.
      expect(budget.requests[0]?.tier).toBe("fast");
      expectStatuses(budget.states, ["completed", "completed", "completed", "error", "error"], "explorer with a 3-call budget attempts 5 reads");
      for (const s of budget.states.slice(3)) expect(s.errorMessage ?? "", describeState(s)).toContain("NEED MORE: budget");
      expect(budget.parentText).toContain("[router budget] @explorer stopped on its tool-call budget before finishing");
      expect(budget.parentText).toContain(budget.childID);
      // ... and the resume of the SAME session continues: both remaining reads run.
      expect(budgetResume.childID).toBe(budget.childID);
      expectStatuses(budgetResume.states, ["completed", "completed"], "the resumed explorer reads the remaining files");
      // The run signal's preconditions on the host: the edit landed and router_run exited 0 after it.
      expectCompleted(run.states[0], "edit before the run");
      expectText(run.states[1], /exit code: 0/, "router_run after the edit");
      expect(gradersRan, "the router's grader reached the provider").toBeGreaterThan(0);
      // The grader was independent in the §2.6 sense — its tier (by model when its variant is no preset rung: run 3 saw opus#default) at
      // least the producer's (fast), another model than the producer's sonnet — so the independence rule admits its verdict as a signal.
      expect(graderRequests.length, JSON.stringify(graderRequests)).toBeGreaterThan(0);
      for (const g of graderRequests) {
        expect(g.tier, `grader model maps to a preset tier: ${JSON.stringify(g)}`).toBeDefined();
        expect(rankOf(g.tier), `grader tier >= producer tier ${grader.requests[0]?.tier}: ${JSON.stringify(g)}`).toBeGreaterThanOrEqual(rankOf(grader.requests[0]?.tier));
        expect(g.catalogModel?.split("#")[0], `grader model differs from the producer's: ${JSON.stringify(g)} vs ${grader.requests[0]?.catalogModel}`).not.toBe(grader.requests[0]?.catalogModel?.split("#")[0]);
      }
      const signalList = signalRows(rows).map(r => `${r.reason}@${r.childSessionID}`).join(", ");
      for (const [name, e] of Object.entries(expected)) expect(has(rows, e), `signal row ${name} (${e.reason.source}) for ${e.child}; signal rows: ${signalList}`).toBe(true);
      // The grader verdict is a `grader` row only: no `verdict` signal row for the grader-verified dispatch (run 2/3 before the fix: verdict:pass).
      expect(signalRows(rows).filter(r => r.childSessionID === grader.childID && r.signal === "verdict").map(r => r.reason), `verdict rows of the grader dispatch; signal rows: ${signalList}`).toEqual([]);
      expect(kinds).toEqual(["authority", "budget", "grader", "incomplete", "redispatch", "run", "verdict"]);
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);

  it("exploration: with routing.exploration.rate 0.2 an eligible deterministic dispatch is sometimes drawn below the static default; the row says explore + propensity and the model stays inside [floor, ceiling]", async () => {
    const { host } = await startRolesHost("explore", { routing: { exploration: { rate: 0.2 } } });
    try {
      const root = await host.newRoot("explore root", undefined, host.project, []);
      const present = path.join(host.project, "m.txt");
      // explorer, class implement: static default medium (CLASS_STATIC_TIER), floor fast (local grant), detection deterministic (router-gated fileExists).
      const draws: ChildView[] = [];
      for (let i = 0; i < 40; i++) {
        draws.push(await runChild(host, root, roleInput("explorer", `explore draw ${i}`, "class=implement risk=low scope=single", [`TASK: confirm m.txt exists (draw ${i})`, "[acceptance]", `check: fileExists path=${present}`, "[/acceptance]"]), `draw ${i}`));
        const tiers = new Set(draws.map(v => v.requests[0]?.tier));
        if (tiers.has("fast") && tiers.has("medium")) break;
      }
      const rows = await waitRows(host, "exploration rows", everyBound(draws.map(v => v.childID)));
      const drawn = draws.map(v => ({ label: v.label, tier: v.requests[0]?.tier, model: v.requests[0]?.catalogModel, row: rowView(dispatchRowOf(rows, v.childID)) }));
      await save("exploration", { draws: drawn, unknownBindings: unknownBindings(rows), routerWarnings: host.routerLogLines(), hostErrors: host.errorLines(), providerErrors: host.provider.errors });

      const explored = draws.filter(v => dispatchRowOf(rows, v.childID)?.explore === true);
      const exploited = draws.filter(v => dispatchRowOf(rows, v.childID)?.explore !== true);
      expect(explored.length, `an exploration row within ${draws.length} eligible dispatches: ${drawn.map(x => `${x.tier}:${rowLine(dispatchRowOf(rows, draws.find(v => v.label === x.label)!.childID))}`).join(" ")}`).toBeGreaterThan(0);
      for (const v of explored) {
        const row = dispatchRowOf(rows, v.childID)!;
        expect(row.propensity, rowLine(row)).toBeCloseTo(0.2, 6);
        expect(row.reason).toContain("exploration draw");
        expect(row.detection?.effective).toBe("deterministic");
        expect(v.requests[0]?.tier, `explored dispatch on ${v.requests[0]?.catalogModel}`).toBe("fast"); // the one target: at the floor, below the default
        expect(row.tier).toBe("fast");
      }
      for (const v of exploited) {
        const row = dispatchRowOf(rows, v.childID)!;
        if (row.switched) continue; // an enforce switch is not an exploration draw (recorded in the evidence)
        expect(row.propensity, rowLine(row)).toBeCloseTo(0.8, 6);
        expect(v.requests[0]?.tier, rowLine(row)).toBe("medium");
      }
      for (const v of draws) for (const r of v.requests) expect(rankOf(r.tier), `I2 for ${v.label}`).toBeLessThanOrEqual(rankOf("medium"));
      expect(unknownBindings(rows)).toEqual([]);
      expect(host.provider.errors).toEqual([]);
    } finally { await finish(host); }
  }, 900_000);
});
