/** CPX Phase 0.1 (task 0.1.2): OpenCode v2 host-contract OBSERVATION smoke. Part 1: scaffolding + contracts C1-C5.
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
import { removeDirWhenReleased } from "../helpers/remove-dir";
import type { CpxFront, CpxRequest } from "./helpers/cpx-scripted-provider";
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

type ProbeMode = "rewrite-completion" | "append-tail-system" | "append-tail-user" | "append-tail-newest";
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
async function writeProbePlugin(out: string, mode: ProbeMode | undefined): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-cpx-probe-plugin-"));
  scratch.push(dir);
  const plugin = path.join(dir, "cpx-probe");
  await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "cpx-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  const env: Record<string, string> = { CPX_PROBE_OUT: out, ...(mode ? { CPX_PROBE_MODE: mode } : {}) };
  const header = Object.entries(env).map(([name, value]) => `process.env.${name} = ${JSON.stringify(value)};`).join("\n");
  await writeFile(path.join(plugin, "server.mjs"), `${header}\n${await readFile(PROBE_SOURCE, "utf8")}`);
  return plugin;
}

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
async function withHost(tag: string, mode: ProbeMode | undefined, o: Observation, body: (s: Scenario) => Promise<void>, options: HostOptions = BASE): Promise<void> {
  const probeFile = path.join(await obsDir(), `${tag}-${RUN_ID}.probe.jsonl`);
  await writeFile(probeFile, "");
  const plugin = await writeProbePlugin(probeFile, mode);
  const host = await RoutingHost.start(`cpx-${tag.toLowerCase()}`, { ...options, extraPlugins: [...(options.extraPlugins ?? []), plugin], provider: options.provider ?? {} });
  try {
    await waitForProbe(probeFile, `the cpx-probe plugin to load (${tag})`, lines => lines.find(l => l.kind === "loaded"), 30_000);
    await body({ host, probeFile, tag });
  } finally {
    const lines = await probeLines(probeFile);
    const kinds: Record<string, number> = {};
    for (const line of lines) kinds[line.kind] = (kinds[line.kind] ?? 0) + 1;
    o.hosts.push({ tag, mode: mode ?? null, probeFile, probeLoaded: kinds.loaded === 1, probeKinds: kinds, probeErrors: clip(lines.filter(l => l.kind === "probe-error"), 800), hostErrors: clip(host.errorLines(), 400) });
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
