import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, gitExecutable, gitTools } from "../../src/router/git-tools";
import type { RunConfig } from "../../src/router/roles";
import {
  argAllowed, authorizeCwd, dropLeadingPartial, npmHardeningFlags, planRun, renderRunOutput, resolveCommandExecutable,
  resolveNodeExecutable, routerRunTool, runEnvironment, RUN_HEAD_BYTES, RUN_OUTPUT_BYTES, scriptAllowed, validateRunArgs,
  type RunRecord, type RunToolDeps,
} from "../../src/router/run-tools";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const WIN = process.platform === "win32";
const SPAWN_TIMEOUT = 90_000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
let root: string;
let sibling: string;
let home: string;

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockClear();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-")));
  sibling = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-sibling-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-home-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [root, sibling, home]) rmSync(dir, RM);
});

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  scripts: ["test", "typecheck", "lint", "build", "test:*"], commands: {}, timeoutMs: 60_000, ...over,
});
/** The run's environment: npm's cache, logs and user config stay in a temp home (tests use temp dirs only). */
const testEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), ...extra,
});
/** A package.json whose scripts run probe.js; probe.js records what the script saw in ran.json. */
function project(dir: string, scripts: Record<string, string> = { test: "node probe.js" }) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", private: true, scripts }));
  writeFileSync(join(dir, "probe.js"), [
    "const fs = require('fs');",
    "fs.writeFileSync(require('path').join(process.cwd(), 'ran.json'), JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),",
    "  nodeOptions: process.env.NODE_OPTIONS ?? null, ci: process.env.CI ?? null, shell: process.env.npm_config_script_shell ?? null }));",
    "console.log('PROBE-OK ' + process.argv.slice(2).join(' '));",
    "if (process.argv[2] === 'exit') process.exit(Number(process.argv[3]));",
  ].join("\n"));
}
type Execute = (args: unknown, context: unknown) => Promise<string>;
function context(sessionID = "child", directory = root) {
  return { sessionID, messageID: "m", agent: "runner", directory, worktree: directory, abort: new AbortController().signal,
    metadata: () => undefined, ask: async () => undefined };
}
function makeTool(over: Partial<RunToolDeps> = {}, records: RunRecord[] = []) {
  const t = routerRunTool({ config: () => config(), resolveWorkRoot: () => root, recordRun: e => { records.push(e); }, env: testEnv(), ...over });
  return (args: unknown, ctx = context()) => (t.execute as unknown as Execute)(args, ctx);
}

describe("router_run authority (P-10, I9)", () => {
  it("refuses an unbound session and spawns nothing", async () => {
    project(root);
    for (const bound of [null, undefined, "", 42]) {
      const run = makeTool({ resolveWorkRoot: () => bound as string | null });
      expect(await run({ script: "test", cwd: root })).toMatch(/^\[router_run\] error: refused: this session has no bound work root \(I9\)/);
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, "ran.json"))).toBe(false);
  });
  it("refuses a foreign, relative or missing cwd and never falls back to context.directory", async () => {
    project(root); project(sibling);
    const run = makeTool();
    expect(await run({ script: "test", cwd: sibling })).toMatch(/^\[router_run\] error: refused: cwd is not this dispatch's work root/);
    expect(await run({ script: "test", cwd: "." })).toMatch(/^\[router_run\] error: refused: cwd must be the absolute path/);
    expect(await run({ script: "test", cwd: join(root, "missing") })).toMatch(/refused: cwd is not this dispatch's work root/);
    expect(await run({ script: "test" })).toMatch(/refused: cwd must be the absolute path/);
    expect(await run({ script: "test", cwd: root }, context("child", sibling))).toMatch(/exit code: 0/);
    expect(existsSync(join(sibling, "ran.json"))).toBe(false);
    expect(authorizeCwd(root, `${root}${WIN ? "\\" : "/"}`)).toBe(root);
    if (WIN) expect(authorizeCwd(root, root.toUpperCase())).toBe(root);
    expect(() => authorizeCwd("relative", root)).toThrow("not an absolute path");
  }, SPAWN_TIMEOUT);
  it("runs in a sibling-directory work root although the session directory is elsewhere", async () => {
    project(root); project(sibling);
    const run = makeTool({ resolveWorkRoot: () => sibling });
    const out = await run({ script: "test", cwd: sibling }, context("child", root));
    expect(out).toMatch(/exit code: 0/);
    expect(existsSync(join(sibling, "ran.json"))).toBe(true);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(sibling, "ran.json"), "utf8")).cwd.toLowerCase()).toBe(sibling.toLowerCase());
  }, SPAWN_TIMEOUT);
});

describe("router_run allowlist", () => {
  it("refuses names outside routing.run, missing package.json and missing scripts", async () => {
    const run = makeTool();
    expect(await run({ script: "test", cwd: root })).toMatch(/refused: no readable package\.json in the work root/);
    project(root, { test: "node probe.js", deploy: "node probe.js", "test:unit": "node probe.js" });
    expect(await run({ script: "deploy", cwd: root })).toMatch(/refused: "deploy" is not in routing\.run\.scripts or routing\.run\.commands/);
    expect(await run({ script: "testx", cwd: root })).toMatch(/is not in routing\.run/);
    expect(await run({ script: "lint", cwd: root })).toMatch(/refused: package\.json has no script "lint"/);
    for (const name of ["constructor", "__proto__", "toString"]) expect(await run({ script: name, cwd: root })).toMatch(/refused/);
    for (const name of ["--script-shell=x", "-v", "a b", "a;b", ""]) expect(await run({ script: name, cwd: root })).toMatch(/^\[router_run\] error: /);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(await run({ script: "test:unit", cwd: root })).toMatch(/package\.json script "test:unit": exit code: 0/);
  }, SPAWN_TIMEOUT);
  it("matches script entries exactly or by a trailing-* prefix; a bare * matches nothing", () => {
    expect(scriptAllowed(["test", "test:*"], "test")).toBe(true);
    expect(scriptAllowed(["test:*"], "test:unit")).toBe(true);
    expect(scriptAllowed(["test:*"], "test:")).toBe(false);
    expect(scriptAllowed(["test:*"], "test")).toBe(false);
    expect(scriptAllowed(["test:*"], "testx")).toBe(false);
    expect(scriptAllowed(["*"], "deploy")).toBe(false);
  });
});

describe("router_run arguments", () => {
  const METACHARACTERS = [";", "|", "&", "\n", "`", "$(", "%PATH%", "^", "!", "\"", "<", ">", " ", "'", "(", ")", "\\", "*", "?", ",", "\r", "\0"];
  it("refuses every shell metacharacter, before anything is spawned", async () => {
    for (const meta of METACHARACTERS) expect(() => validateRunArgs([`a${meta}b`])).toThrow(/argument 1 refused/);
    expect(() => validateRunArgs(["x".repeat(201)])).toThrow(/argument 1 refused/);
    expect(() => validateRunArgs([""])).toThrow(/argument 1 refused/);
    expect(() => validateRunArgs(Array(51).fill("a"))).toThrow(/at most 50/);
    expect(validateRunArgs(["test/unit/a.test.ts", "--reporter=dot", "a:b@c+d=e"])).toEqual(["test/unit/a.test.ts", "--reporter=dot", "a:b@c+d=e"]);
    project(root);
    const run = makeTool({ config: () => config({ commands: { probe: { argv: ["node", "probe.js"], args: ["*", "-*"] } } }) });
    for (const meta of METACHARACTERS) {
      const out = await run({ script: "probe", args: [`a${meta}b`], cwd: root });
      expect(out).toMatch(/^\[router_run\] error: /);
      expect(out).not.toContain(`a${meta}b`);
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
  it("accepts arguments only when the entry declares them; options need a declared option pattern", async () => {
    expect(argAllowed(["*"], "test/a.ts")).toBe(true);
    expect(argAllowed(["*"], "--output")).toBe(false);
    expect(argAllowed(["test/*"], "src/a.ts")).toBe(false);
    expect(argAllowed(["--reporter=*"], "--reporter=dot")).toBe(true);
    expect(argAllowed(["--reporter=*"], "--output")).toBe(false);
    expect(argAllowed(["--bail"], "--bail")).toBe(true);
    project(root);
    const run = makeTool({ config: () => config({ commands: {
      bare: { argv: ["node", "probe.js"] },
      empty: { argv: ["node", "probe.js"], args: [] },
      files: { argv: ["node", "probe.js"], args: ["*"] },
      npmNoSeparator: { argv: ["npm", "run", "test"], args: ["-*"] },
    } }) });
    expect(await run({ script: "test", args: ["x"], cwd: root })).toMatch(/refused: package\.json scripts take no caller arguments/);
    expect(await run({ script: "bare", args: ["x"], cwd: root })).toMatch(/refused: "bare" takes no caller arguments/);
    expect(await run({ script: "empty", args: ["x"], cwd: root })).toMatch(/takes no caller arguments/);
    expect(await run({ script: "files", args: ["--output"], cwd: root })).toMatch(/refused: argument 1 is not among the arguments "files" declares/);
    expect(await run({ script: "npmNoSeparator", args: ["--script-shell=evil.cmd"], cwd: root })).toMatch(/need a "--" in its argv/);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    const out = await run({ script: "files", args: ["one", "two/three.ts"], cwd: root });
    expect(out).toMatch(/command "files": exit code: 0/);
    expect(out).toContain("PROBE-OK one two/three.ts");
  }, SPAWN_TIMEOUT);
});

describe("router_run execution", () => {
  it("spawns node with npm-cli.js and the hardening flags, shell: false, never a .cmd shim", async () => {
    project(root);
    const records: RunRecord[] = [];
    const out = await makeTool({}, records)({ script: "test", cwd: root });
    expect(out).toMatch(/^\[router_run\] package\.json script "test": exit code: 0; duration \d+\.\d s\n/);
    expect(out).toContain("PROBE-OK");
    const calls = vi.mocked(childProcess.spawn).mock.calls.filter(call => !String(call[0]).toLowerCase().endsWith("taskkill.exe"));
    expect(calls).toHaveLength(1);
    const [executable, argv, options] = calls[0]! as unknown as [string, string[], childProcess.SpawnOptions];
    expect(executable).toMatch(WIN ? /\\node\.exe$/i : /\/node$/);
    expect(argv[0]).toMatch(/[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/);
    expect(argv.slice(1, 5)).toEqual(npmHardeningFlags(argv[1]!.slice("--script-shell=".length)));
    expect(argv[1]).toMatch(WIN ? /^--script-shell=[A-Za-z]:\\.*\\cmd\.exe$/i : /^--script-shell=\//);
    expect(argv.slice(5)).toEqual(["run", "test"]);
    expect(options.shell).toBe(false);
    expect(String(options.cwd)).toBe(root);
    expect(options.env?.CI).toBe("1");
    expect(records).toEqual([{ sessionID: "child", script: "test", exitCode: 0, at: expect.any(Number) }]);
  }, SPAWN_TIMEOUT);
  it("propagates a non-zero exit code as a normal result and to recordRun", async () => {
    project(root);
    const records: RunRecord[] = [];
    const run = makeTool({ config: () => config({ commands: { fail: { argv: ["node", "probe.js", "exit", "3"] } } }) }, records);
    const out = await run({ script: "fail", cwd: root });
    expect(out).toMatch(/^\[router_run\] command "fail": exit code: 3;/);
    expect(records.map(r => r.exitCode)).toEqual([3]);
    project(root, { test: "node probe.js exit 7" });
    const viaNpm = await run({ script: "test", cwd: root });
    expect(viaNpm).toMatch(/exit code: 7;/);
    expect(records.map(r => r.exitCode)).toEqual([3, 7]);
    const throwing = makeTool({ recordRun: () => { throw new Error("store down"); } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await throwing({ script: "test", cwd: root })).toMatch(/exit code: 7;/);
  }, SPAWN_TIMEOUT);
  it("bounds output above 64 KiB with a notice and keeps the tail", async () => {
    project(root);
    writeFileSync(join(root, "big.js"), "process.stdout.write('HEAD-START\\n' + 'line of output text\\n'.repeat(15000)); process.stderr.write('STDERR-END\\n'); process.stdout.write('TAIL-END\\n');");
    const out = await makeTool({ config: () => config({ commands: { big: { argv: ["node", "big.js"] } } }) })({ script: "big", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(out).toContain("HEAD-START");
    expect(out).toContain("TAIL-END");
    expect(out).toContain("STDERR-END");
    expect(out).toMatch(/\[router_run\] output truncated: \d+ bytes omitted; showing at most the first 16384 and the last 49152 bytes \(bound 65536 bytes\)/);
    expect(Buffer.byteLength(out)).toBeLessThan(RUN_OUTPUT_BYTES + 1024);
  }, SPAWN_TIMEOUT);
  it("never shows a credential cut at the head or tail boundary", async () => {
    project(root);
    // The credential straddles byte RUN_HEAD_BYTES: the head ends inside it.
    const lead = "y".repeat(RUN_HEAD_BYTES - 20);
    writeFileSync(join(root, "secret.js"), `process.stdout.write(${JSON.stringify(lead)} + ' https://deploy:hunter2secret@example.com/repo\\n' + 'filler line\\n'.repeat(20000) + 'final https://alice:topsecret9@example.com/x done\\n');`);
    const out = await makeTool({ config: () => config({ commands: { secret: { argv: ["node", "secret.js"] } } }) })({ script: "secret", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    for (const fragment of ["hunter2", "hunter", "2secret", "topsecret9", "alice:", "deploy:"]) expect(out).not.toContain(fragment);
    expect(out).toContain("final https://example.com/x done");
    // Synthetic cuts: the tail window starts inside a credential, the head ends inside one.
    const tailCut = renderRunOutput({ output: Buffer.from("head\n"), truncated: true, omitted: 100, tail: Buffer.from("er:s3cr3t@host.example/x\nnext https://u:pw123@h/y\n") });
    expect(tailCut).not.toContain("s3cr3t"); expect(tailCut).not.toContain("pw123"); expect(tailCut).toContain("next https://h/y");
    const headCut = renderRunOutput({ output: Buffer.from("ok https://bob:passw"), truncated: true, omitted: 5, tail: Buffer.from("x\nlast\n") });
    expect(headCut).not.toContain("passw"); expect(headCut).toContain("ok ");
    expect(renderRunOutput({ output: Buffer.from("a https://u:p@h/ "), truncated: true, omitted: 0, tail: Buffer.from("b\n") })).toBe("a https://h/ b\n");
    expect(dropLeadingPartial("partial-token rest")).toBe("rest");
    expect(dropLeadingPartial("no-whitespace-at-all")).toBe("");
  }, SPAWN_TIMEOUT);
  it("kills the process tree on timeout and reports no exit code", async () => {
    project(root);
    writeFileSync(join(root, "hang.js"), "console.log('started'); setInterval(() => {}, 1000);");
    const records: RunRecord[] = [];
    const started = performance.now();
    const out = await makeTool({ config: () => config({ timeoutMs: 1_500, commands: { hang: { argv: ["node", "hang.js"] } } }) }, records)({ script: "hang", cwd: root });
    expect(out).toMatch(/^\[router_run\] command "hang": timed out after 1500 ms, process tree killed; exit code: none/);
    expect(out).toContain("started");
    expect(records.map(r => r.exitCode)).toEqual([null]);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, SPAWN_TIMEOUT);
});

describe("router_run hijack resistance (#77 G4)", () => {
  function plantEvil(dir: string) {
    writeFileSync(join(dir, "evil.js"), "require('fs').writeFileSync(require('path').join(__dirname, 'node-marker.txt'), 'evil');");
    if (WIN) {
      writeFileSync(join(dir, "evil.cmd"), "@echo off\r\necho evil> \"%~dp0shell-marker.txt\"\r\n");
    } else {
      writeFileSync(join(dir, "evil.sh"), "#!/bin/sh\necho evil > \"$(dirname \"$0\")/shell-marker.txt\"\n");
      chmodSync(join(dir, "evil.sh"), 0o755);
    }
  }
  const markers = (dir: string) => ["shell-marker.txt", "node-marker.txt", "npm-marker.txt"].filter(name => existsSync(join(dir, name)));

  it("ignores a repo .npmrc script-shell and node-options", async () => {
    project(root); plantEvil(root);
    writeFileSync(join(root, ".npmrc"), WIN ? "script-shell=.\\evil.cmd\r\nnode-options=--require .\\evil.js\r\n"
      : "script-shell=./evil.sh\nnode-options=--require ./evil.js\n");
    const out = await makeTool()({ script: "test", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(markers(root)).toEqual([]);
    const seen = JSON.parse(readFileSync(join(root, "ran.json"), "utf8"));
    expect(seen.nodeOptions ?? "").toBe("");
    expect(seen.ci).toBe("1");
    expect(seen.shell).not.toMatch(/evil/);
    // Positive control: the same npm WITHOUT the hardening flags honours the repo .npmrc.
    project(sibling); plantEvil(sibling);
    writeFileSync(join(sibling, ".npmrc"), WIN ? "node-options=--require .\\evil.js\r\n" : "script-shell=./evil.sh\nnode-options=--require ./evil.js\n");
    const plan = planRun({ script: "test", cwd: sibling }, sibling, config(), { platform: process.platform, env: testEnv() });
    execFileSync(plan.executable, [plan.argv[0]!, "run", "test"], { cwd: sibling, env: plan.env, stdio: "ignore", windowsHide: true });
    expect(markers(sibling)).toEqual(WIN ? ["node-marker.txt"] : ["shell-marker.txt"]);
  }, SPAWN_TIMEOUT);
  it("drops inherited npm_config_*, NODE_OPTIONS and PREFIX from the environment", async () => {
    project(root); plantEvil(root);
    const evilShell = join(root, WIN ? "evil.cmd" : "evil.sh");
    const env = testEnv({ npm_config_script_shell: evilShell, NPM_CONFIG_NODE_OPTIONS: `--require ${join(root, "evil.js")}`,
      NODE_OPTIONS: `--require ${join(root, "evil.js")}`, npm_config_userconfig: join(root, ".npmrc"), PREFIX: root });
    const out = await makeTool({ env })({ script: "test", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(markers(root)).toEqual([]);
    const hardened = runEnvironment({ Path: "p", npm_config_x: "1", NPM_CONFIG_Y: "2", Npm_Lifecycle_Event: "z", node_options: "n", NODE_OPTIONS: "n", ci: "0", COMSPEC: "x" }, "win32", "C:\\Windows\\System32\\cmd.exe");
    expect(hardened).toEqual({ Path: "p", CI: "1", ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(runEnvironment({ PATH: "p", ci: "0" }, "linux")).toEqual({ PATH: "p", ci: "0", CI: "1" });
  }, SPAWN_TIMEOUT);
  it("never uses a planted node_modules/.bin npm shim, even first on PATH", async () => {
    project(root); plantEvil(root);
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm.cmd"), "@echo off\r\necho evil> \"%~dp0..\\..\\npm-marker.txt\"\r\n");
    writeFileSync(join(bin, "npm"), "#!/bin/sh\necho evil > \"$(dirname \"$0\")/../../npm-marker.txt\"\n");
    if (!WIN) chmodSync(join(bin, "npm"), 0o755);
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
    const env = testEnv({ [pathKey]: `${bin}${WIN ? ";" : ":"}${process.env[pathKey] ?? ""}` });
    const out = await makeTool({ env })({ script: "test", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(markers(root)).toEqual([]);
    const npmCli = (vi.mocked(childProcess.spawn).mock.calls[0]![1] as string[])[0]!;
    expect(npmCli.toLowerCase().startsWith(root.toLowerCase())).toBe(false);
  }, SPAWN_TIMEOUT);
  it("refuses a node executable, command executable or shell inside the work root", () => {
    mkdirSync(join(root, "bin"));
    const planted = join(root, "bin", WIN ? "tool.exe" : "tool");
    writeFileSync(planted, "");
    writeFileSync(join(root, "bin", WIN ? "node.exe" : "node"), "");
    const host = { platform: process.platform, env: { PATH: join(root, "bin") } as NodeJS.ProcessEnv };
    expect(() => resolveNodeExecutable({ ...host, nodeExecPath: join(root, "bin", WIN ? "node.exe" : "node") }, [root])).toThrow(/inside the work root/);
    expect(() => resolveCommandExecutable("tool", host, [root])).toThrow(/inside the work root/);
    expect(() => resolveCommandExecutable(planted, host, [root])).toThrow(/inside the work root/);
    writeFileSync(join(sibling, WIN ? "tool.exe" : "tool"), "");
    const both = { platform: process.platform, env: { PATH: `${join(root, "bin")}${WIN ? ";" : ":"}${sibling}` } as NodeJS.ProcessEnv };
    expect(resolveCommandExecutable("tool", both, [root]).toLowerCase()).toBe(join(sibling, WIN ? "tool.exe" : "tool").toLowerCase());
    for (const shell of ["cmd", "cmd.exe", "powershell", "pwsh", "bash", "sh", "env", "C:\\Windows\\System32\\cmd.exe", "/bin/sh"]) {
      expect(() => resolveCommandExecutable(shell, host, [root])).toThrow(/is a shell/);
    }
    for (const shim of ["npx", "pnpm", "yarn", "bunx", "npx.cmd"]) expect(() => resolveCommandExecutable(shim, host, [root])).toThrow(/reads repository configuration/);
    expect(() => resolveCommandExecutable("./tool", host, [root])).toThrow(/absolute or a bare name/);
    if (WIN) expect(() => resolveCommandExecutable("tool.cmd", both, [root])).toThrow(/\.exe or \.com/);
  });
  it("plans npm through node, with the hardening flags before the entry", () => {
    project(root);
    const plan = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    expect(plan.kind).toBe("script");
    expect(plan.argv[0]).toMatch(/npm-cli\.js$/);
    expect(plan.argv.slice(-2)).toEqual(["run", "test"]);
    expect(plan.argv).toContain("--node-options=");
    expect(plan.argv).toContain("--workspaces=false");
    expect(plan.timeoutMs).toBe(60_000);
    expect(planRun({ script: "test", cwd: root }, root, config({ timeoutMs: Number.POSITIVE_INFINITY }), { platform: process.platform, env: testEnv() }).timeoutMs).toBe(600_000);
    expect(planRun({ script: "test", cwd: root }, root, config({ timeoutMs: 2 ** 40 }), { platform: process.platform, env: testEnv() }).timeoutMs).toBe(2 ** 31 - 1);
    const npmCommand = planRun({ script: "unit", args: ["test/a.ts"], cwd: root }, root,
      config({ commands: { unit: { argv: ["npm", "run", "test", "--"], args: ["test/*"] } } }), { platform: process.platform, env: testEnv() });
    expect(npmCommand.argv.slice(1, 5)).toEqual(npmHardeningFlags(npmCommand.argv[1]!.slice("--script-shell=".length)));
    expect(npmCommand.argv.slice(5)).toEqual(["run", "test", "--", "test/a.ts"]);
  });
});

describe("router_git work-root resolver (R6/P-18)", () => {
  function repository(dir: string) {
    const git = (...args: string[]) => execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: dir, env: gitEnvironment(), encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "bound.txt"), "x\n");
    git("add", "-A"); git("commit", "-qm", "init");
  }
  const call = (tools: ReturnType<typeof gitTools>, name: string, directory: string) =>
    (tools[name]!.execute as unknown as Execute)({}, context("child", directory));

  it("uses the bound root, refuses an unbound role session, and keeps today's behaviour for undefined", async () => {
    repository(sibling);
    const bound = gitTools({ resolveWorkRoot: () => sibling });
    expect(await call(bound, "router_git_ls_files", root)).toBe("bound.txt\n");
    const unbound = gitTools({ resolveWorkRoot: () => null });
    expect(await call(unbound, "router_git_ls_files", sibling)).toBe("[router_git] error: refused: this role session has no bound work root (I9)");
    const notRole = gitTools({ resolveWorkRoot: () => undefined });
    expect(await call(notRole, "router_git_ls_files", sibling)).toBe("bound.txt\n");
    expect(await call(gitTools(), "router_git_ls_files", sibling)).toBe("bound.txt\n");
    const relative = gitTools({ resolveWorkRoot: () => "relative/dir" });
    expect(await call(relative, "router_git_ls_files", sibling)).toBe("[router_git] error: Bound work root is not an absolute path");
    const throwing = gitTools({ resolveWorkRoot: () => { throw new Error("binding lookup failed"); } });
    expect(await call(throwing, "router_git_ls_files", sibling)).toBe("[router_git] error: binding lookup failed");
  }, SPAWN_TIMEOUT);
});
