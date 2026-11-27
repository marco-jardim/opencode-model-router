/** Live probe (not a regression test): what a REAL OpenCode v2 host does around the router's own child runs.
 *
 *   RUN_OC_SMOKE_RUNNER=1 OPENCODE_V2_BIN=<abs path to opencode 2.x> [OMR_SMOKE_EVIDENCE_DIR=<abs dir>] \
 *     npx vitest run --config vitest.smoke.config.ts test/smoke/runner-live-probe.smoke.test.ts
 *
 * - Skipped unless RUN_OC_SMOKE_RUNNER=1. Uses only the existing `RoutingHost` harness (isolated `opencode serve`, scripted keyless
 *   provider, the router loaded from this checkout, a probe plugin that logs tool hooks and session events).
 * - It OBSERVES. The only assertions are the two marked ASSERT in scenario A. Everything else is recorded in a JSON report:
 *   `<OMR_SMOKE_EVIDENCE_DIR or the real OS temp dir>/runner-live-probe.json` (never inside the repository), rewritten after every
 *   scenario and once more in afterAll. A scenario that throws or times out leaves its error (and every snapshot taken so far) in
 *   the report; the other scenarios still run.
 *   The fallback directory is `OMR_SMOKE_REAL_TMPDIR` (the smoke temp guard's record of the real temp dir) rather than a plain
 *   `os.tmpdir()`: under vitest.smoke.config.ts `os.tmpdir()` is a per-run directory that the guard deletes at teardown.
 * - Scenarios (each starts its own host and always stops it):
 *     A  `delegate`: the router's own producer + grader children (native child runner).
 *     B  a native `subagent` call by the root with a criteria-only acceptance (the path the orchestrator normally uses).
 *     C  a `delegate` whose producer child itself calls `subagent` once (CHILD_SCRIPT64 scripted step).
 * - What is recorded after the root settles and again after idle waits (late wake of the root): the root's own history
 *   (`session.context`), every model request the provider received for the root with its last user / tool-result content,
 *   the child sessions and the event types per session, the router's WARN/ERROR log lines and the tail of the host log.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, RoutingHost, arr, delay, obj, scriptLine, stopAllHosts, str, type EventRecord, type HookRecord, type Obj, type WireRequest } from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_RUNNER === "1";
const d = RUN ? describe : describe.skip;

const ACCEPTANCE = "[acceptance]\ncriteria: the reply says CHILD_DONE\n[/acceptance]";
/** Same host options for every scenario (B leaves `routing.background.mode` at its default). */
const OVERRIDES: Obj = {
  experimental: { verifiedDelegateTool: true },
  enforcement: { mode: "enforced", verify: { require: "always", defaultVerify: "required", background: false } },
};

const MAX_ITEMS = 200;
const TEXT = 240;

// ------------------------------------------------------------------------------------------------ report ----
const report: Obj = { probe: "runner-live-probe", scenarios: {} as Obj };

function reportDir(): string {
  const override = process.env.OMR_SMOKE_EVIDENCE_DIR;
  const dir = override !== undefined && override !== "" ? path.resolve(override) : path.resolve(process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir());
  const relative = path.relative(ROOT, dir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error(`the probe report must not be written inside the repository: ${dir}`);
  return dir;
}
async function writeReport(): Promise<string | undefined> {
  try {
    const dir = reportDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "runner-live-probe.json");
    report.reportPath = file;
    report.writtenAt = new Date().toISOString();
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
  } catch (error) {
    console.log(`[runner-live-probe] cannot write the report: ${errText(error)}`);
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ helpers ----
const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);
const errText = (error: unknown): string => clip(error instanceof Error ? error.message : String(error), 2_000);
const safeJson = (value: unknown): string => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } };
const capped = <T>(items: readonly T[]): T[] => items.slice(0, MAX_ITEMS);

interface FlagRule { readonly name: string; readonly pattern: RegExp }
const HISTORY_FLAGS: readonly FlagRule[] = [
  { name: "background-result", pattern: /background-result/ },
  { name: "<subagent", pattern: /<subagent/ },
  { name: "\"pass\"", pattern: /\\*"pass\\*"/ },
  { name: "CHILD_DONE", pattern: /CHILD_DONE/ },
  { name: "router", pattern: /router/i },
];
const REQUEST_FLAGS: readonly FlagRule[] = [
  { name: "background-result", pattern: /background-result/ },
  { name: "<subagent ", pattern: /<subagent / },
  { name: "\"pass\":", pattern: /\\*"pass\\*"\s*:/ },
];
const flagsOf = (rules: readonly FlagRule[], text: string): string[] => rules.filter(rule => rule.pattern.test(text)).map(rule => rule.name);

/** Text of an Anthropic-style content value: strings, text blocks and (recursively) tool_result blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content).map(obj).map(block => {
    if (block.type === "text") return str(block.text) ?? "";
    if (block.type === "tool_result") return contentText(block.content);
    return "";
  }).filter(text => text !== "").join("\n");
}
/** The last user message (a tool result is a user message) that is not the router's `<router-state>` tail. */
function lastUserContent(messages: readonly Obj[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    const text = contentText(message.content);
    if (text.trimStart().startsWith("<router-state>")) continue;
    return text;
  }
  return "";
}
/** Whatever text a v2 context entry carries: `text`, `description`, and `content` (string or parts of type text). */
function entryText(entry: Obj): string {
  const out: string[] = [];
  for (const key of ["text", "description"] as const) { const value = str(entry[key]); if (value !== undefined && value !== "") out.push(value); }
  const content = entry.content;
  if (typeof content === "string") { if (content !== "") out.push(content); }
  else for (const part of arr(content).map(obj)) if (part.type === "text") { const value = str(part.text); if (value !== undefined && value !== "") out.push(value); }
  return out.join("\n");
}
/** The text a tool's execute.after record carries (content parts, output.output, a string output, the error). */
function hookResultText(after: HookRecord): string {
  const result = obj(after.result);
  const out: string[] = [];
  for (const part of arr(result.content).map(obj)) { const value = str(part.text); if (value !== undefined && value !== "") out.push(value); }
  if (typeof result.output === "string") out.push(result.output);
  else { const value = str(obj(result.output).output); if (value !== undefined && value !== "") out.push(value); }
  if (after.error !== undefined) out.push(`ERROR ${safeJson(after.error)}`);
  return out.join("\n");
}
/** What the ROOT model was given for one of its tool calls: the tool_result block (by tool_use_id) of its own later request. */
function rootSawToolResult(host: RoutingHost, root: string, callID: string): string {
  for (const request of [...host.requestsOf(root)].reverse()) {
    const blocks = request.messages.flatMap(message => arr(message.content).map(obj)).filter(block => block.type === "tool_result" && block.tool_use_id === callID);
    if (blocks.length > 0) return blocks.map(block => contentText(block.content)).join("\n");
  }
  return "";
}
const hookView = (h: HookRecord): Obj => ({
  hook: h.hook, tool: h.tool, sessionID: h.sessionID, agent: h.agent, callID: h.callID, status: h.status, t: h.__t,
  input: clip(safeJson(h.input), TEXT), result: clip(safeJson(h.result), 600), error: h.error === undefined ? undefined : clip(safeJson(h.error), 600),
});

// ------------------------------------------------------------------------------------------------ snapshots ----
interface HistoryItem { index: number; type?: string; id?: string; keys: string[]; textSource: "fields" | "json"; text: string; flags: string[]; flagsAnywhereInJson: string[] }
interface RequestItem { seq: number; kind?: string; agent?: string; reply: string; toolResult: boolean; stream: boolean; messages: number; lastUserContent: string; lastContentFlags: string[]; bodyFlags: string[] }
interface TypeCount { type: string; count: number }
interface SessionItem { id: string; parentID?: string; depth: number; agent?: string; title?: string; createdAtMs: number | null; lastEventAtMs: number | null; eventTypes: TypeCount[]; info?: Obj }
interface Snap {
  label: string; at: string; msSinceStart: number; note?: string;
  rootActive: boolean | null;
  history: { total: number; items: HistoryItem[]; flagged: number };
  rootRequests: { total: number; items: RequestItem[]; withBodyFlags: number };
  requestCounts: Obj[];
  graders: { total: number; sinceStart: number };
  providerRequestsTotal: number; providerErrors: string[];
  sessions: SessionItem[];
  rootEventTypes: TypeCount[];
  rootEventTimeline: { t: number | null; type: string }[];
  unattributedEventTypes: TypeCount[];
  routerLogLines: string[];
  hostTail: string;
  errors: Record<string, string>;
}
interface SnapContext { readonly host: RoutingHost; readonly root: string; readonly t0: number; readonly gradersBefore: number }

const typeCounts = (events: readonly EventRecord[]): TypeCount[] => {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
};
const relativeTime = (at: number | undefined, t0: number): number | null => (at === undefined ? null : at - t0);

interface SessionMeta { id: string; parentID?: string; agent?: string; title?: string; createdAt?: number; depth: number }
/** The sessions under `root` (children, grandchildren…) from the host's session.created events, with their depth (1 = child). */
function descendants(events: readonly EventRecord[], root: string): SessionMeta[] {
  const created = new Map<string, SessionMeta>();
  for (const event of events) {
    if (event.type !== "session.created") continue;
    const data = obj(event.data);
    const id = str(data.sessionID);
    if (id === undefined || created.has(id)) continue;
    const title = str(data.title);
    created.set(id, { id, parentID: str(data.parentID), agent: str(data.agent), title: title === undefined ? undefined : clip(title, TEXT), createdAt: event.__t, depth: 0 });
  }
  const out: SessionMeta[] = [];
  for (const meta of created.values()) {
    let depth = 0;
    let current = meta.parentID;
    const seen = new Set<string>([meta.id]);
    while (current !== undefined && current !== root && !seen.has(current)) { seen.add(current); depth += 1; current = created.get(current)?.parentID; }
    if (current === root) out.push({ ...meta, depth: depth + 1 });
  }
  return out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

const historyItem = (entry: Obj, index: number): HistoryItem => {
  const fields = entryText(entry);
  const json = safeJson(entry);
  const basis = fields !== "" ? fields : json;
  return { index, type: str(entry.type), id: str(entry.id), keys: Object.keys(entry).slice(0, 30), textSource: fields !== "" ? "fields" : "json", text: clip(basis, TEXT), flags: flagsOf(HISTORY_FLAGS, basis), flagsAnywhereInJson: flagsOf(HISTORY_FLAGS, json) };
};
const requestItem = (request: WireRequest): RequestItem => {
  const last = lastUserContent(request.messages);
  return {
    seq: request.seq, kind: request.kind, agent: request.agent, reply: request.reply, toolResult: request.toolResult, stream: request.stream, messages: request.messages.length,
    lastUserContent: clip(last, TEXT), lastContentFlags: flagsOf(REQUEST_FLAGS, last), bodyFlags: flagsOf(REQUEST_FLAGS, safeJson(request.messages)),
  };
};

async function snapshot(ctx: SnapContext, label: string, note?: string): Promise<Snap> {
  const { host, root, t0 } = ctx;
  const errors: Record<string, string> = {};
  const attempt = async <T>(key: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) { errors[key] = errText(error); return fallback; }
  };
  const rootActive = await attempt<boolean | null>("rootActive", async () => Object.hasOwn(await host.client.session.active(), root), null);
  const entries = (await attempt<Obj[]>("history", () => host.client.session.context({ sessionID: root }), [])).map(obj);
  const history = entries.map(historyItem);
  const rootRequestList = host.requestsOf(root);
  const requests = rootRequestList.map(requestItem);
  const events = await attempt<EventRecord[]>("events", () => host.events(), []);
  const tree = descendants(events, root);
  const known = new Set<string>([root, ...tree.map(s => s.id)]);
  const eventsOfSession = (id: string): EventRecord[] => events.filter(e => obj(e.data).sessionID === id);
  const sessions: SessionItem[] = [];
  for (const meta of capped(tree)) {
    const own = eventsOfSession(meta.id);
    const info = await attempt<Obj | undefined>(`session.get ${meta.id}`, async () => {
      const got = await host.client.session.get({ sessionID: meta.id });
      return { agent: got.agent, parentID: got.parentID, outcome: got.outcome, cost: got.cost, tokens: got.tokens, title: got.title === undefined ? undefined : clip(got.title, TEXT) };
    }, undefined);
    sessions.push({ id: meta.id, parentID: meta.parentID, depth: meta.depth, agent: meta.agent, title: meta.title, createdAtMs: relativeTime(meta.createdAt, t0), lastEventAtMs: relativeTime(own.at(-1)?.__t, t0), eventTypes: capped(typeCounts(own)), info });
  }
  const rootEvents = eventsOfSession(root);
  const unattributed = events.filter(e => { const id = str(obj(e.data).sessionID); return id === undefined || !known.has(id); });
  const providerRequests = host.provider.requests;
  const requestCounts: Obj[] = [root, ...tree.map(s => s.id)].slice(0, MAX_ITEMS).map(id => {
    const own = providerRequests.filter(r => r.session === id);
    return { sessionID: id, role: id === root ? "root" : "child", requests: own.length, graderRequests: own.filter(r => r.reply === "grader").length, toolReplies: own.filter(r => r.reply === "tool").length, byKind: Object.fromEntries(typeCounts(own.map(r => ({ type: `${r.kind ?? "?"}/${r.agent ?? "?"}` }))).map(c => [c.type, c.count])) };
  });
  return {
    label, at: new Date().toISOString(), msSinceStart: Date.now() - t0, ...(note === undefined ? {} : { note }),
    rootActive,
    history: { total: history.length, items: capped(history), flagged: history.filter(h => h.flags.length > 0 || h.flagsAnywhereInJson.some(f => f !== "router")).length },
    rootRequests: { total: requests.length, items: capped(requests), withBodyFlags: requests.filter(r => r.bodyFlags.length > 0).length },
    requestCounts,
    graders: { total: host.provider.graders, sinceStart: host.provider.graders - ctx.gradersBefore },
    providerRequestsTotal: providerRequests.length, providerErrors: capped(host.provider.errors.map(e => clip(e, 600))),
    sessions,
    rootEventTypes: capped(typeCounts(rootEvents)),
    rootEventTimeline: rootEvents.slice(-MAX_ITEMS).map(e => ({ t: relativeTime(e.__t, t0), type: e.type })),
    unattributedEventTypes: capped(typeCounts(unattributed)),
    routerLogLines: capped(host.routerLogLines().map(line => clip(line, 600))),
    hostTail: host.tail(4_000),
    errors,
  };
}

/** Waits `ms`; if the root woke up meanwhile (active) waits until it is idle again, then takes the snapshot. */
async function snapshotAfterIdle(ctx: SnapContext, label: string, ms: number): Promise<Snap> {
  await delay(ms);
  let note: string | undefined;
  try {
    if (Object.hasOwn(await ctx.host.client.session.active(), ctx.root)) {
      note = `the root was ACTIVE after the ${ms} ms idle wait (late wake); waited for it to go idle again before the snapshot`;
      await ctx.host.settle(ctx.root);
    }
  } catch (error) { note = `${note ?? "idle wait"}: ${errText(error)}`; }
  return snapshot(ctx, label, note);
}

const historyKey = (item: HistoryItem): string => item.id ?? `#${item.index}`;
/** What appeared between two snapshots of the same session. */
function diff(a: Snap, b: Snap): Obj {
  const oldHistory = new Set(a.history.items.map(historyKey));
  const oldRequests = new Set(a.rootRequests.items.map(r => r.seq));
  const oldSessions = new Set(a.sessions.map(s => s.id));
  const before = new Map(a.rootEventTypes.map(e => [e.type, e.count] as const));
  return {
    from: a.label, to: b.label,
    newRootHistoryEntries: capped(b.history.items.filter(i => !oldHistory.has(historyKey(i)))),
    newRootRequests: capped(b.rootRequests.items.filter(r => !oldRequests.has(r.seq))),
    newSessions: capped(b.sessions.filter(s => !oldSessions.has(s.id)).map(s => ({ id: s.id, agent: s.agent, depth: s.depth }))),
    newRootEventCounts: capped(b.rootEventTypes.map(e => ({ type: e.type, added: e.count - (before.get(e.type) ?? 0) })).filter(e => e.added > 0)),
    graderRequestsAdded: b.graders.total - a.graders.total,
    providerRequestsAdded: b.providerRequestsTotal - a.providerRequestsTotal,
    rootActiveAtSecondSnapshot: b.rootActive,
    nothingNew: b.history.total === a.history.total && b.rootRequests.total === a.rootRequests.total && b.providerRequestsTotal === a.providerRequestsTotal,
  };
}

// ------------------------------------------------------------------------------------------------ scenarios ----
async function hostVersion(host: RoutingHost): Promise<unknown> {
  try { return await host.client.server.info(); } catch (error) { return { error: errText(error) }; }
}
async function stopHost(host: RoutingHost, rec: Obj): Promise<void> {
  try {
    const t = await host.stop();
    rec.teardown = { pid: t.pid, method: t.method, exitCode: t.exitCode, hostPortClosed: t.hostPortClosed, providerStopped: t.providerStopped, rootRemoved: t.rootRemoved };
  } catch (error) { rec.teardown = { error: errText(error) }; }
}

/** Runs one scenario body; its failure is recorded (not lost) and returned so the `it` can rethrow it AFTER the report is written. */
async function scenario(name: string, body: (rec: Obj) => Promise<void>): Promise<{ rec: Obj; error?: unknown }> {
  const rec: Obj = { status: "running", startedAt: new Date().toISOString() };
  (report.scenarios as Obj)[name] = rec;
  const started = Date.now();
  let failure: unknown;
  try { await body(rec); rec.status = rec.status === "skipped" ? "skipped" : "completed"; }
  catch (error) { failure = error; rec.status = "error"; rec.error = errText(error); }
  rec.durationMs = Date.now() - started;
  const file = await writeReport();
  for (const line of summary(name, rec)) console.log(line);
  if (file !== undefined) console.log(`[runner-live-probe] report: ${file}`);
  return { rec, ...(failure === undefined ? {} : { error: failure }) };
}

function summary(name: string, rec: Obj): string[] {
  const lines = [`[runner-live-probe] ${name}: ${String(rec.status)} in ${String(rec.durationMs ?? "?")} ms${rec.error !== undefined ? ` ERROR: ${String(rec.error)}` : ""}${rec.skipped !== undefined ? ` skipped: ${String(rec.skipped)}` : ""}`];
  const delegate = obj(rec.delegate);
  if (delegate.resultText !== undefined) lines.push(`  result: ${clip(String(delegate.resultText).replace(/\s+/g, " "), 200)}`);
  if (rec.assertions !== undefined) lines.push(`  assertions: ${safeJson(rec.assertions)}`);
  for (const raw of arr(rec.snapshots)) {
    const s = obj(raw);
    const history = obj(s.history);
    const requests = obj(s.rootRequests);
    const graders = obj(s.graders);
    lines.push(`  [${String(s.label)} +${String(s.msSinceStart)} ms] rootActive=${String(s.rootActive)} history=${String(history.total)} (flagged ${String(history.flagged)}) rootRequests=${String(requests.total)} (body flags ${String(requests.withBodyFlags)}) graders=${String(graders.sinceStart)} sessions=${arr(s.sessions).length} routerLogLines=${arr(s.routerLogLines).length}`);
  }
  for (const raw of arr(rec.diffs)) {
    const x = obj(raw);
    lines.push(`  diff ${String(x.from)} -> ${String(x.to)}: +${arr(x.newRootHistoryEntries).length} root history, +${arr(x.newRootRequests).length} root requests, +${String(x.graderRequestsAdded)} grader requests, nothingNew=${String(x.nothingNew)}`);
  }
  return lines;
}

/** A: `delegate`, producer + grader children through the native child runner. */
async function runA(rec: Obj): Promise<void> {
  const host = await RoutingHost.start("probe-delegate", { routing: { engine: "advise", background: { mode: "off" } }, overrides: OVERRIDES });
  try {
    const t0 = Date.now();
    rec.hostVersion = await hostVersion(host);
    const root = await host.newRoot("probe A root");
    rec.rootID = root;
    const ctx: SnapContext = { host, root, t0, gradersBefore: host.provider.graders };
    const snaps: Snap[] = [];
    rec.snapshots = snaps;
    const call = await host.call(root, "delegate", { tier: "fast", task: "VERIFY:required\nCHILD_DONE", acceptance: ACCEPTANCE }, 180_000);
    const text = hookResultText(call.after);
    rec.delegate = {
      callID: call.callID, hookAfterMs: relativeTime(call.after.__t, t0), resultText: clip(text, 1_200), resultJson: clip(safeJson(call.after.result), 1_200), rootSawToolResult: clip(rootSawToolResult(host, root, call.callID), 1_200),
    };
    snaps.push(await snapshot(ctx, "after-settle"));
    snaps.push(await snapshotAfterIdle(ctx, "after-idle-8s", 8_000));
    rec.diffs = [diff(snaps[0]!, snaps[1]!)];
    rec.hooksOutsideRoot = capped((await host.hooks()).filter(h => h.sessionID !== root).map(hookView));
    // ASSERT (recorded first, checked by the `it` after the report is written).
    rec.assertions = { delegateTextHasVerifiedMarker: text.includes("[router ✓ verified:") || safeJson(call.after.result).includes("[router ✓ verified:"), graderRequests: host.provider.graders - ctx.gradersBefore };
  } finally { await stopHost(host, rec); }
}

/** B: a native `subagent` call by the root with a criteria-only acceptance (background: false, which this host ignores). */
async function runB(rec: Obj): Promise<void> {
  const host = await RoutingHost.start("probe-native", { routing: { engine: "advise" }, overrides: OVERRIDES });
  try {
    const t0 = Date.now();
    rec.hostVersion = await hostVersion(host);
    const root = await host.newRoot("probe B root");
    rec.rootID = root;
    const ctx: SnapContext = { host, root, t0, gradersBefore: host.provider.graders };
    const snaps: Snap[] = [];
    rec.snapshots = snaps;
    const prompt = ["VERIFY: required", "CHILD_DONE", ACCEPTANCE].join("\n");
    const gradersBeforeCall = host.provider.graders;
    const call = await host.call(root, "subagent", { agent: "fast", description: "probe B native subagent", prompt, background: false }, 180_000);
    rec.dispatch = {
      callID: call.callID, childID: call.childID, hookAfterMs: relativeTime(call.after.__t, t0),
      hookResultText: clip(hookResultText(call.after), 1_200), hookResultJson: clip(safeJson(call.after.result), 1_200), rootSawToolResult: clip(rootSawToolResult(host, root, call.callID), 1_200),
      gradersBeforeCall, gradersAfterCall: host.provider.graders,
    };
    snaps.push(await snapshot(ctx, "after-settle"));
    snaps.push(await snapshotAfterIdle(ctx, "after-idle-8s", 8_000));
    snaps.push(await snapshotAfterIdle(ctx, "after-idle-38s", 30_000));
    rec.diffs = [diff(snaps[0]!, snaps[1]!), diff(snaps[1]!, snaps[2]!), diff(snaps[0]!, snaps[2]!)];
    rec.hooksOutsideRoot = capped((await host.hooks()).filter(h => h.sessionID !== root).map(hookView));
    rec.graderAfterSettle = { before: gradersBeforeCall, afterSettle: snaps[0]!.graders.total, after8s: snaps[1]!.graders.total, after38s: snaps[2]!.graders.total };
  } finally { await stopHost(host, rec); }
}

/** C: a `delegate` whose scripted producer calls `subagent` once before its final answer. */
async function runC(rec: Obj): Promise<void> {
  const host = await RoutingHost.start("probe-grandchild", { routing: { engine: "advise", background: { mode: "off" } }, overrides: OVERRIDES });
  try {
    const t0 = Date.now();
    rec.hostVersion = await hostVersion(host);
    const root = await host.newRoot("probe C root");
    rec.rootID = root;
    const ctx: SnapContext = { host, root, t0, gradersBefore: host.provider.graders };
    const snaps: Snap[] = [];
    rec.snapshots = snaps;
    // The producer's prompt carries the script (no SPIKE_* marker): its first request emits a `subagent` call, the next answers CHILD_DONE.
    const script = scriptLine([{ tool: "subagent", input: { agent: "fast", description: "probe C grandchild", prompt: "CHILD_DONE grandchild work", background: false } }], "CHILD_DONE");
    const task = ["VERIFY:required", "CHILD_DONE", script].join("\n");
    const started = Date.now();
    const call = await host.call(root, "delegate", { tier: "fast", task, acceptance: ACCEPTANCE }, 180_000);
    const returnedMs = Date.now() - started;
    const activeAtReturn = await host.client.session.active().then(a => Object.keys(a), () => [] as string[]);
    const text = hookResultText(call.after);
    rec.delegate = {
      callID: call.callID, resultText: clip(text, 1_200), resultJson: clip(safeJson(call.after.result), 1_200), rootSawToolResult: clip(rootSawToolResult(host, root, call.callID), 1_200),
      timingsMs: { hookAfterFromCall: call.after.__t - started, hostCallReturned: returnedMs },
    };
    snaps.push(await snapshot(ctx, "after-settle"));
    const events = await host.events();
    const tree = descendants(events, root);
    const grandchildren = tree.filter(s => s.depth >= 2);
    rec.grandchildren = grandchildren.map(g => {
      const own = events.filter(e => obj(e.data).sessionID === g.id);
      return {
        id: g.id, parentID: g.parentID, agent: g.agent, createdAtMs: relativeTime(g.createdAt, t0), lastEventAtMs: relativeTime(own.at(-1)?.__t, t0),
        activeWhenDelegateReturned: activeAtReturn.includes(g.id),
        eventTypesBeforeDelegateHookAfter: capped(typeCounts(own.filter(e => e.__t !== undefined && e.__t <= call.after.__t))),
        eventTypesAll: capped(typeCounts(own)),
        eventTimeline: own.slice(0, MAX_ITEMS).map(e => ({ t: relativeTime(e.__t, t0), type: e.type, beforeDelegateReturned: e.__t !== undefined && e.__t <= call.after.__t })),
      };
    });
    rec.activeWhenDelegateReturned = activeAtReturn.filter(id => id === root || tree.some(s => s.id === id));
    rec.hooksOutsideRoot = capped((await host.hooks()).filter(h => h.sessionID !== root).map(hookView));
    snaps.push(await snapshotAfterIdle(ctx, "after-idle-8s", 8_000));
    rec.diffs = [diff(snaps[0]!, snaps[1]!)];
    if (grandchildren.length === 0) rec.note = "no grandchild session was created (the scripted subagent call may have been refused by the host or the router: see hooksOutsideRoot)";
  } finally { await stopHost(host, rec); }
}

// ------------------------------------------------------------------------------------------------ tests ----
d("runner live probe: the host's behaviour around the router's own child runs (observation only)", () => {
  afterAll(async () => {
    await stopAllHosts();
    report.finishedAt = new Date().toISOString();
    const file = await writeReport();
    console.log(`[runner-live-probe] final report: ${file ?? "NOT WRITTEN"}`);
  }, 120_000);

  it("A delegate: producer + grader children through the native child runner", async () => {
    report.startedAt ??= new Date().toISOString();
    report.env = { platform: process.platform, node: process.version, opencodeBin: process.env.OPENCODE_V2_BIN ?? "(from PATH)" };
    const { rec, error } = await scenario("A_delegate", runA);
    if (error !== undefined) throw error;
    const assertions = obj(rec.assertions);
    expect(assertions.delegateTextHasVerifiedMarker, "the delegate result carries [router ✓ verified:").toBe(true);
    expect(Number(assertions.graderRequests), "grader requests that reached the provider").toBeGreaterThanOrEqual(1);
  }, 600_000);

  it("B native subagent call with a criteria-only acceptance (what the orchestrator normally does)", async () => {
    const { error } = await scenario("B_native_subagent", runB);
    if (error !== undefined) throw error;
  }, 900_000);

  it("C delegate whose producer calls subagent once (grandchild)", async () => {
    const { error } = await scenario("C_producer_calls_subagent", runC);
    if (error !== undefined) throw error;
  }, 600_000);
});
