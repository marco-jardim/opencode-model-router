import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RoutingHost, ROOT, arr, obj, jsonl, redact, stopAllHosts, waitFor as waitForHost, type HostOptions, type Obj } from "./helpers/routing-host";
import { CpxTimings, collectTimingJournal, timedWrapperSource, timingJournalSource, timingObserverSource, TIMING_DIRECTORY, type TimingRecord } from "./helpers/cpx-timing";
import { assertG8IdleEpisodes, collectObservationFiles, G8_IDLE_CEILING_MS, reconstructIdleEpisodes, type IdleEpisode } from "./helpers/cpx-idle-oracle";
import { assertG8Bound, freezeG8Plan, reconstructG8, workGraph, type GraphEdge, type PhaseGraph } from "./helpers/cpx-g8-oracle";
import type { CpxRequest } from "./helpers/cpx-scripted-provider";
import type { ExecutorConfig, ExecutorEvent, LedgerV1 } from "../../src/executor/types";
import { createLedgerStore, createNodeFileSystem } from "../../src/executor/ledger";
import { detectManagers, planProvision } from "../../src/executor/slots/provision";
import { isSlotRecord } from "../../src/executor/slots/pool";
import { spawnBounded } from "../../src/router/git-tools";
import { observeFull } from "../../src/executor/integrate/checks";
import type { TaskScript } from "../fixtures/cpx/e2e/scripts";
import type { TestEvent } from "node:test/reporters";
import { loadScript, scriptedTurns, type PlanScript } from "../fixtures/cpx/e2e/scripts";

// Phase 6.1.3: real-host runs are deliberately opt-in, like the other CPX smokes.
const enabled = process.env.RUN_OC_SMOKE_CPX === "1";
const repositories = ["node-pnpm", "node-npm", "py-pip"] as const;
const plans = ["throughput", "resilience"] as const;
const waitFor = waitForHost;
// Provider work and the pre-run G8 oracle use authored milliseconds, without host slack.
// Owner amendment (2026-10-14): the per-host watchdog is derived from the G8 contract instead of a fixed 90 s, which
// run 12 showed cannot hold a complete run (serial integration alone is ~75–85 s). The G8 assertion still uses the
// intrinsic service under A-6.1-1; the per-entry allowance below only sizes the watchdog. Run 12 measured 3.4–4.5 s per
// task integration entry (throughput npm 11 entries / 40.9 s, pnpm 10 / 45.5 s, pip 10 / 34.2 s).
const INTEGRATION_ENTRY_ALLOWANCE_MS = 5_000;
const SETUP_WATCHDOG_MS = 60_000; // host boot through the compiled ledger
const AUDIT_MARGIN_MS = 60_000; // G1/G2/G3 proofs, background dispatches, integration-head audits and evidence capture
const HOST_RUN_CEILING_MS = 300_000; // a genuine stall still fails within this bound
const HOST_RUNS = repositories.length * 3; // throughput + resilience baseline + resilience restart
const RUN_BUDGET_MS = HOST_RUNS * HOST_RUN_CEILING_MS + 90_000; // nine host ceilings plus two bounded G12 subprocesses
const CAPACITY_COOLDOWN_MS = 10_000;
let runDeadline = Number.POSITIVE_INFINITY;

/** Integration entries the run must serialize: every writing task, every phase suite, and one per injected fault. */
function integratingEntries(script: PlanScript, phases: number): number {
  return Object.values(script.tasks).filter(task => task.writePath !== undefined).length + phases + script.injections.length;
}

/** Post-compilation watchdog: the G8 contract with a pre-run serial-integration allowance, plus the audit margin. */
function executionWatchdogMs(cp: number, work: number, parallel: number, entries: number): number {
  return Math.ceil(1.3 * Math.max(cp, work / parallel, entries * INTEGRATION_ENTRY_ALLOWANCE_MS)) + AUDIT_MARGIN_MS;
}
function provisioningFor(repository: typeof repositories[number], pnpmCli?: string): Pick<ExecutorConfig, "provision" | "python"> {
  const python = process.env.CPX_E2E_PYTHON ?? "auto";
  if (repository === "py-pip") return { python, provision: { pip: [["python", "-m", "venv", "--system-site-packages", ".venv"]] } };
  if (repository === "node-pnpm" && pnpmCli) {
    if (!path.isAbsolute(pnpmCli) || !/\.c?js$/i.test(pnpmCli) || /[\\/]corepack[\\/]/i.test(pnpmCli)) throw new Error("CPX_E2E_PNPM_CLI must name a pre-provisioned absolute pnpm .js/.cjs entry, not a Corepack bootstrap shim");
    return { python, provision: { pnpm: [["node", pnpmCli, "install", "--offline", "--frozen-lockfile", "--ignore-workspace", "--config.confirm-modules-purge=false"]] } };
  }
  return { python, provision: "auto" };
}

// The configured command must report real failing test IDs in an executor-supported format, not raw TAP.
// This is a Node custom reporter over actual runner events: it changes neither tests nor their exit status.
const nodeReporterSource = `import path from 'node:path';
export default async function* reporter(events) {
 let failed;
 for await (const event of events) {
  if(event.type==='test:fail') {
   const d=event.data;
   if(d.todo||d.skip||d.details.type==='suite'||d.details.error.failureType==='subtestsFailed')continue;
   if(!d.file){yield 'ERROR Node runner failure without a test file\\n';continue;}
   const root=process.env.CPX_E2E_REPORT_ROOT||process.cwd();
   const file=path.relative(root,d.file).replaceAll('\\\\','/');
   yield 'FAIL '+file+' > '+d.name.replace(/[\\r\\n]/g,' ')+'\\n';
  } else if(event.type==='test:summary'&&!event.data.file) {
   const c=event.data.counts;
   // Count independently from runner totals, never from the IDs emitted above.
   failed=c.tests-c.passed-c.skipped-c.todo-c.cancelled;
   if(c.cancelled||(event.data.success===false&&failed===0))yield 'ERROR incomplete Node test run\\n';
  } else if(event.type==='test:diagnostic'&&!event.data.file) {
   const count=/^fail (\\d+)$/.exec(event.data.message);
   if(count)failed=Number(count[1]); // older Node 22's actual runner summary
  }
 }
 if(failed===undefined)yield 'ERROR Node runner supplied no failure inventory\\n';
 else yield 'Tests: '+failed+' failed\\n';
}
`;

/** Only the pre-run DAG and sidecar durations enter this oracle, never observed launch order. */
function workBounds(script: PlanScript, edges: readonly GraphEdge[], graph: PhaseGraph = { phases: [], tasks: {} }): { cp: number; work: number } {
  const { cp, work } = workGraph(script.tasks, edges, graph, "G5");
  return { cp, work };
}

function assertIdleFragments(idle: readonly number[]): void {
  for (const interval of idle) {
    expect(interval, "G8: valid nonnegative measured idle").toBeGreaterThanOrEqual(0);
    expect(interval, "G8: idle with ready work at most 10,000 ms").toBeLessThanOrEqual(G8_IDLE_CEILING_MS);
  }
}

const json = (value: unknown): string => JSON.stringify(value) ?? "";
const header = (request: CpxRequest, key: string): string | undefined => {
  const value = request.headers[key];
  return Array.isArray(value) ? value[0] : value;
};
const messages = (request: CpxRequest): Obj[] => arr(obj(request.body).messages).map(obj);
const primaryRequests = (requests: readonly CpxRequest[], session: string): CpxRequest[] =>
  requests.filter(request => header(request, "x-proof-session") === session && header(request, "x-proof-kind") === "primary");
const tail = (message: Obj): boolean => message.role === "user" && json(message.content).includes("<router-state>");
function planRunningInTail(request: CpxRequest, planId: string): boolean {
  const text = messages(request).filter(tail).map(message => typeof message.content === "string" ? message.content : arr(message.content).map(block => String(obj(block).text ?? "")).join("\n")).join("\n");
  // runtime.planLine: `plan <id>: <done>/<total> done, <count> running, <count> ready`.
  return new RegExp(`\\bplan ${planId}: \\d+/\\d+ done, [1-9]\\d* running,`).test(text);
}
function writeToolResult(request: CpxRequest, target: string): Obj | undefined {
  const fold = (path: string) => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
  const blocks = messages(request).flatMap(message => arr(message.content).map(obj));
  const use = blocks.find(block => block.type === "tool_use" && block.name === "write" && typeof obj(block.input).path === "string" && fold(String(obj(block.input).path)) === fold(target));
  return use ? blocks.find(block => block.type === "tool_result" && block.tool_use_id === use.id) : undefined;
}
function withoutCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, item]) => [key, withoutCache(item)]));
  return value;
}

function assertPrefix(previous: CpxRequest, next: CpxRequest): void {
  expect(json(obj(next.body).system), "G4: immutable system bytes").toBe(json(obj(previous.body).system));
  const prefix = messages(previous).filter(message => !tail(message));
  const current = messages(next).filter(message => !tail(message));
  expect(current.length, "G4: history cannot shrink outside compaction").toBeGreaterThanOrEqual(prefix.length);
  prefix.forEach((message, index) => {
    // The sole ephemeral breakpoint moves; no other historic byte may change.
    expect(json(withoutCache(current[index])), `G4: message ${index} bytes`).toBe(json(withoutCache(message)));
  });
}

function assertCacheLayout(request: CpxRequest): void {
  const history = messages(request);
  const tails = history.flatMap((message, index) => tail(message) ? [index] : []);
  expect(tails.length, "G4: at most one dynamic tail").toBeLessThanOrEqual(1);
  if (tails.length) expect(tails[0], "G4: state is last, never historic").toBe(history.length - 1);
  const lastReal = history.length - 1 - tails.length;
  const points: { path: string; value: Obj }[] = [];
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (/^cache_?control$/i.test(key)) points.push({ path: `${at}.${key}`, value: obj(item) });
      else walk(item, `${at}.${key}`);
    }
  };
  walk(request.body, "$");
  const marks = points.filter(point => point.path.startsWith("$.messages"));
  expect(marks, "G4: one message breakpoint").toHaveLength(1);
  expect(marks[0]!.path.startsWith(`$.messages[${lastReal}]`), "G4: marker on last real message, not tail").toBe(true);
  expect(marks[0]!.value.type, "G4: ephemeral marker").toBe("ephemeral");
  for (const point of points) expect(point.value.ttl, "G4: no TTL").toBeUndefined();
}

describe("CPX e2e assertion negative controls", () => {
  it("auxiliary requests cannot consume a plan child's scripted write", () => {
    const request: CpxRequest = { index: 0, method: "POST", url: "/v1/messages", headers: { "x-proof-kind": "primary" }, body: { messages: [{ role: "user", content: "[plan p-fixture:1.1.4#1] nonce=fixture" }] } };
    expect(planIdentity(request)).toEqual({ id: "1.1.4", attempt: 1 });
    expect(planIdentity({ ...request, headers: { "x-proof-kind": "title" } })).toBeUndefined();
    expect(planIdentity({ ...request, headers: { "x-proof-kind": "compaction" } })).toBeUndefined();
  });
  it("each repository provisions its own manager, not an accidentally forced Python environment", async () => {
    for (const repository of repositories) {
      const tracked = repository === "node-pnpm" ? ["package.json", "pnpm-lock.yaml"] : repository === "node-npm" ? ["package.json", "package-lock.json"] : ["requirements.txt"];
      const detection = await detectManagers(path.join(ROOT, "test", "fixtures", "cpx", "e2e", repository), tracked, createNodeFileSystem(), provisioningFor(repository));
      expect(detection.managers).toEqual([repository === "node-pnpm" ? "pnpm" : repository === "node-npm" ? "npm" : "pip"]);
    }
  });
  it("G1 needs this plan's positive running count, not a generic in-flight annotation", () => {
    const request = (text: string): CpxRequest => ({ index: 0, method: "POST", url: "/v1/messages", headers: {}, body: { messages: [{ role: "user", content: `<router-state>\n${text}\n</router-state>` }] } });
    expect(planRunningInTail(request("plan p-fixture: 0/24 done, 1 running, 3 ready"), "p-fixture")).toBe(true);
    expect(planRunningInTail(request("plan p-fixture: 0/24 done, 0 running, 4 ready"), "p-fixture")).toBe(false);
    expect(planRunningInTail(request("In flight: unrelated child"), "p-fixture")).toBe(false);
    expect(planRunningInTail(request("plan p-other: 0/24 done, 2 running, 1 ready"), "p-fixture")).toBe(false);
    const historical = request("");
    historical.body = { messages: [{ role: "user", content: "plan p-fixture: 0/24 done, 1 running, 3 ready" }] };
    expect(planRunningInTail(historical, "p-fixture"), "G1: historical text is not request-time tail state").toBe(false);
  });
  it("the pre-run graph oracle uses precedence, not a measured schedule", () => {
    const script = { ...loadScript("throughput"), tasks: { a: { durationMs: 3_000 }, b: { durationMs: 4_000 }, c: { durationMs: 5_000 } } };
    expect(workBounds(script, [{ from: "a", to: "b" }])).toEqual({ cp: 7_000, work: 12_000 });
    expect(() => workBounds(script, [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toThrow(/G5: cycle/);
    expect(() => workBounds(script, [{ from: "not-a-task", to: "a" }])).toThrow(/G5: unknown graph vertex/);
    const phases = { phases: [{ id: "1.1" }, { id: "1.2" }], tasks: { a: { phase: "1.1" }, b: { phase: "1.1" }, c: { phase: "1.2" } } };
    expect(workBounds(script, [{ from: "a", to: "b" }, { from: "gate:1.1", to: "c" }], phases)).toEqual({ cp: 12_000, work: 12_000 });
    expect(() => workBounds(script, [{ from: "gate:1.1", to: "a" }], phases)).toThrow(/G5: cycle/);
    expect(() => workBounds(script, [{ from: "gate:missing", to: "a" }], phases)).toThrow(/G5: unknown graph vertex/);
    expect(() => workBounds(script, [{ from: "a", to: "missing-target" }], phases)).toThrow(/G5: unknown graph vertex/);
  });
  it("the watchdog comes from the G8 contract with a pre-run integration allowance, under an explicit ceiling", () => {
    const throughput = loadScript("throughput");
    expect(Object.values(throughput.tasks).filter(task => task.writePath !== undefined), "throughput writers").toHaveLength(20);
    const entries = integratingEntries(throughput, 4);
    expect(entries).toBe(24 + throughput.injections.length);
    // The allowance dominates CP (59 s) and W/p (39 s) for this fixture; without entries the CP term rules.
    expect(executionWatchdogMs(59_000, 156_000, 4, entries)).toBe(Math.ceil(1.3 * entries * INTEGRATION_ENTRY_ALLOWANCE_MS) + AUDIT_MARGIN_MS);
    expect(executionWatchdogMs(59_000, 156_000, 4, 0)).toBe(Math.ceil(1.3 * 59_000) + AUDIT_MARGIN_MS);
    // Run 12's measured ~10.5 s boot-to-approval must fit next to the derived budget under the ceiling.
    expect(executionWatchdogMs(59_000, 156_000, 4, entries) + 15_000, "derived budget fits the host ceiling").toBeLessThanOrEqual(HOST_RUN_CEILING_MS);
    expect(RUN_BUDGET_MS).toBe(HOST_RUNS * HOST_RUN_CEILING_MS + 90_000);
  });
  it("G8 accepts 10,000 ms idle but rejects 10,001 ms independently of makespan", () => {
    expect(() => assertIdleFragments([0, 10_000])).not.toThrow();
    expect(() => assertIdleFragments([10_001])).toThrow(/G8: idle with ready work/);
  });
  it("G4 rejects rewriting an earlier request", () => {
    const request = (text: string): CpxRequest => ({ index: 0, method: "POST", url: "/v1/messages", headers: {}, body: { system: [], messages: [{ role: "user", content: text }] } });
    expect(() => assertPrefix(request("original"), request("mutated"))).toThrow(/G4/);
    expect(() => assertCacheLayout(request("no breakpoint"))).toThrow(/G4/);
  });
  it("G6 rejects distinct writers but allows one task's runtime/child co-holders", () => {
    const holders = [{ holderID: "runtime", taskRef: "task-one" }, { holderID: "child", taskRef: "task-one" }];
    const leases = [{ logical: "repo:file", holderID: "runtime" }, { logical: "repo:file", holderID: "child" }];
    expect(nonOverlappingLeases({ holders, leases })).toBe(true);
    expect(nonOverlappingLeases({ holders: [...holders, { holderID: "intruder", taskRef: "task-two" }], leases: [...leases, { logical: "repo:file", holderID: "intruder" }] }), "G6: conflicting-writer negative control").toBe(false);
  });
  it("G6 correlates the hidden write result to its actual path and tool-use ID", () => {
    const target = path.join(ROOT, "node-pnpm", "artifacts", "b.json");
    const refusal = { type: "tool_result", tool_use_id: "hidden", is_error: true, content: "is being edited by holder" };
    const request: CpxRequest = { index: 0, method: "POST", url: "/v1/messages", headers: {}, body: { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "other", name: "write", input: { path: path.join(ROOT, "other.json") } }, { type: "tool_use", id: "hidden", name: "write", input: { path: target } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "other", content: "success" }, refusal] },
    ] } };
    expect(writeToolResult(request, target)).toEqual(refusal);
    expect(writeToolResult(request, path.join(ROOT, "missing.json"))).toBeUndefined();
  });
  it("G7 Node reporting preserves real failure IDs and rejects an incomplete inventory", async () => {
    const module: { default(events: AsyncIterable<TestEvent>): AsyncIterable<string> } = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(nodeReporterSource).toString("base64")}`);
    const file = path.join(ROOT, "node-npm", "test", "phase.test.js");
    const details = { duration_ms: 1, type: "test" as const, error: Object.assign(new Error("negative total was clamped"), { cause: new Error("expected -5, got 0"), failureType: "testCodeFailure" }) };
    const failure: TestEvent = { type: "test:fail", data: { file, line: 5, column: 1, name: "phase suite preserves negative totals", nesting: 0, testNumber: 1, parentId: undefined, tags: [], testId: 1, details } };
    const summary: TestEvent = { type: "test:summary", data: { file: undefined, duration_ms: 2, success: false, counts: { tests: 2, passed: 1, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 2 } } };
    const saved = process.env.CPX_E2E_REPORT_ROOT;
    process.env.CPX_E2E_REPORT_ROOT = ROOT;
    try {
      async function* events(): AsyncGenerator<TestEvent> { yield failure; yield summary; }
      let stdout = "";
      for await (const text of module.default(events())) stdout += text;
      const output = { stdout, stderr: "", exitCode: 1, timedOut: false, durationMs: 2 };
      expect(observeFull(output, ROOT)).toEqual({ ids: ["node-npm/test/phase.test.js > phase suite preserves negative totals"], files: [file], complete: true });
      const missingId = { ...output, stdout: "Tests: 2 failed\n" + stdout.replace("Tests: 1 failed\n", "") };
      expect(observeFull(missingId, ROOT)?.complete, "G7: reporter must not fabricate completeness from emitted IDs").toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CPX_E2E_REPORT_ROOT;
      else process.env.CPX_E2E_REPORT_ROOT = saved;
    }
  });
});

const scratchParents = new Set<string>();
afterAll(async () => {
  try { await stopAllHosts(); }
  finally { for (const directory of scratchParents) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}, 120_000);

async function startE2eHost(options: HostOptions): Promise<RoutingHost> {
  // Keep OpenCode's OWN data/opencode/snapshot git below MAX_PATH without disabling router verification snapshots.
  const parent = await mkdtemp(path.join(ROOT, ".cpx-smoke-"));
  scratchParents.add(parent);
  const keys = ["TEMP", "TMP", "TMPDIR"] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) process.env[key] = parent;
  try { return await RoutingHost.start("c", options); }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

/** G6: observe only the adapter's existing process registry; a probe must never create an unrelated empty one. */
async function observeLeaseRegistry(directory: string): Promise<string> {
  const plugin = path.join(directory, "g6-lease-probe");
  const reads = path.join(directory, "g6-lease-reads");
  const moduleURL = (file: string) => JSON.stringify(pathToFileURL(path.join(ROOT, "src", file)).href);
  await mkdir(plugin, { recursive: true });
  await mkdir(reads, { recursive: true });
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "cpx-e2e-g6-leases", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  await writeFile(path.join(plugin, "server.mjs"), `import {readdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {peekLeaseRegistry} from ${moduleURL("compat/background.ts")};
import {loadConfig,resolveRouting} from ${moduleURL("router/config.ts")};
import {resolveOutcomesDir} from ${moduleURL("routing/outcomes/persist.ts")};
export default {id:'cpx-e2e-g6-leases',async setup(ctx){
 const routing=resolveRouting(loadConfig(ctx.location.directory),'v2',console);
 const snapshotPath=join(resolveOutcomesDir(routing.outcomes.path,{tmpdir:tmpdir(),homedir:homedir()}),'leases.json');
 const reads=${JSON.stringify(reads)};
 const timer=setInterval(()=>{
  for(const file of readdirSync(reads).filter(file=>file.endsWith('.request'))){
    let payload;
    try{
     const registry=peekLeaseRegistry(snapshotPath);
     if(!registry)throw new Error('No initialized adapter lease registry at '+snapshotPath+'; probe will not create one');
     payload={source:'existing-process-registry',snapshotPath,directory:ctx.location.directory,pid:process.pid,snapshot:registry.snapshot()};
    }catch(error){payload={error:String(error)};}
   const response=join(reads,file+'.response');
   writeFileSync(response+'.tmp',JSON.stringify(payload));
   renameSync(response+'.tmp',response);
   unlinkSync(join(reads,file));
  }
 },50);
 timer.unref();
 return async()=>{clearInterval(timer);};
}};`);
  return plugin;
}

const fixtureRoot = path.join(ROOT, "test", "fixtures", "cpx", "e2e");
const HOST_SLACK_MS = 30_000;
const TERMINAL = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
interface RunResult { ledger: unknown; tree: string; commits: string[]; metrics: unknown; tailAudit: Record<string, string> }
function assertTailObligation(audit: Record<string, string>, name: string, observed: boolean): void {
  expect(observed, `tail obligation: ${name}`).toBe(true);
  audit[name] = "asserted from host/ledger observations";
}
function cleanQa(ledger: LedgerV1, id: string): boolean {
  const attempt = ledger.tasks[id]?.attempts.find(attempt => attempt.outcome === "succeeded");
  if (!attempt) return false;
  try { return Array.isArray(obj(JSON.parse(attempt.context)).findings) && arr(obj(JSON.parse(attempt.context)).findings).length === 0; }
  catch { return false; }
}
function nonOverlappingLeases(snapshot: Obj): boolean {
  const holders = new Map(arr(snapshot.holders).map(value => { const holder = obj(value); return [holder.holderID, holder.taskRef ?? holder.holderID]; }));
  const owners = new Map<unknown, Set<unknown>>();
  for (const value of arr(snapshot.leases)) {
    const lease = obj(value);
    if (typeof lease.logical !== "string" || !holders.has(lease.holderID)) return false;
    const group = owners.get(lease.logical) ?? new Set();
    group.add(holders.get(lease.holderID));
    owners.set(lease.logical, group);
  }
  // A task's runtime holder and its child may co-hold the same logical lease, in multiple physical worktrees.
  return [...owners.values()].every(group => group.size === 1);
}
// Explicit gaps, not fabricated passes. These also appear as named it.skip cases in the smoke output.
const unmeasured = {
  "G1/prior-and-off": "RoutingHost exposes post-router hooks, not pre-router nativeArgs; these sidecars have no sampled/prior/off control dispatches (covered by smoke:cpx).",
  "G2/deferred-and-capture": "The sidecars have no VERIFY:deferred dispatch and the real-host API exposes no per-attempt change-set capture/enqueue counters.",
  "G3/FAIL-and-fallback": "The sidecars contain PASS only; the pinned host supports C4/C15 and has no capability-disable switch. Conditional foreground fallback is checked if absent, not claimed otherwise.",
  "G5/frozen-largest-plans": "This smoke compiles the two e2e plans; frozen-largest-plan classifier cases are a separate compiler suite, not host measurements of these fixtures.",
  "G6/shared-read-and-run": "The lease injection is write/write only; no scripted shared-tree read/search/router_run under another child's lease or deferred plugin verification is supplied.",
  "G8/idle-telemetry-completeness": "The host has no continuous scheduler/free-capacity observation port; recorded idle intervals and the makespan bound are checked, but omitted metric events cannot be proved absent from these captures.",
  "G9/non-plan-pending-restart": "The supplied restart checkpoint precedes the background injections; no non-plan pending verification crosses that checkpoint.",
  "G11/usage-limit": "The sidecar supplies a rate-limit burst, not a usage-limit/reset script; no real-host usage-limit inbox item is measured here.",
  "G12/full-CI-and-smokes": "The isolated host has no PR job-status API; full coverage/all smoke suites and smoke:v1 need the orchestrator's separate preflight/executable selection, outside this bounded e2e run.",
} as const;
async function seedRepository(project: string, primary: typeof repositories[number]): Promise<void> {
  // All declared paths must resolve, even in a single-manager iteration.
  for (const repository of repositories) await cp(path.join(fixtureRoot, repository), path.join(project, repository), { recursive: true });
  // The selected manager is also present at the git root, where slot provisioning detects it.
  await cp(path.join(fixtureRoot, primary), project, { recursive: true });
  for (const plan of plans) await cp(path.join(fixtureRoot, `${plan}.md`), path.join(project, `${plan}.md`));
  // These wrappers belong to the isolated driver, not the fixtures. Checks remain real/offline.
  const script = loadScript("throughput");
  const local = script.localChecks["1.2"];
  // Invoke the exact test/tsc programs behind the package scripts without a Windows .cmd shell.
  const phase = [
    { cwd: "node-pnpm", command: process.execPath, args: [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"] },
    { cwd: "node-pnpm", command: process.execPath, args: ["--experimental-strip-types", "--test", "test/index.test.mjs"] },
    { cwd: "node-npm", command: process.execPath, args: ["--test", "test/index.test.js", "test/phase.test.js"] },
    { cwd: "py-pip", command: process.env.CPX_E2E_PYTHON ?? "python", args: ["-m", "pytest", "tests"] },
  ];
  await writeFile(path.join(project, "cpx-node-reporter.mjs"), nodeReporterSource);
  for (const [name, commands] of [["local", local], ["phase", phase]] as const) {
    const reported = commands.map(command => {
      const index = command.args.indexOf("--test");
      return index < 0 ? command : { ...command, command: process.execPath, args: [...command.args.slice(0, index + 1), "--test-reporter=../cpx-node-reporter.mjs", ...command.args.slice(index + 1)] };
    });
    const selectPhase = name === "phase" ? `
// The host has one trusted phaseSuite command, but the fixture declares four suites.
// Select by the REAL journal's open phase/revert entry, including bisection probes; never by wall time.
const common=spawnSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8',timeout:5000});
if(common.status!==0)throw new Error(common.stderr);
const home=path.join(path.resolve(common.stdout.trim()),'omr-executor');
let phaseID='2.2';
const slot=path.basename(process.cwd());
if(slot==='ci'||slot==='integration'){
 const open=new Map();
 // Authored plans use IDs such as throughput/resilience, not necessarily the generated p-* prefix.
 for(const id of readdirSync(home)){
  const history=path.join(home,id,'history.jsonl');if(!existsSync(history))continue;
  for(const line of readFileSync(history,'utf8').split('\\n').slice(0,-1).filter(Boolean)){
   const e=JSON.parse(line);if(e.type!=='integration-step')continue;
   if(e.closes)open.delete(e.entry.id);else open.set(e.entry.id,e);
  }
 }
 const kind=slot==='ci'?'phase-suite':'revert';
 const current=[...open.values()].filter(e=>e.entry.kind===kind).sort((a,b)=>b.seq-a.seq)[0];
 if(!current?.entry.phaseId){
  if(slot==='integration'&&[...open.values()].some(e=>e.entry.kind==='phase-suite'))throw new Error('CRITICAL PRODUCT FINDING G7: the phase-suite command runs in integration instead of its prepared ci slot');
  throw new Error('No open phase entry for '+slot);
 }
  phaseID=current.entry.phaseId;
  timing.mark('phase.entry',{entryId:current.entry.id,entryKind:current.entry.kind,phaseID,slot});
}
commands=commands.filter(c=>phaseID==='2.2'||c.cwd===({'1.1':'node-pnpm','1.2':'node-npm','2.1':'py-pip'}[phaseID]));
timing.mark('phase.selected',{phaseID,slot});
console.log('CPX_PHASE '+JSON.stringify({phaseID,slot,cwd:process.cwd(),commands}));
` : "";
    await writeFile(path.join(project, `cpx-${name}.mjs`), timedWrapperSource(name, reported, selectPhase));
  }
  await writeFile(path.join(project, ".gitignore"), "node_modules/\n.venv/\n__pycache__/\n.pytest_cache/\n");
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.name", "CPX smoke");
  git(project, "config", "user.email", "cpx@example.invalid");
  git(project, "config", "core.autocrlf", "false");
  git(project, "add", "--all");
  git(project, "-c", "commit.gpgSign=false", "commit", "-q", "--no-verify", "-m", "offline fixtures");
}

type MetricEvent = Extract<ExecutorEvent, { type: "metric" }>;
type StepEvent = Extract<ExecutorEvent, { type: "integration-step" }>;
function integrationTime(events: readonly ExecutorEvent[]): number {
  const open = new Map<string, StepEvent>();
  const intervals: { from: number; to: number }[] = [];
  for (const event of events) {
    if (event.type !== "integration-step" || event.entry.kind === "phase-suite") continue;
    const key = `${event.entry.id}:${event.step}`;
    if (event.edge === "start") {
      expect(open.has(key), "G7: no overlapping integration step").toBe(false);
      open.set(key, event);
    } else {
      const start = open.get(key);
      expect(start, `G7: journal start for ${key}`).toBeDefined();
      intervals.push({ from: Date.parse(start!.at), to: Date.parse(event.at) });
      open.delete(key);
    }
  }
  expect(open.size, "G7: every integration step closes").toBe(0);
  // Raw journal-time diagnostic only; nested bisect/suite/revert spans still use union accounting.
  let elapsed = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const interval of intervals.sort((a, b) => a.from - b.from)) {
    expect(interval.to, "G7: monotonic integration timestamps").toBeGreaterThanOrEqual(interval.from);
    elapsed += Math.max(0, interval.to - Math.max(interval.from, end));
    end = Math.max(end, interval.to);
  }
  return elapsed;
}

function assertCompiled(ledger: LedgerV1, script: PlanScript): void {
  expect(ledger.config.maxParallel, "G8: configured p is fixed before the run").toBe(script.executor.maxParallel);
  expect(Object.keys(ledger.tasks).sort(), "G5: all 24 IDs recognized").toEqual(Object.keys(script.tasks).sort());
  const editing = Object.values(ledger.tasks).filter(task => task.kind !== "qa");
  expect(editing.filter(task => task.footprint.writes.length > 0).length / editing.length, "G5: editing footprint coverage").toBeGreaterThanOrEqual(0.8);
  for (const phase of ["1.1", "1.2", "2.1", "2.2"]) {
    for (const from of ["2", "3"]) expect(ledger.edges.some(edge => edge.from === `${phase}.${from}` && edge.to === `${phase}.5`), "G5: authored Order dependency").toBe(true);
    expect(ledger.edges.some(edge => edge.from === `${phase}.1` && edge.to === `${phase}.4` && edge.kind === "conflict"), "G5: implicit read/write dependency").toBe(true);
  }
  expect(ledger.phases.find(phase => phase.id === "2.1")?.dependsOn, "G5: authored first cross-phase dependency").toEqual(["1.1"]);
  expect(ledger.phases.find(phase => phase.id === "2.2")?.dependsOn, "G5: authored release dependencies").toEqual(["1.2", "2.1"]);
  workBounds(script, ledger.edges, ledger); // Cycle/unknown-vertex assertion also applies before any launch.
}

function assertFinal(ledger: LedgerV1, script: PlanScript, events: readonly ExecutorEvent[], clean: boolean): void {
  expect(ledger.status, "G9: converged terminal ledger").toBe("completed");
  expect(ledger.phases.map(phase => phase.gate), "G7: all four checked gates").toEqual(["passed", "passed", "passed", "passed"]);
  for (const id of Object.keys(script.tasks)) {
    expect(["done", "integrated"], `G2: completion of ${id}`).toContain(ledger.tasks[id]?.state);
    if (clean) expect(ledger.tasks[id]?.attempts, `G8: first-attempt completion ${id}`).toHaveLength(1);
  }
  const metrics = events.filter((event): event is MetricEvent => event.type === "metric");
  const launches = metrics.flatMap(event => event.metric.name === "launch" ? [event.metric] : []);
  expect(launches.length, "G1: real executor launches recorded").toBeGreaterThanOrEqual(24);
  expect(new Set(launches.map(launch => `${launch.taskId}:${launch.attempt}`)).size, "G2: one launch metric per attempt").toBe(launches.length);
  expect(metrics.some(event => event.metric.name === "context-age" && event.metric.result === "confirmed"), "G1: retained orchestrator actually launched children").toBe(true);
  const verdicts = events.filter(event => event.type === "attempt-verdict");
  expect(verdicts.length, "G2: actual verification records (not an empty uniqueness check)").toBeGreaterThan(0);
  expect(new Set(verdicts.map(event => `${event.taskId}:${event.n}`)).size, "G2: verification exactly once per attempt").toBe(verdicts.length);
}

function normalizedLedger(ledger: LedgerV1): unknown {
  return {
    status: ledger.status,
    phases: ledger.phases.map(phase => ({ id: phase.id, gate: phase.gate, qaRound: phase.qaRound, paused: phase.paused })),
    tasks: Object.values(ledger.tasks).sort((a, b) => a.id.localeCompare(b.id)).map(task => ({
      id: task.id, state: task.state, writes: task.footprint.writes, reads: task.footprint.reads,
      successfulAttempts: task.attempts.filter(attempt => attempt.outcome === "succeeded").length,
      verdicts: task.attempts.filter(attempt => attempt.outcome === "succeeded").map(attempt => attempt.verdict),
    })),
    edges: ledger.edges.map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })).sort((a, b) => json(a).localeCompare(json(b))),
    inbox: ledger.inbox.map(item => ({ kind: item.kind, taskId: item.taskId, answer: item.answer })),
  };
}

interface AttemptScript { id: string; attempt: number; child: string; slot: string; turns: ReturnType<typeof scriptedTurns>; first: boolean }
function planIdentity(request: CpxRequest): { id: string; attempt: number } | undefined {
  if (header(request, "x-proof-kind") !== "primary") return undefined;
  const match = /\[plan [a-z0-9-]+:([^\]\s]+)#(\d+)\] nonce=/.exec(json(request.body));
  return match ? { id: match[1]!, attempt: Number(match[2]) } : undefined;
}

function selectedScript(script: PlanScript, id: string, attempt: number): TaskScript {
  const original = script.tasks[id] ?? script.generatedTasks?.[id];
  if (!original) throw new Error(`Unscripted task ${id}#${attempt}`);
  const recovery = script.injections.find(injection => "task" in injection && injection.task === id && "recovery" in injection);
  return attempt > 1 && recovery && "recovery" in recovery ? recovery.recovery : original;
}

async function command(host: RoutingHost, root: string, text: string, input: Obj, timing?: CpxTimings): Promise<void> {
  const action = String(input.action);
  timing?.mark("plan.command.start", { action, sessionID: root });
  const front = host.front;
  if (!front) throw new Error("Missing scripted front");
  const seen = new Set((await host.hooks()).filter(hook => hook.sessionID === root && hook.tool === "router_plan" && hook.hook === "after").map(hook => hook.callID));
  front.replyNext({ tool: "router_plan", input }, { when: request => header(request, "x-proof-session") === root && header(request, "x-proof-kind") === "primary" });
  timing?.mark("plan.command.send", { action, sessionID: root });
  await host.client.session.command({ sessionID: root, name: "plan", text });
  timing?.mark("plan.command.returned", { action, sessionID: root });
  const after = await waitFor(`/plan ${text}`, async () => (await host.hooks()).find(hook => hook.sessionID === root && hook.tool === "router_plan" && hook.hook === "after" && !seen.has(hook.callID)), HOST_SLACK_MS);
  expect(json(after), `real /plan ${text} succeeds`).not.toMatch(/refused \(E_|\[router_plan\].* failed/);
  timing?.mark("plan.command.after-observed", { action, sessionID: root, callID: after.callID, hookAt: after.__t });
  await host.settle(root);
  timing?.mark("plan.command.end", { action, sessionID: root });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("driver disposed")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("driver disposed")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const runID = randomUUID();
async function writeEvidence(name: string, value: unknown): Promise<void> {
  const directory = path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-e2e", runID);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), `${json(redact(value))}\n`);
  console.log(`[cpx-e2e] evidence: ${path.join(directory, `${name}.json`)}`);
}

function sessionMethod(host: RoutingHost, name: string): (input: Obj) => Promise<unknown> {
  const method: unknown = Reflect.get(host.client.session, name);
  if (typeof method !== "function") throw new Error(`Host lacks session.${name}`);
  return input => Promise.resolve(Reflect.apply(method, host.client.session, [input]) as unknown);
}

const compactionSummary = ["## Objective", "Complete the offline plan.", "## Requirements", "Preserve the held placeholder.", "## Decisions", "Await PASS.", "## Work State", "### Completed", "Independent work.", "### Active", "Required verification.", "### Blocked", "Held output.", "## Next Move", "Await verdict.", "## Relevant Files", "Fixture artifacts.", "## Important Context", "Do not disclose held output."].join("\n");

async function observeCompactionPlugin(root: string): Promise<string> {
  const directory = path.join(root, "e2e-observer");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), json({ name: "cpx-e2e-observer", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  await writeFile(path.join(directory, "server.mjs"), timingObserverSource(root));
  return directory;
}

async function drive(name: typeof plans[number], repository: typeof repositories[number], restart: boolean): Promise<RunResult> {
  if (Date.now() >= runDeadline) throw new Error(`The ${RUN_BUDGET_MS / 60_000}-minute e2e run budget is exhausted`);
  const driverStartedAt = Date.now();
  const timing = new CpxTimings(driverStartedAt);
  timing.mark("driver.start");
  const script = loadScript(name);
  const provisioning = provisioningFor(repository, process.env.CPX_E2E_PNPM_CLI);
  const controller = new AbortController();
  let diagnosticStore: ReturnType<typeof createLedgerStore> | undefined;
  let deadlineLedger: LedgerV1 | undefined;
  const waitFor = async <T>(label: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = HOST_SLACK_MS, stepMs = 100): Promise<T> => {
    try {
      return await waitForHost(label, async () => {
        if (controller.signal.aborted) throw new Error(`Disposed while awaiting ${label}`);
        return probe();
      }, timeoutMs, stepMs);
    } catch (error) {
      const ledger = (diagnosticStore && planId ? await diagnosticStore.read(planId).catch(() => undefined) : undefined) ?? deadlineLedger;
      if (!ledger) throw error;
      observations.lastLedger = ledger;
      const slots: unknown[] = [];
      if (host) {
        const markers = path.join(host.project, ".git", "omr-executor", "slots", ledger.planId);
        for (const file of await readdir(markers).catch(() => [])) if (file.endsWith(".json")) {
          const slot = await readFile(path.join(markers, file), "utf8").then(text => JSON.parse(text) as unknown).catch(() => undefined);
          if (slot) slots.push(slot);
        }
      }
      observations.timeoutSlots = slots;
      const g6Diagnostic = json({ registryPath: observations.leaseRegistryPath, registryLocation: observations.leaseRegistryLocation, writeHooks: observations.g6HolderWriteHooks, lastSample: observations.g6HolderLastSample });
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPlan ${ledger.planId}: status=${ledger.status}\nInbox: ${json(ledger.inbox)}\nPhases: ${json(ledger.phases.map(phase => ({ id: phase.id, gate: phase.gate, paused: phase.paused })))}\nTasks: ${json(Object.values(ledger.tasks).map(task => ({ id: task.id, state: task.state, slot: task.slot, attempts: task.attempts })))}\nSlots: ${json(slots)}\nRecent progress: ${json(progress.slice(-8))}\nResolved provisioning: ${json(observations.provisioning)}\nG6 holder diagnostic: ${g6Diagnostic}\nHost log: ${host?.tail(4_000) ?? "unavailable"}`, { cause: error });
    }
  };
  const plugins: string[] = [];
  const observations: Obj = { plan: name, repository, restart, scriptedDurations: script.tasks, durationScale: 1,
    timingSlackMs: 0, idleSlackMs: 0, idleCeilingMs: G8_IDLE_CEILING_MS, runBudgetMs: RUN_BUDGET_MS };
  const journal = new Map<string, TimingRecord>();
  const diagnostics: Obj = {
    driver: timing, journal: [], hostEvents: [], toolHooks: [], outcomeTimings: [], captures: [],
    clock: "at/*At are epoch ms; durationMs is monotonic; correlate sessionID with ledger attempts/providerArrivals, cwd/entryId with integration-step checks",
    limitations: [
      "Helper/setup and post-router hook observations, not internal preparation, model selection, verification-slot wait or OS process-start attribution; those need production instrumentation.",
      "compile/approve include command round trip and settle, not compiler-only work. Observer setup starts after module imports/router setup. Residual ledger checks time outside wrapper spans remains unattributed, not evidence of a stall.",
      "wrapper.start is module entry, wrapper.end precedes final diagnostic flush/process exit. command spans cover spawnSync (spawn + child + pipe drain), not just native test runtime; ioMs excludes the final flush.",
      "Observer buffers asynchronously (250ms); a hard kill can lose its pending tail. A killed wrapper may retain only command.pending, not its buffered actual start/end. Missing checkpoints are not zero durations.",
      "Bounded: 512 driver rows, 256 journal files (512KiB each; 512 observer or 32 wrapper rows + truncation marker), first 2048 host events/hooks and 512 outcome timings. File-cap saturation is reported, not a pass.",
    ],
  };
  observations.diagnosticTimings = diagnostics;
  let captureQueue = Promise.resolve();
  const collectDiagnostics = (activeHost: RoutingHost, stage: string): Promise<void> => {
    captureQueue = captureQueue.then(async () => {
      const at = Date.now();
      const captured: Obj = { stage, at };
      try {
        const collected = await collectTimingJournal(path.join(activeHost.root, TIMING_DIRECTORY));
        for (const row of collected.records) journal.set(`${row.file}:${row.seq}`, row);
        diagnostics.journal = [...journal.values()];
        captured.journal = { ...collected, records: collected.records.length };
      } catch { captured.journalUnavailable = true; }
      try {
        const events = (await activeHost.events()).filter(event => event.type === "probe.instance.started" || event.type === "session.created" || event.type.startsWith("session.execution."));
        if (events.length) diagnostics.hostEvents = events.slice(0, 2048).map(event => ({ at: event.__t, created: event.created, eventID: event.id, type: event.type,
          sessionID: obj(event.data).sessionID, parentID: obj(event.data).parentID, instance: event.__instance }));
        captured.hostEventsTruncated = events.length > 2048;
      } catch { captured.hostEventsUnavailable = true; }
      try {
        const hooks = await activeHost.hooks();
        if (hooks.length) diagnostics.toolHooks = hooks.slice(0, 2048).map(hook => ({ at: hook.__t, hook: hook.hook, tool: hook.tool,
          sessionID: hook.sessionID, callID: hook.callID, instance: hook.instance, status: hook.status }));
        captured.toolHooksTruncated = hooks.length > 2048;
      } catch { captured.toolHooksUnavailable = true; }
      try {
        const rows = await jsonl<Obj>(path.join(activeHost.outcomes, "timings.jsonl"));
        if (rows.length) diagnostics.outcomeTimings = rows.slice(0, 512); // Existing counters/labels-only production log.
        captured.outcomeTimingsTruncated = rows.length > 512;
      } catch { captured.outcomeTimingsUnavailable = true; }
      try {
        // Keep ALL raw streams before scratch cleanup, including unsealed failure/restart tails.
        // Only reconstructIdleEpisodes can accept them as complete G8 evidence; captures never imply success.
        const files = await collectObservationFiles(activeHost.observationDirectory);
        observations.v2Observations = files;
        captured.v2ObservationFiles = files.length;
      } catch (error) { captured.v2ObservationsUnavailable = String(error); }
      captured.completedAt = Date.now();
      if (arr(diagnostics.captures).length < 16) arr(diagnostics.captures).push(captured);
    });
    return captureQueue;
  };
  const tailAudit: Record<string, string> = {};
  const obligation = (name: string, observed: boolean): void => assertTailObligation(tailAudit, name, observed);
  let host: RoutingHost | undefined;
  let planId: string | undefined;
  let failure: unknown;
  let result: RunResult | undefined;
  const backgroundRoots: string[] = [];
  const backgrounds: Promise<void>[] = [];
  const attempts = new Map<string, AttemptScript>();
  const adHocScripts = new Map<string, AttemptScript>();
  const workRequests = new Map<number, number>();
  const arrivals = new Map<number, number>();
  // Attach diagnostics before any waits so failures retain partial/pending observations. Times are epoch ms.
  const providerArrivals: Obj[] = [];
  observations.providerArrivals = providerArrivals;
  const leaseProbeTrace: Obj[] = [];
  observations.leaseProbeTrace = leaseProbeTrace;
  const leaseSamples: Obj[] = [];
  observations.leaseSamples = leaseSamples; // Preserve real samples even when a checkpoint fails before plan completion.
  const progress: Obj[] = [];
  let lastProgressKey = "";
  const recordProgress = (ledger: LedgerV1): void => {
    const tasks = Object.values(ledger.tasks).map(task => ({ id: task.id, state: task.state, attempt: task.attempts.length, outcome: task.attempts.at(-1)?.outcome }));
    const phases = ledger.phases.map(phase => ({ id: phase.id, gate: phase.gate, paused: phase.paused }));
    const key = json({ status: ledger.status, head: ledger.integration.head, tasks, phases });
    if (key === lastProgressKey) return;
    lastProgressKey = key;
    progress.push({ elapsedMs: Date.now() - driverStartedAt, seq: ledger.seq, status: ledger.status, head: ledger.integration.head, tasks, phases });
    observations.progress = progress;
  };
  let burstLeft = script.injections.find(injection => injection.kind === "rate-limit")?.options.times ?? 0;
  let lastFaultAt = 0;
  let heldVerdict = false;
  let releaseVerdict = false;
  let restarted = false;
  let g1Child: string | undefined;
  let g1Released = false;
  let g1Sample: { request: CpxRequest; ledger: LedgerV1; at: number } | undefined;
  const g1Marker = "CPX_E2E_G1_NEXT_TURN";
  let root = "";
  let hostDeadlineAt = driverStartedAt;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const onDeadline = (): void => {
    const deadlineAt = Date.now();
    observations.deadlineAt = deadlineAt;
    observations.deadlineElapsedMs = deadlineAt - driverStartedAt;
    // stop() removes the scratch ledger. Preserve deadline evidence BEFORE aborting SDK waits / disposing it.
    void (async () => {
      deadlineLedger = diagnosticStore && planId ? await diagnosticStore.read(planId).catch(() => undefined) : undefined;
      observations.deadlineLedger = deadlineLedger;
      if (deadlineLedger) recordProgress(deadlineLedger);
      observations.deadlineEvents = diagnosticStore && planId ? await diagnosticStore.exportPlan(planId).catch(() => undefined) : undefined;
      observations.deadlineHostLog = host?.tail(8_000);
      observations.deadlineRequests = host?.front?.requests;
      observations.deadlineScriptCursors = [...attempts.values()].map(attempt => ({ id: attempt.id, attempt: attempt.attempt, child: attempt.child, slot: attempt.slot, remainingTurns: attempt.turns.length, first: attempt.first }));
      timing.mark("driver.deadline");
      if (host) await collectDiagnostics(host, "deadline");
      controller.abort();
      await host?.stop().catch(() => undefined);
    })();
  };
  // Re-arming only moves the deadline; it never exceeds the host ceiling or the aggregate run budget.
  const armWatchdog = (sinceStartMs: number, reason: string): void => {
    hostDeadlineAt = Math.min(driverStartedAt + sinceStartMs, driverStartedAt + HOST_RUN_CEILING_MS, runDeadline);
    observations.watchdog = { reason, deadlineMs: hostDeadlineAt - driverStartedAt, ceilingMs: HOST_RUN_CEILING_MS };
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(onDeadline, Math.max(0, hostDeadlineAt - Date.now()));
  };
  armWatchdog(SETUP_WATCHDOG_MS, "setup");
  try {
    // The plan/repository labels live in session titles/evidence, not in a MAX_PATH-sensitive host temp prefix.
    host = await timing.span("setup", () => startE2eHost({
      longPaths: true,
      v2Observations: true,
      diagnostics: { timing, collect: collectDiagnostics },
      extraPlugins: plugins,
      provider: {},
      routing: directory => ({
        engine: "advise", delegation: "roles", repoParents: [directory],
        workRoots: [path.join(directory, "project"), path.join(directory, "slots", "**")],
        leases: { mode: "enforce", run: "refuse" },
        executor: { ...script.executor, slotsDir: path.join(directory, "slots"), approve: "ask", land: "manual",
          // Throughput exercises the product default (4); G7 resilience needs a singleton `checks` step.
          ...(name === "resilience" ? { batchMax: 1 } : {}),
          capacityCooldownMs: CAPACITY_COOLDOWN_MS, wakeDebounceMs: 1_000,
          ...provisioning,
          integrationChecks: [{ script: "cpx-local", args: [] }], phaseSuite: [{ script: "cpx-phase", args: [] }] },
        run: { commands: {
          "cpx-local": { argv: ["node", "cpx-local.mjs"] },
          "cpx-phase": { argv: ["node", "cpx-phase.mjs"] },
        }, timeoutMs: 120_000 },
      }),
      prepare: async ({ root: directory, project }) => {
        await mkdir(path.join(directory, TIMING_DIRECTORY), { recursive: true });
        await writeFile(path.join(directory, TIMING_DIRECTORY, "journal.mjs"), timingJournalSource);
        await mkdir(path.join(directory, "slots"), { recursive: true });
        await timing.span("setup.seed", () => seedRepository(project, repository));
        timing.mark("setup.provision-plan.start");
        const fs = createNodeFileSystem();
        const detection = await detectManagers(project, git(project, "ls-files", "-z").split("\0").filter(Boolean), fs, provisioning);
        const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"].includes(key.toUpperCase())));
        for (const [key, directoryName] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp" })) env[key] = path.join(directory, directoryName);
        const steps = planProvision(project, detection, { env, platform: process.platform, nodeExecPath: process.execPath, guards: [project, path.join(directory, "slots"), ROOT] }, provisioning);
        observations.provisioning = { managers: detection.managers, steps: steps.map(step => ({ manager: step.manager, command: step.command, args: step.args })) };
        if (steps.some(step => step.manager === "pnpm" && step.args.some(arg => /[\\/]corepack[\\/]dist[\\/]pnpm\.js$/i.test(arg)))) {
          throw new Error("Offline pnpm prerequisite is missing in RoutingHost's fresh private HOME/cache: auto provisioning selected a Corepack bootstrap shim. Supply a pre-provisioned pnpm executable/CLI on PATH, or set CPX_E2E_PNPM_CLI to its absolute .js/.cjs entry; do not download a package manager inside the smoke. Resolved provisioning: " + json(observations.provisioning));
        }
        // Slots create `--system-site-packages` venvs, so the interpreter the executor resolves must already have pytest
        // in its SYSTEM site-packages: a venv never sees the user site. Run 13 resolved `py -3`, whose pytest lived only
        // in the user site; the phase suite then failed in the CI slot and paused the plan. `-s` mirrors that exclusion.
        for (const step of steps.filter(candidate => candidate.manager === "pip")) {
          const module = step.args.indexOf("-m");
          const interpreter = [...step.args.slice(0, module < 0 ? 0 : module), "-s", "-c", "import pytest"];
          const probe = spawnSync(step.command, interpreter, { cwd: project, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
          if (probe.status !== 0) {
            throw new Error(`Offline Python prerequisite is missing: the interpreter the executor resolves (${step.command} ${interpreter.slice(0, -3).join(" ")}) cannot import pytest from its system site-packages. Set CPX_E2E_PYTHON to an absolute Python with pytest installed; do not install packages inside the smoke. ${(probe.stderr || probe.error?.message || "").trim()}`);
          }
        }
        timing.mark("setup.provision-plan.end");
        timing.mark("setup.observers.start");
        plugins.push(await observeCompactionPlugin(directory));
        plugins.push(await observeLeaseRegistry(directory));
        timing.mark("setup.observers.end");
      },
    }));
    if (controller.signal.aborted) throw new Error("Host boot exceeded the bounded driver deadline");
    const activeHost = host;
    const leaseProbe = (await activeHost.client.plugin.list()).data.find(plugin => plugin.id === "cpx-e2e-g6-leases");
    expect(leaseProbe?.state.status, `G6: live registry probe loaded successfully: ${json(leaseProbe?.state)}`).toBe("active");
    const readLeaseSnapshot = async (): Promise<Obj> => {
      const request = path.join(activeHost.root, "g6-lease-reads", `${randomUUID()}.request`);
      const startedAt = Date.now();
      const trace: Obj = { requestPath: request, responsePath: `${request}.response`, startedAt, elapsedMs: startedAt - driverStartedAt, state: "created" };
      leaseProbeTrace.push(trace);
      try {
        await writeFile(request, "");
        trace.requestWrittenAt = Date.now();
        trace.state = "request-written";
        const sample = await waitFor("G6 fresh snapshot of the host's live lease registry", async () => {
          const text = await readFile(`${request}.response`, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (text !== undefined) {
            trace.responseObservedAt = Date.now();
            trace.state = "response-observed";
          }
          return text === undefined ? undefined : obj(JSON.parse(text));
        });
        await rm(`${request}.response`);
        trace.completedAt = Date.now();
        trace.state = "completed";
        if (sample.error) throw new Error(`G6 live lease registry probe failed: ${sample.error}`);
        observations.leaseRegistryPath = sample.snapshotPath;
        observations.leaseRegistryLocation = sample.directory;
        observations.leaseRegistrySource = sample.source;
        expect(sample.source, "G6: observation found an existing registry without acquiring or creating one").toBe("existing-process-registry");
        expect(sample.snapshotPath, "G6: probe uses the registry key forced by this host's routing.outcomes.path").toBe(path.join(activeHost.outcomes, "leases.json"));
        expect(Array.isArray(obj(sample.snapshot).leases), "G6: fresh snapshot comes from the host's live registry").toBe(true);
        const snapshot = obj(sample.snapshot);
        leaseSamples.push(snapshot);
        return snapshot;
      } catch (error) {
        trace.failedAt = Date.now();
        trace.error = error instanceof Error ? error.stack ?? error.message : String(error);
        trace.state = "failed";
        throw error;
      }
    };
    observations.hostRootLength = activeHost.root.length;
    const front = activeHost.front!;
    const assertScriptedWrite = async (request: CpxRequest, attempt: AttemptScript, task: TaskScript): Promise<void> => {
      const authored = scriptedTurns(script, task);
      const consumed = authored.length - attempt.turns.length;
      const previous = authored[consumed - 1]?.reply;
      if (!previous || !("tool" in previous) || previous.tool !== "write") return;
      // The intentional hidden write has its own lease-refusal and critical-overlap checks below.
      if (name === "resilience" && attempt.id === "1.1.3" && consumed === 1) return;
      const target = path.join(attempt.slot, String(previous.input.path));
      const result = writeToolResult(request, target);
      expect(result, `Scripted write ${attempt.id}#${attempt.attempt} has a correlated tool result for ${target}`).toBeDefined();
      expect(result?.is_error, `Scripted write ${attempt.id}#${attempt.attempt} succeeded: ${json(result)}`).not.toBe(true);
      expect(await readFile(target, "utf8"), `Scripted write ${attempt.id}#${attempt.attempt} landed before completion: ${json(result)}`).toBe(previous.input.content);
    };
    const store = createLedgerStore({ home: path.join(activeHost.project, ".git", "omr-executor") });
    diagnosticStore = store;
    const assignedSlotPath = async (ledger: LedgerV1, taskID: string): Promise<string> => {
      const slot = ledger.tasks[taskID]?.slot;
      if (!slot) throw new Error(`No assigned slot for ${taskID}`);
      const file = path.join(activeHost.project, ".git", "omr-executor", "slots", ledger.planId, `${slot}.json`);
      const marker: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isSlotRecord(marker)) throw new Error(`Invalid actual slot marker for ${taskID}: ${json(marker)}`);
      expect(marker.planId, `Actual slot belongs to ${taskID}'s plan`).toBe(ledger.planId);
      expect(marker.slot, `Actual slot matches ${taskID}'s assignment`).toBe(slot);
      expect(marker.state, `Actual slot is leased to ${taskID}`).toBe("leased");
      return marker.path;
    };
    const readG6HolderProof = async (): Promise<Obj | undefined> => {
      const ledger = await store.read(planId!);
      const task = ledger.tasks["1.1.2"]!;
      const holder = task.attempts.at(-1)?.childSessionID;
      if (!holder || !task.slot) return undefined;
      const leasedPath = path.join(await assignedSlotPath(ledger, "1.1.2"), "node-pnpm/artifacts/b.json");
      const normalize = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
      const hooks = await activeHost.hooks();
      const write = hooks.find(hook => hook.hook === "after" && hook.sessionID === holder && hook.tool === "write" && hook.status === "completed" && !hook.error && hooks.some(before => before.hook === "before" && before.callID === hook.callID && normalize(String(before.input?.path)) === normalize(leasedPath)));
      observations.g6HolderWriteHooks = hooks.filter(hook => hook.sessionID === holder && hook.tool === "write");
      if (!write) return undefined;
      const snapshot = await readLeaseSnapshot();
      const owners = arr(snapshot.holders).map(obj).filter(owner => owner.taskRef === `${planId}:1.1.2` && owner.scope === "until-integrated");
      observations.g6HolderLastSample = { holder, write, leasedPath, snapshot, registryPath: observations.leaseRegistryPath, registryLocation: observations.leaseRegistryLocation };
      const lease = arr(snapshot.leases).map(obj).find(lease => owners.some(owner => owner.holderID === lease.holderID) && normalize(String(lease.physical)) === normalize(leasedPath));
      expect(await readFile(leasedPath, "utf8"), "G6: holder really wrote its scripted content before contender release").toBe(script.defaults.content);
      if (!lease) {
        const current = (await store.read(planId!)).tasks["1.1.2"]!;
        if (current.state === "integrated" || current.state === "done") {
          throw new Error(`G6 checkpoint lost the holder before sampling its live lease: ${json({ current, sample: observations.g6HolderLastSample })}`);
        }
        throw new Error(`CRITICAL PRODUCT FINDING G6: the holder's completed write has the expected content but no live until-integrated lease in the host's real registry; ${json(observations.g6HolderLastSample)}`);
      }
      return { holder, write, lease, snapshot };
    };
    root = await timing.span("root.create", () => activeHost.newRoot(`${name} ${repository} scripted orchestrator`));
    timing.mark("root.created", { sessionID: root });
    const burst = script.injections.find(injection => injection.kind === "rate-limit");
    if (burst) front.failWhen(request => planIdentity(request)?.id === burst.task, burst.fault, burst.options);

    // The front's delay token identifies the request; concurrent waits are concurrent, not summed.
    // Only successful first turns charge work. Retry faults never advance an attempt's turn cursor.
    front.options.delayMs = request => {
      const arrivedAt = Date.now();
      arrivals.set(request.index, arrivedAt);
      providerArrivals.push({ requestIndex: request.index, sessionID: header(request, "x-proof-session") ?? null,
        kind: header(request, "x-proof-kind") ?? null, arrivedAt, elapsedMs: arrivedAt - driverStartedAt });
      return request.index + 1;
    };
    front.options.sleep = async token => {
      const request = front.requests[token - 1]!;
      if (!g1Sample && planId && header(request, "x-proof-session") === root && header(request, "x-proof-kind") === "primary" && json(request.body).includes(g1Marker)) {
        g1Sample = { request, ledger: await store.read(planId), at: arrivals.get(request.index)! };
        timing.mark("g1.parent.request-sampled", { requestIndex: request.index, sessionID: root, arrivedAt: g1Sample.at });
        front.replyNext({ text: "ROOT_G1_NEXT_DONE" }, { when: candidate => candidate.index === request.index });
        return;
      }
      if (header(request, "x-proof-kind") === "compaction") {
        front.replyNext({ text: compactionSummary }, { when: candidate => candidate.index === request.index });
        return;
      }
      if (json(obj(request.body).system).includes("independent, skeptical verification grader")) {
        if (heldVerdict && json(request.body).includes("held.json")) await waitFor("G3 verdict release", () => releaseVerdict ? true : undefined, HOST_SLACK_MS);
        return; // RoutingProvider supplies the real PASS grader envelope.
      }
      if (header(request, "x-proof-kind") !== "primary") return; // Titles and other auxiliary generations are not scripted task turns.
      const identity = planIdentity(request);
      if (!identity) {
        const child = header(request, "x-proof-session");
        if (!child || child === root || backgroundRoots.includes(child)) return;
        const id = /CPX_E2E_CALL=([a-z-]+)/.exec(json(request.body))?.[1];
        const dispatch = script.backgroundDispatches?.find(call => call.id === id);
        if (!dispatch) return;
        let attempt = adHocScripts.get(child);
        if (!attempt) {
          attempt = { id: dispatch.id, attempt: 1, child, slot: activeHost.project, turns: scriptedTurns(script, dispatch.script), first: true };
          adHocScripts.set(child, attempt);
        }
        await assertScriptedWrite(request, attempt, dispatch.script);
        const frame = attempt.turns[0];
        if (!frame) throw new Error(`Unexpected extra ad hoc request ${dispatch.id}`);
        const reply = "tool" in frame.reply ? { ...frame.reply, input: { ...frame.reply.input, path: path.join(activeHost.project, String(frame.reply.input.path)) } } : frame.reply;
        if (frame.delayMs) workRequests.set(request.index, frame.delayMs);
        await sleep(frame.delayMs, controller.signal);
        if (request.durationMs !== undefined) return;
        attempt.turns.shift();
        attempt.first = false;
        front.replyNext(reply, { when: candidate => candidate.index === request.index });
        return;
      }
      if (!planId) throw new Error("A child arrived before its durable plan was discovered");
      const child = header(request, "x-proof-session");
      if (!child) throw new Error("Child request has no session tag");
      if (burst && identity.id === burst.task && burstLeft > 0) {
        burstLeft--;
        lastFaultAt = Date.now();
        await sleep(burst.faultDelayMs, controller.signal);
        return;
      }
      const key = `${child}:${identity.id}#${identity.attempt}`;
      let attempt = attempts.get(key);
      if (!attempt) {
        const ledger = await store.read(planId);
        const task = ledger.tasks[identity.id];
        if (!task?.slot) throw new Error(`No assigned slot for ${key}`);
        attempt = { ...identity, child, slot: await assignedSlotPath(ledger, identity.id), turns: scriptedTurns(script, selectedScript(script, identity.id, identity.attempt)), first: true };
        attempts.set(key, attempt);
      }
      await assertScriptedWrite(request, attempt, selectedScript(script, identity.id, identity.attempt));
      if (identity.id === "1.1.1" && attempt.first && !g1Released) {
        g1Child = child;
        timing.mark("g1.child.held", { sessionID: child, requestIndex: request.index, arrivedAt: arrivals.get(request.index) });
        await waitFor("G1 next orchestrator turn before child release", () => g1Released ? true : undefined);
        timing.mark("g1.child.released", { sessionID: child });
      }
      if (burst && identity.id === burst.task && attempt.first && lastFaultAt) {
        // Let the real governor's quiet cooldown elapse. Its dependent tasks then start NEW success tokens,
        // so recovery can be tested rather than falsely failing a plan that finishes before the cooldown.
        await sleep(Math.max(0, lastFaultAt + CAPACITY_COOLDOWN_MS + 1_000 - Date.now()), controller.signal);
      }
      if (name === "resilience" && identity.id === "1.1.3" && attempt.first) {
        // Scripted durations do not order HTTP arrivals or cold slot provisioning. Wait for the REAL holder.
        const proof = await waitFor("G6 holder write and repository-wide lease before the hidden write", readG6HolderProof);
        observations.g6HolderProof = proof;
        const ledger = await store.read(planId);
        const holderSlot = ledger.tasks["1.1.2"]!.slot;
        if (!holderSlot) throw new Error("G6 holder lost its assigned slot before the hidden write");
        const holderRoot = await assignedSlotPath(ledger, "1.1.2");
        expect(path.resolve(holderRoot, git(holderRoot, "rev-parse", "--git-common-dir")), "G6: holder and hidden writer are in the same git repository").toBe(path.resolve(attempt.slot, git(attempt.slot, "rev-parse", "--git-common-dir")));
      }
      if (name === "resilience" && identity.id === "1.1.3" && !attempt.first && !observations.g6ContenderResult) {
        const target = path.join(attempt.slot, "node-pnpm/artifacts/b.json");
        const result = writeToolResult(request, target);
        if (!result) throw new Error(`Driver could not correlate the hidden write's tool result: child=${child}; target=${target}; request=${json(request.body)}`);
        observations.g6ContenderResult = { child, target, result, requestIndex: request.index };
        if (!/is being edited by/.test(json(result))) {
          const content = await readFile(target, "utf8");
          observations.g6ContenderContent = content;
          const snapshot = await readLeaseSnapshot();
          const proofLease = obj(obj(observations.g6HolderProof).lease);
          const stillHeld = arr(snapshot.leases).map(obj).some(lease => lease.holderID === proofLease.holderID && lease.logical === proofLease.logical);
          const hiddenWrite = scriptedTurns(script, script.tasks["1.1.3"]!)[0]!.reply;
          if (stillHeld && "tool" in hiddenWrite && content === hiddenWrite.input.content) {
            throw new Error(`CRITICAL PRODUCT FINDING G6: the hidden write succeeded while the holder's proven until-integrated lease remained live; ${json({ holder: observations.g6HolderProof, contender: observations.g6ContenderResult, snapshot, content })}`);
          }
          throw new Error(`G6 hidden write did not produce the required lease refusal; investigate the actual earlier guard/tool error or lost holder, not a successful-overlap claim: ${json({ result, content, stillHeld, snapshot })}`);
        }
      }
      if (name === "resilience" && identity.id === "1.1.2" && !attempt.first) {
        const proof = await waitFor("G6 actual holder lease after its successful write", readG6HolderProof);
        observations.g6HolderProof = proof;
        const refused = await waitFor("G6 lease-only refusal", () => front.requests.find(candidate => planIdentity(candidate)?.id === "1.1.3" && /is being edited by/.test(json(candidate.body))), HOST_SLACK_MS);
        const ledger = await store.read(planId);
        const holder = ledger.tasks["1.1.2"]!.attempts.at(-1)!.childSessionID;
        expect(json(refused.body).includes(holder!) || json(refused.body).includes(`plan:${planId}:1.1.2`), "G6: refusal identifies the actual holder, not a generic scope denial").toBe(true);
        observations.leasedContent = await readFile(path.join(attempt.slot, "node-pnpm/artifacts/b.json"), "utf8");
        expect(observations.leasedContent, "G6: refused write leaves holder file unchanged").toBe(script.defaults.content);
        observations.leaseRefusal = refused.body;
      }
      if (restart && identity.id === "2.1.4" && !restarted) {
        await waitFor("restart at observed running checkpoint", () => restarted ? true : undefined, HOST_SLACK_MS);
      }
      if (request.durationMs !== undefined) return; // The killed host cannot advance this attempt's turn cursor.
      const frame = attempt.turns[0];
      if (!frame) throw new Error(`Unexpected extra successful request for ${key}`);
      const reply = "tool" in frame.reply && frame.reply.tool === "write"
        ? { ...frame.reply, input: { ...frame.reply.input, path: path.join(attempt.slot, String(frame.reply.input.path)) } }
        : frame.reply;
      if (frame.delayMs) workRequests.set(request.index, frame.delayMs);
      await sleep(frame.delayMs, controller.signal);
      if (request.durationMs !== undefined) return; // An orphan's closed connection cannot consume a successful reply.
      attempt.turns.shift();
      attempt.first = false;
      front.replyNext(reply, { when: candidate => candidate.index === request.index });
    };

    await timing.span("compile", () => command(activeHost, root, `run "${path.join(activeHost.project, script.plan)}"`, { action: "compile", path: path.join(activeHost.project, script.plan) }, timing));
    const list = await store.list();
    expect(list, "G5: /plan run creates one real ledger").toHaveLength(1);
    planId = list[0]!.planId;
    timing.mark("compile.ledger-observed", { planId });
    const compiled = await store.read(planId);
    assertCompiled(compiled, script);
    expect(compiled.config.batchMax, "throughput uses default batches; resilience keeps singleton checks").toBe(name === "throughput" ? 4 : 1);
    const bounds = workBounds(script, compiled.edges, compiled);
    const g8Plan = name === "throughput" ? freezeG8Plan(script.tasks, compiled) : undefined;
    observations.compiled = compiled;
    observations.bounds = bounds;
    const entries = integratingEntries(script, compiled.phases.length);
    armWatchdog(Date.now() - driverStartedAt + executionWatchdogMs(bounds.cp, bounds.work, script.executor.maxParallel, entries), "contract");
    obj(observations.watchdog).integratingEntries = entries;
    if (name === "resilience") expect(compiled.edges.some(edge => [edge.from, edge.to].every(id => ["1.1.2", "1.1.3"].includes(id))), "G6: overlap not serialized by compiler").toBe(false);
    await timing.span("approve", () => command(activeHost, root, `approve ${planId}`, { action: "approve", planId }, timing));
    timing.mark("g1.start");
    await timing.span("g1.launch-wait", () => waitFor("G1 actual plan child launched after approval turn ends", async () => {
      const ledger = await store.read(planId!);
      recordProgress(ledger);
      observations.lastLedger = ledger;
      const blocking = ledger.inbox.filter(item => item.answer === null && item.severity !== "info");
      if (ledger.status === "paused" || blocking.length) throw new Error(`G1 launch blocked: status=${ledger.status}; inbox=${json(blocking)}`);
      return g1Child && ledger.tasks["1.1.1"]?.state === "running" && ledger.tasks["1.1.1"]?.attempts.at(-1)?.childSessionID === g1Child ? true : undefined;
    }));
    // Retained launches start AFTER the approval turn. That turn's old request cannot show future children.
    // Gate one provider response, give the parent a genuine next turn, and inspect its request-time ledger/tail.
    timing.mark("g1.parent.prompt.start", { sessionID: root });
    const nextTurn = activeHost.client.session.prompt({ sessionID: root, text: `${g1Marker}: continue an independent orchestrator step without polling the plan.` });
    nextTurn.catch(() => undefined);
    try {
      const sample = await waitFor("G1 next orchestrator request while the plan child runs", () => g1Sample);
      observations.g1 = { ...sample, childSessionID: g1Child };
      expect(sample.ledger.tasks["1.1.1"]?.state, "G1: child is genuinely running at the next request").toBe("running");
      expect(sample.ledger.tasks["1.1.1"]?.attempts.at(-1)?.childSessionID, "G1: request-time state belongs to the observed held child").toBe(g1Child);
      expect((await activeHost.eventsOf(g1Child!)).some(event => TERMINAL.has(event.type)), "G1: next request precedes child end").toBe(false);
      expect(planRunningInTail(sample.request, planId!), "G1: orchestrator runs while this plan's children are in flight").toBe(true);
      await waitFor("G1 parent next turn completes independently of held child", async () => Object.hasOwn(await activeHost.client.session.active(), root) ? undefined : true);
      await nextTurn;
      timing.mark("g1.parent.prompt.end", { sessionID: root });
      expect((await activeHost.eventsOf(g1Child!)).some(event => TERMINAL.has(event.type)), "G1: parent finished its independent step before the held child ended").toBe(false);
    } finally { g1Released = true; timing.mark("g1.end"); }

    let launchedBackgrounds = false;
    let humanAnswered = false;
    const human = script.injections.find(injection => injection.kind === "human-escalation");
    const checkpoint = script.injections.find(injection => injection.kind === "host-restart");
    const immutableId = planId;
    const capabilities = await waitFor("host holding capabilities", async () => (await jsonl<Obj>(path.join(activeHost.root, "e2e-observer.jsonl"))).find(line => line.kind === "capabilities"), 30_000);
    const canHold = capabilities.C4 === true && capabilities.C15 === true;
    observations.capabilities = capabilities;

    const background = async (dispatch: NonNullable<PlanScript["backgroundDispatches"]>[number]): Promise<void> => {
      const parent = await activeHost.newRoot(`non-plan ${dispatch.id}`);
      backgroundRoots.push(parent);
      let prompt = `[route class=implement risk=low scope=single needs=edit root="${activeHost.project}" tier=medium pin]\n${dispatch.prompt}`;
      if (dispatch.script.writePath) prompt = prompt.replace(`check: fileExists path=${dispatch.script.writePath}`, `check: fileExists path=${path.join(activeHost.project, dispatch.script.writePath)}`);
      const required = dispatch.id === "required-held";
      const useBackground = dispatch.background && (!required || canHold);
      if (required && canHold) heldVerdict = true;
      const dispatched = activeHost.dispatch(parent, { agent: "implementer", description: dispatch.id, prompt, background: useBackground });
      if (dispatch.userAction === "background-while-running") {
        await waitFor("foreground child actually running before user background action", () => [...adHocScripts.values()].find(attempt => attempt.id === dispatch.id), HOST_SLACK_MS);
        await sessionMethod(activeHost, "background")({ sessionID: parent });
      }
      const call = await dispatched;
      if (useBackground || dispatch.userAction) {
        expect(json(call.after.result), "G1/G2: running acknowledgement").toMatch(/Running in the background|status.*running/);
        const childEnd = await waitFor(`actual end event of ${dispatch.id}`, async () => (await activeHost.eventsOf(call.childID)).find(event => TERMINAL.has(event.type)));
        expect(call.after.__t, "G1: real acknowledgement timestamp precedes child end").toBeLessThan(Number(childEnd.__t));
        const next = front.requests.filter(request => header(request, "x-proof-session") === parent && header(request, "x-proof-kind") === "primary").find(request => (arrivals.get(request.index) ?? 0) >= call.after.__t);
        expect(next, "G1: actual next orchestrator request").toBeDefined();
        expect(arrivals.get(next!.index), "G1: orchestrator next step before child end").toBeLessThan(Number(childEnd.__t));
      }
      await waitFor(`end of ${dispatch.id}`, async () => (await activeHost.eventsOf(call.childID)).find(event => TERMINAL.has(event.type)), HOST_SLACK_MS);
      if (required && canHold) {
        const requests = () => front.requests.filter(request => header(request, "x-proof-session") === parent);
        const placeholder = await waitFor("G3 permanent context placeholder", () => requests().find(request => /state=\\?"held\\?"/.test(json(request.body))), HOST_SLACK_MS);
        expect(json(placeholder.body), "G3: held output absent").not.toContain(script.defaults.completion);
        expect(requests().some(request => json(request.body).includes("<router-verdict")), "G3: no verdict before gated release").toBe(false);
        await activeHost.prompt(parent, "Preserve the pending held result; continue the independent step.");
        await activeHost.prompt(parent, "Keep the permanent placeholder in the compaction window.");
        await sessionMethod(activeHost, "compact")({ sessionID: parent });
        const compactRequest = await waitFor("G3 compaction request", () => front.requests.find(request => header(request, "x-proof-session") === parent && header(request, "x-proof-kind") === "compaction"), HOST_SLACK_MS);
        expect(json(compactRequest.body), "G3: compaction preserves held placeholder").toMatch(/state=\\?"held\\?"/);
        expect(json(compactRequest.body), "G3: no raw output in compaction").not.toContain(script.defaults.completion);
        await waitFor("successful compaction", async () => (await activeHost.client.session.context({ sessionID: parent })).find(message => message.type === "compaction" && message.status === "completed"), HOST_SLACK_MS);
        const beforeRelease = requests().length;
        expect(requests().every(request => !json(request.body).includes(script.defaults.completion)), "G3: ALL context/compaction requests before verdict hide output").toBe(true);
        const eventsBeforeRelease = (await activeHost.eventsOf(parent)).length;
        releaseVerdict = true;
        const verdict = await waitFor("G3 PASS releases output", () => requests().slice(beforeRelease).find(request => json(request.body).includes("<router-verdict")), HOST_SLACK_MS);
        expect(json(verdict.body), "G3: PASS verdict").toMatch(/verdict=\\?"PASS\\?"/);
        expect(json(verdict.body), "G3: PASS posts output").toContain(script.defaults.completion);
        await activeHost.settle(parent);
        const history = await activeHost.client.session.context({ sessionID: parent });
        expect((json(history).match(/<router-verdict/g) ?? []).length, "G3: one durable verdict delivery").toBe(1);
        const wakeEvents = (await activeHost.eventsOf(parent)).slice(eventsBeforeRelease).filter(event => event.type === "session.execution.started");
        observations.heldWakeEvents = wakeEvents;
        expect(wakeEvents, "G3: exactly one automatic parent execution after gated verdict release").toHaveLength(1);
        // Explicit prompts/compaction above are not automatic wakes: count only post-verdict starts.
        expect(requests().slice(beforeRelease).filter(request => json(messages(request).filter(message => !tail(message))).includes("<router-verdict")).length, "G3: one release wake request").toBe(1);
        obligation("C4-and-C15-held-through-context-and-compaction", /state=\\?"held\\?"/.test(json(placeholder.body)) && /state=\\?"held\\?"/.test(json(compactRequest.body)));
        obligation("no-output-before-verdict", requests().slice(0, beforeRelease).every(request => !json(request.body).includes(script.defaults.completion)));
        obligation("one-verdict-delivery-and-parent-wake", (json(history).match(/<router-verdict/g) ?? []).length === 1 && wakeEvents.length === 1);
        tailAudit["otherwise-foreground-fallback"] = "not exercised: C4 AND C15 available; G3/FAIL-and-fallback is explicitly skipped";
      } else if (required) {
        expect(call.before.input?.background, "G3: actual host call stays foreground when C4/C15 unavailable").toBe(false);
        expect(json(call.after.result), "G3: fallback is not a running acknowledgement").not.toMatch(/Running in the background|status.*running/);
        expect(json(call.after.result), "G3: foreground result verified").toMatch(/PASS|verification.*pass/i);
        obligation("otherwise-foreground-fallback", call.before.input?.background === false && /PASS|verification.*pass/i.test(json(call.after.result)));
        for (const key of ["C4-and-C15-held-through-context-and-compaction", "no-output-before-verdict", "one-verdict-delivery-and-parent-wake"]) tailAudit[key] = "not exercised: required holding unavailable on this host (C4/C15)";
      }
      await activeHost.settle(parent);
      const requests = front.requests.filter(request => header(request, "x-proof-session") === parent);
      const compactIndex = requests.find(request => header(request, "x-proof-kind") === "compaction")?.index;
      const primary = requests.filter(request => header(request, "x-proof-kind") === "primary");
      primary.forEach(assertCacheLayout);
      for (let index = 1; index < primary.length; index++) {
        // Actual compaction starts a new cache epoch; held -> released within an epoch must still be byte-stable.
        if (compactIndex !== undefined && primary[index - 1]!.index < compactIndex && primary[index]!.index > compactIndex) continue;
        assertPrefix(primary[index - 1]!, primary[index]!);
      }
      if (dispatch.id === "adhoc-background") {
        const annotated = await waitFor("G2 ad hoc completion annotation", () => requests.concat(front.requests.filter(request => header(request, "x-proof-session") === parent)).find(request => messages(request).some(message => tail(message) && json(message).includes(call.childID) && /Completed since/.test(json(message)))), HOST_SLACK_MS);
        expect(annotated, "G2: completion annotation").toBeDefined();
        expect(front.requests.filter(request => header(request, "x-proof-session") === parent && messages(request).some(message => tail(message) && json(message).includes(call.childID) && /Completed since/.test(json(message)))).length, "G2: annotation exactly once").toBe(1);
        obligation("adhoc-tail-annotation-once", front.requests.filter(request => header(request, "x-proof-session") === parent && messages(request).some(message => tail(message) && json(message).includes(call.childID) && /Completed since/.test(json(message)))).length === 1);
      }
      const timings = await waitFor(`G2 timing for ${dispatch.id}`, async () => {
        const rows = await jsonl<Obj>(path.join(activeHost.outcomes, "timings.jsonl"));
        const matching = rows.filter(row => row.childSessionID === call.childID);
        return matching.length ? matching : undefined;
      }, HOST_SLACK_MS);
      expect(timings, "G2: timing exactly once").toHaveLength(1);
      expect((await activeHost.hooks()).filter(hook => hook.hook === "after" && hook.callID === call.callID), "G2: dispatch acknowledgement once").toHaveLength(1);
      if (dispatch.verify === "required") {
        const stored = await activeHost.client.session.context({ sessionID: parent });
        expect(json(stored), "G2: completion-time verification").toMatch(/PASS|verification.*pass/i);
        expect(json(stored).match(/<router-verdict/g) ?? [], "G2: completion-time verdict once").toHaveLength(useBackground || dispatch.userAction ? 1 : 0);
      }
      observations[dispatch.id] = { call, requests, timings };
      const journalDirectory = process.platform === "win32"
        ? path.join(activeHost.root, "home", ".local", "state", "opencode-model-router")
        : path.join(activeHost.root, "state", "opencode-model-router");
      if (useBackground || dispatch.userAction) {
        const processed = await waitFor("G2 durable completion effects", async () => {
          const rows = await jsonl<Obj>(path.join(journalDirectory, "pending.jsonl"));
          const matching = rows.filter(row => row.kind === "processed" && row.child === call.childID && row.callID === call.callID);
          return matching.length ? matching : undefined;
        });
        expect(processed, "G2: durable completion effects exactly once").toHaveLength(1);
        if (dispatch.userAction) obligation("user-backgrounded-verification-at-completion-once", processed.length === 1 && timings.length === 1 && (json(await activeHost.client.session.context({ sessionID: parent })).match(/<router-verdict/g) ?? []).length === 1);
        observations[dispatch.id] = { call, requests, timings, processed };
      }
    };

    const observedHeads = new Set<string>();
    const final = await waitFor("plan completion (no orchestrator polling turns)", async () => {
      if (front.frontErrors.length || activeHost.provider.errors.length) throw new Error(`Scripted provider failed: ${json([front.frontErrors, activeHost.provider.errors])}`);
      const ledger = await store.read(immutableId);
      recordProgress(ledger);
      observations.lastLedger = ledger;
      if (ledger.status === "paused" || (name === "throughput" && ledger.phases.some(phase => phase.paused))) {
        throw new Error(`Plan paused unexpectedly before lease sampling: ${json({ phases: ledger.phases, inbox: ledger.inbox })}\n${activeHost.tail()}`);
      }
      try {
        const snapshot = await readLeaseSnapshot();
        expect(Array.isArray(snapshot.leases), "G6: real lease snapshot").toBe(true);
        expect(nonOverlappingLeases(snapshot), "G6: no distinct task/agent owners of a logical file at any observed snapshot").toBe(true);
      } catch (error) {
        if (obj(error).code !== "ENOENT") throw error;
      }
      observedHeads.add(ledger.integration.head);
      if (restart && checkpoint && !restarted && ledger.tasks["2.1.1"]?.state === "integrated" && ledger.tasks[checkpoint.task]?.state === "running") {
        observations.restartCheckpoint = ledger;
        // Do not release the orphan's provider response until its original process has been killed.
        await collectDiagnostics(activeHost, "before-restart");
        await timing.span("host.restart", () => activeHost.restart());
        restarted = true;
        await command(activeHost, root, `resume ${immutableId}`, { action: "resume", planId: immutableId }, timing);
      }
      if (human && !humanAnswered) {
        const questions = ledger.inbox.filter(item => item.kind === "question" && item.taskId === human.task);
        const item = questions.find(question => question.answer === null);
        if (item && ledger.tasks[human.independentTask]?.attempts.some(attempt => attempt.outcome === "succeeded")) {
          expect(questions, "G10: one human queue item").toHaveLength(1);
          const independent = ledger.tasks[human.independentTask]!.attempts.find(attempt => attempt.outcome === "succeeded")!;
          expect(Date.parse(independent.endedAt!), "G10: independent work continues during question wait").toBeGreaterThanOrEqual(Date.parse(item.createdAt));
          observations.humanWait = { item, independent };
          humanAnswered = true;
          await command(activeHost, root, `answer --plan ${immutableId} ${item.id} ${human.answer}`, { action: "answer", planId: immutableId, inboxId: item.id, text: human.answer }, timing);
        }
      }
      if (!launchedBackgrounds && ledger.tasks["2.2.2"]?.state === "running") {
        launchedBackgrounds = true;
        for (const dispatch of script.backgroundDispatches ?? []) {
          const operation = background(dispatch);
          operation.catch(() => undefined); // Observed and rethrown by Promise.all below, not an unhandled rejection.
          backgrounds.push(operation);
        }
      }
      return ledger.status === "completed" ? ledger : undefined;
    }, Math.max(0, hostDeadlineAt - Date.now()), 50);
    await Promise.all(backgrounds);
    expect(restarted, "G9: requested restart checkpoint was reached").toBe(restart);
    if (human) expect(humanAnswered, "G10: scripted orchestrator actually answered").toBe(true);
    if (name === "resilience") expect([...adHocScripts.values()].map(attempt => attempt.id).sort(), "G2/G3: actual children served for every non-plan case").toEqual(script.backgroundDispatches!.map(dispatch => dispatch.id).sort());
    const exported = await waitFor("completion metric durably observable", async () => {
      const exported = await store.exportPlan(immutableId);
      return exported.events.some(event => event.type === "metric" && event.metric.name === "wake" && event.metric.reason === "plan-completed" && event.metric.result === "sent") ? exported : undefined;
    });
    const events = exported.events;
    assertFinal(final, script, events, name === "throughput");
    observations.final = final;
    observations.events = events;
    observations.requests = front.requests;
    observations.requestArrivals = [...arrivals];
    observations.leaseSamples = leaseSamples;
    expect(leaseSamples.some(snapshot => arr(snapshot.leases).length > 0), "G6: lease-safety check sampled actual live writers").toBe(true);
    for (const [index, duration] of workRequests) {
      const request = front.requests[index]!;
      if (request.served !== "scripted") continue; // Closed restart orphan, never a successful work reply.
      expect(request.durationMs, `G8: measured work request ${index}`).toBeGreaterThanOrEqual(duration - 5);
    }
    observations.workRequests = [...workRequests];
    const timings = await waitFor("G2 plan timing rows", async () => {
      const rows = await jsonl<Obj>(path.join(activeHost.outcomes, "timings.jsonl"));
      const children = Object.values(final.tasks).flatMap(task => task.attempts.filter(attempt => attempt.outcome === "succeeded").map(attempt => attempt.childSessionID));
      return children.every(child => rows.some(row => row.childSessionID === child)) ? rows : undefined;
    }, HOST_SLACK_MS);
    for (const task of Object.values(final.tasks)) for (const attempt of task.attempts.filter(attempt => attempt.outcome === "succeeded")) {
      expect(timings.filter(row => row.childSessionID === attempt.childSessionID), `G2: timing once for ${task.id}#${attempt.n}`).toHaveLength(1);
    }
    const launches = events.filter((event): event is MetricEvent => event.type === "metric" && event.metric.name === "launch");
    const completed = events.filter((event): event is MetricEvent => event.type === "metric" && event.metric.name === "wake" && event.metric.reason === "plan-completed" && event.metric.result === "sent");
    expect(completed, "G2: one plan completion wake").toHaveLength(1);
    const makespan = Date.parse(completed[0]!.at) - Math.min(...launches.map(event => Date.parse(event.at)));
    const serialIntegration = integrationTime(events);
    const idle = events.flatMap(event => event.type === "metric" && event.metric.name === "idle-with-ready" && event.metric.free > 0 ? [event.metric.ms] : []);
    for (const event of events) if (event.type === "metric" && event.metric.name === "idle-with-ready" && event.metric.free > 0) {
      expect(event.metric.readyTaskIds.length, "G8: idle metric has actual ready tasks").toBeGreaterThan(0);
      expect(event.metric.free, "G8: reported free capacity cannot exceed configured p").toBeLessThanOrEqual(script.executor.maxParallel);
      expect(Date.parse(event.metric.toAt) - Date.parse(event.metric.fromAt), "G8: idle duration matches ledger endpoints").toBe(event.metric.ms);
    }
    if (name === "throughput") assertIdleFragments(idle);
    // Retain the legacy per-fragment assertion as an additional check, never the episode oracle.
    const idleEpisodes: IdleEpisode[] = [];
    const metrics = { makespan, rawCP: bounds.cp, W_auth: bounds.work, p: script.executor.maxParallel, rawΣI: serialIntegration, idle, idleEpisodes,
      durationScale: 1, timingSlackMs: 0, idleSlackMs: 0, idleCeilingMs: G8_IDLE_CEILING_MS,
      rawEfficiency: makespan / Math.max(bounds.cp, bounds.work / script.executor.maxParallel, serialIntegration),
      conflictRate: events.filter(event => event.type === "integration-step" && event.result === "conflict").length / Object.values(final.tasks).filter(task => task.integrated !== null).length,
      reworkRate: Object.values(final.tasks).reduce((count, task) => count + Math.max(0, task.attempts.length - 1), 0) / Object.keys(final.tasks).length,
      capacity: events.filter(event => event.type === "metric" && event.metric.name === "capacity"),
      contextAge: events.filter(event => event.type === "metric" && event.metric.name === "context-age"),
      humanStops: final.inbox.filter(item => item.severity !== "info"),
    };
    observations.metrics = metrics;
    observations.snapshotWarnings = activeHost.tail(128_000).split(/\r?\n/).filter(line => /failed to capture snapshot|Filename too long/i.test(line));
    observations.unmeasured = unmeasured;
    if (name === "throughput") {
      obligation("initial-tasks-complete-once", Object.keys(script.tasks).every(id => ["done", "integrated"].includes(final.tasks[id]!.state) && final.tasks[id]!.attempts.filter(attempt => attempt.outcome === "succeeded").length === 1));
      obligation("four-clean-qa-reports", ["1.1.QA", "1.2.QA", "2.1.QA", "2.2.QA"].every(id => cleanQa(final, id)));
      obligation("four-passed-phase-gates", final.phases.length === 4 && final.phases.every(phase => phase.gate === "passed"));
      obligation("non-overlapping-leases", leaseSamples.some(snapshot => arr(snapshot.leases).length > 0) && leaseSamples.every(nonOverlappingLeases));
    }

    if (name === "resilience") {
      expect(observations.leaseRefusal, "G6: hard overlap path ran").toBeDefined();
      const failedSuite = events.filter(event => event.type === "integration-step" && event.entry.kind === "phase-suite" && event.edge === "end" && event.result === "failed");
      expect(failedSuite.length, "G7: phase-only regression detected").toBeGreaterThan(0);
      expect(events.some(event => event.type === "integration-step" && event.step === "checks" && event.entry.taskIds.includes("1.2.3") && event.result === "ok"), "G7: real task local suite passed, phase suite alone failed").toBe(true);
      expect(events.some(event => event.type === "integration-step" && event.step === "bisect"), "G7: suite failure bisected").toBe(true);
      expect(events.some(event => event.type === "integration-step" && event.step === "revert-fast-forward" && event.result === "ok"), "G7: checked revert").toBe(true);
      expect(final.tasks["1.2.3"]!.attempts.filter(attempt => attempt.outcome === "succeeded").length, "G7: corrective attempt, not test workaround").toBeGreaterThanOrEqual(2);
      const qa = script.injections.find(injection => injection.kind === "qa-findings")!;
      const report = JSON.parse(final.tasks[qa.task]!.attempts.find(attempt => attempt.outcome === "succeeded")!.context) as { findings: unknown[] };
      expect(report.findings, "G10: actual durable two-finding QA report").toEqual(script.tasks[qa.task]!.findings!.findings);
      for (const id of [...qa.fixTasks, qa.reviewTask]) expect(final.tasks[id]?.state, `G10: auto-generated ${id}`).toMatch(/done|integrated/);
      expect(final.phases.find(phase => phase.id === "2.1")?.qaRound, "G10: automatic re-review").toBe(2);
      expect(front.requests.filter(request => planIdentity(request)?.id === burst!.task && request.served === "rate-limit"), "G11: three actual HTTP 429 responses").toHaveLength(3);
      expect(front.pendingFaults, "G11: burst consumed without replies lost").toBe(0);
      const capacity = events.flatMap(event => event.type === "metric" && event.metric.name === "capacity" ? [event.metric] : []);
      const decrease = capacity.find(metric => metric.change === "decrease");
      expect(decrease, "G11: recorded capacity decrease").toBeDefined();
      expect(decrease?.from, "G11: burst begins at independently configured capacity").toBe(script.executor.maxParallel);
      expect(decrease?.to, "G11: halve configured capacity, not observed p as bound").toBe(Math.max(1, Math.floor(script.executor.maxParallel / 2)));
      expect(capacity.some(metric => metric.change === "increase" && metric.to === script.executor.maxParallel), "G11: success recovers to configured cap").toBe(true);
      for (const dispatch of script.backgroundDispatches ?? []) expect(final.tasks[dispatch.id], "G2: ad hoc call not fabricated as plan task").toBeUndefined();
      obligation("hidden-overlap-has-no-compiler-edge", !compiled.edges.some(edge => [edge.from, edge.to].every(id => ["1.1.2", "1.1.3"].includes(id))));
      obligation("hidden-write-refused-by-lease", /is being edited by/.test(json(observations.leaseRefusal)));
      obligation("leased-file-unchanged", observations.leasedContent === script.defaults.content);
      obligation("local-check-pass-phase-suite-fail", failedSuite.length > 0 && events.some(event => event.type === "integration-step" && event.step === "checks" && event.entry.taskIds.includes("1.2.3") && event.result === "ok"));
      obligation("corrective-attempt-passes", final.tasks["1.2.3"]!.attempts.filter(attempt => attempt.outcome === "succeeded").length === 2 && final.tasks["1.2.3"]!.attempts.at(-1)?.verdict === "pass");
      const questions = final.inbox.filter(item => item.kind === "question" && item.taskId === human!.task);
      obligation("human-queue-item-once", questions.length === 1);
      const progress = obj(observations.humanWait);
      obligation("independent-progress-during-human-wait", Date.parse(String(obj(progress.independent).endedAt)) >= Date.parse(String(obj(progress.item).createdAt)) && obj(progress.item).answer === null);
      obligation("human-approved-retry-completes", questions[0]?.answer === human!.answer && final.tasks[human!.task]!.state === "integrated");
      obligation("two-qa-findings", report.findings.length === 2 && json(report.findings) === json(script.tasks[qa.task]!.findings!.findings));
      obligation("two-generated-fixes", qa.fixTasks.length === 2 && qa.fixTasks.every(id => !compiled.tasks[id] && final.tasks[id]?.state === "integrated"));
      expect(obj(JSON.parse(git(activeHost.project, "show", `${final.integration.head}:py-pip/artifacts/b.json`))).reviewed, "G10: first generated fix actually changes integrated content").toBe(true);
      expect(obj(JSON.parse(git(activeHost.project, "show", `${final.integration.head}:py-pip/artifacts/c.json`))).audited, "G10: second generated fix actually changes integrated content").toBe(true);
      obligation("one-clean-re-review", !compiled.tasks[qa.reviewTask] && cleanQa(final, qa.reviewTask) && final.tasks[qa.reviewTask]!.attempts.filter(attempt => attempt.outcome === "succeeded").length === 1);
      obligation("three-429s-replies-not-consumed", burstLeft === 0 && front.requests.filter(request => planIdentity(request)?.id === burst!.task && request.served === "rate-limit").length === 3 && [...attempts.values()].filter(attempt => attempt.id === burst!.task).some(attempt => attempt.turns.length === 0));
      obligation("rate-limited-task-completes", final.tasks[burst!.task]!.state === "integrated");
      obligation("adhoc-not-a-plan-task", script.backgroundDispatches!.every(dispatch => !final.tasks[dispatch.id] && !compiled.tasks[dispatch.id]));
      tailAudit["restart-equivalent-to-baseline"] = "comparison asserted by the separate baseline/restart test below";
      const integrations = events.filter((event): event is StepEvent => event.type === "integration-step" && event.step === "fast-forward" && event.edge === "end" && event.result === "ok");
      obligation("no-duplicate-integration-or-completion-effects", Object.values(final.tasks).every(task => {
        const count = integrations.filter(event => event.entry.taskIds.includes(task.id)).length;
        return count <= task.attempts.filter(attempt => attempt.outcome === "succeeded").length && task.attempts.filter(attempt => attempt.outcome === "succeeded").every(attempt => timings.filter(row => row.childSessionID === attempt.childSessionID).length === 1);
      }));
    }

    const rootRequests = front.requests.filter(request => header(request, "x-proof-session") === root && header(request, "x-proof-kind") === "primary");
    expect(rootRequests.length, "G4: actual consecutive orchestrator requests").toBeGreaterThan(1);
    rootRequests.forEach(assertCacheLayout);
    for (let index = 1; index < rootRequests.length; index++) assertPrefix(rootRequests[index - 1]!, rootRequests[index]!);
    const polling = (await activeHost.hooks()).filter(hook => hook.hook === "before" && hook.sessionID === root && hook.tool === "router_plan" && ["status", "ready"].includes(String(hook.input?.action)));
    expect(polling, "G10: zero orchestrator polling turns").toHaveLength(0);

    // Re-run integration checks at EVERY published head, not just the final branch tip.
    const heads = events.flatMap(event => event.type === "integration-step" && event.edge === "end" && ["fast-forward", "revert-fast-forward"].includes(event.step) && event.result === "ok" && event.entry.candidate ? [event.entry.candidate] : []);
    const integratedTasks = new Set(events.flatMap(event => event.type === "integration-step" && event.step === "fast-forward" && event.edge === "end" && event.result === "ok" ? event.entry.taskIds : []));
    expect(integratedTasks.size, "G7: actual integrated tasks (a batch publishes one head)").toBeGreaterThanOrEqual(20);
    expect(heads.length, "G7: actual published heads to audit").toBeGreaterThan(0);
    for (const head of observedHeads) expect(git(activeHost.project, "merge-base", "--is-ancestor", head, final.integration.head), "G7: observed head belongs to checked integration history").toBe("");
    const audit = path.join(activeHost.root, "audit");
    const checkedHeads: { head: string; exit: number | null }[] = [];
    git(activeHost.project, "worktree", "add", "--detach", audit, final.integration.head);
    try {
      for (const head of new Set(heads)) {
        git(audit, "reset", "--hard", head);
        const checked = await spawnBounded(process.execPath, ["cpx-local.mjs"], audit, { signal: controller.signal, timeoutMs: Math.min(15_000, runDeadline - Date.now()), maxBytes: 64 * 1024, settleOnFailure: true, killGroupOnSettle: true });
        checkedHeads.push({ head, exit: checked.code });
        expect(checked.code, `G7: published integration head ${head} green: ${checked.output.toString("utf8")}\n${checked.stderr.toString("utf8")}`).toBe(0);
      }
      git(audit, "reset", "--hard", final.integration.head);
      const suites = await spawnBounded(process.execPath, ["cpx-phase.mjs"], audit, { signal: controller.signal, timeoutMs: Math.min(30_000, runDeadline - Date.now()), maxBytes: 64 * 1024, settleOnFailure: true, killGroupOnSettle: true });
      expect(suites.code, `G7/G12: final real suites: ${suites.output.toString("utf8")}\n${suites.stderr.toString("utf8")}`).toBe(0);
      if (name === "resilience") {
        obligation("integration-head-always-green", checkedHeads.length >= 20 && checkedHeads.every(check => check.exit === 0));
        obligation("final-suites-and-four-phase-gates-pass", suites.code === 0 && final.phases.length === 4 && final.phases.every(phase => phase.gate === "passed"));
      }
    } finally { git(activeHost.project, "worktree", "remove", "--force", audit); }
    observations.integrationHeadChecks = checkedHeads;
    // IDs, commit timestamps, and independent-task order may change on a REAL host. Preserve logical effects/counts.
    const commits = git(activeHost.project, "log", "--format=%s", `${final.repo.baseCommit}..${final.integration.head}`).split("\n")
      .map(subject => subject.replaceAll(immutableId, "<plan>").replace(/\b[0-9a-f]{7}\.\.[0-9a-f]{7}\b/g, "<range>")).sort();
    const tree = git(activeHost.project, "rev-parse", `${final.integration.head}^{tree}`);
    const markers = path.join(activeHost.project, ".git", "omr-executor", "slots", immutableId);
    const slotRecords = await Promise.all((await readdir(markers)).filter(file => file.endsWith(".json")).map(async file => obj(JSON.parse(await readFile(path.join(markers, file), "utf8")))));
    expect(slotRecords.some(slot => String(slot.slot).startsWith("slot-") && slot.state === "leased"), "G6/G9: no abandoned task leases").toBe(false);
    const leaseSnapshot = await waitFor("G6 all real registry leases released", async () => {
      const snapshot = await readLeaseSnapshot();
      expect(Array.isArray(snapshot.leases), "G6: actual lease snapshot exists").toBe(true);
      return arr(snapshot.leases).length === 0 ? snapshot : undefined;
    });
    observations.finalLeases = leaseSnapshot;
    const activeSessions = await activeHost.client.session.active();
    const backgroundSessions = [...backgroundRoots, ...adHocScripts.keys()];
    for (const session of backgroundSessions) expect(Object.hasOwn(activeSessions, session), "G2/G6: no active background parent/child after completion").toBe(false);
    if (name === "resilience") {
      obligation("no-abandoned-leases", !slotRecords.some(slot => String(slot.slot).startsWith("slot-") && slot.state === "leased") && arr(leaseSnapshot.leases).length === 0);
      obligation("no-live-leases-or-background-calls", arr(leaseSnapshot.leases).length === 0 && backgroundRoots.length === 3 && backgroundSessions.every(session => !Object.hasOwn(activeSessions, session)));
    }
    result = { ledger: normalizedLedger(final), tree, commits, metrics, tailAudit };
    // Inventory again just before purge, including late metric writes. The sealed oracle also requires
    // this export's high-water mark to match its last ledger snapshot, so no unseen tail can pass coverage.
    const idleInventory = name === "throughput" ? await store.exportPlan(immutableId) : undefined;
    if (idleInventory) observations.idleLedgerInventory = idleInventory;
    front.replyNext({ tool: "router_plan", input: { action: "purge", planId: immutableId } }, { when: request => header(request, "x-proof-session") === root && header(request, "x-proof-kind") === "primary" });
    await activeHost.prompt(root, "Purge the completed fixture plan and its marked slots.");
    expect(await store.list(), "G6/G9: purge leaves no ledger or slot residue").toHaveLength(0);
    if (name === "throughput") {
      // After the LAST live-host assertion: eviction disposes adapters and writes real end seals.
      // A hard restart intentionally cannot supply a sealed stream; resilience remains a separate G9 run.
      await activeHost.sealObservations();
      const files = await collectObservationFiles(activeHost.observationDirectory);
      observations.v2Observations = files;
      if (!idleInventory || !g8Plan) throw new Error("G8: missing frozen plan or ledger inventory");
      const amended = reconstructG8(g8Plan, final, idleInventory.events, files, serialIntegration);
      observations.g8Oracle = amended;
      Object.assign(metrics, amended, { efficiency: amended.makespan / Math.max(amended.CP_eff, amended.W_auth / amended.p, amended["ΣI_service"]) });
      expect(amended.makespan, "G8: service and idle inventories use the original makespan").toBe(makespan);
      assertG8Bound(amended);
      obligation("G8-makespan-bound", amended.makespan <= amended.bound);
      const inventorySeq = Math.max(idleInventory.snapshot.seq, ...idleInventory.events.map(event => event.seq));
      const oracle = reconstructIdleEpisodes(files, { planId: immutableId, parentSessionID: root, finalLedgerSeq: inventorySeq });
      idleEpisodes.push(...oracle.episodes);
      observations.idleOracle = oracle;
      assertG8IdleEpisodes(idleEpisodes, idleInventory.events.flatMap(event => event.type === "metric" && event.metric.name === "idle-with-ready" ? [event.metric] : []));
      obligation("idle-with-ready-at-most-10000ms", idleEpisodes.every(episode => episode.ms <= G8_IDLE_CEILING_MS));
    }
    expect(Object.keys(tailAudit).sort(), "Every sidecar tail assertion has an assertion or explicit conditional/comparison disposition").toEqual([...script.tailAssertions].sort());
    observations.tailAudit = tailAudit;
  } catch (error) {
    failure = error;
    timing.mark("driver.failure");
    observations.productFinding = error instanceof Error ? error.stack ?? error.message : String(error);
    if (host) {
      observations.hostLog = host.tail(12_000);
      observations.requests = host.front?.requests;
      if (planId) {
        const store = createLedgerStore({ home: path.join(host.project, ".git", "omr-executor") });
        observations.failureLedger = await store.read(planId).catch(() => undefined);
        observations.failureEvents = await store.exportPlan(planId).catch(() => undefined);
      }
      await collectDiagnostics(host, "failure");
    }
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    releaseVerdict = true;
    g1Released = true;
    if (host) {
      observations.teardown = await host.stop();
      const teardown = obj(observations.teardown);
      if (!failure && (!teardown.hostPortClosed || !teardown.providerStopped || !teardown.rootRemoved)) failure = new Error(`Leaked host/process: ${json(teardown)}`);
    }
    await Promise.allSettled(backgrounds); // Killing the host first releases SDK waits of failed foreground calls.
    observations.driverElapsedMs = Date.now() - driverStartedAt;
    timing.mark("driver.end", { failed: failure !== undefined });
    await writeEvidence(`${name}-${repository}-${restart ? "restart" : "baseline"}`, observations);
  }
  if (failure) throw failure;
  if (!result) throw new Error("Driver produced no result");
  return result;
}

describe.skipIf(!enabled || !process.env.OPENCODE_V2_BIN)("CPX e2e: both plans on all offline repository managers", () => {
  beforeAll(() => { runDeadline = Date.now() + RUN_BUDGET_MS; });
  for (const [criterion, reason] of Object.entries(unmeasured)) it.skip(`${criterion}: ${reason}`, () => {});
  it("G12 local non-regression: typecheck, v1 goldens, help/stats and docs-drift", async () => {
    const checks = [
      [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "test/golden", "test/unit/docs-drift.test.ts", "test/unit/routing-outcomes.stats.test.ts", "test/unit/commands-output.test.ts", "--maxWorkers=2"],
    ];
    const evidence: unknown[] = [];
    for (const args of checks) {
      const check = await spawnBounded(process.execPath, args, ROOT, { timeoutMs: Math.min(45_000, runDeadline - Date.now()), maxBytes: 64 * 1024, settleOnFailure: true, killGroupOnSettle: true });
      evidence.push({ args, code: check.code, failure: check.failure, output: check.output.toString("utf8"), stderr: check.stderr.toString("utf8") });
      await writeEvidence("G12", evidence);
      expect(check.failure, "G12: bounded subprocess completed").toBeUndefined();
      expect(check.code, `G12: ${args.join(" ")}\n${check.output.toString("utf8")}\n${check.stderr.toString("utf8")}`).toBe(0);
    }
  }, 95_000);
  for (const repository of repositories) {
    it(`throughput /plan run on ${repository}: G1–G8/G10/G12`, async () => {
      await drive("throughput", repository, false);
    }, HOST_RUN_CEILING_MS + 30_000);
    it(`resilience /plan run on ${repository}: G1–G7/G9–G12 and restart equivalence`, async () => {
      const baseline = await drive("resilience", repository, false);
      const recovered = await drive("resilience", repository, true);
      expect(recovered.ledger, "G9: normalized final ledger matches uninterrupted run").toEqual(baseline.ledger);
      expect(recovered.tree, "G9: same integration branch tree").toBe(baseline.tree);
      expect(recovered.commits, "G9: same logical integration commits/counts, no duplicated effects").toEqual(baseline.commits);
      await writeEvidence(`resilience-${repository}-equivalence`, { baseline: baseline.metrics, recovered: recovered.metrics, assertions: ["restart-equivalent-to-baseline", "no-duplicate-integration-or-completion-effects"], ledgerEqual: true, treeEqual: true, commitEffectsEqual: true });
    }, 2 * HOST_RUN_CEILING_MS + 30_000);
  }
});

if (enabled && !process.env.OPENCODE_V2_BIN) {
  it("requires an explicitly selected v2 host", () => {
    throw new Error("Set OPENCODE_V2_BIN to the absolute OpenCode v2 executable path");
  });
}
