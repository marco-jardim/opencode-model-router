/** Real-host, keyless proof of depth enforcement and per-producer effort.
 * RUN_OC_SMOKE_KEYLESS=1 (or RUN_OC_SMOKE=1) enables v1 on PATH.
 * RUN_OC_SMOKE_V2=1 with OPENCODE_V2_BIN enables v2 (independently of v1).
 * SMOKE_DEPTH_EFFORT_MUTATION=depth|bump changes CONFIG ONLY for proof mutation.
 * SMOKE_DEPTH_EFFORT_ARTIFACTS retains secret-free captures outside the checkout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { depthAdvisoryBanner, depthLimitMessage } from "../../src/router/depth-guard";
import { ScriptedProvider, blocks, blockText, type HostVersion, type Block } from "./helpers/scripted-provider";

const ROOT = path.resolve(__dirname, "../..");
const MODEL = "anthropic/claude-opus-4-7";
const KEYLESS = process.env.RUN_OC_SMOKE_KEYLESS === "1" || process.env.RUN_OC_SMOKE === "1";
const V2 = process.env.RUN_OC_SMOKE_V2 === "1";
if (V2 && !process.env.OPENCODE_V2_BIN) throw new Error("Set OPENCODE_V2_BIN to the OpenCode 2 executable when RUN_OC_SMOKE_V2=1");
const hosts: { version: HostVersion; executable: string; enabled: boolean }[] = [
  { version: "v1", executable: "opencode", enabled: KEYLESS },
  { version: "v2", executable: process.env.OPENCODE_V2_BIN ?? "", enabled: V2 },
];
interface HookRecord {
  hook: string;
  sessionID: string;
  parentID?: string;
  agent?: string;
  callID?: string;
  result?: { output?: { sessionID?: string; status?: string; output?: string }; metadata?: { status?: string }; content?: Block[] };
}
interface Run { code: number | null; stdout: string; stderr: string; rootID?: string; childID?: string; grandchildID?: string }
interface ProcessHandle { child: ChildProcess; closed: Promise<number | null>; stdout: string; stderr: string }
const fixtures: Fixture[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Fixture {
  readonly provider: ScriptedProvider;
  readonly processes: ProcessHandle[] = [];
  readonly runs: Run[] = [];
  readonly configs: { project: string; config: object; override: object }[] = [];
  env: NodeJS.ProcessEnv = {};
  baseURL = "";
  constructor(readonly host: typeof hosts[number], readonly root: string) { this.provider = new ScriptedProvider(host.version); }

  async init() {
    this.env = { ...process.env };
    for (const key of Object.keys(this.env)) {
      if (/^(OPENCODE_|MODEL_ROUTER_|XDG_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(key)) delete this.env[key];
    }
    for (const [key, folder] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp" })) {
      this.env[key] = path.join(this.root, folder);
      await mkdir(this.env[key], { recursive: true });
    }
    Object.assign(this.env, { OPENCODE_TEST_HOME: this.env.HOME, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_FILEWATCHER_DISABLE: "true", MODEL_ROUTER_VERIFIED_DELEGATE: "1", PROOF_LOG: path.join(this.root, "hooks.jsonl") });
    await writeFile(this.env.PROOF_LOG!, "");
    this.baseURL = await this.provider.start();
    // Observers only record identity/result state and add capture headers. They
    // never implement the guard, rewrite tool results, or apply effort options.
    await writeFile(path.join(this.root, "observer-v1.mjs"), `import {appendFileSync} from 'node:fs';
export default async ({client})=>{
 const log=x=>appendFileSync(process.env.PROOF_LOG,JSON.stringify(x)+'\\n');
 return {
  'chat.headers':async(i,o)=>{o.headers['x-proof-session']=i.sessionID;o.headers['x-proof-agent']=i.agent;},
  'chat.params':async(i)=>{const s=(await client.session.get({path:{id:i.sessionID}})).data;log({hook:'params',sessionID:i.sessionID,parentID:s?.parentID,agent:i.agent});},
  'tool.execute.after':async(i,o)=>log({hook:'after',sessionID:i.sessionID,callID:i.callID,output:o.output,metadata:o.metadata})
 };
};`);
    const observer = path.join(this.root, "observer-v2");
    await mkdir(observer);
    await writeFile(path.join(observer, "package.json"), JSON.stringify({ name: "depth-effort-observer", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
    await writeFile(path.join(observer, "server.mjs"), `import {appendFileSync} from 'node:fs';
export default {id:'depth-effort-observer',async setup(ctx){
 const log=x=>appendFileSync(process.env.PROOF_LOG,JSON.stringify(x)+'\\n');
 await ctx.session.hook('context',async e=>{const s=await ctx.session.get({sessionID:e.sessionID});log({hook:'params',sessionID:e.sessionID,parentID:s.parentID,agent:e.agent});});
 await ctx.session.hook('http.request',e=>{e.request.headers.set('x-proof-session',e.sessionID);e.request.headers.set('x-proof-agent',e.agent??'aux');e.request.headers.set('x-proof-kind',e.kind);});
 await ctx.tool.hook('execute.after',e=>log({hook:'after',sessionID:e.sessionID,callID:e.id,result:e.result}));
}};`);
    return this;
  }

  async project(name: string, override: object, observe = true) {
    const project = path.join(this.root, name);
    await mkdir(path.join(project, ".opencode"), { recursive: true });
    const settings = { baseURL: this.baseURL, apiKey: "keyless-smoke-fake" };
    const config = this.host.version === "v1" ? {
      model: MODEL, subagent_depth: 4,
      plugin: [ROOT, ...(observe ? [pathToFileURL(path.join(this.root, "observer-v1.mjs")).href] : [])],
      provider: { anthropic: { options: settings } },
      agent: { general: { model: MODEL, permission: { task: "allow" } } },
    } : {
      model: MODEL, experimental: { subagent_depth: 4 },
      plugins: [ROOT, ...(observe ? [path.join(this.root, "observer-v2")] : [])],
      providers: { anthropic: { settings } },
      agents: { general: { model: MODEL, permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } },
    };
    await writeFile(path.join(project, "opencode.json"), JSON.stringify(config));
    await writeFile(path.join(project, ".opencode", "opencode-model-router.overrides.jsonc"), JSON.stringify(override));
    this.configs.push({ project, config, override });
    return project;
  }

  launch(project: string, args: string[]): ProcessHandle {
    const child = spawn(this.host.executable, args, { cwd: project, env: { ...this.env, PWD: project }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const handle: ProcessHandle = { child, closed: Promise.resolve(null), stdout: "", stderr: "" };
    handle.closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    // Attach rejection handling immediately, including startup failures before run() awaits close.
    void handle.closed.catch(() => undefined);
    child.stdout!.on("data", chunk => { handle.stdout += chunk; });
    child.stderr!.on("data", chunk => { handle.stderr += chunk; });
    this.processes.push(handle);
    return handle;
  }

  async hooks(): Promise<HookRecord[]> {
    return (await readFile(this.env.PROOF_LOG!, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  async run(project: string, marker: string, session?: string): Promise<Run> {
    const offset = (await this.hooks()).length;
    const handle = this.launch(project, ["run", ...(this.host.version === "v2" ? ["--standalone", "--auto"] : []), "--format", "json", "--model", MODEL, ...(session ? ["--session", session] : []), marker]);
    const timer = setTimeout(() => handle.child.kill("SIGKILL"), 90_000);
    let code: number | null;
    try { code = await handle.closed; } finally { clearTimeout(timer); }
    const hooks = (await this.hooks()).slice(offset);
    const root = hooks.find(x => x.hook === "params" && x.agent === "build");
    const child = hooks.find(x => x.hook === "params" && x.parentID === root?.sessionID);
    const grandchild = hooks.find(x => x.hook === "params" && x.parentID === child?.sessionID);
    const run = { code, stdout: handle.stdout, stderr: handle.stderr, rootID: root?.sessionID, childID: child?.sessionID, grandchildID: grandchild?.sessionID };
    this.runs.push(run);
    expect(code, handle.stderr + handle.stdout).toBe(0);
    expect(this.provider.errors).toEqual([]);
    const output: { type: string; part?: { text?: string } }[] = handle.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(output.some(x => x.type === "text" && x.part?.text === "ok"), handle.stdout).toBe(true);
    return run;
  }
}

async function fixture(host: typeof hosts[number]) {
  const f = new Fixture(host, await mkdtemp(path.join(tmpdir(), "omr-depth-effort-")));
  fixtures.push(f);
  return f.init();
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      for (const p of f.processes) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGKILL");
      await Promise.allSettled(f.processes.map(p => p.closed));
      await f.provider.stop();
      if (process.env.SMOKE_DEPTH_EFFORT_ARTIFACTS) {
        await mkdir(process.env.SMOKE_DEPTH_EFFORT_ARTIFACTS, { recursive: true });
        await writeFile(path.join(process.env.SMOKE_DEPTH_EFFORT_ARTIFACTS, `${f.host.version}-${path.basename(f.root)}.json`), JSON.stringify({ host: f.host.version, configs: f.configs, captures: f.provider.captures, replies: f.provider.replies, hooks: await f.hooks(), runs: f.runs, processes: f.processes.map(p => ({ pid: p.child.pid, exitCode: p.child.exitCode, signal: p.child.signalCode, stdout: p.stdout, stderr: p.stderr })) }, null, 2));
      }
    } finally {
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
}, 30_000);

function scenarioConfig(mode: "enforced" | "advisory", effort = false, bump = true) {
  const mutation = process.env.SMOKE_DEPTH_EFFORT_MUTATION;
  return {
    activePreset: "smoke", defaultTier: "fast", experimental: { verifiedDelegateTool: true },
    presets: { smoke: {
      fast: { model: MODEL, effort: "low", costRatio: 1, whenToUse: ["smoke"] },
      medium: { model: MODEL, costRatio: 1, whenToUse: ["smoke"] },
      heavy: { model: MODEL, costRatio: 1, whenToUse: ["smoke"] },
    } },
    enforcement: {
      mode, maxDelegationDepth: mutation === "depth" ? null : 1,
      verify: { require: effort ? "always" : "never", defaultVerify: "required", minGraderTier: "heavy", preferDeterministic: false, background: false },
      escalate: { effortBump: mutation === "bump" ? false : bump, maxAttemptsPerTier: 1, maxTotalAttempts: 3, costCeiling: { base: "medium", multiple: 10 } },
    },
  };
}

for (const host of hosts) {
  const d = host.enabled ? describe : describe.skip;
  d(`depth/effort real host ${host.version}${host.version === "v2" && !V2 ? " (set RUN_OC_SMOKE_V2=1 and OPENCODE_V2_BIN to run)" : ""}`, () => {
    it("loads set/unset/invalid keys without adding agents; invalid config warns but starts", async () => {
      const f = await fixture(host);
      const project = await f.project("baseline", {}, false);
      const password = host.version === "v2" ? randomBytes(24).toString("base64url") : undefined;
      if (password) f.env.OPENCODE_PASSWORD = password;
      async function inventory(directory: string): Promise<{ agents: string[]; log: string }> {
        // Router config is process-cwd scoped, not the HTTP location parameter.
        // A fresh process is essential: reusing serve across directories can
        // falsely pass inventory checks while never loading an invalid override.
        const server = f.launch(directory, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"]);
        const deadline = Date.now() + 30_000;
        let address: string | undefined;
        while (!(address = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(server.stdout + server.stderr)?.[1])) {
          if (server.child.exitCode !== null || Date.now() > deadline) throw new Error(`Server startup failed: ${server.stderr}`);
          await delay(100);
        }
        const url = new URL(host.version === "v1" ? "/agent" : "/api/agent", address);
        url.searchParams.set(host.version === "v1" ? "directory" : "location[directory]", directory);
        const headers: Record<string, string> = password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
        async function get(target: URL) {
          const response = await fetch(target, { signal: AbortSignal.timeout(60_000), headers });
          const text = await response.text();
          expect(response.status, text + server.stderr).toBe(200);
          return text;
        }
        let text = await get(url);
        if (host.version === "v2") {
          // The first catalog request starts the native plugin graph, but can
          // return an empty catalog before setup completes (as in the existing
          // v2 registration smoke). Wait for THIS plugin's active state.
          const pluginURL = new URL(url);
          pluginURL.pathname = "/api/plugin";
          const until = Date.now() + 30_000;
          let state: { status: string; error?: string } | undefined;
          do {
            const inventory: { data: { id: string; state: { status: string; error?: string } }[] } = JSON.parse(await get(pluginURL));
            state = inventory.data.find(p => p.id === "opencode-model-router")?.state;
            if (state?.status === "active" || state?.status === "failed") break;
            await delay(50);
          } while (Date.now() < until);
          expect(state, server.stderr).toMatchObject({ status: "active" });
          text = await get(url);
        }
        const body: { name?: string; id?: string }[] | { data: { name?: string; id?: string }[] } = JSON.parse(text);
        const entries = Array.isArray(body) ? body : body.data;
        server.child.kill("SIGKILL");
        await server.closed;
        return { agents: entries.map(a => a.id ?? a.name ?? "").sort(), log: server.stderr + server.stdout };
      }
      const baseline = (await inventory(project)).agents;
      expect(baseline).toEqual(expect.arrayContaining(["fast", "medium", "heavy"]));
      // Empty enforcement is the unset control for each key; compare FULL host inventories.
      for (const [key, valid, invalid] of [["maxDelegationDepth", 2, -1], ["effortBump", false, "yes"], ["effortBumpMax", "high", "bogus"]] as const) {
        for (const [label, value] of [["set", valid], ["invalid", invalid]] as const) {
          const enforcement = key === "maxDelegationDepth" ? { [key]: value } : { escalate: { [key]: value } };
          const dir = await f.project(`${key}-${label}`, { enforcement }, false);
          const actual = await inventory(dir);
          expect(actual.agents, `${key} ${label}`).toEqual(baseline);
          if (label === "invalid") {
            // Do not mistake a config path containing "invalid" for a warning.
            const warning = actual.log.split(/\r?\n/).find(line => line.includes(key) && line.includes("must be"));
            expect(warning, `${key} must warn, not silently accept invalid config\n${actual.log}`).toBeDefined();
            expect(warning).toMatch(/ignoring|invalid|dropp/i);
          }
        }
      }
      expect(f.provider.captures).toHaveLength(0);
    }, 300_000);

    for (const mode of ["enforced", "advisory"] as const) {
      for (const kind of (host.version === "v2" ? ["foreground", "background", "resume"] : ["foreground"])) {
        it(`${mode} ${kind}: root allowed; child ${mode === "enforced" ? "refused with exact D5" : "proceeds with exactly one banner"}`, async () => {
          const f = await fixture(host);
          const project = await f.project("project", scenarioConfig(mode));
          let run: Run;
          let existing: string | undefined;
          if (kind === "resume") {
            // Enforced refusal is before native ownership validation. Advisory
            // must resume a true direct child, not a sibling of the caller.
            const setup = await f.run(project, mode === "advisory" ? "ROOT_NEST_FG" : "ROOT_SETUP");
            existing = mode === "advisory" ? setup.grandchildID : setup.childID;
            expect(existing).toBeTruthy();
            run = await f.run(project, `ROOT_NEST_RESUME RESUME_ID=${existing}${mode === "advisory" ? ` RESUME_CALLER_ID=${setup.childID}` : ""}`, setup.rootID);
          } else run = await f.run(project, kind === "background" ? "ROOT_NEST_BG" : "ROOT_NEST_FG");
          expect(run.rootID).toBeTruthy();
          expect(run.childID).toBeTruthy();
          const childBlocks = f.provider.captures.filter(c => c.session === run.childID).flatMap(c => blocks(c.body));
          const uses = childBlocks.filter(b => b.type === "tool_use" && b.name === (host.version === "v1" ? "task" : "subagent"));
          const call = uses.find(b => kind !== "resume" || b.input?.sessionID === existing);
          expect(call, JSON.stringify(childBlocks)).toBeDefined();
          if (kind === "background") expect(call?.input?.background).toBe(true);
          const result = childBlocks.find(b => b.type === "tool_result" && b.tool_use_id === call?.id);
          expect(result).toBeDefined();
          const text = blockText(result?.content);
          if (mode === "enforced") {
            expect(result?.is_error).toBe(true);
            const message = host.version === "v2" ? (JSON.parse(text) as { error: { message: string } }).error.message : text;
            expect(message).toBe(depthLimitMessage(1, 1));
          } else {
            expect(result?.is_error).not.toBe(true);
            expect(text.split("[⚠ GUARD:delegation_depth]")).toHaveLength(2);
            expect(text.trimEnd().endsWith(depthAdvisoryBanner(1, 1))).toBe(true);
            if (host.version === "v2") {
              const after = (await f.hooks()).find(h => h.hook === "after" && h.callID === call?.id && h.sessionID === run.childID);
              if (kind === "background") {
                expect(after?.result?.output?.status).toBe("running");
                expect(after?.result?.metadata?.status).toBe("running");
                expect(after?.result?.output?.output?.split("[⚠ GUARD:delegation_depth]")).toHaveLength(2);
              } else {
                expect(text).toContain("<subagent sessionID=");
                expect(after?.result?.output?.status).toBe("completed");
                if (existing) expect(after?.result?.output?.sessionID).toBe(existing);
              }
            }
          }
          const rootResults = f.provider.captures.filter(c => c.session === run.rootID && c.role === "orchestrator").flatMap(c => blocks(c.body)).filter(b => b.type === "tool_result");
          expect(rootResults.length).toBeGreaterThan(0);
          expect(rootResults.every(b => !b.is_error && !blockText(b.content).includes("DELEGATION DEPTH LIMIT"))).toBe(true);
          expect(rootResults.every(b => !blockText(b.content).includes("[⚠ GUARD:delegation_depth]"))).toBe(true);
        }, 120_000);
      }
    }

    for (const bump of [true, false]) {
      it(bump ? "bumps only the retry producer from low to medium" : "effortBump false keeps both producer attempts at low", async () => {
        const f = await fixture(host);
        const project = await f.project("project", scenarioConfig("advisory", true, bump));
        const run = await f.run(project, "CALL_DELEGATE");
        const producers = f.provider.captures.filter(c => c.role === "producer");
        expect(producers.map(c => c.body.output_config?.effort)).toEqual(["low", bump ? "medium" : "low"]);
        expect(new Set(producers.map(c => c.session)).size).toBe(2);
        for (const role of ["title", "grader", "orchestrator"] as const) {
          const requests = f.provider.captures.filter(c => c.role === role);
          expect(requests.length, `${role} must actually be exercised`).toBeGreaterThan(0);
          expect(requests.map(c => c.body.output_config?.effort)).toEqual(requests.map(() => undefined));
        }
        expect(f.provider.replies.filter(r => r.role === "grader").map(r => JSON.parse(r.text).pass)).toEqual([false, true]);
        expect(run.stdout).toContain("[router ✓ verified: checker]");
        expect(f.provider.captures.at(-1)?.role).toBe("orchestrator");
      }, 120_000);
    }
  });
}
