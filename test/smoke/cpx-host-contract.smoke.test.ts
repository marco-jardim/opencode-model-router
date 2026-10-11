/** CPX Phase 0.1 (task 0.1.2): OpenCode v2 host-contract OBSERVATION smoke. Parts 1-2: scaffolding + contracts C1-C10.
 *
 *   RUN_OC_SMOKE_CPX=1 OPENCODE_V2_BIN=<abs path to opencode 2> npm run smoke:cpx
 *
 * Gate: RUN_OC_SMOKE_CPX=1. Unset: every test of the file is skipped. Set without OPENCODE_V2_BIN: one test fails hard (`Set OPENCODE_V2_BIN ...`)
 * and the contract scenarios stay skipped (the harness would otherwise fall back to whatever `opencode` is on PATH, possibly a v1).
 *
 * Observation mode: each scenario drives the REAL host (RoutingHost + keyless scripted provider behind a CpxFront) with the test-only probe
 * plugin (test/smoke/probe/cpx-probe-plugin.js) loaded through HostOptions.extraPlugins, records what the host did, writes
 * `<OBS_DIR>/C<n>.json` BEFORE asserting, and asserts only that the scenario ran and wrote its observation (the probe loaded in every host).
 * The decided-branch assertions are pinned later (task 0.1.6, ADR 0007). A scenario that throws still writes what it saw (`scenarioError`).
 *
 * Probe wiring: RoutingHost builds the host env from an allowlist, so CPX_PROBE_* cannot travel from the test process. The generated
 * `server.mjs` of the wrapper directory starts with `process.env.CPX_PROBE_* = ...` lines (the host loads native plugins in-process; only
 * `node:` modules are imported, so the assignments run before the probe reads its env), followed by the unchanged probe source. One host
 * per scenario, so the config is fixed per host (it also survives `RoutingHost.restart()`).
 *
 * Output: OBS_DIR = `<OMR_CPX_PROBE_DIR | OMR_SMOKE_REAL_TMPDIR | os.tmpdir()>/omr-cpx-probe`. The smoke globalSetup (test/setup/smoke-tmp-guard.ts)
 * points TEMP at a per-run directory it deletes at the end, so the REAL temp directory it recorded is used (same as role-spikes); both
 * paths are written into every C<n>.json (`obsDir`, `vitestTmpdir`). One probe JSON-lines file per host and run:
 * `<OBS_DIR>/<tag>-<runId>.probe.jsonl`; one summary per contract: `<OBS_DIR>/C<n>.json`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import type { CpxFront, CpxRequest, FaultKind } from "./helpers/cpx-scripted-provider";
import {
  RoutingHost, ROOT, agentWithoutModel, arr, clip, obj, redact, stopAllHosts, str, waitFor, type Dispatched, type HostOptions, type Obj,
} from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_CPX === "1";
const BIN = process.env.OPENCODE_V2_BIN;
const d = RUN && BIN ? describe : describe.skip;
const PROBE_SOURCE = path.join(ROOT, "test", "smoke", "probe", "cpx-probe-plugin.js");
const RUN_ID = randomUUID().slice(0, 8);
const CHILD = "cpx-child";
const SONNET = "anthropic/claude-sonnet-5-5";
/** Completion envelope of a background child as the host writes it (`<subagent sessionID="..." state="...">`); the probe uses the same pattern. */
const ENVELOPE = /<subagent\s+sessionID=/;
/** Text the probe's `rewrite-completion` mode puts in place of the envelope. */
const PLACEHOLDER = "held \u2014 verdict pending (probe)";
const MARKER = /CPX_TAIL_MARKER/;
const CHILD_ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
/** Verification off, so the router does not rewrite `background: true` into a foreground call (role-spikes S6B); engine shadow as everywhere. */
const BASE: HostOptions = { routing: { engine: "shadow" }, overrides: { enforcement: { mode: "off" } }, hostConfig: { agents: { [CHILD]: agentWithoutModel() } } };

type ProbeMode = "rewrite-completion" | "append-tail-system" | "append-tail-user" | "append-tail-newest" | "cache-hint-1h" | "filter-grep" | "mutate-subagent-prompt" | "rewrite-compaction" | "retained-launch";
/** One probe JSON line: `{ t, kind, ...fields }` (see cpx-probe-plugin.js). */
interface ProbeLine extends Obj { t: number; kind: string }

if (RUN && !BIN) {
  it("requires OPENCODE_V2_BIN", () => {
    throw new Error("Set OPENCODE_V2_BIN to the absolute path of the OpenCode v2 executable (RUN_OC_SMOKE_CPX=1 is set)");
  });
}

// ----------------------------------------------------------------------- scaffolding ----
const scratch: string[] = [];
afterAll(async () => {
  await stopAllHosts();
  for (const dir of scratch.splice(0)) await removeDirWhenReleased(dir);
}, 120_000);

/** Directory of the observations (see the file header); created on first use. */
async function obsDir(): Promise<string> {
  const dir = path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-probe");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `OPENCODE_V2_BIN --version`: the scenario's host version record. */
function hostVersion(): string {
  const result = spawnSync(BIN ?? "", ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  return `${result.stdout.trim()}${result.stderr.trim() ? ` (stderr: ${result.stderr.trim()})` : ""}`;
}

/** The probe wrapped for loading by path: `<tmp>/cpx-probe/{package.json,server.mjs}`; server.mjs = `process.env` assignments + the probe source. */
async function writeProbePlugin(out: string, mode: ProbeMode | undefined, extraEnv: Readonly<Record<string, string>> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-cpx-probe-plugin-"));
  scratch.push(dir);
  const plugin = path.join(dir, "cpx-probe");
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "cpx-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  await writeProbeServer(plugin, out, mode, extraEnv);
  return plugin;
}
/** (Re)writes `server.mjs` of a wrapped probe: the env preamble, then the unchanged probe source. */
async function writeProbeServer(plugin: string, out: string, mode: ProbeMode | undefined, extraEnv: Readonly<Record<string, string>>): Promise<void> {
  const env: Record<string, string> = { CPX_PROBE_OUT: out, ...(mode ? { CPX_PROBE_MODE: mode } : {}), ...extraEnv };
  const header = Object.entries(env).map(([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`).join("\n");
  await writeFile(path.join(plugin, "server.mjs"), `${header}\n${await readFile(PROBE_SOURCE, "utf8")}`);
}
/** Probe env that needs the host's project directory (known only once the host root exists): resolved in `HostOptions.prepare`, before the host process starts. */
type ProbeEnv = Readonly<Record<string, string>> | ((project: string) => Readonly<Record<string, string>>);

/** Reads a probe JSON-lines file (missing: no lines). A torn last line (write in flight) is skipped; any other error propagates. */
async function probeLines(file: string): Promise<ProbeLine[]> {
  if (!existsSync(file)) return [];
  const lines: ProbeLine[] = [];
  for (const text of (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean)) {
    try { lines.push(JSON.parse(text) as ProbeLine); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return lines;
}

/** Polls the probe file until `predicate` returns a value; throws on timeout (event-driven wait on the probe's own lines, no fixed sleeps). */
async function waitForProbe<T>(file: string, label: string, predicate: (lines: ProbeLine[]) => T | undefined, timeoutMs: number): Promise<T> {
  return waitFor(label, async () => predicate(await probeLines(file)), timeoutMs, 100);
}

/** `waitFor` that answers `undefined` on timeout (observation mode: "it did not happen" is a result); any other error propagates. */
async function tryWait<T>(label: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T | undefined> {
  try { return await waitFor(label, probe, timeoutMs, 100); } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for")) return undefined;
    throw error;
  }
}

/** Everything one contract records; written to `<OBS_DIR>/<id>.json` by {@link observeContract}. */
interface Observation { observed: Obj; relied: ProbeLine[]; hosts: Obj[] }
interface Scenario { host: RoutingHost; probeFile: string; tag: string }

/** Starts one host (probe + CpxFront), runs `body`, records the probe summary of the host, ALWAYS stops the host. */
async function withHost(tag: string, mode: ProbeMode | undefined, o: Observation, body: (s: Scenario) => Promise<void>, options: HostOptions = BASE, probeEnv: ProbeEnv = {}): Promise<void> {
  const probeFile = path.join(await obsDir(), `${tag}-${RUN_ID}.probe.jsonl`);
  await writeFile(probeFile, "");
  const plugin = await writeProbePlugin(probeFile, mode, typeof probeEnv === "function" ? {} : probeEnv);
  const prepare: HostOptions["prepare"] = async dirs => {
    await options.prepare?.(dirs);
    if (typeof probeEnv === "function") await writeProbeServer(plugin, probeFile, mode, probeEnv(dirs.project));
  };
  const host = await RoutingHost.start(`cpx-${tag.toLowerCase()}`, { ...options, prepare, extraPlugins: [...(options.extraPlugins ?? []), plugin], provider: options.provider ?? {} });
  try {
    await waitForProbe(probeFile, `the cpx-probe plugin to load (${tag})`, lines => lines.find(l => l.kind === "loaded"), 30_000);
    await body({ host, probeFile, tag });
  } finally {
    const lines = await probeLines(probeFile);
    const kinds: Record<string, number> = {};
    for (const line of lines) kinds[line.kind] = (kinds[line.kind] ?? 0) + 1;
    o.hosts.push({ tag, mode: mode ?? null, probeFile, probeLoaded: (kinds.loaded ?? 0) >= 1, probeKinds: kinds, probeErrors: clip(lines.filter(l => l.kind === "probe-error"), 800), hostErrors: clip(host.errorLines(), 400) });
    await host.stop();
  }
}

/** Runs one contract: `body` fills the observation; the file is written BEFORE any assertion (and also when `body` throws), then
 * the only assertions of this phase: the file exists and the probe loaded in every host. */
async function observeContract(id: string, body: (o: Observation) => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  const o: Observation = { observed: {}, relied: [], hosts: [] };
  let failure: unknown;
  try { await body(o); } catch (error) {
    failure = error;
    o.observed.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  const dir = await obsDir();
  const file = path.join(dir, `${id}.json`);
  const record = {
    contract: id, runId: RUN_ID, recordedAt: new Date().toISOString(), hostVersion: hostVersion(), obsDir: dir, vitestTmpdir: tmpdir(),
    durationMs: Date.now() - startedAt, hosts: o.hosts, probeLinesRelied: clip(o.relied, 1500), observed: clip(o.observed, 3000),
  };
  await writeFile(file, `${JSON.stringify(redact(record), null, 2)}\n`);
  console.log(`[cpx-host-contract] ${id} observation written to ${file}`);
  if (failure !== undefined) throw failure;
  expect(existsSync(file)).toBe(true);
  expect(o.hosts.length).toBeGreaterThan(0);
  expect(o.hosts.every(h => h.probeLoaded === true)).toBe(true);
}

// ----------------------------------------------------------------------- wire helpers ----
const hdr = (r: CpxRequest, name: string): string | undefined => { const v = r.headers[name]; return Array.isArray(v) ? v[0] : v; };
function front(host: RoutingHost): CpxFront {
  if (!host.front) throw new Error("host started without the CPX front");
  return host.front;
}
/** Provider requests of the primary agent loop of one session, as the front captured them (the probe's http.request hook adds the x-proof-* headers). */
const parentRequests = (host: RoutingHost, session: string): CpxRequest[] => front(host).requests.filter(r => hdr(r, "x-proof-session") === session && hdr(r, "x-proof-kind") === "primary");
const bodyMessages = (r: CpxRequest): Obj[] => arr(obj(r.body).messages).map(obj);
const hasToolResult = (m: Obj | undefined): boolean => arr(m?.content).map(obj).some(b => b.type === "tool_result");
const lastIsToolResult = (r: CpxRequest): boolean => hasToolResult(bodyMessages(r).at(-1));
const json = (value: unknown): string => JSON.stringify(value) ?? "";
const indexesWhere = (messages: Obj[], test: (text: string) => boolean): number[] => messages.flatMap((m, i) => (test(json(m)) ? [i] : []));
const envelopeMessages = (messages: Obj[]): Obj[] => messages.flatMap((m, i) => (ENVELOPE.test(json(m)) ? [{ index: i, role: str(m.role) ?? str(m.type), message: clip(m, 1200) }] : []));

function requestView(r: CpxRequest, arrivals: ReadonlyMap<number, number>): Obj {
  const messages = bodyMessages(r);
  return {
    index: r.index, arrivedAt: arrivals.get(r.index), served: r.served, messageCount: messages.length, lastRole: str(messages.at(-1)?.role), lastIsToolResult: lastIsToolResult(r),
    envelopeAt: indexesWhere(messages, t => ENVELOPE.test(t)), placeholderAt: indexesWhere(messages, t => t.includes(PLACEHOLDER)),
    markerAt: indexesWhere(messages, t => MARKER.test(t)), lastMessage: clip(messages.at(-1), 500),
  };
}

/** What the front does to requests: stamps each arrival and, once armed, holds the first TOOL-RESULT request of `session` for `ms`. */
interface Slow { session?: string; ms: number; armed: boolean; firedIndex?: number }
function instrument(host: RoutingHost): { arrivals: Map<number, number>; slow: Slow } {
  const arrivals = new Map<number, number>();
  const slow: Slow = { ms: 0, armed: false };
  front(host).options.delayMs = request => {
    arrivals.set(request.index, Date.now());
    if (!slow.armed || hdr(request, "x-proof-session") !== slow.session || !lastIsToolResult(request)) return 0;
    slow.armed = false;
    slow.firedIndex = request.index;
    return slow.ms;
  };
  return { arrivals, slow };
}

/** The stored history of a session as the host answers `session.context`: one summary per message plus the envelope messages in full. */
async function storedView(host: RoutingHost, session: string): Promise<{ messages: Obj[]; envelopes: Obj[] }> {
  const stored = await host.client.session.context({ sessionID: session });
  return {
    messages: stored.map((m, i) => ({ i, type: str(m.type), role: str(m.role), hasEnvelope: ENVELOPE.test(json(m)), hasPlaceholder: json(m).includes(PLACEHOLDER), hasMarker: MARKER.test(json(m)), snippet: json(m).slice(0, 240) })),
    envelopes: envelopeMessages(stored),
  };
}

// ------------------------------------------------------------------ background driver ----
interface Bg { root: string; call: Dispatched; childID?: string; ack: Obj; ackMs: number; parentCountAtIdle: number; idleAt: number }
/** One root turn whose scripted model calls `subagent` with `background: true` (child held `holdMs` on its first request); returns once the root is idle. */
async function launchBackground(s: Scenario, marker: string, holdMs: number, onRoot?: (root: string) => void): Promise<Bg> {
  const { host } = s;
  host.provider.holdMarked(marker, holdMs);
  const root = await host.newRoot(`${s.tag} root`);
  onRoot?.(root);
  const call = await host.call(root, "subagent", { agent: CHILD, description: `${s.tag} background`, prompt: `${marker} background child`, model: `${SONNET}#low`, background: true });
  return { root, call, childID: call.childID, ack: obj(call.after.result), ackMs: call.after.__t - call.before.__t, parentCountAtIdle: parentRequests(host, root).length, idleAt: Date.now() };
}

/** Waits for the terminal execution event of the child (probe line); falls back to `session.wait` and says so. */
async function awaitChildEnd(s: Scenario, childID: string | undefined, o: Observation): Promise<Obj> {
  if (!childID) return { source: "none", reason: "the acknowledgement carries no child sessionID" };
  const line = await tryWait(`terminal execution event of ${childID}`, async () => (await probeLines(s.probeFile)).find(l => CHILD_ENDED.has(l.kind) && l.sessionID === childID), 60_000);
  if (line) { o.relied.push(line); return { source: "probe", kind: line.kind, at: line.t }; }
  await s.host.settle(childID);
  return { source: "settle-fallback", at: Date.now() };
}

/** After the child ended: did a NEW parent provider request arrive although nobody prompted the parent? Waits for that root to be idle again. */
async function observeWake(s: Scenario, bg: Bg, ms: number): Promise<CpxRequest | undefined> {
  const woke = await tryWait("a parent provider request after the background child ended", () => parentRequests(s.host, bg.root)[bg.parentCountAtIdle], ms);
  if (woke) await s.host.settle(bg.root);
  return woke;
}

/** Probe lines of the given kinds about one session (`sessionID` field). */
const linesOf = (lines: readonly ProbeLine[], session: string | undefined, ...kinds: string[]): ProbeLine[] => lines.filter(l => l.sessionID === session && (kinds.length === 0 || kinds.includes(l.kind)));
/** A probe line reduced to what identifies it (kind, time, ids, the event's scalar data and error). */
const lineBrief = (l: ProbeLine): Obj => ({ kind: l.kind, t: l.t, eventID: l.eventID, sessionID: l.sessionID, parentID: l.parentID, agent: l.agent, data: l.data, error: l.error });

const executeAfterOf = (lines: readonly ProbeLine[], callID: string): ProbeLine[] => lines.filter(l => l.kind === "execute.after" && l.tool === "subagent" && l.callID === callID);

// ---------------------------------------------------------------------------- C1 ----
d("C1 background subagent: immediate running acknowledgement, one execute.after", () => {
  it("records the ack and counts execute.after for the call id", async () => {
    await observeContract("C1", async o => {
      await withHost("C1", undefined, o, async s => {
        const bg = await launchBackground(s, "C1_HOLD", 2_000);
        const atAck = executeAfterOf(await probeLines(s.probeFile), bg.call.callID);
        const childEnd = await awaitChildEnd(s, bg.childID, o);
        const wake = await observeWake(s, bg, 15_000); // the host's completion handling has run by then: a duplicate execute.after would show
        const lines = await probeLines(s.probeFile);
        const after = executeAfterOf(lines, bg.call.callID);
        o.relied.push(...after);
        const output = obj(bg.ack.output);
        o.observed.ack = {
          exactResult: clip(bg.ack, 1500), status: output.status, sessionID: output.sessionID, matchesChildID: output.sessionID === bg.childID,
          returnedMs: bg.ackMs, hostSawBackground: obj(bg.call.before.input).background, probeAckShape: clip(after[0], 800),
        };
        o.observed.executeAfter = {
          callID: bg.call.callID, probeCountAtAck: atAck.length, probeCountFinal: after.length,
          harnessCount: (await s.host.hooks()).filter(h => h.hook === "after" && h.callID === bg.call.callID).length,
          childEnd, parentWokeAfterChildEnd: wake !== undefined,
        };
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C2 ----
d("C2 background completion: injected into the parent, idle parent woken", () => {
  it("records the completion shape and whether an idle parent gets a new request unprompted", async () => {
    await observeContract("C2", async o => {
      await withHost("C2", undefined, o, async s => {
        const { arrivals } = instrument(s.host);
        const bg = await launchBackground(s, "C2_HOLD", 2_000);
        const childEnd = await awaitChildEnd(s, bg.childID, o);
        const wake = await observeWake(s, bg, 30_000);
        const lines = await probeLines(s.probeFile);
        const rootExecution = lines.filter(l => l.kind.startsWith("session.execution.") && l.sessionID === bg.root);
        o.relied.push(...rootExecution);
        const requests = parentRequests(s.host, bg.root);
        const stored = await storedView(s.host, bg.root);
        o.observed.completion = {
          childEnd, userPromptsAfterAck: 0, parentRequestsAtIdle: bg.parentCountAtIdle, parentRequestsFinal: requests.length, parentWoke: wake !== undefined,
          wakeArrivedAt: wake ? arrivals.get(wake.index) : undefined,
          wakeMsAfterChildEnd: wake && typeof childEnd.at === "number" ? (arrivals.get(wake.index) ?? NaN) - childEnd.at : undefined,
          rootExecutionEvents: rootExecution.map(l => ({ kind: l.kind, t: l.t })),
          wireEnvelope: wake ? envelopeMessages(bodyMessages(wake)) : [], storedEnvelope: stored.envelopes,
        };
        o.observed.parentRequests = requests.map(r => requestView(r, arrivals));
        o.observed.storedHistory = stored.messages;
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C3 ----
d("C3 background completion while the parent is mid-turn", () => {
  it("records where a completion that arrives during a slow parent request shows up", async () => {
    await observeContract("C3", async o => {
      await withHost("C3", undefined, o, async s => {
        const { arrivals, slow } = instrument(s.host);
        // The parent's request that carries the ack's tool result is held 8 s; the child (first request held 1.5 s) ends during it.
        const bg = await launchBackground(s, "C3_HOLD", 1_500, root => { Object.assign(slow, { session: root, ms: 8_000, armed: true }); });
        const childEnd = await awaitChildEnd(s, bg.childID, o);
        const delivered = await tryWait("a parent request carrying the completion", () => parentRequests(s.host, bg.root).find(r => ENVELOPE.test(json(bodyMessages(r)))), 30_000);
        await s.host.settle(bg.root);
        const requests = parentRequests(s.host, bg.root);
        const slowRequest = requests.find(r => r.index === slow.firedIndex);
        const slowAt = slowRequest ? arrivals.get(slowRequest.index) : undefined;
        const stored = await storedView(s.host, bg.root);
        o.observed.midTurn = {
          slowRequestIndex: slow.firedIndex, slowArrivedAt: slowAt, slowReleaseAt: slowAt === undefined ? undefined : slowAt + slow.ms, childEnd,
          childEndedDuringSlowRequest: slowAt !== undefined && typeof childEnd.at === "number" && childEnd.at >= slowAt && childEnd.at < slowAt + slow.ms,
          ackSettledBeforeSlowRelease: slowAt === undefined ? undefined : bg.idleAt >= slowAt + slow.ms,
        };
        o.observed.delivery = {
          deliveredInProviderRequest: delivered !== undefined, firstDeliveryRequestIndex: delivered?.index, lostFromWire: delivered === undefined,
          storedHasEnvelope: stored.envelopes.length > 0, storedEnvelope: stored.envelopes,
        };
        o.observed.parentRequests = requests.map(r => requestView(r, arrivals));
        o.observed.storedHistory = stored.messages;
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C4 ----
d("C4 context hook sees and rewrites the completion message", () => {
  it("records the hook's view, the provider body with the placeholder and the stored original", async () => {
    await observeContract("C4", async o => {
      await withHost("C4", "rewrite-completion", o, async s => {
        const { arrivals } = instrument(s.host);
        const bg = await launchBackground(s, "C4_HOLD", 1_500);
        const childEnd = await awaitChildEnd(s, bg.childID, o);
        const wake = await observeWake(s, bg, 30_000);
        await s.host.prompt(bg.root, "C4 follow-up"); // a second request: does the rewrite repeat while the stored original stays?
        const lines = await probeLines(s.probeFile);
        const contexts = lines.filter(l => l.kind === "context" && l.sessionID === bg.root);
        const sawCompletion = contexts.filter(l => ENVELOPE.test(json(l.messages)));
        const rewrites = lines.filter(l => l.kind === "rewrite-completion");
        o.relied.push(...sawCompletion.slice(0, 2), ...rewrites.slice(0, 3));
        const requests = parentRequests(s.host, bg.root);
        const stored = await storedView(s.host, bg.root);
        o.observed.hook = {
          childEnd, parentWokeUnprompted: wake !== undefined, usedFollowUpPrompt: true,
          contextCallsForParent: contexts.length, contextCallsWithEnvelope: sawCompletion.length,
          firstSeen: sawCompletion[0] ? { requestNo: sawCompletion[0].requestNo, messageCount: sawCompletion[0].messageCount, messages: clip(sawCompletion[0].messages, 600) } : null,
          rewriteLines: rewrites.map(l => ({ requestNo: l.requestNo, did: l.did, replaced: l.replaced })),
        };
        o.observed.providerBodies = requests.map(r => requestView(r, arrivals));
        o.observed.rawEnvelopeInAnyProviderBody = requests.some(r => ENVELOPE.test(json(bodyMessages(r))));
        o.observed.placeholderInProviderBodies = requests.filter(r => json(bodyMessages(r)).includes(PLACEHOLDER)).map(r => r.index);
        o.observed.stored = { originalKept: stored.envelopes.length > 0, placeholderPersisted: stored.messages.some(m => m.hasPlaceholder === true), envelopes: stored.envelopes, history: stored.messages };
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C5 ----
const hasMarker = (value: unknown): boolean => MARKER.test(json(value));
/** Drops the tail marker from a request's messages (a whole message when it holds only the marker) and from its system field. */
function stripMarkers(body: Obj): { messages: Obj[]; system: unknown; rest: string } {
  const messages = arr(body.messages).map(obj).flatMap(m => {
    if (!hasMarker(m)) return [m];
    const kept = arr(m.content).filter(block => !hasMarker(block));
    return kept.length === 0 ? [] : [{ ...m, content: kept }];
  });
  const system = Array.isArray(body.system) ? body.system.filter(block => !hasMarker(block)) : typeof body.system === "string" ? body.system.replace(/CPX_TAIL_MARKER \d+/g, "") : body.system;
  const { messages: _m, system: _s, ...rest } = body;
  return { messages, system, rest: json(rest) };
}
function markerPaths(value: unknown, at = "$", out: string[] = []): string[] {
  if (typeof value === "string") { if (MARKER.test(value)) out.push(at); } else if (Array.isArray(value)) value.forEach((v, i) => markerPaths(v, `${at}[${i}]`, out));
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) markerPaths(v, `${at}.${k}`, out);
  return out;
}
/** Element-wise comparison of `a` (the earlier request, marker stripped) against the same-length prefix of `b`; reports the first differing character. */
function prefixDiff(a: Obj[], b: Obj[]): Obj {
  for (let i = 0; i < a.length; i += 1) {
    const x = json(a[i]);
    const y = i < b.length ? json(b[i]) : undefined;
    if (x === y) continue;
    let at = 0;
    while (y !== undefined && at < x.length && x[at] === y[at]) at += 1;
    return { identical: false, compared: a.length, firstDiff: { messageIndex: i, charOffset: at, earlier: x.slice(Math.max(0, at - 60), at + 80), later: y === undefined ? "(absent)" : y.slice(Math.max(0, at - 60), at + 80) } };
  }
  return { identical: true, compared: a.length };
}

d("C5 context-hook tail: sent to the provider, not persisted, earlier prefix byte-identical", () => {
  it("records, for system / user / newest-part tails, the wire placement, persistence and the prefix comparison of two consecutive requests", async () => {
    await observeContract("C5", async o => {
      const variants: Obj = {};
      o.observed.variants = variants;
      for (const [name, mode] of [["system", "append-tail-system"], ["user", "append-tail-user"], ["newest", "append-tail-newest"]] as const) {
        await withHost(`C5-${name}`, mode, o, async s => {
          const { arrivals } = instrument(s.host);
          const root = await s.host.newRoot(`C5 ${name} root`);
          await s.host.prompt(root, "C5 first turn");
          await s.host.prompt(root, "C5 second turn");
          const requests = parentRequests(s.host, root);
          const tails = (await probeLines(s.probeFile)).filter(l => l.kind === mode && l.sessionID === root);
          o.relied.push(...tails.slice(0, 3));
          const stored = await storedView(s.host, root);
          const view: Obj = {
            probeMode: mode, tailLines: tails.map(l => ({ requestNo: l.requestNo, marker: l.marker, role: l.role, did: l.did, index: l.index })),
            parentRequests: requests.map(r => requestView(r, arrivals)), storedHasMarker: stored.messages.some(m => m.hasMarker === true), storedHistory: stored.messages,
          };
          const [first, second] = requests;
          if (first && second) {
            const a = stripMarkers(obj(first.body));
            const b = stripMarkers(obj(second.body));
            const secondText = json(second.body);
            view.wire = {
              firstMarkerPaths: markerPaths(first.body), secondMarkerPaths: markerPaths(second.body),
              firstMarkerSent: hasMarker(first.body), secondMarkerSent: hasMarker(second.body),
              firstMarkerStillInSecond: tails[0]?.marker !== undefined && secondText.includes(String(tails[0].marker)),
            };
            view.prefix = {
              messages: prefixDiff(a.messages, b.messages), systemIdentical: json(a.system) === json(b.system), otherFieldsIdentical: a.rest === b.rest,
              earlierMessageCount: a.messages.length, laterMessageCount: b.messages.length,
            };
          } else view.prefix = { skipped: `only ${requests.length} primary request(s) captured` };
          variants[name] = view;
        });
      }
    });
  }, 600_000);
});

// ------------------------------------------------------------------ batch 2 helpers ----
/** Every object key matching `key` anywhere in `value`, with its JSON path and value. */
function findKeys(value: unknown, key: RegExp, at = "$", out: Obj[] = []): Obj[] {
  if (Array.isArray(value)) value.forEach((v, i) => findKeys(v, key, `${at}[${i}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (key.test(k)) out.push({ path: `${at}.${k}`, value: v });
      findKeys(v, key, `${at}.${k}`, out);
    }
  }
  return out;
}
/** JSON paths of every string value matching `re`. */
function stringPaths(value: unknown, re: RegExp, at = "$", out: string[] = []): string[] {
  if (typeof value === "string") { if (re.test(value)) out.push(at); } else if (Array.isArray(value)) value.forEach((v, i) => stringPaths(v, re, `${at}[${i}]`, out));
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) stringPaths(v, re, `${at}.${k}`, out);
  return out;
}
/** Waits (bounded) until the session has left the host's active set; `undefined` when it is still active. */
const waitIdle = (host: RoutingHost, session: string, ms: number): Promise<true | undefined> => tryWait(`${session} to leave the active set`, async () => (Object.hasOwn(await host.client.session.active(), session) ? undefined : true), ms);
/** First probe line of a terminal execution event for `session` (optionally only lines after `since`). */
const terminalOf = (lines: readonly ProbeLine[], session: string, since = 0): ProbeLine | undefined => lines.find(l => CHILD_ENDED.has(l.kind) && l.sessionID === session && l.t >= since);

// ---------------------------------------------------------------------------- C6 ----
d("C6 one-hour cache hint set by a plugin in the context hook", () => {
  it("records what the probe tried and every cache_control the provider request carries", async () => {
    await observeContract("C6", async o => {
      await withHost("C6", "cache-hint-1h", o, async s => {
        const { arrivals } = instrument(s.host);
        const root = await s.host.newRoot("C6 root");
        await s.host.prompt(root, "C6 first turn");
        await s.host.prompt(root, "C6 second turn");
        const lines = await probeLines(s.probeFile);
        const hints = lines.filter(l => l.kind === "cache-hint-1h");
        const shape = lines.find(l => l.kind === "context-shape");
        o.relied.push(...hints.slice(0, 2), ...(shape ? [shape] : []));
        const requests = parentRequests(s.host, root);
        const views = requests.map(r => {
          const body = obj(r.body);
          const occurrences = findKeys(body, /^cache_?control$/i);
          return {
            index: r.index, arrivedAt: arrivals.get(r.index), anthropicBeta: hdr(r, "anthropic-beta"), topLevelKeys: Object.keys(body),
            systemType: Array.isArray(body.system) ? "array" : typeof body.system, systemBlocks: arr(body.system).length,
            cacheControl: occurrences, ttl: findKeys(body, /^ttl$/), oneHourStrings: stringPaths(body, /^1h$/),
            systemCacheControl: occurrences.filter(c => String(c.path).startsWith("$.system")),
            oneHourOnSystem: occurrences.some(c => String(c.path).startsWith("$.system") && /"ttl":"1h"/.test(json(c.value))),
          };
        });
        o.observed.probeTried = hints.map(l => ({ requestNo: l.requestNo, did: l.did, via: l.via, set: l.set, partKeys: l.partKeys, reason: l.reason }));
        o.observed.contextShape = shape ? { eventKeys: shape.eventKeys, systemPartKeys: shape.systemPartKeys, messageKeys: shape.messageKeys, partKeys: shape.partKeys, optionKeys: shape.optionKeys } : null;
        o.observed.requests = views;
        o.observed.providerCarriesOneHourOnSystem = views.some(v => v.oneHourOnSystem);
        o.observed.providerCarriesOneHourAnywhere = views.some(v => v.cacheControl.some(c => /"ttl":"1h"/.test(json(c.value))) || v.oneHourStrings.length > 0);
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C7 ----
/** `<subagent sessionID="…" state="…">` pairs found in the JSON text of stored messages (quotes may be JSON-escaped). */
const envelopeStates = (value: unknown): Obj[] => [...json(value).matchAll(/<subagent\s+sessionID=\\?"([^"\\]+)\\?"\s+state=\\?"([^"\\]+)\\?"/g)].map(m => ({ sessionID: m[1], state: m[2] }));
const textsOf = (m: Obj): string[] => findKeys(m, /^(text|content|output)$/).map(k => k.value).filter((v): v is string => typeof v === "string");

d("C7 child terminal events carry the child id; the context reads back the final text", () => {
  it("records succeeded / failed / interrupted children: events, retries, context text", async () => {
    await observeContract("C7", async o => {
      await withHost("C7", undefined, o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        host.provider.holdMarked("C7_HOLD", 8_000);
        const root = await host.newRoot("C7 root");
        // Failure mechanism: the FRONT answers every provider request of the C7_FAIL child (non-root session, last message carries the token) with HTTP 400
        // `invalid_request_error` (fault kind "invalid-request", non-retryable, never forwarded). The fixture behind it raises no error, so `callMany`'s
        // "scripted provider error" abort can never fire; the number of fault answers served is the host's attempt count for that child.
        const failChild = (r: CpxRequest): boolean => hdr(r, "x-proof-session") !== root && hdr(r, "x-proof-kind") === "primary" && json(bodyMessages(r).at(-1)).includes("C7_FAIL");
        front(host).failWhen(failChild, "invalid-request", { times: Number.POSITIVE_INFINITY });
        const child = (token: string, extra = ""): Obj => ({ agent: CHILD, description: `C7 ${token}`, prompt: `C7_HOLD ${token}${extra}`, model: `${SONNET}#low`, background: true });
        const calls = await host.callMany(root, [child("C7_OK"), child("C7_FAIL"), child("C7_INT")]);
        const ids = Object.fromEntries(["C7_OK", "C7_FAIL", "C7_INT"].map(token => [token, calls.find(c => str(obj(c.before.input).prompt)?.includes(token))?.childID]));
        o.observed.children = ids;
        const intID = ids.C7_INT;
        if (!intID) throw new Error("no child sessionID for C7_INT in the acknowledgement");
        const held = await tryWait("the interrupt child's held provider request", () => host.provider.holds.find(h => h.session === intID && h.releasedAt === undefined), 30_000);
        const interruptAt = Date.now();
        let interruptResult: unknown;
        let interruptError: string | undefined;
        try { interruptResult = await host.client.session.interrupt({ sessionID: intID }); } catch (error) { interruptError = String(error); }
        o.observed.interrupt = { api: "host.client.session.interrupt({ sessionID })", heldWhenCalled: held !== undefined, calledAt: interruptAt, result: clip(interruptResult, 500), error: interruptError };
        const perChild: Obj = {};
        for (const [token, id] of Object.entries(ids)) {
          if (!id) { perChild[token] = { error: "no sessionID" }; continue; }
          const end = await tryWait(`terminal execution event of ${token}`, async () => terminalOf(await probeLines(s.probeFile), id), 90_000);
          if (end) o.relied.push(end);
          const lines = linesOf(await probeLines(s.probeFile), id);
          const context = await host.client.session.context({ sessionID: id });
          const finalMessage = context.at(-1);
          const info = await host.client.session.get({ sessionID: id }).then(g => ({ outcome: g.outcome, cost: g.cost, tokens: g.tokens, agent: g.agent, parentID: g.parentID }), error => ({ error: String(error) }));
          const requests = front(host).requests.filter(r => hdr(r, "x-proof-session") === id);
          perChild[token] = {
            sessionID: id, terminal: end ? { kind: end.kind, t: end.t, eventID: end.eventID, sessionID: end.sessionID, parentID: end.parentID, agent: end.agent, data: end.data, error: end.error } : null,
            allProbeLines: lines.map(lineBrief), eventTypes: (await host.eventsOf(id)).map(e => e.type), session: info,
            context: { messageCount: context.length, finalMessage: clip(finalMessage, 800), finalTexts: finalMessage ? textsOf(finalMessage).map(t => t.slice(0, 300)) : [], containsChildOk: json(context).includes("CHILD_OK"), roles: context.map(m => str(m.role) ?? str(m.type)) },
            providerRequests: requests.map(r => ({ index: r.index, arrivedAt: arrivals.get(r.index), served: r.served, toolNames: arr(obj(r.body).tools).map(t => str(obj(t).name)) })),
          };
        }
        o.observed.perChild = perChild;
        o.observed.fixtureErrors = host.provider.errors.map(e => e.slice(0, 300));
        const failServed = front(host).requests.filter(r => r.served === "invalid-request");
        o.observed.failure = {
          mechanism: "CpxFront.failWhen(<non-root, primary, last message carries C7_FAIL>, \"invalid-request\", { times: Infinity }): HTTP 400 invalid_request_error answered by the front",
          faultAnswersServed: failServed.length, hostAttemptsForFailChild: failServed.map(r => ({ index: r.index, arrivedAt: arrivals.get(r.index), session: hdr(r, "x-proof-session") })),
          retriedByHost: failServed.length > 1, pendingFaultEntries: front(host).pendingFaults,
        };
        front(host).clearFaults();
        // The parent: which completion envelopes (and states) did it get?
        const stored = await tryWait("three completion envelopes in the parent", async () => { const v = await storedView(host, root); return envelopeStates(v.envelopes).length >= 3 ? v : undefined; }, 30_000);
        const view = stored ?? await storedView(host, root);
        o.observed.parentCompletions = { allThreeStored: stored !== undefined, states: envelopeStates(view.envelopes), envelopes: view.envelopes };
        o.observed.rootIdle = (await waitIdle(host, root, 30_000)) === true;
      });
    });
  }, 600_000);
});

// ---------------------------------------------------------------------------- C8 ----
interface BackgroundApi { background(input: { sessionID: string }): Promise<void> }
/** `host.client.session.background` (@opencode/client SessionBackgroundInput = { sessionID }); absent from the harness's HostClient type, so it is looked up at run time. */
function backgroundApi(host: RoutingHost): BackgroundApi | undefined {
  const session: object = host.client.session;
  const method: unknown = Reflect.get(session, "background");
  if (typeof method !== "function") return undefined;
  return { background: async input => { await Reflect.apply(method, session, [input]); } };
}
const sansIDs = (value: unknown): string => json(value).replace(/ses_[A-Za-z0-9]+/g, "<id>");

d("C8 a user-backgrounded running subagent gets the same running acknowledgement", () => {
  it("moves a held foreground subagent to the background through the client and records its execute.after", async () => {
    await observeContract("C8", async o => {
      await withHost("C8", undefined, o, async s => {
        const { host } = s;
        host.provider.holdMarked("C8_HOLD", 6_000);
        const root = await host.newRoot("C8 root");
        const api = backgroundApi(host);
        o.observed.api = { found: api !== undefined, via: "host.client.session.background({ sessionID })", sessionMethods: Object.keys(host.client.session), looked: ["host.client.session (runtime)", "@opencode/client dist/promise/generated/client.d.ts:79 SessionBackgroundInput", "no HTTP post helper on RoutingHost (getJson is GET only)"] };
        const input = { agent: CHILD, description: "C8 foreground", prompt: "C8_HOLD foreground child", model: `${SONNET}#low`, background: false };
        await host.client.session.prompt({ sessionID: root, text: `SPIKE_CALL=${JSON.stringify(input)}` });
        const before = await waitForProbe(s.probeFile, "execute.before of the foreground subagent", ls => ls.find(l => l.kind === "execute.before" && l.tool === "subagent" && l.sessionID === root), 30_000);
        const held = await tryWait("the foreground child's held provider request", () => host.provider.holds.find(h => h.session !== undefined && h.session !== root && h.releasedAt === undefined), 30_000);
        const childID = held?.session;
        const callID = str(before.callID) ?? "";
        const calledAt = Date.now();
        const attempts: Obj[] = [];
        if (api) {
          for (const [target, id] of [["parent", root], ["child", childID]] as const) {
            if (!id) continue;
            try { await api.background({ sessionID: id }); attempts.push({ target, sessionID: id, ok: true }); break; } catch (error) { attempts.push({ target, sessionID: id, ok: false, error: String(error) }); }
          }
        }
        const after = await tryWait("execute.after of the foreground subagent call", async () => executeAfterOf(await probeLines(s.probeFile), callID)[0], 60_000);
        const childEnd = childID ? await tryWait(`terminal execution event of ${childID}`, async () => terminalOf(await probeLines(s.probeFile), childID), 60_000) : undefined;
        if (after) o.relied.push(after);
        const harnessAfter = (await host.hooks()).filter(h => h.hook === "after" && h.callID === callID);
        o.observed.background = {
          callID, childID, heldWhenMoved: held !== undefined, calledAt, attempts, apiAbsent: api === undefined,
          executeAfter: after ? { ...lineBrief(after), status: after.status, resultStatus: after.resultStatus, resultSessionID: after.resultSessionID, resultKeys: after.resultKeys, contentText: after.contentText, outputText: after.outputText, afterMs: after.t - calledAt } : null,
          harnessAfterCount: harnessAfter.length, harnessResult: clip(harnessAfter[0]?.result, 1200), childEndAt: childEnd?.t,
          afterBeforeChildEnd: after && childEnd ? after.t < childEnd.t : undefined,
        };
        await waitIdle(host, root, 60_000);
        // Control: the C1 style background:true call with the same fixtures; is its acknowledgement the same?
        const root2 = await host.newRoot("C8 control root");
        const control = await host.call(root2, "subagent", { ...input, description: "C8 control", prompt: "C8_HOLD control child", background: true });
        const controlOutput = obj(control.after.result?.output);
        const movedOutput = obj(harnessAfter[0]?.result?.output);
        o.observed.comparisonWithC1Ack = {
          controlResult: clip(control.after.result, 1000), controlStatus: controlOutput.status, movedStatus: movedOutput.status,
          sameStatus: controlOutput.status === movedOutput.status, sameShapeModuloIds: sansIDs(control.after.result) === sansIDs(harnessAfter[0]?.result),
        };
        await awaitChildEnd(s, control.childID, o);
        await waitIdle(host, root2, 60_000);
      });
    });
  }, 600_000);
});

// ---------------------------------------------------------------------------- C9 ----
const PATH_TOOLS = new Set(["glob", "grep", "list"]);
/** The tool input for the scripted call: keys are taken from the advertised schema (`props`) when the host lists the tool, else the common names. */
function toolInput(tool: string, props: readonly string[], project: string): Obj {
  const pick = (...names: string[]): string => names.find(n => props.includes(n)) ?? names[0]!;
  const input: Obj = {};
  const file = path.join(project, tool === "write" ? "written.txt" : tool === "edit" || tool === "multiedit" ? "edit-me.txt" : "visible.txt");
  if (tool === "router_run") return { script: "typecheck", cwd: project };
  input[pick("filePath", "file_path", "path")] = PATH_TOOLS.has(tool) ? project : file;
  if (tool === "glob") input[pick("pattern")] = "*.txt";
  if (tool === "grep") input[pick("pattern")] = "row";
  if (tool === "write") input[pick("content")] = "written by C9\n";
  if (tool === "edit") { input[pick("oldString", "old_string")] = "alpha"; input[pick("newString", "new_string")] = "beta"; }
  if (tool === "multiedit") input[pick("edits")] = [{ oldString: "alpha", newString: "beta" }];
  if (tool === "patch" || tool === "apply_patch") return { [pick("patchText", "patch", "input")]: "*** Begin Patch\n*** End Patch" };
  return input;
}
/** Text of the tool_result blocks in the LAST message of a provider request: what the model was handed back. */
function toolResultText(r: CpxRequest): string {
  const last = bodyMessages(r).at(-1);
  return arr(last?.content).map(obj).filter(b => b.type === "tool_result").map(b => (typeof b.content === "string" ? b.content : arr(b.content).map(c => str(obj(c).text) ?? "").join("\n"))).join("\n");
}

d("C9 tool hooks: execute.before paths, execute.after result rewriting", () => {
  it("drives read/write/edit/glob/grep/list/router_run (and multiedit/patch/apply_patch if advertised) and records the args and the filtered results", async () => {
    await observeContract("C9", async o => {
      await withHost("C9", "filter-grep", o, async s => {
        const { host } = s;
        const project = host.project;
        await writeFile(path.join(project, "CPX_LEASED-a.txt"), "other content\n");
        await writeFile(path.join(project, "visible.txt"), "CPX_LEASED row\nkept row\n");
        await writeFile(path.join(project, "edit-me.txt"), "alpha\n");
        await mkdir(path.join(project, "sub"), { recursive: true });
        await writeFile(path.join(project, "sub", "inner.txt"), "inner row\n");
        const root = await host.newRoot("C9 root");
        await host.prompt(root, "C9 warmup"); // the first request lists the tools the host advertises
        const defs = new Map(arr(obj(parentRequests(host, root)[0]?.body).tools).map(obj).map(t => [str(t.name) ?? "", Object.keys(obj(obj(t.input_schema).properties))] as const));
        o.observed.advertisedTools = Object.fromEntries(defs);
        const wanted = ["read", "write", "edit", "glob", "grep", "list", "router_run", ...["multiedit", "patch", "apply_patch"].filter(t => defs.has(t))];
        const perTool: Obj = {};
        o.observed.perTool = perTool;
        for (const tool of wanted) {
          const input = toolInput(tool, defs.get(tool) ?? [], project);
          const startedAt = Date.now();
          let promptError: string | undefined;
          try { await host.prompt(root, `READ_ONLY_PROBE=${JSON.stringify({ tool, input })}`); } catch (error) { promptError = String(error); }
          const lines = (await probeLines(s.probeFile)).filter(l => l.tool === tool && l.sessionID === root && l.t >= startedAt);
          const before = lines.find(l => l.kind === "execute.before");
          const after = lines.find(l => l.kind === "execute.after");
          const filter = after ? (await probeLines(s.probeFile)).find(l => l.kind === "filter-grep" && l.callID === after.callID) : undefined;
          o.relied.push(...[before, after, filter].filter((l): l is ProbeLine => l !== undefined));
          const seen = parentRequests(host, root).filter(r => lastIsToolResult(r)).at(-1);
          const modelText = seen ? toolResultText(seen) : undefined;
          perTool[tool] = {
            advertised: defs.has(tool), inputSent: input, promptError,
            executeBefore: before ? { argKeys: before.argKeys, args: before.args, agent: before.agent } : null,
            executeAfter: after ? { status: after.status, resultKeys: after.resultKeys, contentText: after.contentText, outputText: after.outputText, error: after.error } : null,
            filter: filter ? { mutable: filter.mutable, removedLines: filter.removedLines, error: filter.error, note: filter.note } : null,
            modelSaw: modelText === undefined ? null : { text: modelText.slice(0, 500), containsLeased: modelText.includes("CPX_LEASED"), containsHiddenNote: modelText.includes("[cpx: 1 hidden]"), requestIndex: seen?.index },
            probeSawLeasedBeforeFilter: after ? json([after.contentText, after.outputText]).includes("CPX_LEASED") : undefined,
          };
        }
        o.observed.fixtureErrors = host.provider.errors.map(e => e.slice(0, 300));
      });
    });
  }, 900_000);
});

// --------------------------------------------------------------------------- C10 ----
interface FaultCase { name: string; kind: FaultKind; mode: "once" | "persistent" | "until-reset"; capMs: number }
const FAULT_CASES: readonly FaultCase[] = [
  { name: "rate-limit-once", kind: "rate-limit", mode: "once", capMs: 90_000 },
  { name: "overloaded-once", kind: "overloaded", mode: "once", capMs: 90_000 },
  { name: "rate-limit-persistent", kind: "rate-limit", mode: "persistent", capMs: 75_000 },
  { name: "overloaded-persistent", kind: "overloaded", mode: "persistent", capMs: 75_000 },
  { name: "usage-limit-until-reset", kind: "usage-limit", mode: "until-reset", capMs: 120_000 },
];
const RESET_AHEAD_MS = 10_000;

d("C10 provider errors: 429, 529 and usage limit", () => {
  it("queues faults on the root's requests and records retries, backoff, events and whether the turn completes", async () => {
    await observeContract("C10", async o => {
      const cases: Obj = {};
      o.observed.cases = cases;
      for (const c of FAULT_CASES) {
        await withHost(`C10-${c.name}`, undefined, o, async s => {
          const { host } = s;
          const { arrivals } = instrument(host);
          const root = await host.newRoot(`C10 ${c.name} root`);
          const resetAtMs = Date.now() + RESET_AHEAD_MS;
          const mine = (r: CpxRequest): boolean => hdr(r, "x-proof-session") === root && hdr(r, "x-proof-kind") === "primary";
          // once: one failure; persistent: every root request fails until the cap; until-reset: every root request fails until resetAt has passed.
          front(host).failWhen(r => mine(r) && (c.mode !== "until-reset" || Date.now() < resetAtMs), c.kind, {
            times: c.mode === "once" ? 1 : Infinity, retryAfterSeconds: 2, ...(c.kind === "usage-limit" ? { resetAt: new Date(resetAtMs) } : {}),
          });
          const promptedAt = Date.now();
          await host.client.session.prompt({ sessionID: root, text: "C10 turn" });
          const outcome = (lines: readonly ProbeLine[]) => lines.find(l => l.sessionID === root && l.t >= promptedAt && CHILD_ENDED.has(l.kind));
          const terminal = await tryWait(`terminal execution event of the ${c.name} root`, async () => outcome(await probeLines(s.probeFile)), c.capMs);
          let stillRetrying = false;
          if (!terminal) {
            stillRetrying = true;
            front(host).clearFaults();
            await host.client.session.interrupt({ sessionID: root });
          }
          const idle = await waitIdle(host, root, 60_000);
          const lines = (await probeLines(s.probeFile)).filter(l => l.sessionID === root && l.t >= promptedAt && l.kind.startsWith("session."));
          o.relied.push(...lines.filter(l => l.kind === "session.step.failed" || CHILD_ENDED.has(l.kind)));
          const requests = front(host).requests.filter(mine);
          const stored = await host.client.session.context({ sessionID: root });
          const events = (await host.events()).filter(e => obj(e.data).sessionID === root && !/(delta|streamed)/.test(e.type));
          cases[c.name] = {
            kind: c.kind, mode: c.mode, capMs: c.capMs, promptedAt, resetAt: c.kind === "usage-limit" ? new Date(resetAtMs).toISOString() : undefined,
            outcome: stillRetrying ? "still retrying at the cap (faults cleared, root interrupted)" : terminal?.kind, rootIdleAfter: idle === true,
            turnCompleted: json(stored).includes("CHILD_OK"), terminal: terminal ? lineBrief(terminal) : null,
            providerRequests: requests.map((r, i) => {
              const at = arrivals.get(r.index);
              const prev = i > 0 ? arrivals.get(requests[i - 1]!.index) : promptedAt;
              return { index: r.index, arrivedAt: at, sincePreviousMs: at !== undefined && prev !== undefined ? at - prev : undefined, served: r.served };
            }),
            requestCount: requests.length, faultsServed: requests.filter(r => r.served !== "forwarded" && r.served !== undefined).length,
            succeededAfterReset: c.kind === "usage-limit" ? requests.some(r => r.served === "forwarded" && (arrivals.get(r.index) ?? 0) >= resetAtMs) : undefined,
            stepFailed: lines.filter(l => l.kind === "session.step.failed").map(lineBrief),
            probeSessionLines: lines.map(l => ({ kind: l.kind, t: l.t, error: l.error })),
            hostEvents: events.slice(0, 60).map(e => ({ type: e.type, created: e.created, data: clip(e.data, 400) })),
            hostLogLines: host.tail(150_000).split(/\r?\n/).filter(line => /retr|429|529|overload|rate.?limit|usage/i.test(line)).slice(-30).map(line => line.slice(0, 300)),
            frontErrors: front(host).frontErrors,
          };
        });
      }
    });
  }, 1_500_000);
});

// ------------------------------------------------------------------ batch 3 helpers ----
/** `host.client.session.<name>` looked up at run time (the harness's HostClient type lists only some methods). `undefined` when the client has no such method. */
function sessionMethod(host: RoutingHost, name: string): ((input: Obj) => Promise<unknown>) | undefined {
  const session: object = host.client.session;
  const method: unknown = Reflect.get(session, name);
  return typeof method === "function" ? async input => Reflect.apply(method, session, [input]) : undefined;
}
/** The whole `session.get` answer (clipped), or its error. Reads `host.client` at call time, so it works across `restart()`. */
const sessionState = (host: RoutingHost, id: string): Promise<unknown> => host.client.session.get({ sessionID: id }).then(g => clip(g, 1200), error => ({ error: String(error) }));
const isActive = (host: RoutingHost, id: string): Promise<boolean | string> => host.client.session.active().then(active => Object.hasOwn(active, id), error => String(error));
const toolUses = (r: CpxRequest): Obj[] => bodyMessages(r).flatMap(m => arr(m.content).map(obj)).filter(b => b.type === "tool_use");

const GATE_BASE = 7_000_000;
interface GateArrival { token: string; index: number; session?: string; at: number; releasedAt?: number }
/** Holds the first provider request of each non-root session whose messages carry an un-released token, until `release(token)`. Works through
 * the front's `delayMs` (returns a code >= GATE_BASE) and `sleep` (parks on that code), so each child is released individually and from the
 * test process: it survives `RoutingHost.restart()` (the front does). Also stamps every arrival in `stamps` (what `instrument` does). */
class Gates {
  readonly stamps = new Map<number, number>();
  readonly arrivals: GateArrival[] = [];
  waiting = 0;
  peakWaiting = 0;
  private readonly released = new Set<string>();
  private readonly parked = new Map<number, (() => void)[]>();
  constructor(host: RoutingHost, private readonly root: string, readonly tokens: readonly string[]) {
    const options = front(host).options;
    options.delayMs = request => {
      this.stamps.set(request.index, Date.now());
      const session = hdr(request, "x-proof-session");
      if (session === undefined || session === this.root || hdr(request, "x-proof-kind") !== "primary") return 0;
      const text = json(bodyMessages(request));
      const code = this.tokens.findIndex(t => !this.released.has(t) && text.includes(t));
      if (code < 0) return 0;
      this.arrivals.push({ token: this.tokens[code]!, index: request.index, session, at: Date.now() });
      this.waiting += 1;
      this.peakWaiting = Math.max(this.peakWaiting, this.waiting);
      return GATE_BASE + code;
    };
    options.sleep = ms => new Promise<void>(resolve => {
      if (ms < GATE_BASE || ms >= GATE_BASE + this.tokens.length) { setTimeout(resolve, ms); return; }
      this.parked.set(ms, [...(this.parked.get(ms) ?? []), resolve]);
    });
  }
  /** Releases one token (and every later arrival of it). */
  release(token: string): void {
    this.released.add(token);
    const code = GATE_BASE + this.tokens.indexOf(token);
    const waiters = this.parked.get(code) ?? [];
    this.parked.delete(code);
    this.waiting -= waiters.length;
    for (const a of this.arrivals) if (a.token === token && a.releasedAt === undefined) a.releasedAt = Date.now();
    for (const resolve of waiters) resolve();
  }
  releaseAll(): void { for (const t of this.tokens) this.release(t); }
  /** The session id behind a token (from the held request's header), once it has arrived. */
  sessionOf(token: string): string | undefined { return this.arrivals.find(a => a.token === token)?.session; }
  arrived(token: string): boolean { return this.arrivals.some(a => a.token === token); }
}
const childInput = (token: string, background: boolean): Obj => ({ agent: CHILD, description: token, prompt: `${token} child`, model: `${SONNET}#low`, background });

// ---------------------------------------------------------------------------- C11 ----
d("C11 stored parent history keeps the subagent arguments the model wrote", () => {
  it("mutates the subagent prompt in execute.before and records stored history, the child's prompt and the next parent request", async () => {
    await observeContract("C11", async o => {
      await withHost("C11", "mutate-subagent-prompt", o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        const root = await host.newRoot("C11 root");
        const written = "C11 original prompt";
        const call = await host.call(root, "subagent", { agent: CHILD, description: "C11 child", prompt: written, model: `${SONNET}#low`, background: false });
        await host.prompt(root, "C11 follow-up"); // a later parent request re-reads the stored history
        const lines = await probeLines(s.probeFile);
        const mutations = lines.filter(l => l.kind === "mutate-subagent-prompt");
        o.relied.push(...mutations.slice(0, 2));
        const stored = await host.client.session.context({ sessionID: root });
        const toolMessages = stored.filter(m => /subagent/.test(json(m)) && json(m).includes("C11"));
        const childRequest = call.childID ? front(host).requests.find(r => hdr(r, "x-proof-session") === call.childID && hdr(r, "x-proof-kind") === "primary") : undefined;
        const childMessages = childRequest ? bodyMessages(childRequest) : [];
        const requests = parentRequests(host, root);
        o.observed.hook = { modelWrote: written, probeLines: mutations.map(l => ({ original: l.original, mutated: l.mutated })), harnessBeforeInput: clip(call.before.input, 600), harnessAfterInput: clip(call.after.input, 600) };
        o.observed.storedHistory = {
          messageCount: stored.length, subagentMessages: clip(toolMessages, 1800), inputKeyPaths: findKeys(toolMessages, /^(input|args|arguments)$/).map(k => ({ path: k.path, value: clip(k.value, 400) })),
          originalPaths: stringPaths(stored, /C11 original prompt/), mutatedPaths: stringPaths(stored, /CPX_MUTATED/),
          hasOriginal: json(stored).includes(written), hasMutated: json(stored).includes("CPX_MUTATED"),
        };
        o.observed.child = {
          sessionID: call.childID, firstRequestIndex: childRequest?.index, lastMessage: clip(childMessages.at(-1), 600),
          receivedMutated: json(childMessages).includes("CPX_MUTATED"), receivedOriginalOnly: json(childMessages).includes(written) && !json(childMessages).includes("CPX_MUTATED"),
        };
        o.observed.parentWire = requests.map(r => ({ ...requestView(r, arrivals), toolUses: toolUses(r).map(b => ({ id: b.id, name: b.name, input: clip(b.input, 400), mutated: json(b.input).includes("CPX_MUTATED") })) }));
      });
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------- C12 ----
d("C12 background children in flight across a host restart", () => {
  it("releases child A right before restart() and child B after the relaunch and records what each delivers", async () => {
    await observeContract("C12", async o => {
      await withHost("C12", undefined, o, async s => {
        const { host } = s;
        const root = await host.newRoot("C12 root");
        const gates = new Gates(host, root, ["C12_A", "C12_B"]);
        const calls = await host.callMany(root, gates.tokens.map(t => childInput(t, true)));
        const ids = Object.fromEntries(gates.tokens.map(t => [t, calls.find(c => str(obj(c.before.input).prompt)?.includes(t))?.childID]));
        await tryWait("both children's held requests", () => (gates.tokens.every(t => gates.arrived(t)) ? true : undefined), 30_000);
        const parentRequestsBefore = parentRequests(host, root).length;
        const storedBefore = await storedView(host, root);
        o.observed.before = { children: ids, heldAt: gates.arrivals.map(a => ({ token: a.token, index: a.index, at: a.at })), parentRequests: parentRequestsBefore, parentMessages: storedBefore.messages.length, active: await Promise.all(Object.entries(ids).map(async ([t, id]) => [t, id ? await isActive(host, id) : null])) };
        // A: released, then the restart starts as soon as the front has forwarded A's request (the fixture answers it; the host may or may not process the answer before the kill).
        const releasedAt = Date.now();
        gates.release("C12_A");
        const aArrival = gates.arrivals.find(a => a.token === "C12_A");
        const aRequest = aArrival ? front(host).requests.find(r => r.index === aArrival.index) : undefined;
        const forwarded = await tryWait("A's request to be forwarded to the fixture", () => (aRequest?.served === "forwarded" ? true : undefined), 15_000);
        const restartStartedAt = Date.now();
        await host.restart();
        const restartEndedAt = Date.now();
        gates.release("C12_B");
        const bReleasedAt = Date.now();
        o.observed.timing = { aReleasedAt: releasedAt, aForwarded: forwarded === true, restartStartedAt, restartEndedAt, bReleasedAt, restartMs: restartEndedAt - restartStartedAt, note: "A's request was released and forwarded before restart() was called; restart() kills and relaunches in one call, so the downtime itself cannot be hit" };
        const perChild: Obj = {};
        for (const t of gates.tokens) {
          const id = ids[t];
          if (!id) { perChild[t] = { error: "no sessionID" }; continue; }
          const end = await tryWait(`terminal event of ${t} after the restart`, async () => terminalOf(await probeLines(s.probeFile), id), 45_000);
          if (end) o.relied.push(end);
          const context = await host.client.session.context({ sessionID: id }).then(c => c, error => ({ error: String(error) }));
          perChild[t] = {
            sessionID: id, terminal: end ? { ...lineBrief(end), afterRestartStart: end.t >= restartStartedAt, afterRestartEnd: end.t >= restartEndedAt } : null,
            probeLines: linesOf(await probeLines(s.probeFile), id).map(lineBrief), session: await sessionState(host, id), active: await isActive(host, id),
            providerRequests: front(host).requests.filter(r => hdr(r, "x-proof-session") === id).map(r => ({ index: r.index, arrivedAt: gates.stamps.get(r.index), served: r.served })),
            context: Array.isArray(context) ? { messageCount: context.length, roles: context.map(m => str(m.role) ?? str(m.type)), containsChildOk: json(context).includes("CHILD_OK"), last: clip(context.at(-1), 600) } : context,
          };
        }
        o.observed.perChild = perChild;
        const woke = await tryWait("a parent request after the restart", () => parentRequests(host, root)[parentRequestsBefore], 30_000);
        const stored = await tryWait("completion envelopes of both children", async () => { const v = await storedView(host, root); return envelopeStates(v.envelopes).length >= 2 ? v : undefined; }, 30_000);
        const after = stored ?? await storedView(host, root);
        o.observed.parent = {
          wokeAfterRestart: woke !== undefined, parentRequestsAfter: parentRequests(host, root).length, parentRequestsBefore,
          envelopeStates: envelopeStates(after.envelopes), envelopes: after.envelopes, messageCountAfter: after.messages.length, session: await sessionState(host, root), active: await isActive(host, root),
        };
        o.observed.rootLinesAfterRestart = linesOf(await probeLines(s.probeFile), root).filter(l => l.t >= restartStartedAt).map(lineBrief);
        o.observed.hostErrors = host.errorLines().slice(-10).map(l => l.slice(0, 300));
      });
    });
  }, 600_000);
});

// ---------------------------------------------------------------------------- C13 ----
const tokensOf = (label: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${label}_${i + 1}x`);
const activeCount = async (host: RoutingHost, ids: readonly string[]): Promise<number> => { const active = await host.client.session.active(); return ids.filter(id => Object.hasOwn(active, id)).length; };

d("C13 concurrent background children, host cap, parent interrupt", () => {
  it("holds 6 then 8 background children, then interrupts a parent with 3 children held (background and foreground)", async () => {
    await observeContract("C13", async o => {
      await withHost("C13", undefined, o, async s => {
        const { host } = s;
        // (1) + (2): N children at once, all held at the provider. peakWaiting = most provider requests parked at the same moment.
        const concurrency: Obj = {};
        o.observed.concurrency = concurrency;
        for (const n of [6, 8]) {
          const root = await host.newRoot(`C13 n=${n} root`);
          const gates = new Gates(host, root, tokensOf(`C13n${n}`, n));
          const calls = await host.callMany(root, gates.tokens.map(t => childInput(t, true)), 180_000);
          const allArrived = await tryWait(`${n} held child requests`, () => (gates.arrivals.length >= n ? true : undefined), 25_000);
          const kids = await host.children(root);
          const ids = kids.map(k => k.id);
          const atPeak = { requested: n, acks: calls.length, ackStatuses: calls.map(c => obj(obj(c.after.result).output).status), allArrived: allArrived === true, arrivedAtProvider: gates.arrivals.length, peakWaiting: gates.peakWaiting, childSessions: ids.length, activeChildren: await activeCount(host, ids) };
          gates.releaseAll();
          const ended = await tryWait(`all ${n} children to end`, async () => { const ls = await probeLines(s.probeFile); return ids.every(id => terminalOf(ls, id)) ? ls : undefined; }, 120_000);
          const lines = ended ?? await probeLines(s.probeFile);
          concurrency[`n${n}`] = { ...atPeak, arrivalTimes: gates.arrivals.map(a => ({ token: a.token, at: a.at })), terminalKinds: ids.map(id => terminalOf(lines, id)?.kind ?? null), allEnded: ended !== undefined };
        }
        // (3): interrupt the parent while 3 children are held. Background: the parent is idle (turn ended after the acks). Foreground: the parent is inside the subagent tool calls.
        const interrupts: Obj = {};
        o.observed.parentInterrupt = interrupts;
        for (const variant of ["background", "foreground"] as const) {
          const root = await host.newRoot(`C13 interrupt ${variant} root`);
          const gates = new Gates(host, root, tokensOf(`C13i${variant === "background" ? "b" : "f"}`, 3));
          const inputs = gates.tokens.map(t => childInput(t, variant === "background"));
          if (variant === "background") await host.callMany(root, inputs);
          else await host.client.session.prompt({ sessionID: root, text: `SPIKE_CALLS=${JSON.stringify(inputs)}` });
          await tryWait("3 held child requests", () => (gates.arrivals.length >= 3 ? true : undefined), 30_000);
          const ids = [...new Set(gates.arrivals.map(a => a.session).filter((x): x is string => x !== undefined))];
          const rootActiveBefore = await isActive(host, root);
          const activeBefore = await activeCount(host, ids);
          const interruptAt = Date.now();
          let interruptResult: unknown;
          let interruptError: string | undefined;
          try { interruptResult = await host.client.session.interrupt({ sessionID: root }); } catch (error) { interruptError = String(error); }
          const endedEarly = await tryWait("a child to end before release (killed by the parent interrupt)", async () => { const ls = await probeLines(s.probeFile); return ids.map(id => terminalOf(ls, id, interruptAt)).find(l => l !== undefined); }, 10_000);
          const afterInterrupt = { activeChildren: await activeCount(host, ids), rootActive: await isActive(host, root), childEndedBeforeRelease: endedEarly ? lineBrief(endedEarly) : null };
          gates.releaseAll();
          const ended = await tryWait("all children to end after release", async () => { const ls = await probeLines(s.probeFile); return ids.every(id => terminalOf(ls, id)) ? ls : undefined; }, 60_000);
          const lines = await probeLines(s.probeFile);
          interrupts[variant] = {
            children: ids, rootActiveBefore, activeChildrenBefore: activeBefore, interrupt: { api: "host.client.session.interrupt({ sessionID: parent })", at: interruptAt, result: clip(interruptResult, 400), error: interruptError },
            afterInterrupt, allEndedAfterRelease: ended !== undefined,
            perChild: await Promise.all(ids.map(async id => ({
              sessionID: id, terminal: terminalOf(lines, id) ? lineBrief(terminalOf(lines, id)!) : null, session: await sessionState(host, id),
              providerRequests: front(host).requests.filter(r => hdr(r, "x-proof-session") === id).map(r => ({ index: r.index, served: r.served })),
              heldRequestReleasedAndForwarded: front(host).requests.some(r => hdr(r, "x-proof-session") === id && r.served === "forwarded"),
            }))),
            rootLinesAfterInterrupt: linesOf(lines, root).filter(l => l.t >= interruptAt).map(lineBrief),
          };
          await waitIdle(host, root, 30_000);
        }
      });
    });
  }, 1_200_000);
});

// ---------------------------------------------------------------------------- C14 ----
interface Span { from: number; to: number }
const peakOverlap = (spans: readonly Span[]): number => Math.max(0, ...spans.map(a => spans.filter(b => b.from <= a.from && a.from < b.to).length));
const RETAINED_NAME = "cpx-retained.txt";
/** Prompt of the retained-launch children (probe `{n}` = child number): the RoutingProvider marker `READ_ONLY_PROBE=<json>` makes the fixture answer with a `read` call. */
const retainedPrompt = (file: string): string => `CPX_RETAINED_CHILD {n} READ_ONLY_PROBE=${JSON.stringify({ tool: "read", input: { path: file } })}`;
/** Probe env of C14; the child prompt names a file of the host's project, so it is resolved in `prepare` (see {@link ProbeEnv}). */
const retainedEnv: ProbeEnv = project => ({
  CPX_PROBE_TOOL_URL: pathToFileURL(path.join(ROOT, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")).href, CPX_PROBE_RELAUNCH_MS: "60000",
  CPX_PROBE_CHILD_PROMPT: retainedPrompt(path.join(project, RETAINED_NAME)),
});

d("C14 launch with a retained tool context outside any LLM tool call", () => {
  it("captures the context in cpx_probe_capture, ends the turn, and records the probe's launches (now and 60 s later)", async () => {
    await observeContract("C14", async o => {
      await withHost("C14", "retained-launch", o, async s => {
        const { host } = s;
        const retainedFile = path.join(host.project, RETAINED_NAME);
        const { arrivals } = instrument(host);
        host.provider.holdMarked("CPX_RETAINED_CHILD", 3_000);
        const root = await host.newRoot("C14 root");
        const ids = async () => (await host.client.session.context({ sessionID: root })).map(m => str(m.id) ?? str(m.type));
        await host.prompt(root, `READ_ONLY_PROBE=${JSON.stringify({ tool: "cpx_probe_capture", input: {} })}`);
        const history: Obj = { afterCaptureTurn: await ids() };
        const batchDone = (batch: number) => async () => { const ls = (await probeLines(s.probeFile)).filter(l => l.kind === "retained-launch-result" && l.batch === batch); return ls.length >= 3 ? ls : undefined; };
        const first = await tryWait("batch 1 results", batchDone(1), 120_000);
        history.afterBatch1 = await ids();
        const second = await tryWait("batch 2 (relaunch after 60 s) results", batchDone(2), 180_000);
        history.afterBatch2 = await ids();
        const lines = await probeLines(s.probeFile);
        const retained = lines.filter(l => l.kind.startsWith("retained-") || l.kind === "probe-error");
        o.relied.push(...retained.slice(0, 12));
        const childIDs = [...new Set(retained.map(l => str(l.childSessionID) ?? str(l.seenInProgress)).filter((x): x is string => x !== undefined))];
        const holds = host.provider.holds.filter(h => h.session !== undefined && childIDs.includes(h.session));
        const byBatch = (batch: number) => retained.filter(l => l.batch === batch);
        o.observed.registration = { toolRegistered: clip(lines.find(l => l.kind === "retained-tool-registered"), 400), capture: clip(lines.find(l => l.kind === "retained-capture"), 600), probeErrors: clip(lines.filter(l => l.kind === "probe-error"), 600) };
        o.observed.launches = [1, 2].map(batch => ({
          batch, batchLine: clip(byBatch(batch).find(l => l.kind === "retained-launch-batch"), 600),
          attempts: byBatch(batch).filter(l => l.kind === "retained-launch-attempt").map(l => ({ n: l.n, t: l.t })),
          childrenSeen: byBatch(batch).filter(l => l.kind === "retained-launch-child").map(l => ({ n: l.n, t: l.t, childSessionID: l.childSessionID })),
          results: byBatch(batch).filter(l => l.kind === "retained-launch-result").map(l => ({ n: l.n, t: l.t, ok: l.ok, childSessionID: l.childSessionID, status: l.status, output: l.output, error: l.error, name: l.name })),
          errors: byBatch(batch).filter(l => l.kind === "retained-launch-error").map(l => clip(l, 400)),
          delivered: batch === 1 ? first !== undefined : second !== undefined,
        }));
        o.observed.childrenRan = Object.fromEntries(childIDs.map(id => [id, front(host).requests.filter(r => hdr(r, "x-proof-session") === id).map(r => ({ index: r.index, arrivedAt: arrivals.get(r.index), served: r.served }))]));
        o.observed.concurrency = {
          holdSpans: holds.map(h => ({ session: h.session, arrivedAt: h.arrivedAt, releasedAt: h.releasedAt })),
          peakOverlapAllChildren: peakOverlap(holds.map(h => ({ from: h.arrivedAt, to: h.releasedAt ?? Number.POSITIVE_INFINITY }))),
          peakOverlapBatch1: peakOverlap(holds.filter(h => h.arrivedAt < (byBatch(2).find(l => l.kind === "retained-launch-batch")?.t ?? Number.POSITIVE_INFINITY)).map(h => ({ from: h.arrivedAt, to: h.releasedAt ?? Number.POSITIVE_INFINITY }))),
        };
        const toolLines = lines.filter(l => (l.kind === "execute.before" || l.kind === "execute.after") && typeof l.sessionID === "string" && childIDs.includes(l.sessionID));
        const harnessHooks = (await host.hooks()).filter(h => childIDs.includes(h.sessionID));
        const hostEvents = await host.events();
        const decisions = await host.decisionRows();
        const sentInput = { path: retainedFile };
        // The child's prompt makes the fixture emit a `read` call (READ_ONLY_PROBE marker) in the child's own turn: those calls pass through the router's hooks
        // (loaded first), then this file's probe, then the harness probe (loaded last, so it sees what the earlier hooks left).
        const perChild = childIDs.map(id => {
          const probe = toolLines.filter(l => l.sessionID === id);
          const harness = harnessHooks.filter(h => h.sessionID === id);
          const mine = front(host).requests.filter(r => hdr(r, "x-proof-session") === id && hdr(r, "x-proof-kind") === "primary");
          const toolResultRequest = mine.find(r => lastIsToolResult(r));
          const lifecycleEvents = hostEvents.filter(e => e.type === "probe.lifecycle" && e.sessionID === id);
          return {
            sessionID: id, agent: harness[0]?.agent,
            probeBefore: probe.filter(l => l.kind === "execute.before").map(l => ({ tool: l.tool, argKeys: l.argKeys, args: l.args, agent: l.agent, t: l.t })),
            probeAfter: probe.filter(l => l.kind === "execute.after").map(l => ({ tool: l.tool, status: l.status, contentText: l.contentText, outputText: l.outputText, error: l.error, t: l.t })),
            harnessRouterSeen: harness.map(h => ({ hook: h.hook, tool: h.tool, callID: h.callID, agent: h.agent, input: clip(h.input, 400), status: h.status, result: clip(h.result, 600), error: clip(h.error, 400) })),
            inputUnchangedByRouter: harness.filter(h => h.hook === "before").map(h => json(h.input) === json(sentInput)),
            permissionEvaluations: lifecycleEvents.filter(e => e.point === "evaluate").map(e => ({ action: e.action, resources: clip(e.resources, 300), effectIn: e.effectIn, effectOut: e.effectOut, messageIn: e.messageIn, denied: e.denied })),
            firstContext: lifecycleEvents.filter(e => e.point === "context").map(e => ({ agent: e.agent, messageCount: arr(e.messages).length, options: clip(e.options, 300) })),
            childProviderRequests: mine.map(r => ({ index: r.index, arrivedAt: arrivals.get(r.index), lastIsToolResult: lastIsToolResult(r), toolNames: arr(obj(r.body).tools).map(t => str(obj(t).name)) })),
            modelGotToolResult: toolResultRequest ? toolResultText(toolResultRequest).slice(0, 300) : null,
            routerDecisionRows: decisions.filter(row => json(row).includes(id)).length,
          };
        });
        const triggered = perChild.some(c => c.probeBefore.some(b => b.tool === "read"));
        o.observed.hooksForChildren = {
          childPrompt: retainedPrompt(retainedFile), file: retainedFile,
          childPromptCanTriggerTool: triggered, probeHookLinesForChildren: toolLines.length, harnessHookRecordsForChildren: harnessHooks.length,
          tools: [...new Set([...toolLines.map(l => l.tool), ...harnessHooks.map(h => h.tool)])],
          routerGuardsOrGrantsRan: perChild.some(c => c.permissionEvaluations.length > 0 || c.routerDecisionRows > 0 || c.harnessRouterSeen.some(h => h.hook === "after" && json(h.result).includes("router"))),
          routerLogLines: host.routerLogLines().slice(-10).map(l => l.slice(0, 300)),
          subagentHooksOnRootAfterCapture: lines.filter(l => (l.kind === "execute.before" || l.kind === "execute.after") && l.tool === "subagent" && l.sessionID === root).length,
          perChild,
        };
        const kids = await host.children(root);
        o.observed.parentHistory = { ...history, unchangedAcrossLaunches: json(history.afterCaptureTurn) === json(history.afterBatch1) && json(history.afterBatch1) === json(history.afterBatch2), childrenListedUnderRoot: kids.map(k => ({ id: k.id, parentID: k.parentID, agent: k.agent })), session: await sessionState(host, root) };
      }, { ...BASE, probe: { lifecycle: true }, prepare: async ({ project }) => { await writeFile(path.join(project, RETAINED_NAME), "retained child read target\n"); } }, retainedEnv);
    });
  }, 900_000);
});

// ---------------------------------------------------------------------------- C15 ----
d("C15 compaction hook: can a plugin rewrite the compaction request", () => {
  it("puts CPX_HELD_ORIGINAL in the history, compacts, and records the hook, the provider request and the stored summary", async () => {
    await observeContract("C15", async o => {
      await withHost("C15", "rewrite-compaction", o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        const root = await host.newRoot("C15 root");
        await host.prompt(root, "C15 first note CPX_HELD_ORIGINAL");
        await host.prompt(root, "C15 second note");
        const compact = sessionMethod(host, "compact");
        const requestsBefore = front(host).requests.length;
        let compactResult: unknown;
        let compactError: string | undefined;
        const calledAt = Date.now();
        if (compact) { try { compactResult = await compact({ sessionID: root }); } catch (error) { compactError = String(error); } }
        const hook = await tryWait("the probe's compaction hook line", async () => (await probeLines(s.probeFile)).find(l => l.kind === "compaction" && l.t >= calledAt), 60_000);
        const sent = await tryWait("a provider request after compact()", () => (front(host).requests.length > requestsBefore ? true : undefined), 60_000);
        const idle = await waitIdle(host, root, 90_000);
        const lines = await probeLines(s.probeFile);
        const hooks = lines.filter(l => l.kind === "compaction" || l.kind === "rewrite-compaction" || l.kind === "compaction-hook-available");
        o.relied.push(...hooks);
        const requests = front(host).requests.slice(requestsBefore);
        const stored = await host.client.session.context({ sessionID: root });
        o.observed.api = { compactOnClient: compact !== undefined, via: "host.client.session.compact({ sessionID })", result: clip(compactResult, 600), error: compactError };
        o.observed.hook = {
          available: lines.find(l => l.kind === "compaction-hook-available")?.["compaction-hook-available"], fired: hook !== undefined,
          compactionLines: lines.filter(l => l.kind === "compaction").map(l => ({ t: l.t, sessionID: l.sessionID, agent: l.agent, messageCount: l.messageCount, hasResult: l.hasResult, messages: clip(l.messages, 500), hasSystem: l.hasSystem })),
          rewriteLines: lines.filter(l => l.kind === "rewrite-compaction").map(l => ({ t: l.t, did: l.did, replacements: l.replacements })),
        };
        o.observed.provider = {
          requestSentAfterCompact: sent === true, rootIdleAfter: idle === true,
          requests: requests.map(r => ({
            index: r.index, session: hdr(r, "x-proof-session"), kind: hdr(r, "x-proof-kind"), arrivedAt: arrivals.get(r.index), served: r.served, messageCount: bodyMessages(r).length,
            hasOriginal: json(r.body).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(r.body).includes("CPX_HELD_PLACEHOLDER"),
            originalPaths: stringPaths(r.body, /CPX_HELD_ORIGINAL/), placeholderPaths: stringPaths(r.body, /CPX_HELD_PLACEHOLDER/), lastMessage: clip(bodyMessages(r).at(-1), 500),
          })),
        };
        o.observed.stored = {
          messageCount: stored.length, hasOriginal: json(stored).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(stored).includes("CPX_HELD_PLACEHOLDER"),
          messages: stored.map((m, i) => ({ i, type: str(m.type), role: str(m.role), hasOriginal: json(m).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(m).includes("CPX_HELD_PLACEHOLDER"), snippet: json(m).slice(0, 300) })),
          summaryLike: clip(stored.filter(m => /compact|summary/i.test(json(m).slice(0, 300))), 1200),
        };
      });
    });
  }, 600_000);
});
