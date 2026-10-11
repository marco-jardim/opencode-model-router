/** CPX Phase 0.1 (tasks 0.1.2, 0.1.6): OpenCode v2 host-contract smoke: observation + decided-branch assertions for C1-C15 and O1-O6.
 *
 *   RUN_OC_SMOKE_CPX=1 OPENCODE_V2_BIN=<abs path to opencode 2> npm run smoke:cpx
 *
 * Gate: RUN_OC_SMOKE_CPX=1. Unset: every test of the file is skipped. Set without OPENCODE_V2_BIN: one test fails hard (`Set OPENCODE_V2_BIN ...`)
 * and the contract scenarios stay skipped (the harness would otherwise fall back to whatever `opencode` is on PATH, possibly a v1).
 *
 * Observation mode: each scenario drives the REAL host (RoutingHost + keyless scripted provider behind a CpxFront) with the test-only probe
 * plugin (test/smoke/probe/cpx-probe-plugin.js) loaded through HostOptions.extraPlugins, records what the host did, writes
 * `<OBS_DIR>/C<n>.json` BEFORE asserting (also when the scenario throws: `scenarioError`), then asserts the DECIDED branch of ADR 0007
 * ("Host contracts: branch taken") through the `DECISIONS` table at the end of the file: every check is `<contract>/<decision id>` with a
 * message saying what to reopen, all failed checks of a contract are reported together, and the results are in the file's `checks`.
 * Besides C1-C15 the file closes ADR open observations O1-O6: C7 pins the child's final text path (O1), C10 records the 529 error type
 * (O2), C14 launches 8 retained children (O3), C13 / C14b interrupt an ACTIVE root (O4), C15 completes a compaction (O5) and the O6
 * scenario posts `session.synthetic` with `resume`. A host upgrade that changes a decided behaviour fails `npm run smoke:cpx`.
 *
 * Probe wiring: RoutingHost builds the host env from an allowlist, so CPX_PROBE_* cannot travel from the test process. The generated
 * `server.mjs` of the wrapper directory starts with `process.env.CPX_PROBE_* = ...` lines (the host loads native plugins in-process; only
 * `node:` modules are imported, so the assignments run before the probe reads its env), followed by the unchanged probe source. One host
 * per scenario, so the config is fixed per host (it also survives `RoutingHost.restart()`).
 *
 * Output: OBS_DIR = `<OMR_CPX_PROBE_DIR | OMR_SMOKE_REAL_TMPDIR | os.tmpdir()>/omr-cpx-probe`. The smoke globalSetup (test/setup/smoke-tmp-guard.ts)
 * points TEMP at a per-run directory it deletes at the end, so the REAL temp directory it recorded is used (same as role-spikes). Every run
 * writes into its own directory RUN_DIR = `<OBS_DIR>/<runId>/` (runs never overwrite each other): one probe JSON-lines file per host
 * (`<RUN_DIR>/<tag>-<runId>.probe.jsonl`) and one summary per contract (`<RUN_DIR>/C<n>.json`). To find the latest run without knowing the
 * run id: `<OBS_DIR>/latest.json` = `{ runId, runDir }` (the run dir of the most recent contract written) and `<OBS_DIR>/latest/C<n>.json` is
 * a copy of the most recent summary of each contract. The paths are also written into every C<n>.json (`obsDir`, `runDir`, `vitestTmpdir`).
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
import type { CpxFront, CpxRequest, FaultKind, UsageLimitVariant } from "./helpers/cpx-scripted-provider";
import {
  RoutingHost, ROOT, agentWithoutModel, arr, clip, obj, redact, ref, scriptLine, stopAllHosts, str, waitFor, type Dispatched, type HostOptions, type Obj,
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

type ProbeMode = "rewrite-completion" | "append-tail-system" | "append-tail-user" | "append-tail-newest" | "cache-hint-1h" | "cache-hint-1h-message" | "append-tail-user+hint-last-real" | "filter-grep" | "mutate-subagent-prompt" | "rewrite-compaction" | "retained-launch" | "rewrite-completion+compaction" | "retry-observe" | "retry-stop" | "plugin-session-api";
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
  // Every cleanup step is attempted even when an earlier one fails; the collected errors are rethrown at the end.
  const errors: string[] = [];
  const attempt = async (label: string, step: () => Promise<unknown>): Promise<void> => {
    try { await step(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`); }
  };
  await attempt("stopAllHosts", stopAllHosts);
  for (const dir of scratch.splice(0)) await attempt(`remove ${dir}`, () => removeDirWhenReleased(dir));
  if (errors.length > 0) throw new Error(`cpx-host-contract cleanup failed (${errors.length}):\n${errors.join("\n")}`);
}, 120_000);

/** Base directory of the observations (see the file header): `<...>/omr-cpx-probe`. */
const obsBaseDir = (): string => path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-probe");
/** Directory of THIS run's observations: `<OBS_DIR>/<runId>/`; created on first use. */
async function obsDir(): Promise<string> {
  const dir = path.join(obsBaseDir(), RUN_ID);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `OPENCODE_V2_BIN --version`: the scenario's host version record. Never throws (a spawn failure is recorded as text, so the observation is still written). */
function hostVersion(): string {
  const result = spawnSync(BIN ?? "", ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const spawnError = result.error ? `spawn error: ${result.error.message}` : "";
  return [stdout, stderr ? `(stderr: ${stderr})` : "", spawnError ? `(${spawnError})` : ""].filter(Boolean).join(" ");
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
/** Same pattern as `CREDENTIAL_NAME` in test/smoke/helpers/routing-host.ts (not exported there): env names the harness treats as credentials. Keep in sync. */
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|COPILOT|GITHUB|^GH_|GEMINI|GOOGLE|AZURE|AWS_)/i;
/** (Re)writes `server.mjs` of a wrapped probe: the env preamble, then the unchanged probe source. Refuses (throws) an extra env key that looks like a credential. */
async function writeProbeServer(plugin: string, out: string, mode: ProbeMode | undefined, extraEnv: Readonly<Record<string, string>>): Promise<void> {
  const credentialLike = Object.keys(extraEnv).filter(name => CREDENTIAL_NAME.test(name));
  if (credentialLike.length > 0) throw new Error(`refusing to write credential-like env key(s) into the generated probe server.mjs: ${credentialLike.join(", ")}`);
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
interface Observation { observed: Obj; relied: ProbeLine[]; hosts: Obj[]; checks: Check[] }
/** One decided-branch assertion (task 0.1.6): evaluated by {@link observeContract} AFTER the observation file is written. `id` = `C<n>/D<decision>`, `message` says what a failure means. */
interface Check { id: string; ok: boolean; message: string }
/** Registers a decided-branch assertion: `id` is `C<n>/<decision id>`; `message` states the contract that broke (what to reopen). */
function check(o: Observation, id: string, ok: boolean, message: string): void { o.checks.push({ id, ok, message }); }
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
    const hostErrors = clip(host.errorLines(), 400);
    // QA-0.1-14: the teardown result is asserted (a leaked host process / port / scratch root would poison the next scenario) and recorded.
    let teardown: Obj;
    try { teardown = { ...(await host.stop()) }; } catch (error) { teardown = { stopError: error instanceof Error ? (error.stack ?? error.message) : String(error) }; }
    o.hosts.push({ tag, mode: mode ?? null, probeFile, probeLoaded: (kinds.loaded ?? 0) >= 1, probeKinds: kinds, probeErrors: clip(lines.filter(l => l.kind === "probe-error"), 800), hostErrors, teardown });
    check(o, `${tag.replace(/-.*$/, "")}/teardown`, teardown.stopError === undefined && teardown.rootRemoved === true && teardown.hostPortClosed === true, `${tag}: host.stop() must remove the scratch root and close the host port (rootRemoved=${String(teardown.rootRemoved)}, hostPortClosed=${String(teardown.hostPortClosed)}${teardown.stopError === undefined ? "" : `, stopError=${String(teardown.stopError).slice(0, 300)}`}); a leaked host or directory affects the next scenario`);
  }
}

/** Runs one contract: `body` fills the observation; the file is written BEFORE any assertion (and also when `body` throws), then
 * the only assertions of this phase: the file exists and the probe loaded in every host. */
async function observeContract(id: string, body: (o: Observation) => Promise<void>): Promise<void> {
  // A contract without a DECISIONS entry would pass silently: refuse to run it.
  const decide: ((o: Observation) => void) | undefined = Object.hasOwn(DECISIONS, id) ? DECISIONS[id] : undefined;
  if (!decide) throw new Error(`${id}: no entry in the DECISIONS table; every contract needs its decided-branch checks (add DECISIONS.${id})`);
  const startedAt = Date.now();
  const o: Observation = { observed: {}, relied: [], hosts: [], checks: [] };
  let failure: unknown;
  try { await body(o); } catch (error) {
    failure = error;
    o.observed.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  if (failure === undefined) {
    try { decide(o); } catch (error) { check(o, `${id}/checks`, false, `the decided-branch check code itself failed (an observation key is missing or malformed): ${String(error)}`); }
  }
  const dir = await obsDir();
  const base = obsBaseDir();
  const file = path.join(dir, `${id}.json`);
  const record = {
    contract: id, runId: RUN_ID, recordedAt: new Date().toISOString(), hostVersion: hostVersion(), obsDir: base, runDir: dir, vitestTmpdir: tmpdir(),
    durationMs: Date.now() - startedAt, hosts: o.hosts, checks: o.checks, probeLinesRelied: clip(o.relied, 1500), observed: clip(o.observed, 3000),
  };
  const text = `${JSON.stringify(redact(record), null, 2)}\n`;
  await writeFile(file, text);
  // Stable locations for the orchestrator: `<OBS_DIR>/latest/C<n>.json` (copy) and `<OBS_DIR>/latest.json` (the run dir of the most recent write).
  await mkdir(path.join(base, "latest"), { recursive: true });
  await writeFile(path.join(base, "latest", `${id}.json`), text);
  await writeFile(path.join(base, "latest.json"), `${JSON.stringify({ runId: RUN_ID, runDir: dir, recordedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`[cpx-host-contract] ${id} observation written to ${file}`);
  if (failure !== undefined) throw failure;
  // Decided branches (ADR 0007): every failed check names its contract/decision; all of them are reported at once.
  const broken = o.checks.filter(c => !c.ok);
  if (broken.length > 0) throw new Error(`${id}: ${broken.length} decided-branch check(s) failed (observation: ${file})\n${broken.map(c => `  - ${c.id}: ${c.message}`).join("\n")}`);
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
async function launchBackground(s: Scenario, marker: string, holdMs: number, onRoot?: (root: string) => void | Promise<void>): Promise<Bg> {
  const { host } = s;
  host.provider.holdMarked(marker, holdMs);
  const root = await host.newRoot(`${s.tag} root`);
  await onRoot?.(root);
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
      // `userHint` (O8): the user tail plus a MANUAL breakpoint on the last REAL message; where does cache_control land on consecutive requests?
      for (const [name, mode] of [["system", "append-tail-system"], ["user", "append-tail-user"], ["newest", "append-tail-newest"], ["userHint", "append-tail-user+hint-last-real"]] as const) {
        await withHost(`C5-${name}`, mode, o, async s => {
          const { arrivals } = instrument(s.host);
          const root = await s.host.newRoot(`C5 ${name} root`);
          await s.host.prompt(root, "C5 first turn");
          await s.host.prompt(root, "C5 second turn");
          const requests = parentRequests(s.host, root);
          const tails = (await probeLines(s.probeFile)).filter(l => l.kind === mode && l.sessionID === root);
          o.relied.push(...tails.slice(0, 3));
          const stored = await storedView(s.host, root);
          // O8: every cache_control on the wire, per request, and on which message it sits relative to the last REAL message (= the one before the tail).
          const breakpoints = requests.map(r => {
            const count = bodyMessages(r).length;
            const paths = findKeys(obj(r.body), /^cache_?control$/i).map(c => `${String(c.path)}=${json(c.value)}`);
            const onMessage = (index: number) => paths.some(p => p.startsWith(`$.messages[${index}]`));
            return { index: r.index, messageCount: count, paths, onTail: onMessage(count - 1), onLastReal: onMessage(count - 2), onSystem: paths.some(p => p.startsWith("$.system")) };
          });
          const hintLines = (await probeLines(s.probeFile)).filter(l => l.kind === "cache-hint-last-real" && l.sessionID === root);
          o.relied.push(...hintLines.slice(0, 2));
          const view: Obj = {
            breakpoints, hintLines: hintLines.map(l => ({ requestNo: l.requestNo, did: l.did, index: l.index, partIndex: l.partIndex, set: l.set })),
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
  it("sets the plugin API's own `cache` hint (ttlSeconds 3600) on the last system part, then on the last message, and records every cache_control the provider request carries", async () => {
    await observeContract("C6", async o => {
      const variants: Obj = {};
      o.observed.variants = variants;
      for (const [name, mode] of [["system", "cache-hint-1h"], ["message", "cache-hint-1h-message"]] as const) {
      await withHost(`C6-${name}`, mode, o, async s => {
        const { arrivals } = instrument(s.host);
        const root = await s.host.newRoot("C6 root");
        await s.host.prompt(root, "C6 first turn");
        await s.host.prompt(root, "C6 second turn");
        const lines = await probeLines(s.probeFile);
        const hints = lines.filter(l => l.kind === mode);
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
            messageCacheControl: occurrences.filter(c => String(c.path).startsWith("$.messages")),
            oneHourOnMessage: occurrences.some(c => String(c.path).startsWith("$.messages") && /"ttl":"1h"/.test(json(c.value))),
          };
        });
        // Where the probe put the hint (what it set, on which part) and what the wire carries: the plugin API's `cache` field -> Anthropic `cache_control`.
        variants[name] = {
          probeMode: mode,
          probeTried: hints.map(l => ({ requestNo: l.requestNo, did: l.did, via: l.via, target: l.target, index: l.index, partIndex: l.partIndex, set: l.set, hadCacheKey: l.hadCacheKey, partKeys: l.partKeys, reason: l.reason })),
          contextShape: shape ? { eventKeys: shape.eventKeys, systemPartKeys: shape.systemPartKeys, messageKeys: shape.messageKeys, partKeys: shape.partKeys, optionKeys: shape.optionKeys } : null,
          requests: views,
          oneHourOnSystem: views.some(v => v.oneHourOnSystem), oneHourOnMessage: views.some(v => v.oneHourOnMessage),
          oneHourAnywhere: views.some(v => v.cacheControl.some(c => /"ttl":"1h"/.test(json(c.value))) || v.oneHourStrings.length > 0),
          hintsApplied: hints.length > 0 && hints.every(l => l.did === true),
        };
      });
      }
      o.observed.providerCarriesOneHourOnSystem = at(variants, "system", "oneHourOnSystem");
      o.observed.providerCarriesOneHourOnMessage = at(variants, "message", "oneHourOnMessage");
      o.observed.providerCarriesOneHourAnywhere = at(variants, "system", "oneHourAnywhere") === true || at(variants, "message", "oneHourAnywhere") === true;
    });
  }, 600_000);
});

// ---------------------------------------------------------------------------- C7 ----
/** `<subagent sessionID="…" state="…">` pairs found in the JSON text of stored messages (quotes may be JSON-escaped). */
const envelopeStates = (value: unknown): Obj[] => [...json(value).matchAll(/<subagent\s+sessionID=\\?"([^"\\]+)\\?"\s+state=\\?"([^"\\]+)\\?"/g)].map(m => ({ sessionID: m[1], state: m[2] }));
/** `JSON.parse` of a probe `error` field (a JSON string cut to 1000 characters); `{ unparsed }` when it is not complete JSON. */
function parseJsonObject(value: unknown): Obj {
  if (typeof value !== "string") return { unparsed: value };
  try { return obj(JSON.parse(value)); } catch (error) { if (error instanceof SyntaxError) return { unparsed: value.slice(0, 300) }; throw error; }
}
/** The last `assistant` message of a session context (where the child's final text is stored). */
const finalAssistant = (context: readonly Obj[]): Obj | undefined => context.filter(m => m.type === "assistant").at(-1);
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
            // O1: the child's final assistant text lives in the last `assistant` message (the last message of the context is the `idle` marker, which carries only the outcome).
            context: {
              messageCount: context.length, finalMessage: clip(finalMessage, 800), finalMessageType: str(finalMessage?.type), finalOutcome: str(finalMessage?.outcome), containsChildOk: json(context).includes("CHILD_OK"), roles: context.map(m => str(m.role) ?? str(m.type)),
              finalAssistant: clip(finalAssistant(context), 800), finalTexts: textsOf(finalAssistant(context) ?? {}).map(t => t.slice(0, 300)), finalTextPaths: stringPaths(finalAssistant(context), /CHILD_OK/),
            },
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
/** `tool_use_id` of the tool_result blocks in the LAST message of a provider request. */
const toolResultIds = (r: CpxRequest): string[] => arr(bodyMessages(r).at(-1)?.content).map(obj).filter(b => b.type === "tool_result").flatMap(b => { const id = str(b.tool_use_id); return id === undefined ? [] : [id]; });
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
        const { arrivals } = instrument(host);
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
          // QA-0.1-10: the request that carried THIS call's result: the one whose tool_result.tool_use_id is the call id; else the first tool-result request that arrived after the prompt started.
          const callID = str(before?.callID);
          const candidates = parentRequests(host, root).filter(r => lastIsToolResult(r));
          const byId = callID === undefined ? undefined : candidates.find(r => toolResultIds(r).includes(callID));
          const firstAfterStart = candidates.find(r => (arrivals.get(r.index) ?? 0) >= startedAt);
          const seen = byId ?? firstAfterStart;
          const selectedBy = byId ? "tool_use_id" : firstAfterStart ? "first-after-start" : null;
          const modelText = seen ? toolResultText(seen) : undefined;
          const advertised = defs.has(tool);
          perTool[tool] = {
            advertised, inputSent: input, promptError, callID, selectedBy, toolResultIdsInSelected: seen ? toolResultIds(seen) : [],
            // QA-0.1-9: for a tool the host does not advertise the input keys are the test's own input, not an observation: recorded as unobserved.
            executeBefore: before
              ? (advertised ? { argKeys: before.argKeys, args: before.args, agent: before.agent } : { argKeys: null, args: null, agent: before.agent, inputKeysUnobserved: true, reason: "the host does not advertise this tool in this fixture, so the arguments are the test's own input" })
              : null,
            executeAfter: after ? { status: after.status, resultKeys: after.resultKeys, contentText: after.contentText, outputText: after.outputText, error: after.error } : null,
            filter: filter ? { mutable: filter.mutable, removedLines: filter.removedLines, sawLeasedFull: filter.sawLeasedFull, error: filter.error, note: filter.note } : null,
            modelSaw: modelText === undefined ? null : { text: modelText.slice(0, 500), containsLeased: modelText.includes("CPX_LEASED"), containsHiddenNote: modelText.includes("[cpx: 1 hidden]"), requestIndex: seen?.index },
            // The execute.after line keeps only a ~300-character preview of the result; `filter.sawLeasedFull` is the probe's check on the FULL pre-filter text.
            probeSawLeasedInPreview: after ? json([after.contentText, after.outputText]).includes("CPX_LEASED") : undefined,
          };
        }
        o.observed.fixtureErrors = host.provider.errors.map(e => e.slice(0, 300));
      });
    });
  }, 900_000);
});

// --------------------------------------------------------------------------- C10 ----
interface FaultCase { name: string; kind: FaultKind; mode: "once" | "persistent" | "until-reset"; capMs: number; variant?: UsageLimitVariant; probe?: ProbeMode }
/** Observation window of the persistent-fault cases (ms): "no step.failed" is only claimed within it (QA-0.1-7b). */
const PERSISTENT_WINDOW_MS = 75_000;
const FAULT_CASES: readonly FaultCase[] = [
  { name: "rate-limit-once", kind: "rate-limit", mode: "once", capMs: 90_000 },
  { name: "overloaded-once", kind: "overloaded", mode: "once", capMs: 90_000 },
  { name: "rate-limit-persistent", kind: "rate-limit", mode: "persistent", capMs: PERSISTENT_WINDOW_MS },
  { name: "overloaded-persistent", kind: "overloaded", mode: "persistent", capMs: PERSISTENT_WINDOW_MS },
  { name: "usage-limit-until-reset", kind: "usage-limit", mode: "until-reset", capMs: 120_000 },
  // QA-0.1-7a: which feature of the usage-limit answer makes the host classify it as provider.quota? One run per variant (default = the case above).
  { name: "usage-limit-header-only", kind: "usage-limit", mode: "until-reset", capMs: 120_000, variant: "header-only" },
  { name: "usage-limit-alt-wording", kind: "usage-limit", mode: "until-reset", capMs: 120_000, variant: "alt-wording" },
  { name: "usage-limit-retry-after-only", kind: "usage-limit", mode: "until-reset", capMs: 120_000, variant: "retry-after-only" },
  { name: "usage-limit-control-no-wording", kind: "usage-limit", mode: "until-reset", capMs: 120_000, variant: "no-usage-wording" },
  // QA-0.1-7c: the plugin API's session.hook("retry"): observed on a single 429 and on a quota error; `retry-stop` on the persistent 429 (can D13 stop endless retries?).
  { name: "rate-limit-once-retry-observe", kind: "rate-limit", mode: "once", capMs: 90_000, probe: "retry-observe" },
  { name: "usage-limit-retry-observe", kind: "usage-limit", mode: "until-reset", capMs: 120_000, probe: "retry-observe" },
  { name: "rate-limit-persistent-retry-stop", kind: "rate-limit", mode: "persistent", capMs: PERSISTENT_WINDOW_MS, probe: "retry-stop" },
];
/** How the host classifies each usage-limit variant (the error type of step.failed, else of the first session.retry.scheduled).
 *  "reset-sentence" is the observed baseline of the earlier run. The other entries are UNCONFIRMED hypotheses (wording-driven classification) until the
 *  first run of this file: set each to the value recorded in C10.json (`cases.<name>.classification`) and keep the message; do not loosen the check. */
const EXPECTED_CLASSIFICATION: Record<string, string> = {
  "usage-limit-until-reset": "provider.quota", "usage-limit-header-only": "provider.quota", "usage-limit-alt-wording": "provider.quota",
  "usage-limit-retry-after-only": "provider.quota", "usage-limit-control-no-wording": "provider.rate-limit",
};
const RESET_AHEAD_MS = 10_000;

d("C10 provider errors: 429, 529 and usage limit", () => {
  it("queues faults on the root's requests and records retries, backoff, events and whether the turn completes", async () => {
    await observeContract("C10", async o => {
      const cases: Obj = {};
      o.observed.cases = cases;
      for (const c of FAULT_CASES) {
        await withHost(`C10-${c.name}`, c.probe, o, async s => {
          const { host } = s;
          const { arrivals } = instrument(host);
          const root = await host.newRoot(`C10 ${c.name} root`);
          const resetAtMs = Date.now() + RESET_AHEAD_MS;
          const mine = (r: CpxRequest): boolean => hdr(r, "x-proof-session") === root && hdr(r, "x-proof-kind") === "primary";
          // once: one failure; persistent: every root request fails until the cap; until-reset: every root request fails until resetAt has passed.
          front(host).failWhen(r => mine(r) && (c.mode !== "until-reset" || Date.now() < resetAtMs), c.kind, {
            times: c.mode === "once" ? 1 : Infinity, retryAfterSeconds: 2, ...(c.kind === "usage-limit" ? { resetAt: new Date(resetAtMs), ...(c.variant ? { variant: c.variant } : {}) } : {}),
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
          // D13 provider source: the probe records no `session.step.started`, so it is read from the harness event log: the last one BEFORE the first retry event.
          const firstRetry = events.findIndex(e => e.type === "session.retry.scheduled");
          const precedingStep = firstRetry < 0 ? undefined : events.slice(0, firstRetry).filter(e => e.type === "session.step.started").at(-1);
          const stepStartedBeforeRetry = precedingStep
            ? { dataKeys: Object.keys(obj(precedingStep.data)), data: clip(precedingStep.data, 600), providerID: str(obj(obj(precedingStep.data).model).providerID), modelID: str(obj(obj(precedingStep.data).model).id) ?? str(obj(obj(precedingStep.data).model).modelID) }
            : null;
          // QA-0.1-7a: the host's classification of this answer = the error type of the first step.failed, else of the first retry event; and where the reset time can be read from.
          const failedError = lines.filter(l => l.kind === "session.step.failed").map(l => parseJsonObject(l.error))[0];
          const retryError = events.filter(e => e.type === "session.retry.scheduled").map(e => obj(obj(e.data).error))[0];
          const classification = failedError ? str(failedError.type) ?? "step.failed without type" : retryError ? str(retryError.type) ?? "retry without type" : "none";
          const resetIsoSent = new Date(resetAtMs).toISOString();
          const surfaced = failedError ?? retryError;
          const resetPaths = surfaced ? stringPaths(surfaced, new RegExp(resetIsoSent.replace(/[.]/g, "\\."))) : [];
          const responseFields = surfaced ? findKeys(surfaced, /^(headers|response|responseHeaders|retryAfter|resetAt|resetsAt)$/i).map(k => ({ path: k.path, value: clip(k.value, 300) })) : [];
          // QA-0.1-7c: the plugin retry hook's calls (retry-observe / retry-stop modes) and what the probe set.
          const probeAll = await probeLines(s.probeFile);
          const retryHookCalls = probeAll.filter(l => l.kind === "retry-hook" && l.sessionID === root);
          const retryStops = probeAll.filter(l => l.kind === "retry-stop" && l.sessionID === root);
          o.relied.push(...retryHookCalls.slice(0, 3), ...retryStops.slice(0, 2));
          cases[c.name] = {
            variant: c.variant ?? (c.kind === "usage-limit" ? "reset-sentence" : undefined), probeMode: c.probe ?? null, observationWindowMs: c.capMs,
            classification, classifiedBy: failedError ? "session.step.failed" : retryError ? "session.retry.scheduled" : null,
            resetRecoverable: { sentIso: c.kind === "usage-limit" ? resetIsoSent : undefined, inMessage: surfaced ? String(surfaced.message ?? "").includes(resetIsoSent) : false, paths: resetPaths, responseFields, surfacedError: clip(surfaced, 800) },
            retryHook: {
              available: probeAll.find(l => l.kind === "retry-hook-available")?.available,
              calls: retryHookCalls.map(l => ({ t: l.t, attempt: l.attempt, errorType: l.errorType, errorStatus: l.errorStatus, errorMessage: l.errorMessage, errorKeys: l.errorKeys, eventKeys: l.eventKeys, decisionKeys: l.decisionKeys, decisionReceived: l.decisionReceived })),
              stops: retryStops.map(l => ({ t: l.t, attempt: l.attempt, assigned: l.assigned, error: l.error, decisionAfter: l.decisionAfter })),
            },
            stepStartedCount: events.filter(e => e.type === "session.step.started").length, stepStartedBeforeRetry,
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
            // O2: the retry event's error (type / status / message) and the parsed step.failed error, as the host emitted them.
            retryScheduled: events.filter(e => e.type === "session.retry.scheduled").map(e => ({ attempt: obj(e.data).attempt, at: obj(e.data).at, error: { type: obj(obj(e.data).error).type, status: obj(obj(e.data).error).status, message: str(obj(obj(e.data).error).message)?.slice(0, 300), keys: Object.keys(obj(obj(e.data).error)) } })),
            stepFailedParsed: lines.filter(l => l.kind === "session.step.failed").map(l => parseJsonObject(l.error)),
            hostEvents: events.slice(0, 60).map(e => ({ type: e.type, created: e.created, data: clip(e.data, 400) })),
            hostLogLines: host.tail(150_000).split(/\r?\n/).filter(line => /retr|429|529|overload|rate.?limit|usage/i.test(line)).slice(-30).map(line => line.slice(0, 300)),
            frontErrors: front(host).frontErrors,
          };
        });
      }
    });
  }, 3_000_000);
});

// ------------------------------------------------------------------ batch 3 helpers ----
/** `host.client.session.<name>` looked up at run time (the harness's HostClient type lists only some methods). `undefined` when the client has no such method. */
function sessionMethod(host: RoutingHost, name: string): ((input: Obj) => Promise<unknown>) | undefined {
  const session: object = host.client.session;
  const method: unknown = Reflect.get(session, name);
  return typeof method === "function" ? async input => Reflect.apply(method, session, [input]) : undefined;
}
type ClientCall = { status: "absent" } | { status: "error"; error: string } | { status: "ok"; value: unknown };
/** `host.client.<group>.<method>(input)` looked up at run time (client groups the harness's HostClient type does not list); reads `host.client` at call time. */
async function clientCall(host: RoutingHost, group: string, method: string, input: Obj): Promise<ClientCall> {
  const target: unknown = Reflect.get(host.client, group);
  const fn: unknown = target !== null && typeof target === "object" ? Reflect.get(target, method) : undefined;
  if (typeof fn !== "function") return { status: "absent" };
  try { return { status: "ok", value: await Reflect.apply(fn, target, [input]) }; } catch (error) { return { status: "error", error: String(error) }; }
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
  private readonly all: readonly string[];
  /** `tokens` hold child (non-root) sessions by any message; `rootTokens` hold the ROOT session's requests whose LAST message carries the token (keeps a root turn active). */
  constructor(host: RoutingHost, private readonly root: string, readonly tokens: readonly string[], rootTokens: readonly string[] = []) {
    this.all = [...tokens, ...rootTokens];
    const options = front(host).options;
    options.delayMs = request => {
      this.stamps.set(request.index, Date.now());
      const session = hdr(request, "x-proof-session");
      if (session === undefined || hdr(request, "x-proof-kind") !== "primary") return 0;
      const isRoot = session === this.root;
      const text = json(isRoot ? bodyMessages(request).at(-1) : bodyMessages(request));
      const code = this.all.findIndex((t, i) => (i >= this.tokens.length) === isRoot && !this.released.has(t) && text.includes(t));
      if (code < 0) return 0;
      this.arrivals.push({ token: this.all[code]!, index: request.index, session, at: Date.now() });
      this.waiting += 1;
      this.peakWaiting = Math.max(this.peakWaiting, this.waiting);
      return GATE_BASE + code;
    };
    options.sleep = ms => new Promise<void>(resolve => {
      if (ms < GATE_BASE || ms >= GATE_BASE + this.all.length) { setTimeout(resolve, ms); return; }
      this.parked.set(ms, [...(this.parked.get(ms) ?? []), resolve]);
    });
  }
  /** Releases one token (and every later arrival of it). */
  release(token: string): void {
    this.released.add(token);
    const code = GATE_BASE + this.all.indexOf(token);
    const waiters = this.parked.get(code) ?? [];
    this.parked.delete(code);
    this.waiting -= waiters.length;
    for (const a of this.arrivals) if (a.token === token && a.releasedAt === undefined) a.releasedAt = Date.now();
    for (const resolve of waiters) resolve();
  }
  releaseAll(): void { for (const t of this.all) this.release(t); }
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
        // QA-0.1-6: A is only "finished just before the restart" once its terminal probe line AND its completion envelope in the parent's stored history exist; wait for both.
        const aID = ids.C12_A;
        const aTerminalBefore = aID ? await tryWait("child A's terminal probe line before the restart", async () => terminalOf(await probeLines(s.probeFile), aID), 45_000) : undefined;
        if (aTerminalBefore) o.relied.push(aTerminalBefore);
        const aEnvelopeBefore = aID ? await tryWait("child A's completion envelope stored in the parent before the restart", async () => { const v = await storedView(host, root); return envelopeStates(v.envelopes).some(e => e.sessionID === aID) ? v : undefined; }, 45_000) : undefined;
        const restartStartedAt = Date.now();
        await host.restart();
        const restartEndedAt = Date.now();
        gates.release("C12_B");
        const bReleasedAt = Date.now();
        o.observed.timing = {
          aReleasedAt: releasedAt, aForwarded: forwarded === true, restartStartedAt, restartEndedAt, bReleasedAt, restartMs: restartEndedAt - restartStartedAt,
          aTerminalBeforeRestart: aTerminalBefore !== undefined && aTerminalBefore.t < restartStartedAt, aTerminalAt: aTerminalBefore?.t, aEnvelopeStoredBeforeRestart: aEnvelopeBefore !== undefined,
          note: "A's terminal event and stored completion are awaited before restart() is called; restart() kills and relaunches in one call, so the downtime itself cannot be hit",
        };
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
        // The wake request (first parent request after the pre-release snapshot) against the restart window; arrival stamps come from `Gates` (front delayMs, same clock).
        const wakeAt = woke ? gates.stamps.get(woke.index) : undefined;
        const allParentRequests = parentRequests(host, root);
        const carriesA = (r: CpxRequest): boolean => envelopeStates(bodyMessages(r)).some(e => e.sessionID === aID);
        // Wire deliveries of A's completion = parent requests that carry A's envelope although the previous parent request did not (a re-sent history is not a new delivery).
        const aWireDeliveries = allParentRequests.filter((r, i) => carriesA(r) && (i === 0 || !carriesA(allParentRequests[i - 1]!))).length;
        o.observed.parent = {
          wokeBeforeRestart: wakeAt !== undefined && wakeAt < restartStartedAt, wokeAfterRestart: wakeAt !== undefined && wakeAt >= restartStartedAt, wakeArrivedAt: wakeAt, wakeRequestIndex: woke?.index,
          aEnvelopesStored: envelopeStates(after.envelopes).filter(e => e.sessionID === aID).length, aWireDeliveries, aWireRequestsCarrying: allParentRequests.filter(carriesA).map(r => r.index),
          parentRequestsAfter: allParentRequests.length, parentRequestsBefore,
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
        // "background-active" (O4a): background children, and the root is ACTIVE too (a second turn whose provider request is held) when it is interrupted.
        for (const variant of ["background", "foreground", "background-active"] as const) {
          const root = await host.newRoot(`C13 interrupt ${variant} root`);
          const label = { background: "b", foreground: "f", "background-active": "a" }[variant];
          const gates = new Gates(host, root, tokensOf(`C13i${label}`, 3), variant === "background-active" ? ["C13i_rootbusy"] : []);
          const inputs = gates.tokens.map(t => childInput(t, variant !== "foreground"));
          if (variant !== "foreground") await host.callMany(root, inputs);
          else await host.client.session.prompt({ sessionID: root, text: `SPIKE_CALLS=${JSON.stringify(inputs)}` });
          await tryWait("3 held child requests", () => (gates.arrivals.filter(a => a.session !== root).length >= 3 ? true : undefined), 30_000);
          if (variant === "background-active") {
            await host.client.session.prompt({ sessionID: root, text: "C13 keep the root busy C13i_rootbusy" });
            await tryWait("the root's held request", () => (gates.arrivals.some(a => a.session === root) ? true : undefined), 30_000);
          }
          const ids = [...new Set(gates.arrivals.map(a => a.session).filter((x): x is string => x !== undefined && x !== root))];
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
const RETAINED_NAME = "cpx-retained.txt";
/** File URL of the plugin package's `tool` module: `CPX_PROBE_TOOL_URL` of every scenario whose probe mode registers a tool (retained-launch, plugin-session-api). */
const TOOL_MODULE_URL = pathToFileURL(path.join(ROOT, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")).href;
/** Fills every heading of the host's compaction summary template (same text as the frozen routing-spikes harness uses). */
const COMPACTION_SUMMARY = ["## Objective", "cpx", "## Requirements", "none", "## Decisions", "none", "## Work State", "### Completed", "none", "### Active", "none", "### Blocked", "none", "## Next Move", "reply", "## Relevant Files", "none", "## Important Context", "none"].join("\n");
/** Children per retained-launch batch (O3: ADR 0007 proved 3; D13/D14 clamp `maxParallel` to 8, so 8 must run concurrently). */
const RETAINED_COUNT = 8;
/** Children of the control / retained-signal hosts (they only need to show the router-only effect and the signal effect). */
const LIGHT_COUNT = 3;
/** Identical `read` calls each retained child makes (CHILD_SCRIPT64 steps): the router's redundancy / read-budget guards refuse the later ones when they apply to the child. */
const RETAINED_READS = 6;
/** Prompt of the retained-launch children (probe `{n}` = child number). `C14G_<n>x` is the token `Gates` parks the child's first request on; the CHILD_SCRIPT64 marker
 * makes RoutingProvider script `RETAINED_READS` identical `read` calls of `file` in the child's own turn, then answer CHILD_OK. */
const retainedPrompt = (file: string): string => `C14G_{n}x ${scriptLine(Array.from({ length: RETAINED_READS }, () => ({ tool: "read", input: { path: file } })), "CHILD_OK")}`;
/** Probe env of the C14 hosts; the child prompt names a file of the host's project, so it is resolved in `prepare` (see {@link ProbeEnv}). Children use the non-default agent
 * `cpx-child` and an explicit model, so the contract "agent and model are honoured for retained launches" is observable. */
const retainedEnvFor = (count: number, relaunchMs: number | undefined, extra: Readonly<Record<string, string>> = {}): ProbeEnv => project => ({
  CPX_PROBE_TOOL_URL: pathToFileURL(path.join(ROOT, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")).href, CPX_PROBE_RETAINED_COUNT: String(count),
  ...(relaunchMs === undefined ? {} : { CPX_PROBE_RELAUNCH_MS: String(relaunchMs) }),
  CPX_PROBE_CHILD_PROMPT: retainedPrompt(path.join(project, RETAINED_NAME)), CPX_PROBE_CHILD_AGENT: CHILD, CPX_PROBE_CHILD_MODEL: `${SONNET}#low`, ...extra,
});
const retainedEnv: ProbeEnv = retainedEnvFor(RETAINED_COUNT, 60_000);
/** Host options of the C14 hosts: router ENFORCED (guards live), the harness probe's lifecycle log (permission evaluations), the read target in the project. */
const retainedHostOptions = (overrides: Partial<HostOptions> = {}): HostOptions => ({
  ...BASE, overrides: { enforcement: { mode: "enforced" } }, probe: { lifecycle: true },
  prepare: async ({ project }) => { await writeFile(path.join(project, RETAINED_NAME), "retained child read target\n"); }, ...overrides,
});
/** Per retained child: the agent / model it ACTUALLY ran with (session record, provider request headers and bodies), the tool results the model got back, and the router-only
 * observable: a router guard refusal text (`DENIED: …`) in a tool result, which only the router can produce (the control host without the router never shows one). */
async function childContracts(host: RoutingHost, ids: readonly string[]): Promise<Obj[]> {
  const hooks = await host.hooks();
  return Promise.all(ids.map(async id => {
    const mine = front(host).requests.filter(r => hdr(r, "x-proof-session") === id && hdr(r, "x-proof-kind") === "primary");
    const results = mine.filter(r => lastIsToolResult(r)).map(r => toolResultText(r));
    const refusals = results.filter(t => /DENIED:|Refused/.test(t));
    const session = await host.client.session.get({ sessionID: id }).then(g => ({ agent: g.agent, parentID: g.parentID, model: g.model ? ref(g.model) : undefined }), error => ({ error: String(error) }));
    return {
      sessionID: id, session, wireModels: [...new Set(mine.map(r => str(obj(r.body).model)))], catalogModels: [...new Set(mine.map(r => hdr(r, "x-proof-model")))],
      providerRequests: mine.length, toolResults: results.length, toolResultSamples: results.slice(0, 3).map(t => t.slice(0, 160)),
      routerRefusals: refusals.length, firstRefusal: refusals[0]?.slice(0, 300),
      readHooksBefore: hooks.filter(h => h.sessionID === id && h.hook === "before" && h.tool === "read").length,
      readHooksAfterOk: hooks.filter(h => h.sessionID === id && h.hook === "after" && h.tool === "read" && h.status === "completed").length,
    };
  }));
}
/** A light C14 host (3 children, no relaunch): used as the CONTROL (`withoutRouter`: same launch, no router) and for the retained-`signal` variant. */
async function lightRetained(o: Observation, tag: string, options: HostOptions, extraEnv: Readonly<Record<string, string>>, parkMs: number): Promise<Obj> {
  let summary: Obj = {};
  await withHost(tag, "retained-launch", o, async s => {
    const { host } = s;
    const root = await host.newRoot(`${tag} root`);
    const gates = new Gates(host, root, tokensOf("C14G", LIGHT_COUNT));
    await host.prompt(root, `READ_ONLY_PROBE=${JSON.stringify({ tool: "cpx_probe_capture", input: {} })}`);
    const parked = await tryWait(`${LIGHT_COUNT} retained children parked (${tag})`, () => (gates.arrivals.filter(a => a.session !== root).length >= LIGHT_COUNT ? true : undefined), parkMs);
    const peakWaiting = gates.peakWaiting;
    gates.releaseAll();
    const results = await tryWait(`${LIGHT_COUNT} launch results (${tag})`, async () => { const ls = (await probeLines(s.probeFile)).filter(l => l.kind === "retained-launch-result"); return ls.length >= LIGHT_COUNT ? ls : undefined; }, 90_000);
    const lines = await probeLines(s.probeFile);
    const launchResults = lines.filter(l => l.kind === "retained-launch-result");
    const ids = [...new Set(launchResults.map(l => str(l.childSessionID)).filter((x): x is string => x !== undefined))];
    o.relied.push(...lines.filter(l => l.kind === "retained-launch-batch"));
    summary = {
      tag, withoutRouter: options.withoutRouter === true, parked: parked === true, peakWaiting, resultsReturned: results !== undefined,
      batchLine: clip(lines.find(l => l.kind === "retained-launch-batch"), 900),
      results: launchResults.map(l => ({ n: l.n, ok: l.ok, status: l.status, error: l.error, name: l.name, childSessionID: l.childSessionID })),
      children: await childContracts(host, ids),
    };
  }, options, retainedEnvFor(LIGHT_COUNT, undefined, extraEnv));
  return summary;
}

d("C14 launch with a retained tool context outside any LLM tool call", () => {
  it("captures the context in cpx_probe_capture, ends the turn, and records the probe's launches (now and 60 s later)", async () => {
    await observeContract("C14", async o => {
      await withHost("C14", "retained-launch", o, async s => {
        const { host } = s;
        const retainedFile = path.join(host.project, RETAINED_NAME);
        const root = await host.newRoot("C14 root");
        // QA-5 (O3): batch 1 is parked by `Gates` (not a timed hold) until all RETAINED_COUNT children's first provider requests are waiting at once, then released.
        const gates = new Gates(host, root, tokensOf("C14G", RETAINED_COUNT));
        const arrivals = gates.stamps;
        const ids = async () => (await host.client.session.context({ sessionID: root })).map(m => str(m.id) ?? str(m.type));
        await host.prompt(root, `READ_ONLY_PROBE=${JSON.stringify({ tool: "cpx_probe_capture", input: {} })}`);
        const parked = await tryWait(`${RETAINED_COUNT} retained children parked at the provider`, () => (gates.arrivals.filter(a => a.session !== root).length >= RETAINED_COUNT ? true : undefined), 90_000);
        const peakWaiting = gates.peakWaiting;
        const parkedSessions = new Set(gates.arrivals.map(a => a.session)).size;
        gates.releaseAll();
        const history: Obj = { afterCaptureTurn: await ids() };
        const batchDone = (batch: number) => async () => { const ls = (await probeLines(s.probeFile)).filter(l => l.kind === "retained-launch-result" && l.batch === batch); return ls.length >= RETAINED_COUNT ? ls : undefined; };
        const first = await tryWait("batch 1 results", batchDone(1), 120_000);
        history.afterBatch1 = await ids();
        const second = await tryWait("batch 2 (relaunch after 60 s) results", batchDone(2), 180_000);
        history.afterBatch2 = await ids();
        const lines = await probeLines(s.probeFile);
        const retained = lines.filter(l => l.kind.startsWith("retained-") || l.kind === "probe-error");
        o.relied.push(...retained.slice(0, 12));
        const childIDs = [...new Set(retained.map(l => str(l.childSessionID) ?? str(l.seenInProgress)).filter((x): x is string => x !== undefined))];
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
        // Batch 1 only: every child's first request is parked by Gates until all are waiting; peakWaiting is the number of provider requests parked at the same moment.
        o.observed.concurrency = {
          launched: RETAINED_COUNT, allParked: parked === true, peakWaiting, parkedSessions,
          arrivals: gates.arrivals.map(a => ({ token: a.token, at: a.at, releasedAt: a.releasedAt })),
        };
        // QA-12: what the probe changes in the retained context for its launches (the batch lines record signal / progress replacement and the retained signal's state).
        const batchLine = byBatch(1).find(l => l.kind === "retained-launch-batch");
        o.observed.launchContext = {
          signalReplaced: batchLine?.signalReplaced, progressReplaced: batchLine?.progressReplaced, retainedSignalType: batchLine?.retainedSignalType,
          retainedSignalAbortedAtLaunch: batchLine?.retainedSignalAbortedAtLaunch, requestedAgent: batchLine?.requestedAgent, requestedModel: batchLine?.requestedModel,
          note: "the probe launches with its own 300 s AbortController as `signal` and a recording `progress`; the `retainedSignal` host below launches with the retained signal itself",
        };
        o.observed.childContract = await childContracts(host, childIDs);
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
          const contextTimes = lifecycleEvents.filter(e => e.point === "context").map(e => e.__t).filter((t): t is number => typeof t === "number");
          const toolTimes = harness.filter(h => h.hook === "before").map(h => h.__t);
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
            // D14: the context hook (agent / model binding) must have run for the child BEFORE its first tool call; `__t` = harness clock (Date.now) of the lifecycle event / hook record.
            firstContextAt: contextTimes.length > 0 ? Math.min(...contextTimes) : undefined,
            firstToolAt: toolTimes.length > 0 ? Math.min(...toolTimes) : undefined,
            firstContextBeforeFirstTool: contextTimes.length > 0 && toolTimes.length > 0 ? Math.min(...contextTimes) < Math.min(...toolTimes) : undefined,
          };
        });
        const triggered = perChild.some(c => c.probeBefore.some(b => b.tool === "read"));
        o.observed.hooksForChildren = {
          childPrompt: retainedPrompt(retainedFile), file: retainedFile,
          childPromptCanTriggerTool: triggered, probeHookLinesForChildren: toolLines.length, harnessHookRecordsForChildren: harnessHooks.length,
          tools: [...new Set([...toolLines.map(l => l.tool), ...harnessHooks.map(h => h.tool)])],
          // NOT router evidence: the harness probe's own evaluate hook (lifecycle) also produces permission evaluations. The router-only observable is `childContract[*].routerRefusals`, measured against `control`.
          anyPermissionOrDecisionEvidence: perChild.some(c => c.permissionEvaluations.length > 0 || c.routerDecisionRows > 0 || c.harnessRouterSeen.some(h => h.hook === "after" && json(h.result).includes("router"))),
          routerLogLines: host.routerLogLines().slice(-10).map(l => l.slice(0, 300)),
          subagentHooksOnRootAfterCapture: lines.filter(l => (l.kind === "execute.before" || l.kind === "execute.after") && l.tool === "subagent" && l.sessionID === root).length,
          perChild,
        };
        const kids = await host.children(root);
        o.observed.parentHistory = { ...history, unchangedAcrossLaunches: json(history.afterCaptureTurn) === json(history.afterBatch1) && json(history.afterBatch1) === json(history.afterBatch2), childrenListedUnderRoot: kids.map(k => ({ id: k.id, parentID: k.parentID, agent: k.agent })), session: await sessionState(host, root) };
      }, retainedHostOptions(), retainedEnv);
      // QA-2a CONTROL: the same launch on a host WITHOUT the router. Anything the router adds to a retained child (guard refusals) is absent here.
      o.observed.control = await lightRetained(o, "C14-control", retainedHostOptions({ withoutRouter: true }), {}, 60_000);
      // QA-12: the same launch with the RETAINED context's own `signal` instead of the probe's controller (the capture call has ended by then).
      o.observed.retainedSignal = await lightRetained(o, "C14-signal", retainedHostOptions(), { CPX_PROBE_USE_RETAINED_SIGNAL: "1" }, 30_000);
    });
  }, 1_200_000);
});

// ---------------------------------------------------------------------------- C15 ----
/** The compaction window: the messages the compaction hook received (ids / roles / first text) against the session's stored history snapshot taken just before `compact()`. */
function compactionWindow(hook: ProbeLine | undefined, before: readonly Obj[]): Obj {
  const sent = arr(hook?.messages).map(obj);
  const sentIds = sent.map(m => str(m.id));
  return {
    hookFired: hook !== undefined, hookMessageCount: sent.length,
    hookMessages: sent.map(m => ({ id: str(m.id), role: str(m.role), partCount: m.partCount, text: str(arr(m.texts)[0])?.slice(0, 120), otherPartTypes: arr(m.other).map(x => str(obj(x).type)) })),
    storedBeforeCount: before.length,
    storedBefore: before.map(m => ({ id: str(m.id), type: str(m.type), role: str(m.role), snippet: json(m).slice(0, 120) })),
    storedIdsInHook: before.filter(m => str(m.id) !== undefined && sentIds.includes(str(m.id))).map(m => str(m.id)),
    storedIdsNotInHook: before.filter(m => str(m.id) !== undefined && !sentIds.includes(str(m.id))).map(m => ({ id: str(m.id), type: str(m.type), role: str(m.role) })),
    hookIdsNotInStored: sentIds.filter(id => id !== undefined && !before.some(m => str(m.id) === id)),
  };
}
d("C15 compaction hook: can a plugin rewrite the compaction request", () => {
  it("puts CPX_HELD_ORIGINAL in the history, compacts, and records the hook, the provider request and the stored summary", async () => {
    await observeContract("C15", async o => {
      await withHost("C15", "rewrite-compaction", o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        const root = await host.newRoot("C15 root");
        // O5: the host rejects a summary that does not follow its template. RoutingProvider answers `final` of a `CHILD_SCRIPT64` marker found in the
        // history (no steps), and the compaction request carries that history, so the compaction reply is the template-conforming COMPACTION_SUMMARY.
        await host.prompt(root, `C15 first note CPX_HELD_ORIGINAL ${scriptLine([], COMPACTION_SUMMARY)}`);
        await host.prompt(root, "C15 second note");
        // (a) snapshot of the stored context BEFORE compact(): after a successful compaction `context()` returns only the compacted view.
        const preContext = await host.client.session.context({ sessionID: root });
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
        // QA-0.1-11: success is `status === "completed"` of the compaction record; there is no "any non-failed status after a timeout" branch.
        const settledContext = await tryWait("the compaction record to reach status completed", async () => {
          const c = await host.client.session.context({ sessionID: root });
          const records = c.filter(m => m.type === "compaction");
          return records.length > 0 && records.every(m => m.status === "completed") ? c : undefined;
        }, 60_000);
        const stored = settledContext ?? await host.client.session.context({ sessionID: root });
        const compactionRecords = stored.filter(m => m.type === "compaction");
        const compactionRequest = requests.find(r => hdr(r, "x-proof-kind") === "compaction");
        o.observed.compaction = {
          // O5: a successful compaction. `status` and `error` are the host's own record; the request is the one the host sent with kind "compaction".
          records: compactionRecords.map(m => clip({ status: m.status, reason: m.reason, error: m.error, summary: m.summary }, 700)),
          statuses: compactionRecords.map(m => str(m.status)),
          succeeded: compactionRecords.length > 0 && compactionRecords.every(m => m.status === "completed" && m.error === undefined),
          requestKind: compactionRequest ? hdr(compactionRequest, "x-proof-kind") : null, requestIndex: compactionRequest?.index,
          requestHasPlaceholder: compactionRequest ? json(compactionRequest.body).includes("CPX_HELD_PLACEHOLDER") : null,
          requestHasOriginal: compactionRequest ? json(compactionRequest.body).includes("CPX_HELD_ORIGINAL") : null,
          placeholderLeaf: compactionRequest ? stringPaths(compactionRequest.body, /CPX_HELD_PLACEHOLDER/)[0] : null,
          // Recorded only, NOT asserted (QA-0.1-11): it holds by construction, the summary is the scripted COMPACTION_SUMMARY, which never contains the original text.
          summaryHasOriginal: json(compactionRecords).includes("CPX_HELD_ORIGINAL"),
          summaryTexts: compactionRecords.map(m => textsOf(m).map(t => t.slice(0, 200))),
        };
        o.observed.compactionWindow = compactionWindow(hook, preContext); // which turns the host put into the compaction request
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
        // (b) the full stored message log after compaction, if a client API returns it: `message.list` (MessageListInput: sessionID, limit, order, cursor, type)
        // and `session.export` (SessionExportInput). `session.log` (an event stream) is not read: following it could block.
        const apis: Obj = {};
        for (const [name, group, method, input] of [["message.list", "message", "list", { sessionID: root, limit: 500, order: "asc" }], ["session.export", "session", "export", { sessionID: root }]] as const) {
          const answer = await clientCall(host, group, method, input);
          const text = answer.status === "ok" ? json(answer.value) : "";
          apis[name] = { status: answer.status, error: answer.status === "error" ? answer.error : undefined, bytes: text.length, hasOriginal: text.includes("CPX_HELD_ORIGINAL"), hasPlaceholder: text.includes("CPX_HELD_PLACEHOLDER"), hasCompactionRecord: /"type":"compaction"/.test(text), originalPaths: answer.status === "ok" ? stringPaths(answer.value, /CPX_HELD_ORIGINAL/).slice(0, 5) : [] };
        }
        o.observed.fullLog = {
          apis, anyApiReturnsPreCompaction: Object.values(apis).some(a => at(a, "hasOriginal") === true),
          note: "context() after a successful compaction returns only the compacted view; the pre-compaction evidence is the snapshot taken before compact() and, where an API below returns it, the full log",
        };
        o.observed.preCompaction = {
          messageCount: preContext.length, hasOriginal: json(preContext).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(preContext).includes("CPX_HELD_PLACEHOLDER"),
          originalPaths: stringPaths(preContext, /CPX_HELD_ORIGINAL/), types: preContext.map(m => str(m.type)),
        };
        o.observed.stored = {
          messageCount: stored.length, hasOriginal: json(stored).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(stored).includes("CPX_HELD_PLACEHOLDER"),
          messages: stored.map((m, i) => ({ i, type: str(m.type), role: str(m.role), hasOriginal: json(m).includes("CPX_HELD_ORIGINAL"), hasPlaceholder: json(m).includes("CPX_HELD_PLACEHOLDER"), snippet: json(m).slice(0, 300) })),
          summaryLike: clip(stored.filter(m => /compact|summary/i.test(json(m).slice(0, 300))), 1200),
        };
      });
      // QA-0.1-11 variant: the compacted session holds a REAL background `<subagent …>` completion; both rewrite modes are active in one probe.
      await withHost("C15-real", "rewrite-completion+compaction", o, async s => {
        const { host } = s;
        // RoutingProvider answers the `final` of the LAST `CHILD_SCRIPT64` user text in the request's history (SPIKE_CALL texts never count), and the host sends only the
        // older part of the history to the compaction model (the latest turn is retained), so the script note is the root's FIRST turn: every later reply of the session,
        // the compaction reply included, is the template-conforming COMPACTION_SUMMARY (as in the main variant, whose first prompt carries the script).
        const bg = await launchBackground(s, "C15R_HOLD", 1_500, async root => { await host.prompt(root, `C15R note ${scriptLine([], COMPACTION_SUMMARY)}`); });
        const childEnd = await awaitChildEnd(s, bg.childID, o);
        const wake = await observeWake(s, bg, 30_000);
        const stored = await tryWait("the real completion envelope in the parent's stored history", async () => { const v = await storedView(host, bg.root); return v.envelopes.length > 0 ? v : undefined; }, 30_000);
        // The host compacts everything except the LATEST turn (observed: with the completion as the latest turn the compaction request held only the first note and its reply),
        // so one more plain turn (its reply is the session script's COMPACTION_SUMMARY) makes the completion part of the compacted window.
        await host.prompt(bg.root, "C15R closing turn");
        const closingIdle = await waitIdle(host, bg.root, 60_000);
        const preContext = await host.client.session.context({ sessionID: bg.root });
        const compact = sessionMethod(host, "compact");
        const requestsBefore = front(host).requests.length;
        const calledAt = Date.now();
        let compactError: string | undefined;
        if (compact) { try { await compact({ sessionID: bg.root }); } catch (error) { compactError = String(error); } }
        const hook = await tryWait("the probe's compaction hook line (real completion)", async () => (await probeLines(s.probeFile)).find(l => l.kind === "compaction" && l.sessionID === bg.root && l.t >= calledAt), 60_000);
        const settled = await tryWait("the compaction record (real completion) to reach status completed", async () => {
          const c = await host.client.session.context({ sessionID: bg.root });
          const records = c.filter(m => m.type === "compaction");
          return records.length > 0 && records.every(m => m.status === "completed") ? c : undefined;
        }, 90_000);
        const after = settled ?? await host.client.session.context({ sessionID: bg.root });
        const records = after.filter(m => m.type === "compaction");
        const lines = await probeLines(s.probeFile);
        const rewrite = lines.find(l => l.kind === "rewrite-compaction" && l.sessionID === bg.root && l.t >= calledAt);
        const request = front(host).requests.slice(requestsBefore).find(r => hdr(r, "x-proof-kind") === "compaction" && hdr(r, "x-proof-session") === bg.root);
        if (hook) o.relied.push(hook);
        if (rewrite) o.relied.push(rewrite);
        o.observed.realCompletion = {
          compactionWindow: compactionWindow(hook, preContext), closingTurnIdle: closingIdle === true,
          childEnd, parentWoke: wake !== undefined, storedEnvelopeBeforeCompact: stored !== undefined, storedEnvelopeStates: stored ? envelopeStates(stored.envelopes) : [],
          compactApi: compact !== undefined, compactError,
          hookFired: hook !== undefined, hookSawEnvelope: hook ? ENVELOPE.test(json(hook.messages)) : false, hookMessages: clip(hook?.messages, 800),
          completionReplacements: Number(rewrite?.completionReplacements ?? 0), heldReplacements: Number(rewrite?.replacements ?? 0), rewriteLine: clip(rewrite, 400),
          requestKind: request ? hdr(request, "x-proof-kind") : null, requestIndex: request?.index,
          requestHasPlaceholder: request ? json(request.body).includes(PLACEHOLDER) : null, requestHasEnvelope: request ? ENVELOPE.test(json(bodyMessages(request))) : null,
          placeholderLeaf: request ? stringPaths(request.body, /verdict pending \(probe\)/)[0] : null,
          statuses: records.map(m => str(m.status)), succeeded: records.length > 0 && records.every(m => m.status === "completed" && m.error === undefined), records: records.map(m => clip({ status: m.status, error: m.error, summary: m.summary }, 500)),
          // Whether the context hook (not only the compaction hook) ran for the compaction request: context-hook lines of the root after the compact call.
          contextHookCallsAfterCompact: lines.filter(l => l.kind === "context" && l.sessionID === bg.root && l.t >= calledAt).length,
        };
      });
    });
  }, 900_000);
});

// --------------------------------------------------------------------------- C14b ----
d("C14b interrupting an ACTIVE root while retained-context children run (O4b)", () => {
  it("holds 3 retained children, keeps the root busy, interrupts it and records what happens to the children and their launches", async () => {
    await observeContract("C14b", async o => {
      await withHost("C14b", "retained-launch", o, async s => {
        const { host } = s;
        const root = await host.newRoot("C14b root");
        const gates = new Gates(host, root, tokensOf("C14B", 3), ["C14B_rootbusy"]);
        await host.prompt(root, `READ_ONLY_PROBE=${JSON.stringify({ tool: "cpx_probe_capture", input: {} })}`); // the turn ends; the probe then launches 3 children with the retained context
        const childrenHeld = await tryWait("3 held retained children", () => (gates.arrivals.filter(a => a.session !== root).length >= 3 ? true : undefined), 60_000);
        await host.client.session.prompt({ sessionID: root, text: "C14b keep the root busy C14B_rootbusy" });
        const rootHeld = await tryWait("the root's held request", () => (gates.arrivals.some(a => a.session === root) ? true : undefined), 30_000);
        const ids = [...new Set(gates.arrivals.map(a => a.session).filter((x): x is string => x !== undefined && x !== root))];
        const rootActiveBefore = await isActive(host, root);
        const activeChildrenBefore = await activeCount(host, ids);
        const interruptAt = Date.now();
        let interruptResult: unknown;
        let interruptError: string | undefined;
        try { interruptResult = await host.client.session.interrupt({ sessionID: root }); } catch (error) { interruptError = String(error); }
        const endedEarly = await tryWait("a retained child or its launch to end before release", async () => {
          const ls = await probeLines(s.probeFile);
          return ids.map(id => terminalOf(ls, id, interruptAt)).find(l => l !== undefined) ?? ls.find(l => l.kind === "retained-launch-result" && l.t >= interruptAt);
        }, 10_000);
        const afterInterrupt = { activeChildren: await activeCount(host, ids), rootActive: await isActive(host, root), endedBeforeRelease: endedEarly ? lineBrief(endedEarly) : null };
        gates.releaseAll();
        const results = await tryWait("the 3 launch results", async () => { const ls = (await probeLines(s.probeFile)).filter(l => l.kind === "retained-launch-result"); return ls.length >= 3 ? ls : undefined; }, 60_000);
        const lines = await probeLines(s.probeFile);
        o.relied.push(...lines.filter(l => l.kind === "retained-launch-result"));
        o.observed.setup = { childrenHeld: childrenHeld === true, rootHeld: rootHeld === true, children: ids, rootActiveBefore, activeChildrenBefore };
        o.observed.interrupt = { api: "host.client.session.interrupt({ sessionID: root })", at: interruptAt, result: clip(interruptResult, 400), error: interruptError };
        o.observed.afterInterrupt = afterInterrupt;
        o.observed.launchResults = { allThreeReturned: results !== undefined, results: lines.filter(l => l.kind === "retained-launch-result").map(l => ({ n: l.n, t: l.t, ok: l.ok, status: l.status, error: l.error, name: l.name, childSessionID: l.childSessionID })) };
        o.observed.perChild = await Promise.all(ids.map(async id => ({
          sessionID: id, terminal: terminalOf(lines, id) ? lineBrief(terminalOf(lines, id)!) : null, session: await sessionState(host, id),
          providerRequests: front(host).requests.filter(r => hdr(r, "x-proof-session") === id).map(r => ({ index: r.index, served: r.served })),
        })));
        o.observed.rootLinesAfterInterrupt = linesOf(lines, root).filter(l => l.t >= interruptAt).map(lineBrief);
        await waitIdle(host, root, 30_000);
      }, BASE, { CPX_PROBE_TOOL_URL: pathToFileURL(path.join(ROOT, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")).href, CPX_PROBE_CHILD_PROMPT: "C14B_{n}x child" });
    });
  }, 600_000);
});

// ---------------------------------------------------------------------------- O6 ----
d("O6 synthetic message with resume: does it wake an idle parent", () => {
  it("posts client.session.synthetic with resume false, then true, on an idle parent and records whether a new provider request arrives", async () => {
    await observeContract("O6", async o => {
      await withHost("O6", undefined, o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        const root = await host.newRoot("O6 root");
        await host.prompt(root, "O6 first turn");
        const synthetic = sessionMethod(host, "synthetic");
        const tries: Obj[] = [];
        for (const resume of [false, true]) {
          // SessionSyntheticInput (@opencode/client types.d.ts:5988): { sessionID, text, description?, metadata?, delivery?, resume? }
          const input = { sessionID: root, text: `O6 synthetic note resume=${resume}`, description: "cpx O6 synthetic", metadata: { source: "cpx", resume }, resume };
          const before = parentRequests(host, root).length;
          let result: unknown;
          let error: string | undefined;
          if (synthetic) { try { result = await synthetic(input); } catch (failure) { error = String(failure); } }
          const woke = await tryWait(`a parent request after synthetic (resume=${resume})`, () => parentRequests(host, root)[before], resume ? 30_000 : 8_000);
          if (woke) await host.settle(root);
          tries.push({
            input, result: clip(result, 500), error, woke: woke !== undefined, wokeArrivedAt: woke ? arrivals.get(woke.index) : undefined,
            wireCarriesText: woke ? json(bodyMessages(woke)).includes(input.text) : null, wireLastMessage: woke ? clip(bodyMessages(woke).at(-1), 500) : null,
          });
        }
        const stored = await host.client.session.context({ sessionID: root });
        o.observed.synthetic = {
          api: { onClient: synthetic !== undefined, via: "host.client.session.synthetic(input)" }, tries,
          stored: clip(stored.filter(m => json(m).includes("O6 synthetic note")), 1500), storedTypes: stored.map(m => str(m.type)),
          parentRequests: parentRequests(host, root).length,
        };
      });
    });
  }, 300_000);
});

// --------------------------------------------------------------------------- O6b ----
const SYNTHETIC_TEXT = "CPX_PLUGIN_SYNTHETIC wake";
d("O6b plugin-side session API: synthetic with resume, context, interrupt", () => {
  it("calls ctx.session.context / interrupt / synthetic({ resume: true }) from the probe plugin once the root is idle and records inputs and results", async () => {
    await observeContract("O6b", async o => {
      await withHost("O6b", "plugin-session-api", o, async s => {
        const { host } = s;
        const { arrivals } = instrument(host);
        // A background child held at the provider for 25 s: the target of the plugin-side interrupt.
        const bg = await launchBackground(s, "O6B_HOLD", 25_000);
        const held = await tryWait("the held child's provider request", () => host.provider.holds.find(h => h.session === bg.childID && h.releasedAt === undefined), 30_000);
        const requestsBefore = parentRequests(host, bg.root).length;
        const armedAt = Date.now();
        // The root's turn calls the probe tool (it only arms the probe); the plugin API calls run when this turn's execution ends and the root is idle.
        await host.prompt(bg.root, `READ_ONLY_PROBE=${JSON.stringify({ tool: "cpx_probe_session_api", input: { interruptSessionID: bg.childID } })}`);
        const syntheticCall = await tryWait("the plugin-side synthetic call", async () => (await probeLines(s.probeFile)).find(l => l.kind === "session-api-call" && l.name === "synthetic" && l.t >= armedAt), 60_000);
        const carries = (r: CpxRequest): boolean => json(bodyMessages(r)).includes(SYNTHETIC_TEXT);
        const wake = await tryWait("a parent provider request carrying the plugin-side synthetic text", () => parentRequests(host, bg.root).find(r => carries(r)), 45_000);
        if (wake) await host.settle(bg.root);
        const childEnd = bg.childID ? await tryWait("terminal execution event of the held child", async () => terminalOf(await probeLines(s.probeFile), bg.childID ?? "", armedAt), 45_000) : undefined;
        const lines = await probeLines(s.probeFile);
        const calls = lines.filter(l => l.kind === "session-api-call");
        o.relied.push(...lines.filter(l => l.kind === "session-api-armed" || l.kind === "session-api-start" || l.kind === "session-api-context"), ...calls, ...(childEnd ? [childEnd] : []));
        const callOf = (name: string): ProbeLine | undefined => calls.find(l => l.name === name);
        const stored = await storedView(host, bg.root);
        const requests = parentRequests(host, bg.root);
        o.observed.pluginApi = {
          childID: bg.childID, childHeldWhenCalled: held !== undefined, requestsBefore, armedAt,
          armed: clip(lines.find(l => l.kind === "session-api-armed"), 400), start: clip(lines.find(l => l.kind === "session-api-start"), 600),
          signatures: "ctx.session.context({ sessionID }), ctx.session.interrupt({ sessionID }), ctx.session.synthetic({ sessionID, text, description, metadata, resume }) (SessionDomain = Pick<SessionApi, ...>, @opencode/plugin dist/promise/session.d.ts:143)",
          calls: calls.map(l => ({ name: l.name, status: l.status, input: l.input, resultKind: l.resultKind, resultLength: l.resultLength, result: l.result, error: l.error, t: l.t })),
          context: clip(lines.find(l => l.kind === "session-api-context"), 800),
          interruptResult: parseJsonObject(callOf("interrupt")?.result),
          childTerminal: childEnd ? lineBrief(childEnd) : null,
          syntheticWake: {
            syntheticCallAt: syntheticCall?.t, woke: wake !== undefined, requestIndex: wake?.index, arrivedAt: wake ? arrivals.get(wake.index) : undefined, wireCarriesText: wake ? carries(wake) : false,
            lastMessage: wake ? clip(bodyMessages(wake).at(-1), 600) : null, parentRequestsFinal: requests.length,
          },
          storedHasText: json(await host.client.session.context({ sessionID: bg.root })).includes(SYNTHETIC_TEXT),
          storedTypes: stored.messages.map(m => str(m.type)),
        };
      }, BASE, { CPX_PROBE_TOOL_URL: TOOL_MODULE_URL }); // the probe builds the tool's input schema from this module (the bare specifier does not resolve from the wrapper dir)
    });
  }, 300_000);
});

// ------------------------------------------------------------------ decided branches ----
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((acc, key) => (acc !== null && typeof acc === "object" ? Reflect.get(acc, String(key)) : undefined), value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const same = (a: unknown, b: unknown): boolean => json(a) === json(b);
const sortedKeys = (value: unknown): string => json([...list(value).map(String)].sort());
const ENVELOPE_COMPLETED = /<subagent\s+sessionID=\\?"ses_[A-Za-z0-9]+\\?"\s+state=\\?"completed\\?"/;
const TERMINAL = { ok: "session.execution.succeeded", fail: "session.execution.failed", interrupted: "session.execution.interrupted" } as const;

/** ADR 0007 "Host contracts: branch taken". Each check fails with the contract and decision to reopen when the host stops behaving as decided. */
const DECISIONS: Record<string, (o: Observation) => void> = {
  C1: o => {
    const ob = o.observed;
    check(o, "C1/D1", at(ob, "ack", "status") === "running" && at(ob, "ack", "matchesChildID") === true, "a background subagent call must be acknowledged `{status: running}` with the child's sessionID; D1 (background-first) and the in-flight registration in execute.after rest on it");
    check(o, "C1/D1", at(ob, "ack", "returnedMs") !== undefined && Number(at(ob, "ack", "returnedMs")) < 5_000, "the background acknowledgement must return at once (< 5000 ms), not after the child ends");
    check(o, "C1/D1", at(ob, "ack", "probeAckShape", "resultStatus") === "running", "execute.after must carry the running acknowledgement in the RESULT (resultStatus running); D1 counts a dispatch as background by the result, not by the arguments");
    check(o, "C1/D2", at(ob, "executeAfter", "probeCountFinal") === 1 && at(ob, "executeAfter", "probeCountAtAck") === 1 && at(ob, "executeAfter", "harnessCount") === 1, "execute.after must fire exactly once for a background call id; D2 attaches completion work to the child's end because execute.after only sees the acknowledgement");
  },
  C2: o => {
    const ob = o.observed;
    check(o, "C2/D2", at(ob, "completion", "parentWoke") === true && at(ob, "completion", "userPromptsAfterAck") === 0, "the host must wake an idle parent with the completion, without a user prompt; D2 relies on the host's completion as a trigger and the router posts none");
    const wire = at(ob, "completion", "wireEnvelope", 0);
    check(o, "C2/D2", at(wire, "role") === "user" && ENVELOPE_COMPLETED.test(json(at(wire, "message"))), "the completion must reach the model as a `user` message whose text starts `<subagent sessionID=\"ses_…\" state=\"completed\"`; D2/D3 match this exact shape");
    const storedEnv = at(ob, "completion", "storedEnvelope", 0);
    check(o, "C2/D2", /"type":"synthetic"/.test(json(storedEnv)) && /"source":"subagent"/.test(json(storedEnv)) && /"state":"completed"/.test(json(storedEnv)), "the completion must be stored as a `synthetic` message with metadata.source=subagent and metadata.state=completed");
  },
  C3: o => {
    const ob = o.observed;
    check(o, "C3/D2", at(ob, "midTurn", "childEndedDuringSlowRequest") === true, "scenario precondition: the child must end while the parent's request is in flight (timing of the scripted delay)");
    check(o, "C3/D2", at(ob, "delivery", "lostFromWire") === false && at(ob, "delivery", "storedHasEnvelope") === true, "a completion that arrives mid-turn must be delivered and stored; D2 keeps no undelivered set and never re-posts");
  },
  C4: o => {
    const ob = o.observed;
    check(o, "C4/D3", list(at(ob, "hook", "rewriteLines")).some(l => at(l, "did") === true) && Number(at(ob, "hook", "contextCallsWithEnvelope")) >= 1, "the parent's context hook must see the completion in event.messages and be able to rewrite it; D3 (held placeholder) needs this");
    check(o, "C4/D3", at(ob, "rawEnvelopeInAnyProviderBody") === false && list(at(ob, "placeholderInProviderBodies")).length >= 1, "the rewritten placeholder (not the raw completion) must be what the provider receives; D3 held results");
    check(o, "C4/D3", at(ob, "stored", "originalKept") === true && at(ob, "stored", "placeholderPersisted") === false, "the stored history must keep the original completion and must not persist the placeholder; D3 rewrites per request only");
  },
  C5: o => {
    const variants = at(o.observed, "variants");
    for (const name of ["system", "user", "newest"]) {
      const v = at(variants, name);
      check(o, "C5/D4", at(v, "wire", "firstMarkerSent") === true && at(v, "wire", "secondMarkerSent") === true && at(v, "storedHasMarker") === false && at(v, "wire", "firstMarkerStillInSecond") === false, `C5 ${name} tail: a context-hook tail must be sent to the provider, must not be stored and must be absent from the next request; the turn-state tail design (D4) rests on it`);
    }
    const user = at(variants, "user");
    const first = at(user, "parentRequests", 0);
    const markerIndex = Number(list(at(first, "markerAt"))[0]);
    check(o, "C5/D4", at(user, "tailLines", 0, "role") === "user" && markerIndex === Number(at(first, "messageCount")) - 1, "the turn-state tail must be a `user` message appended LAST in the request's messages (the host moves nothing after it)");
    check(o, "C5/D4", at(user, "prefix", "messages", "identical") === true && at(user, "prefix", "systemIdentical") === true && at(user, "prefix", "otherFieldsIdentical") === true, "everything before the tail (system, other request fields, earlier messages) must be byte-identical across consecutive requests, or the prompt cache prefix breaks (D4/P4)");
    // O8 (second breakpoint), observed on OpenCode v2.0.26: without a manual hint the message breakpoint sits on the tail (last message) only; with a manual
    // hint on the last REAL message the message breakpoint is on that message and NOT on the tail (the hint replaces the tail breakpoint; wire breakpoints:
    // system[0], system[4], tools[17] and the last real message). Whether the earlier request's bytes survive the moved hint is recorded in variants.userHint.prefix (not asserted).
    for (const i of [0, 1]) {
      check(o, "C5/D4/O8", at(user, "breakpoints", i, "onTail") === true && at(user, "breakpoints", i, "onLastReal") === false, `request ${i + 1} without a manual hint: the message breakpoint must sit on the tail (last message) only, not on the last real message`);
    }
    const hinted = at(variants, "userHint");
    check(o, "C5/D4/O8", at(hinted, "hintLines", 0, "did") === true, "the probe must be able to put a manual cache hint on the last real message in the context hook");
    for (const i of [0, 1]) {
      check(o, "C5/D4/O8", at(hinted, "breakpoints", i, "onLastReal") === true && at(hinted, "breakpoints", i, "onTail") === false, `request ${i + 1} with a manual hint on the last real message: the message breakpoint must sit on that message and not on the tail (the hint replaces the automatic tail breakpoint)`);
    }
    check(o, "C5/D4/O8", at(hinted, "wire", "firstMarkerSent") === true && at(hinted, "wire", "secondMarkerSent") === true && at(hinted, "storedHasMarker") === false && at(hinted, "wire", "firstMarkerStillInSecond") === false, "userHint: the tail must still be sent, not stored and absent from the next request when a manual hint is set on the last real message");
  },
  C6: o => {
    const ob = o.observed;
    // The plugin API's own lever is the part field `cache: {type, ttlSeconds}` (SystemPart / TextPart, @opencode/ai schema/messages.d.ts + options.d.ts);
    // the Anthropic protocol maps ttlSeconds >= 3600 to `cache_control {type: "ephemeral", ttl: "1h"}` (protocols/anthropic-messages.js).
    check(o, "C6/D5", at(ob, "variants", "system", "hintsApplied") === true && at(ob, "variants", "message", "hintsApplied") === true, "the probe must be able to set `cache` on the last system part and on the last text part of the last message in the context hook (no lever => D5 stays withdrawn)");
    check(o, "C6/D5", at(ob, "providerCarriesOneHourOnSystem") === true, "D5 decision: a `cache: {type: ephemeral, ttlSeconds: 3600}` hint on the last system part must reach the provider as cache_control ttl 1h on the system block; if it does not, D5 stays withdrawn (re-decide D5 from variants.system in C6.json)");
    check(o, "C6/D5", at(ob, "providerCarriesOneHourOnMessage") === true, "D5 decision: the same hint on the last text part of the last message must reach the provider as cache_control ttl 1h on that message block; if it does not, re-decide D5 from variants.message in C6.json");
  },
  C7: o => {
    const ob = o.observed;
    const ids = at(ob, "children");
    const expected: [string, string][] = [["C7_OK", TERMINAL.ok], ["C7_FAIL", TERMINAL.fail], ["C7_INT", TERMINAL.interrupted]];
    for (const [token, kind] of expected) {
      const child = at(ob, "perChild", token);
      check(o, "C7/D2", at(child, "terminal", "kind") === kind && at(child, "terminal", "sessionID") === at(ids, token) && at(ids, token) !== undefined, `${token}: the child's own terminal event must be ${kind} and carry the child session id; D2 triggers the completion processor on it`);
      check(o, "C7/D2", at(child, "context", "finalMessageType") === "idle" && typeof at(child, "context", "finalOutcome") === "string", `${token}: the last message of context({sessionID: child}) must be {type: idle, outcome}; recovery reads the child's result there`);
    }
    check(o, "C7/D2", at(ob, "perChild", "C7_OK", "context", "finalOutcome") === "succeeded", "C7_OK: the idle marker's outcome must be `succeeded`");
    check(o, "C7/O1", list(at(ob, "perChild", "C7_OK", "context", "finalTexts")).some(t => String(t).includes("CHILD_OK")) && list(at(ob, "perChild", "C7_OK", "context", "finalTextPaths")).length >= 1, "O1: the child's final text must be readable from the last `assistant` message of context({sessionID: child}); recovery reads results from there");
    const states = list(at(ob, "parentCompletions", "states"));
    const stateOf = (token: string) => at(states.find(x => at(x, "sessionID") === at(ids, token)), "state");
    check(o, "C7/D2", at(ob, "parentCompletions", "allThreeStored") === true && stateOf("C7_OK") === "completed" && stateOf("C7_FAIL") === "error" && stateOf("C7_INT") === "cancelled", "the parent must store three completions with states completed / error / cancelled for succeeded / failed / interrupted children (D2 maps outcomes to these states)");
    check(o, "C7/D2", at(ob, "interrupt", "result", "interrupted") === true, "client.session.interrupt on a running child must report interrupted=true");
    check(o, "C7/D2", Number(at(ob, "failure", "faultAnswersServed")) >= 1 && at(ob, "failure", "retriedByHost") === false, "the host must not retry a non-retryable (400 invalid_request) provider error; recovery counts one attempt");
  },
  C8: o => {
    const ob = o.observed;
    check(o, "C8/D2", at(ob, "api", "found") === true && list(at(ob, "background", "attempts")).some(a => at(a, "target") === "parent" && at(a, "ok") === true), "client.session.background({sessionID: parent}) must move the running foreground subagent call to the background");
    check(o, "C8/D2", at(ob, "background", "executeAfter", "resultStatus") === "running" && at(ob, "background", "afterBeforeChildEnd") === true, "after the user backgrounds a call, execute.after must report the running acknowledgement before the child ends; D2 treats it like a C1 dispatch");
    check(o, "C8/D2", at(ob, "comparisonWithC1Ack", "sameStatus") === true && at(ob, "comparisonWithC1Ack", "sameShapeModuloIds") === true, "the moved call's acknowledgement must have the same shape as a native background acknowledgement (C1)");
  },
  C9: o => {
    const ob = o.observed;
    const expected: Record<string, string[]> = { read: ["path"], write: ["content", "path"], edit: ["newString", "oldString", "path"], glob: ["path", "pattern"], grep: ["path", "pattern"], list: ["filePath"], router_run: ["cwd", "script"] };
    // QA-0.1-9: the keys of a tool the host does not advertise are the test's own input: only `advertised === false` is asserted (keys recorded as unobserved).
    const UNADVERTISED_IN_FIXTURE = new Set(["list", "router_run"]);
    for (const [tool, keys] of Object.entries(expected)) {
      if (UNADVERTISED_IN_FIXTURE.has(tool)) {
        check(o, "C9/D7", at(ob, "perTool", tool, "advertised") === false, `${tool}: the host does not advertise this tool in this fixture, so its input keys are NOT observed (recorded as unobserved); if it is advertised now, move ${tool} to the key assertion above`);
        continue;
      }
      check(o, "C9/D7", at(ob, "perTool", tool, "advertised") === true && sortedKeys(at(ob, "perTool", tool, "executeBefore", "argKeys")) === sortedKeys(keys), `${tool}: execute.before must receive exactly the arguments {${keys.join(", ")}}; the lease checks read these keys`);
    }
    for (const tool of Object.keys(obj(at(ob, "perTool")))) {
      check(o, "C9/D7", at(ob, "perTool", tool, "promptError") === undefined, `${tool}: the scripted tool call's prompt must complete without error (promptError: ${String(at(ob, "perTool", tool, "promptError")).slice(0, 200)})`);
    }
    for (const tool of ["glob", "grep"]) {
      check(o, "C9/D7", at(ob, "perTool", tool, "selectedBy") !== null && at(ob, "perTool", tool, "selectedBy") !== undefined, `${tool}: the provider request that carried the call's result must be identified (by tool_use_id, else first after the call started); "what the model saw" is read from it`);
    }
    for (const tool of ["glob", "grep"]) {
      check(o, "C9/D7", at(ob, "perTool", tool, "filter", "mutable") === true && Number(at(ob, "perTool", tool, "filter", "removedLines")) >= 1 && at(ob, "perTool", tool, "filter", "sawLeasedFull") === true, `${tool}: execute.after must be able to rewrite the result (search filtering): the full pre-filter text held the leased line and the probe removed it`);
      check(o, "C9/D7", at(ob, "perTool", tool, "modelSaw", "containsLeased") === false && at(ob, "perTool", tool, "modelSaw", "containsHiddenNote") === true, `${tool}: the model must receive the rewritten result (leased lines removed, note present)`);
    }
    const unexpected = ["multiedit", "patch", "apply_patch"].filter(t => at(ob, "advertisedTools", t) !== undefined);
    check(o, "C9/O9", unexpected.length === 0, `the host now advertises ${unexpected.join(", ")}: extend lease coverage and this contract (O9)`);
  },
  C10: o => {
    const ob = o.observed;
    const kase = (name: string) => at(ob, "cases", name);
    for (const [name, status, type] of [["rate-limit-once", 429, "provider.rate-limit"], ["overloaded-once", 529, undefined]] as const) {
      const c = kase(name);
      check(o, "C10/D13", at(c, "turnCompleted") === true && at(c, "outcome") === TERMINAL.ok && list(at(c, "stepFailed")).length === 0, `${name}: a single provider fault must be retried by the host and the turn must complete, with no session.step.failed`);
      check(o, "C10/D13", list(at(c, "retryScheduled")).length >= 1 && at(c, "retryScheduled", 0, "error", "status") === status, `${name}: the capacity signal must be session.retry.scheduled with data.error.status ${status}`);
      if (type) check(o, "C10/D13", at(c, "retryScheduled", 0, "error", "type") === type, `${name}: data.error.type must be ${type}`);
      // ADR 0007 C10 / D13: the provider of a capacity signal comes from the session's preceding `session.step.started` `data.model.providerID`.
      const providerID = at(c, "stepStartedBeforeRetry", "providerID");
      check(o, "C10/D13", typeof providerID === "string" && providerID !== "", `${name}: the session.step.started preceding the retry must carry data.model.providerID (D13 reads the provider there; see stepStartedBeforeRetry.dataKeys in C10.json and re-decide the provider source if the field moved)`);
    }
    const overloadType = at(kase("overloaded-once"), "retryScheduled", 0, "error", "type");
    check(o, "C10/D13", overloadType === "provider.internal", "529 retry error.type changed — update D13's signal table");
    ob.o2OverloadErrorType = overloadType;
    for (const [name, status] of [["rate-limit-persistent", 429], ["overloaded-persistent", 529]] as const) {
      const c = kase(name);
      check(o, "C10/D13", list(at(c, "retryScheduled")).length >= 2 && at(c, "retryScheduled", 0, "error", "status") === status, `${name}: a persistent fault must keep producing session.retry.scheduled (status ${status})`);
    }
    // QA-0.1-7b: the claim is scoped to the observation window; the host may still fail the step later.
    for (const name of ["rate-limit-persistent"]) {
      const windowMs = Number(at(kase(name), "observationWindowMs"));
      check(o, "C10/D13", windowMs === PERSISTENT_WINDOW_MS && list(at(kase(name), "stepFailed")).length === 0, `${name}: a persistent fault must not produce session.step.failed — no step.failed within ${PERSISTENT_WINDOW_MS} ms (the observation window; nothing is claimed beyond it, so D13 must not rely on the host giving up on its own)`);
    }
    const quota = kase("usage-limit-until-reset");
    const parsed = at(quota, "stepFailedParsed", 0);
    const resetIso = /reset at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(String(at(parsed, "message")))?.[1];
    check(o, "C10/D13", list(at(quota, "stepFailed")).length >= 1 && at(parsed, "type") === "provider.quota" && at(parsed, "status") === 429 && at(quota, "outcome") === TERMINAL.fail, "a usage limit must surface as session.step.failed with error.type provider.quota (status 429) and end the execution as failed");
    check(o, "C10/D13", list(at(quota, "retryScheduled")).length === 0, "a usage limit must not be retried by the host (no session.retry.scheduled)");
    check(o, "C10/D13", resetIso !== undefined && resetIso === at(quota, "resetAt"), "the usage-limit message must carry the reset time as `reset at <ISO-8601>` and it must equal the time the provider sent (this is the test's OWN body sentence: it proves the message text is passed through, not that a real provider's usage limit is classified the same way)");
    // QA-0.1-7a: which features of the answer make the host say provider.quota. The observed classification per variant is asserted (EXPECTED_CLASSIFICATION);
    // whether the reset time is recoverable from the surfaced error is recorded per case (resetRecoverable) and summarised in ob.usageLimitVariants.
    const summary: Obj = {};
    for (const [name, expected] of Object.entries(EXPECTED_CLASSIFICATION)) {
      const c = kase(name);
      summary[name] = { variant: at(c, "variant"), classification: at(c, "classification"), classifiedBy: at(c, "classifiedBy"), resetInMessage: at(c, "resetRecoverable", "inMessage"), resetPaths: at(c, "resetRecoverable", "paths"), responseFields: at(c, "resetRecoverable", "responseFields") };
      check(o, "C10/D13", at(c, "classification") === expected, `${name} (variant ${String(at(c, "variant"))}): the host must classify this usage-limit answer as ${expected}, observed ${String(at(c, "classification"))} (by ${String(at(c, "classifiedBy"))}); D13's quota-versus-retry rule rests on which feature of the answer triggers provider.quota (see usageLimitVariants in C10.json)`);
    }
    ob.usageLimitVariants = summary;
    // QA-0.1-7c: session.hook("retry") of the plugin API. Calls are recorded in cases.<name>.retryHook; `retry-stop` decides whether D13 can stop endless retries.
    const observed = kase("rate-limit-once-retry-observe");
    const firstCall = at(observed, "retryHook", "calls", 0);
    check(o, "C10/D13", at(observed, "retryHook", "available") === true && list(at(observed, "retryHook", "calls")).length >= 1 && at(firstCall, "errorStatus") === 429 && list(at(firstCall, "decisionKeys")).includes("retry") && at(observed, "outcome") === TERMINAL.ok, "session.hook(\"retry\") must be registrable and be called for a retryable 429 with error.status 429 and a `decision` carrying `retry` (observe only: the turn still completes)");
    const quotaObserved = kase("usage-limit-retry-observe");
    check(o, "C10/D13", at(quotaObserved, "classification") === "provider.quota" && at(quotaObserved, "retryHook", "available") === true, `usage limit with the retry hook registered: still classified provider.quota (the hook was called ${list(at(quotaObserved, "retryHook", "calls")).length} time(s) for it; see retryHook.calls)`);
    const stopCase = kase("rate-limit-persistent-retry-stop");
    const stopCalls = list(at(stopCase, "retryHook", "calls"));
    const stopFailed = list(at(stopCase, "stepFailedParsed"));
    const branch = stopCalls.length === 0 ? "hook-not-called" : !list(at(stopCase, "retryHook", "stops")).some(x => at(x, "assigned") === true) ? "decision-not-assignable" : stopFailed.length >= 1 && at(stopFailed, 0, "status") === 429 ? "stops" : "ignored";
    ob.retryStopBranch = { branch, hookCalls: stopCalls.length, stepFailed: stopFailed.length, outcome: at(stopCase, "outcome"), windowMs: at(stopCase, "observationWindowMs") };
    check(o, "C10/D13", branch === "stops" && at(stopCase, "outcome") === TERMINAL.fail, `a plugin retry hook that sets decision {retry:false} must make the host fail the step with the 429 (session.step.failed status 429, execution failed) within ${PERSISTENT_WINDOW_MS} ms; observed branch "${branch}" — if it is not "stops", D13 cannot stop endless retries through the retry hook (re-decide: external interrupt only)`);
  },
  C11: o => {
    const ob = o.observed;
    const withTools = list(at(ob, "parentWire")).filter(w => list(at(w, "toolUses")).length > 0);
    check(o, "C11/D4", json(at(ob, "hook", "harnessBeforeInput")).includes("CPX_MUTATED") && at(ob, "child", "receivedMutated") === true, "execute.before changes to subagent arguments must reach the child (the prompt the child receives is the changed one)");
    check(o, "C11/D4", withTools.length >= 1 && withTools.every(w => list(at(w, "toolUses")).every(t => at(t, "mutated") === false)), "the parent's provider requests must keep the subagent arguments the model wrote (the mutation must not leak into the next parent request)");
    check(o, "C11/D4", at(ob, "storedHistory", "hasOriginal") === true && at(ob, "storedHistory", "hasMutated") === false, "the parent's stored history must keep the original subagent arguments, not the execute.before-mutated ones");
  },
  C12: o => {
    const ob = o.observed;
    const a = at(ob, "before", "children", "C12_A");
    const b = at(ob, "before", "children", "C12_B");
    const envelopes = list(at(ob, "parent", "envelopeStates"));
    check(o, "C12/D16", at(ob, "perChild", "C12_B", "terminal") === null && at(ob, "perChild", "C12_B", "active") === false && same(at(ob, "perChild", "C12_B", "context", "roles"), ["user"]), "a child that was in flight at a host restart must have no terminal event, be inactive and hold only its user message; recovery must re-queue it (if the host now resumes or finishes it, the recovery fallback can be relaxed)");
    check(o, "C12/D16", !envelopes.some(e => at(e, "sessionID") === b), "the parent must get no completion for a child that was in flight at the restart");
    check(o, "C12/D2", at(ob, "timing", "aTerminalBeforeRestart") === true && at(ob, "timing", "aEnvelopeStoredBeforeRestart") === true, "scenario precondition: child A's terminal event and its stored completion envelope must exist before restart() is called");
    // The wake request is classified against the restart window; either side is acceptable, but exactly one, and A's completion is delivered and processed exactly once.
    check(o, "C12/D2", (at(ob, "parent", "wokeBeforeRestart") === true) !== (at(ob, "parent", "wokeAfterRestart") === true), "the parent must be woken for A's completion exactly once, classified as wokeBeforeRestart xor wokeAfterRestart (see parent.wakeArrivedAt vs timing.restartStartedAt)");
    check(o, "C12/D2", envelopes.some(e => at(e, "sessionID") === a && at(e, "state") === "completed") && at(ob, "parent", "aEnvelopesStored") === 1, "A's completion must be stored exactly once as `completed` across the restart (D2 dedupes against the persisted store)");
    check(o, "C12/D2", at(ob, "parent", "aWireDeliveries") === 1, "A's completion must reach the model (a provider request newly carrying A's envelope) exactly once across the restart; a second delivery means the host re-processes a stored completion after a restart and D2 must dedupe");
  },
  C13: o => {
    const ob = o.observed;
    for (const n of [6, 8]) {
      const c = at(ob, "concurrency", `n${n}`);
      check(o, "C13/D13", at(c, "allArrived") === true && at(c, "peakWaiting") === n && list(at(c, "ackStatuses")).every(s => s === "running"), `n=${n}: all ${n} background children must be acknowledged running and be waiting at the provider at once (peakWaiting ${n}); D13 clamps maxParallel to 8`);
      check(o, "C13/D13", at(c, "allEnded") === true && list(at(c, "terminalKinds")).every(k => k === TERMINAL.ok), `n=${n}: all children must finish succeeded`);
    }
    const bg = at(ob, "parentInterrupt", "background");
    check(o, "C13/D14", at(bg, "interrupt", "result", "interrupted") === false && at(bg, "afterInterrupt", "activeChildren") === 3, "interrupting an IDLE parent must report interrupted=false and leave its 3 background children running");
    check(o, "C13/D14", at(bg, "allEndedAfterRelease") === true && list(at(bg, "perChild")).every(c => at(c, "terminal", "kind") === TERMINAL.ok), "after an idle-root interrupt the background children must still finish succeeded");
    const fg = at(ob, "parentInterrupt", "foreground");
    check(o, "C13/D14", at(fg, "interrupt", "result", "interrupted") === true && list(at(fg, "perChild")).length === 3 && list(at(fg, "perChild")).every(c => at(c, "terminal", "kind") === TERMINAL.interrupted), "interrupting an ACTIVE root with foreground children must interrupt all 3 children");
    const act = at(ob, "parentInterrupt", "background-active");
    check(o, "C13/O4a", at(act, "interrupt", "result", "interrupted") === true, "O4a: interrupting an active root (a held turn) with background children must report interrupted=true");
    check(o, "C13/O4a", at(act, "allEndedAfterRelease") === true && list(at(act, "perChild")).length === 3, "O4a: every background child must reach a terminal event after an active-root interrupt (none may be orphaned); the observed fate is recorded in parentInterrupt.background-active");
    // O4a resolved in ADR 0007: interrupting an ACTIVE root does not kill its background children; they keep running and finish succeeded.
    check(o, "C13/O4a", at(act, "afterInterrupt", "activeChildren") === 3, "O4a (ADR 0007): after interrupting an active root all 3 background children must still be active (an active-root interrupt does not kill background children)");
    check(o, "C13/O4a", list(at(act, "perChild")).length === 3 && list(at(act, "perChild")).every(c => at(c, "terminal", "kind") === TERMINAL.ok), "O4a (ADR 0007): every background child of an interrupted active root must end with session.execution.succeeded");
  },
  C14: o => {
    const ob = o.observed;
    for (const batch of [0, 1]) {
      const l = at(ob, "launches", batch);
      const results = list(at(l, "results"));
      check(o, "C14/D14", at(l, "delivered") === true && results.length === RETAINED_COUNT && results.every(r => at(r, "ok") === true && at(r, "status") === "completed") && list(at(l, "errors")).length === 0, `batch ${batch + 1}: ${RETAINED_COUNT} retained-context launches must all complete (batch 2 runs 60 s after the turn); launcher A (D14) rests on it`);
    }
    const hooks = at(ob, "hooksForChildren");
    check(o, "C14/D14", at(hooks, "childPromptCanTriggerTool") === true && Number(at(hooks, "harnessHookRecordsForChildren")) > 0 && list(at(hooks, "perChild")).length === RETAINED_COUNT * 2 && list(at(hooks, "perChild")).every(c => list(at(c, "probeBefore")).some(b => at(b, "tool") === "read")), "the retained-context children's own tool calls must fire the tool hooks (the probe's execute.before, the harness probe's records) for every child; the router-only part is asserted separately through the guard refusals");
    check(o, "C14/D14", at(hooks, "subagentHooksOnRootAfterCapture") === 0, "a retained-context launch must fire no subagent hook on the root");
    const perChildHooks = list(at(hooks, "perChild"));
    check(o, "C14/D14", perChildHooks.length === RETAINED_COUNT * 2 && perChildHooks.every(c => at(c, "routerDecisionRows") === 0), "retained-context launches must leave no router decision row for any child (routerDecisionRows === 0): the router records decisions in subagent tool hooks, which a retained launch never fires");
    check(o, "C14/D14", perChildHooks.length === RETAINED_COUNT * 2 && perChildHooks.every(c => at(c, "firstContextBeforeFirstTool") === true), "for every retained child the first context hook must run before its first tool call (firstContextAt < firstToolAt); D14 binds role / agent / model in the context hook");
    check(o, "C14/O3", at(ob, "concurrency", "allParked") === true && at(ob, "concurrency", "peakWaiting") === RETAINED_COUNT && at(ob, "concurrency", "parkedSessions") === RETAINED_COUNT, `O3: all ${RETAINED_COUNT} retained children's first provider requests must be waiting at once (peakWaiting ${RETAINED_COUNT}, held by Gates until all arrived); if the host caps lower, clamp D13/D14 maxParallel to the observed peak (${String(at(ob, "concurrency", "peakWaiting"))})`);
    // QA-0.1-2: the router's own effect on retained children (enforced mode), measured against the control host without the router, for EVERY child of both batches.
    const children = list(at(ob, "childContract"));
    const control = list(at(ob, "control", "children"));
    const wire = "claude-sonnet-5-5";
    check(o, "C14/D14", children.length === RETAINED_COUNT * 2 && children.every(c => at(c, "session", "agent") === CHILD), `every retained child (${RETAINED_COUNT * 2}) must run with the requested non-default agent ${CHILD} (session.get agent); D14 binds role/agent at launch`);
    check(o, "C14/D14", children.every(c => same(at(c, "wireModels"), [wire]) && same(at(c, "catalogModels"), [`${SONNET}#low`])), `every retained child must run on the requested model (${SONNET}#low): the provider request body model and the host's catalog model header must match; D14 binds the model at launch`);
    check(o, "C14/D14", children.every(c => Number(at(c, "readHooksBefore")) >= 1), "every retained child's own `read` call must pass the tool hooks (execute.before)");
    check(o, "C14/D14", children.every(c => Number(at(c, "routerRefusals")) >= 1), "D14 guards: with the router ENFORCED, every retained child's repeated identical `read` calls must meet a router guard refusal (`DENIED: …` in the tool result); if not, the router's guards do not apply to children launched with a retained context and D14's six guards must be re-decided (compare control.children)");
    check(o, "C14/D14", control.length === LIGHT_COUNT && control.every(c => Number(at(c, "routerRefusals")) === 0 && Number(at(c, "toolResults")) === RETAINED_READS && at(c, "session", "agent") === CHILD), `control host WITHOUT the router: the same launch must show no refusal and all ${RETAINED_READS} reads must succeed (the refusal above is therefore the router's)`);
    check(o, "C14/D14", at(ob, "parentHistory", "unchangedAcrossLaunches") === true, "the parent's history must get no message from retained-context launches");
  },
  C14b: o => {
    const ob = o.observed;
    check(o, "C14b/O4b", at(ob, "setup", "childrenHeld") === true && at(ob, "setup", "rootHeld") === true, "scenario precondition: 3 retained children and the root's turn must be in flight when the root is interrupted");
    check(o, "C14b/O4b", at(ob, "interrupt", "result", "interrupted") === true, "O4b: interrupting an active root must report interrupted=true");
    check(o, "C14b/O4b", at(ob, "launchResults", "allThreeReturned") === true, "O4b: every retained launch must return (ok or error) after an active-root interrupt; none may hang. The fate (killed or finished) is recorded in afterInterrupt / perChild / launchResults");
    const launches = list(at(ob, "launchResults", "results"));
    check(o, "C14b/O4b", launches.length === 3 && launches.every(r => at(r, "ok") === true && at(r, "status") === "completed"), "O4b (ADR 0007): every retained launch must return ok with status completed after an active-root interrupt (the interrupt does not abort retained-context launches)");
  },
  C15: o => {
    const ob = o.observed;
    check(o, "C15/D3", at(ob, "hook", "fired") === true && list(at(ob, "hook", "rewriteLines")).some(l => at(l, "did") === true && Number(at(l, "replacements")) >= 1), "the compaction hook must fire and be able to rewrite the compaction request's messages; D3 applies the held placeholder in compaction too");
    // The post-compaction context() is the compacted view (compaction record + idle), so the original is judged on the snapshot taken BEFORE compact()
    // and, when a client API still returns the pre-compaction messages, on the full log (recorded in fullLog; if none does, the snapshot is the evidence).
    check(o, "C15/D3", at(ob, "preCompaction", "hasOriginal") === true && at(ob, "preCompaction", "hasPlaceholder") === false, "before compaction the stored history must hold the original text and no placeholder (the held placeholder is applied per request only)");
    const apiResults = Object.values(at(ob, "fullLog", "apis") as object);
    // O5 (ADR 0007): a full-log API must return the pre-compaction messages; this also makes the `every` below non-vacuous.
    check(o, "C15/O5", apiResults.some(a => at(a, "status") === "ok" && at(a, "hasOriginal") === true), "O5: at least one full-log client API (message.list / session.export) must answer ok and still hold the original text after compaction; if none does, the stored-original claim rests only on the pre-compaction snapshot and must be re-decided");
    check(o, "C15/O5", at(ob, "fullLog", "anyApiReturnsPreCompaction") === true, "O5: a full-log API must return the pre-compaction history (fullLog.anyApiReturnsPreCompaction)");
    check(o, "C15/D3", at(ob, "stored", "hasPlaceholder") === false && apiResults.length > 0 && apiResults.every(a => at(a, "hasPlaceholder") === false), "the placeholder must not be persisted anywhere: not in the post-compaction context, not in the full message log or export");
    check(o, "C15/O5", at(ob, "compaction", "succeeded") === true && list(at(ob, "compaction", "statuses")).length >= 1, "O5: the scripted compaction must succeed: every compaction record has status `completed` and no error (the summary follows the host's template)");
    check(o, "C15/O5", at(ob, "compaction", "requestKind") === "compaction" && at(ob, "compaction", "requestHasPlaceholder") === true && at(ob, "compaction", "requestHasOriginal") === false && typeof at(ob, "compaction", "placeholderLeaf") === "string", "O5: the compaction request body must carry the placeholder (asserted at a leaf path) and not the original");
    // QA-0.1-11: variant with a REAL background completion in the compacted history and both rewrite modes active.
    const v = at(ob, "realCompletion");
    check(o, "C15/D3", at(v, "storedEnvelopeBeforeCompact") === true, "scenario precondition: the history to compact must hold a real `<subagent …>` completion envelope (a real background child's completion)");
    check(o, "C15/D3", at(v, "hookSawEnvelope") === true && Number(at(v, "completionReplacements")) >= 1, "the compaction hook must see the real completion envelope in event.messages and be able to replace it with the placeholder (D3 held results in compaction)");
    check(o, "C15/D3", at(v, "requestKind") === "compaction" && at(v, "requestHasPlaceholder") === true && at(v, "requestHasEnvelope") === false, "the compaction request must carry the placeholder and NOT the raw completion envelope when a real background completion is in the compacted history");
    check(o, "C15/O5", at(v, "statuses") !== undefined && list(at(v, "statuses")).length >= 1 && at(v, "succeeded") === true, "the compaction of a session holding a real completion must complete: every compaction record has status `completed` and no error");
  },
  O6b: o => {
    const ob = o.observed;
    const calls = list(at(ob, "pluginApi", "calls"));
    const call = (name: string): unknown => calls.find(c => at(c, "name") === name);
    check(o, "O6b/D15", at(ob, "pluginApi", "childHeldWhenCalled") === true && at(ob, "pluginApi", "armed") !== undefined && at(ob, "pluginApi", "start", "sessionMethods") !== undefined, "scenario precondition: the probe tool must arm the plugin API run once the root's turn ended, with the target child held at the provider");
    check(o, "O6b/D15", at(call("context"), "status") === "ok" && at(call("context"), "resultKind") === "array" && Number(at(call("context"), "resultLength")) >= 2, "ctx.session.context({ sessionID }) from a plugin must return the session's messages (an array with the prompts of the turn)");
    check(o, "O6b/D15", at(call("synthetic"), "status") === "ok" && at(call("synthetic"), "input", "resume") === true, "ctx.session.synthetic({ sessionID, text, description, metadata, resume: true }) must exist on the plugin session API and be accepted");
    check(o, "O6b/D15", at(ob, "pluginApi", "syntheticWake", "woke") === true && at(ob, "pluginApi", "syntheticWake", "wireCarriesText") === true && at(ob, "pluginApi", "storedHasText") === true, "a plugin-side synthetic message with resume=true must wake the idle parent: a new provider request carrying the text, and the text is stored (D3 delivery / D15 wake from a plugin)");
    check(o, "O6b/D15", at(call("interrupt"), "status") === "ok" && at(ob, "pluginApi", "interruptResult", "interrupted") === true && at(ob, "pluginApi", "childTerminal", "kind") === TERMINAL.interrupted, "ctx.session.interrupt({ sessionID }) from a plugin on a held running child must report interrupted=true and the child must end with session.execution.interrupted (same as client.session.interrupt, C7)");
  },
  O6: o => {
    const ob = o.observed;
    check(o, "O6/D15", at(ob, "synthetic", "api", "onClient") === true && at(ob, "synthetic", "tries", 1, "error") === undefined, "client.session.synthetic must exist on the client and accept {sessionID, text, description, metadata, resume}");
    check(o, "O6/D15", at(ob, "synthetic", "tries", 0, "input", "resume") === false && at(ob, "synthetic", "tries", 0, "error") === undefined && at(ob, "synthetic", "tries", 0, "woke") === false, "O6 (ADR 0007): a synthetic message posted with resume=false must be accepted and must NOT wake an idle parent (no new provider request)");
    check(o, "O6/D15", at(ob, "synthetic", "tries", 1, "woke") === true && at(ob, "synthetic", "tries", 1, "wireCarriesText") === true, "O6: a synthetic message posted with resume=true must wake an idle parent (a new provider request carrying the text); D3 delivery and the D15 wake channel depend on it");
  },
};
