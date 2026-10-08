import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { gitEnvironment, gitExecutable, mainWorktree, nearestCheckout, spawnBounded, workRootGuards } from "../../src/router/git-tools";
import type { RunConfig } from "../../src/router/roles";
import {
  argAllowed, authorizeCwd, capRendered, dropLeadingPartial, escapesWorkRoot, isCredentialEnv, isFullPath, loadNpmIni, npmConfigPins, npmEnvReplace,
  npmHardeningFlags, optionLead, type WorkRootAnswer,
  planRun, readBoundedRegularFile, renderRunOutput, resolveCommandExecutable, resolveNodeExecutable, resolveNpmCli, resolveSystemShell, routerRunTool,
  runEnvironment, RUN_HEAD_BYTES, RUN_OUTPUT_BYTES, RUN_RENDERED_MAX_BYTES, RUN_STDERR_TAIL_BYTES, RUN_TAIL_BYTES, scriptAllowed, validateRunArgs,
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
  scripts: ["test", "typecheck", "lint", "build", "test:unit"], commands: {}, timeoutMs: 60_000, ...over,
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
function git(dir: string, ...args: string[]): string {
  return execFileSync(gitExecutable(), ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: dir, env: gitEnvironment(), encoding: "utf8" });
}
/** A role session bound to `dir` (the shared WorkRootAnswer, QA-P13-2-8). */
const bind = (dir: string | null): WorkRootAnswer => ({ role: true, root: dir });
function context(sessionID = "child", directory = root) {
  return { sessionID, messageID: "m", agent: "runner", directory, worktree: directory, abort: new AbortController().signal,
    metadata: () => undefined, ask: async () => undefined };
}
function makeTool(over: Partial<RunToolDeps> = {}, records: RunRecord[] = []) {
  const t = routerRunTool({ config: () => config(), resolveWorkRoot: () => bind(root), recordRun: e => { records.push(e); }, env: testEnv(), ...over });
  return (args: unknown, ctx = context()) => (t.execute as unknown as Execute)(args, ctx);
}

describe("router_run authority (P-10, I9)", () => {
  it("refuses an unbound or non-role session, fails closed on a malformed answer, and spawns nothing (QA-P13-2-8)", async () => {
    project(root);
    expect(await makeTool({ resolveWorkRoot: () => bind(null) })({ script: "test", cwd: root }))
      .toMatch(/^\[router_run\] error: refused: this session has no bound work root \(I9\)/);
    expect(await makeTool({ resolveWorkRoot: () => ({ role: false }) })({ script: "test", cwd: root }))
      .toBe("[router_run] error: refused: router_run is only available to role sessions (this session is not one)");
    for (const answer of [null, undefined, root, "", 42, {}, { role: true }, { role: "yes", root }]) {
      expect(await makeTool({ resolveWorkRoot: () => answer as unknown as WorkRootAnswer })({ script: "test", cwd: root }))
        .toBe("[router_run] error: Invalid work-root answer: expected { role: false } or { role: true, root }");
    }
    for (const relative of ["", "relative/dir", ...(WIN ? ["\\tmp", "C:tmp"] : [])]) {
      expect(await makeTool({ resolveWorkRoot: () => bind(relative) })({ script: "test", cwd: root })).toBe("[router_run] error: Bound work root is not an absolute path");
    }
    expect(await makeTool({ resolveWorkRoot: () => { throw new Error("lookup https://u:pw9@h/x failed"); } })({ script: "test", cwd: root })).not.toContain("pw9");
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
    const run = makeTool({ resolveWorkRoot: () => bind(sibling) });
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
  it("R9: matches script entries exactly; a trailing * is no prefix and a bare * matches nothing", () => {
    expect(scriptAllowed(["test", "test:unit"], "test")).toBe(true);
    expect(scriptAllowed(["test", "test:unit"], "test:unit")).toBe(true);
    expect(scriptAllowed(["test"], "test:unit")).toBe(false);
    expect(scriptAllowed(["test:*"], "test:unit")).toBe(false);
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
    const pins = { userconfig: argv[6]!.slice("--userconfig=".length), globalconfig: argv[7]!.slice("--globalconfig=".length) };
    expect(argv.slice(1, 8)).toEqual(npmHardeningFlags(argv[1]!.slice("--script-shell=".length), pins));
    expect(argv[1]).toMatch(WIN ? /^--script-shell=[A-Za-z]:\\.*\\cmd\.exe$/i : /^--script-shell=\//);
    expect(argv).toContain("--logs-max=0");
    expect(pins.userconfig.toLowerCase()).toBe(join(home, ".npmrc").toLowerCase());
    expect(argv.slice(8)).toEqual(["run", "test"]);
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
    // Wherever the stderr chunk arrived relative to stdout (on Linux often 100+ KB earlier), it is shown exactly once.
    expect(out.split("STDERR-END").length - 1).toBe(1);
    expect(out).toMatch(new RegExp(`\\[router_run\\] output truncated: \\d+ bytes omitted; showing at most the first ${RUN_HEAD_BYTES} and the last ${RUN_TAIL_BYTES} bytes, `
      + `plus the last ${RUN_STDERR_TAIL_BYTES} bytes of stderr when not shown \\(bound ${RUN_OUTPUT_BYTES} bytes\\)`));
    expect(RUN_HEAD_BYTES + RUN_TAIL_BYTES + RUN_STDERR_TAIL_BYTES).toBe(RUN_OUTPUT_BYTES);
    expect(Buffer.byteLength(out)).toBeLessThan(RUN_OUTPUT_BYTES + 1024);
  }, SPAWN_TIMEOUT);
  it("keeps the stderr tail when stderr arrived before the shown stdout tail (Linux pipe interleaving)", async () => {
    project(root);
    // Deterministic form of the CI interleaving: the merged stream holds stderr's last line in the middle,
    // behind more than the 16 KiB head of stdout and ahead of more than the 40 KiB tail of stdout.
    writeFileSync(join(root, "early.js"), [
      "process.stdout.write('first stdout\\n'.repeat(2000));",
      "setTimeout(() => process.stderr.write('FAILURE-SUMMARY: 3 failed\\n'), 300);",
      "setTimeout(() => process.stdout.write('later stdout\\n'.repeat(8000)), 600);",
    ].join("\n"));
    const records: RunRecord[] = [];
    const out = await makeTool({ config: () => config({ commands: { early: { argv: ["node", "early.js"] } } }) }, records)({ script: "early", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(out).toMatch(/\[router_run\] stderr tail \(last 26 bytes; stdout and stderr are separate pipes[^\n]*\nFAILURE-SUMMARY: 3 failed\n$/);
    expect(out.split("FAILURE-SUMMARY").length - 1).toBe(1);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(RUN_RENDERED_MAX_BYTES + 200);
    // stderr written last and delivered last is already in the merged tail: no duplicate section.
    writeFileSync(join(root, "late.js"), "process.stdout.write('stdout line\\n'.repeat(20000)); setTimeout(() => process.stderr.write('LATE-STDERR\\n'), 300);");
    const late = await makeTool({ config: () => config({ commands: { late: { argv: ["node", "late.js"] } } }) })({ script: "late", cwd: root });
    expect(late.split("LATE-STDERR").length - 1).toBe(1);
    expect(late).not.toContain("[router_run] stderr tail");
  }, SPAWN_TIMEOUT);
  it("renders the stderr tail bounded and redacted, never a credential cut at its start", () => {
    const base = { output: Buffer.from("head\n"), truncated: true, omitted: 100, tail: Buffer.from("x\nmerged tail\n") };
    const cut = renderRunOutput({ ...base, stderrTail: Buffer.from("ob:hunter2secret@host/x\nlast https://u:pw9@h/y\n"), stderrTotal: 9000 });
    for (const fragment of ["hunter2", "secret", "pw9"]) expect(cut).not.toContain(fragment);
    expect(cut).toMatch(/\[router_run\] stderr tail \(last \d+ bytes;[^\n]*\nlast https:\/\/h\/y\n$/);
    // Whole stderr kept (total = window): nothing dropped at its start.
    expect(renderRunOutput({ ...base, stderrTail: Buffer.from("only line"), stderrTotal: 9 })).toMatch(/\nonly line\n$/);
    // Already shown, empty, or nothing omitted: no section.
    expect(renderRunOutput({ ...base, stderrTail: Buffer.from("merged tail\n"), stderrTotal: 12 })).not.toContain("stderr tail");
    expect(renderRunOutput({ ...base, stderrTail: Buffer.from(" \n"), stderrTotal: 2 })).not.toContain("stderr tail");
    expect(renderRunOutput({ ...base, omitted: 0, stderrTail: Buffer.from("e\n"), stderrTotal: 2 })).not.toContain("stderr tail");
    expect(renderRunOutput({ ...base, stderrTail: Buffer.alloc(0), stderrTotal: 0 })).not.toContain("stderr tail");
  });
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

  it("ignores a repo .npmrc script-shell and node-options (npm config get as the positive control)", async () => {
    project(root); plantEvil(root);
    writeFileSync(join(root, ".npmrc"), WIN ? "script-shell=.\\evil.cmd\r\nnode-options=--require ./evil.js\r\n"
      : "script-shell=./evil.sh\nnode-options=--require ./evil.js\n");
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    const flags = planned.argv.slice(1, 6);
    const get = (extra: string[], key: string) => execFileSync(planned.executable, [planned.argv[0]!, ...extra, "config", "get", key],
      { cwd: root, env: planned.env, encoding: "utf8", windowsHide: true }).trim();
    // Without the flags npm resolves the repository's values: the attack is real on this npm.
    expect(get([], "script-shell")).toMatch(/evil\.(cmd|sh)$/);
    expect(get([], "node-options")).toMatch(/evil\.js/);
    // With the flags the command line wins.
    expect(get(flags, "script-shell")).toBe(flags[0]!.slice("--script-shell=".length));
    expect(get(flags, "node-options")).not.toMatch(/evil/);
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
  it("drops inherited npm_config_*, NODE_OPTIONS and PREFIX: planted userconfig and PREFIX/etc/npmrc, with positive controls", async () => {
    project(root); plantEvil(root);
    const evilJs = join(root, "evil.js").replaceAll("\\", "/");
    const userrc = join(sibling, "user.npmrc");
    writeFileSync(userrc, `node-options=--require ${evilJs}\n`);
    const prefix = join(sibling, "prefix");
    mkdirSync(join(prefix, "etc"), { recursive: true });
    writeFileSync(join(prefix, "etc", "npmrc"), `node-options=--require ${evilJs}\n`);
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    // The worker inherits npm_config_* from `npx vitest`; controls start from a base without them.
    const clean = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
      ...Object.fromEntries(Object.entries(testEnv()).filter(([key]) => !/^(npm_|NODE_OPTIONS$|PREFIX$)/i.test(key))), ...extra });
    const rawRun = (env: NodeJS.ProcessEnv) => execFileSync(planned.executable, [planned.argv[0]!, "run", "test"], { cwd: root, env, stdio: "ignore", windowsHide: true });
    // Controls: plain npm (no flags, environment as given) honours each planted file.
    rawRun(clean({ npm_config_userconfig: userrc }));
    expect(markers(root)).toEqual(["node-marker.txt"]);
    rmSync(join(root, "node-marker.txt"));
    rawRun(clean({ npm_config_globalconfig: join(prefix, "etc", "npmrc") }));
    expect(markers(root)).toEqual(["node-marker.txt"]);
    rmSync(join(root, "node-marker.txt"));
    // PREFIX names the global config only where this npm honours it (`config get globalconfig` decides; not on win32 npm 11).
    const globalconfig = execFileSync(planned.executable, [planned.argv[0]!, "config", "get", "globalconfig"],
      { cwd: root, env: clean({ PREFIX: prefix }), encoding: "utf8", windowsHide: true }).trim();
    if (globalconfig.toLowerCase() === join(prefix, "etc", "npmrc").toLowerCase()) {
      rawRun(clean({ PREFIX: prefix }));
      expect(markers(root)).toEqual(["node-marker.txt"]);
      rmSync(join(root, "node-marker.txt"));
    }
    const evilShell = join(root, WIN ? "evil.cmd" : "evil.sh");
    const env = testEnv({ npm_config_script_shell: evilShell, NPM_CONFIG_NODE_OPTIONS: `--require ${evilJs}`,
      NODE_OPTIONS: `--require ${evilJs}`, npm_config_userconfig: userrc, PREFIX: prefix });
    const out = await makeTool({ env })({ script: "test", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(markers(root)).toEqual([]);
    const hardened = runEnvironment({ Path: "p", npm_config_x: "1", NPM_CONFIG_Y: "2", Npm_Lifecycle_Event: "z", node_options: "n", NODE_OPTIONS: "n", ci: "0", COMSPEC: "x" }, "win32", "C:\\Windows\\System32\\cmd.exe");
    expect(hardened).toEqual({ Path: "", CI: "1", NoDefaultCurrentDirectoryInExePath: "1", ComSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(runEnvironment({ PATH: "p", ci: "0" }, "linux")).toEqual({ PATH: "", ci: "0", CI: "1" });
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
    expect(npmCommand.argv.slice(1, 6)).toEqual(plan.argv.slice(1, 6));
    expect(npmCommand.argv[6]).toMatch(/^--userconfig=/);
    expect(npmCommand.argv[7]).toMatch(/^--globalconfig=/);
    expect(npmCommand.argv.slice(8)).toEqual(["run", "test", "--", "test/a.ts"]);
  });
});

/** Run `fn` while process.execPath names `value` (a Bun-style runtime path); synchronous callers only. */
function withExecPath<T>(value: string, fn: () => T): T {
  const original = process.execPath;
  process.execPath = value;
  try { return fn(); } finally { process.execPath = original; }
}
const NODE_NAME = WIN ? "node.exe" : "node";
const SEP = WIN ? ";" : ":";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
async function waitUntil(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  return check();
}
const hostOf = (env: NodeJS.ProcessEnv, extra: { nodeExecPath?: string } = {}) => ({ platform: process.platform, env, ...extra });

describe("router_run timeout, abort and signals", () => {
  const hangTree = [
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['-e', \"require('fs').writeFileSync('grand.pid', String(process.pid)); console.log('grandchild-up'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "console.log('parent-started'); setInterval(() => {}, 1000);",
  ].join("\n");

  it("kills a hanging grandchild on timeout, keeps the partial output and reports exit null", async () => {
    project(root);
    writeFileSync(join(root, "hangtree.js"), hangTree);
    const records: RunRecord[] = [];
    const run = makeTool({ config: () => config({ timeoutMs: 8_000, commands: { tree: { argv: ["node", "hangtree.js"] } } }) }, records);
    const out = await run({ script: "tree", cwd: root });
    expect(out).toMatch(/^\[router_run\] command "tree": timed out after 8000 ms, process tree killed; exit code: none/);
    expect(out).toContain("parent-started");
    expect(records.map(r => r.exitCode)).toEqual([null]);
    expect(existsSync(join(root, "grand.pid"))).toBe(true);
    const pid = Number(readFileSync(join(root, "grand.pid"), "utf8"));
    expect(await waitUntil(() => !alive(pid))).toBe(true);
  }, SPAWN_TIMEOUT);

  it("aborts a running process tree through context.abort and records a null exit", async () => {
    project(root);
    writeFileSync(join(root, "hangtree.js"), hangTree);
    const records: RunRecord[] = [];
    const run = makeTool({ config: () => config({ timeoutMs: 60_000, commands: { tree: { argv: ["node", "hangtree.js"] } } }) }, records);
    const controller = new AbortController();
    const pending = run({ script: "tree", cwd: root }, { ...context(), abort: controller.signal });
    expect(await waitUntil(() => existsSync(join(root, "grand.pid")))).toBe(true);
    controller.abort();
    const out = await pending;
    expect(out).toMatch(/^\[router_run\] command "tree": aborted, process tree killed; exit code: none/);
    expect(records.map(r => r.exitCode)).toEqual([null]);
    const pid = Number(readFileSync(join(root, "grand.pid"), "utf8"));
    expect(await waitUntil(() => !alive(pid))).toBe(true);
  }, SPAWN_TIMEOUT);

  it("spawns nothing for an already-aborted signal and records nothing", async () => {
    project(root);
    const records: RunRecord[] = [];
    const controller = new AbortController();
    controller.abort();
    const out = await makeTool({}, records)({ script: "test", cwd: root }, { ...context(), abort: controller.signal });
    expect(out).toBe("[router_run] error: router_run aborted");
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  }, SPAWN_TIMEOUT);

  it.skipIf(WIN)("reports a process killed by a signal as having no exit code", async () => {
    project(root);
    writeFileSync(join(root, "selfkill.js"), "console.log('about to die'); process.kill(process.pid, 'SIGKILL');");
    const records: RunRecord[] = [];
    const out = await makeTool({ config: () => config({ commands: { die: { argv: ["node", "selfkill.js"] } } }) }, records)({ script: "die", cwd: root });
    expect(out).toMatch(/exit code: none \(killed by a signal\)/);
    expect(records.map(r => r.exitCode)).toEqual([null]);
  }, SPAWN_TIMEOUT);
});

describe("router_run work roots", () => {
  it("runs in a work root whose path contains spaces", async () => {
    const spaced = join(sibling, "work root with spaces");
    mkdirSync(spaced);
    project(spaced);
    const records: RunRecord[] = [];
    const out = await makeTool({ resolveWorkRoot: () => bind(spaced) }, records)({ script: "test", cwd: spaced });
    expect(out).toMatch(/exit code: 0/);
    expect(JSON.parse(readFileSync(join(spaced, "ran.json"), "utf8")).cwd.toLowerCase()).toBe(realpathSync.native(spaced).toLowerCase());
    expect(records.map(r => r.exitCode)).toEqual([0]);
  }, SPAWN_TIMEOUT);

  it("canonicalises a symlink or junction cwd to the bound root and refuses one pointing elsewhere", async () => {
    project(root); project(sibling);
    const link = join(home, "link-to-root");
    const foreign = join(home, "link-to-sibling");
    symlinkSync(root, link, WIN ? "junction" : "dir");
    symlinkSync(sibling, foreign, WIN ? "junction" : "dir");
    expect(authorizeCwd(root, link)).toBe(root);
    expect(authorizeCwd(link, root)).toBe(root);
    expect(authorizeCwd(link, link)).toBe(root);
    expect(() => authorizeCwd(root, foreign)).toThrow(/cwd is not this dispatch's work root/);
    const run = makeTool();
    expect(await run({ script: "test", cwd: link })).toMatch(/exit code: 0/);
    expect(JSON.parse(readFileSync(join(root, "ran.json"), "utf8")).cwd.toLowerCase()).toBe(root.toLowerCase());
    expect(await run({ script: "test", cwd: foreign })).toMatch(/refused: cwd is not this dispatch's work root/);
    expect(existsSync(join(sibling, "ran.json"))).toBe(false);
  }, SPAWN_TIMEOUT);

  it.skipIf(!WIN)("expands an 8.3 short-name cwd to the canonical work root", async (ctx) => {
    const long = join(sibling, "a rather long directory name");
    mkdirSync(long);
    project(long);
    const short = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long}').ShortPath`], { encoding: "utf8", windowsHide: true }).trim();
    if (short === "" || short.toLowerCase() === long.toLowerCase() || !short.includes("~")) ctx.skip("8.3 names are disabled on this volume");
    expect(authorizeCwd(long, short)).toBe(realpathSync.native(long));
    expect(authorizeCwd(short, long)).toBe(realpathSync.native(long));
    expect(await makeTool({ resolveWorkRoot: () => bind(long) })({ script: "test", cwd: short })).toMatch(/exit code: 0/);
  }, SPAWN_TIMEOUT);

  it("refuses a bound root that is missing, a file or relative, and a case-variant cwd only on win32", () => {
    writeFileSync(join(root, "file.txt"), "x");
    expect(() => authorizeCwd(join(root, "nope"), root)).toThrow(/bound work root does not exist/);
    expect(() => authorizeCwd(join(root, "file.txt"), root)).toThrow(/bound work root does not exist/);
    expect(() => authorizeCwd(root, 42)).toThrow(/cwd must be the absolute path/);
    expect(isFullPath("/usr/bin", "linux")).toBe(true);
    expect(isFullPath("usr/bin", "linux")).toBe(false);
    expect(isFullPath("C:\\a", "win32")).toBe(true);
    expect(isFullPath("C:/a", "win32")).toBe(true);
    expect(isFullPath("\\\\host\\share\\a", "win32")).toBe(true);
    expect(isFullPath("\\a", "win32")).toBe(false);
    expect(isFullPath("C:a", "win32")).toBe(false);
    expect(isFullPath("/a", "win32")).toBe(false);
  });
});

describe("router_run tool boundary", () => {
  it("reports schema violations as errors and spawns nothing", async () => {
    project(root);
    const run = makeTool();
    expect(await run({ script: "test", cwd: root, extra: 1 })).toMatch(/^\[router_run\] error: /);
    expect(await run({ script: "test", cwd: root, args: [5] })).toMatch(/^\[router_run\] error: /);
    expect(await run({ script: "x".repeat(201), cwd: root })).toMatch(/^\[router_run\] error: /);
    expect(await run(undefined)).toMatch(/refused: cwd must be the absolute path/);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
  it("does not call recordRun on a refusal and calls it with the exit code on success", async () => {
    project(root);
    const records: RunRecord[] = [];
    const run = makeTool({ config: () => config({ commands: { ok: { argv: ["node", "probe.js", "exit", "0"] }, bad: { argv: ["node", "probe.js", "exit", "9"] } } }) }, records);
    expect(await run({ script: "deploy", cwd: root })).toMatch(/refused/);
    expect(await run({ script: "ok", cwd: sibling })).toMatch(/refused/);
    expect(records).toEqual([]);
    expect(await run({ script: "ok", cwd: root })).toMatch(/exit code: 0/);
    expect(await run({ script: "bad", cwd: root })).toMatch(/exit code: 9/);
    expect(records).toEqual([
      { sessionID: "child", script: "ok", exitCode: 0, at: expect.any(Number) },
      { sessionID: "child", script: "bad", exitCode: 9, at: expect.any(Number) },
    ]);
    expect(records[0]!.at).toBeLessThanOrEqual(records[1]!.at);
  }, SPAWN_TIMEOUT);
  it("uses the process environment when none is injected and honours the node seam", async () => {
    project(root);
    const config1 = () => config({ commands: { probe: { argv: ["node", "probe.js", "hello"] } } });
    expect(await makeTool({ env: undefined, config: config1 })({ script: "probe", cwd: root })).toContain("PROBE-OK hello");
    expect(await makeTool({ nodeExecPath: process.execPath, config: config1 })({ script: "probe", cwd: root })).toContain("PROBE-OK hello");
    expect(await makeTool({ nodeExecPath: join(sibling, "no-such-node"), config: config1 })({ script: "probe", cwd: root })).toMatch(/refused: node executable is not an absolute path to a file/);
  }, SPAWN_TIMEOUT);
});

describe("router_run plan validation", () => {
  const plan = (script: string, cfg: Partial<RunConfig>, args?: string[]) =>
    planRun({ script, args, cwd: root }, root, config(cfg), hostOf(testEnv()));

  it("refuses malformed command argv", () => {
    for (const argv of [[], [""], ["node", ""], [1], "node", null, undefined]) {
      expect(() => plan("c", { commands: { c: { argv } as never } })).toThrow(/has no valid argv/);
    }
    for (const bad of ["a\0b", "a\nb", "a\rb"]) {
      expect(() => plan("c", { commands: { c: { argv: ["node", bad] } } })).toThrow(/without NUL or line breaks/);
    }
    expect(() => plan("-x", {})).toThrow(/invalid entry name/);
    expect(() => planRun({ script: 5 as never, cwd: root }, root, config(), hostOf(testEnv()))).toThrow(/invalid entry name/);
  });
  it("lets commands win over scripts of the same name and plans a node command with declared args", () => {
    project(root);
    const planned = plan("test", { commands: { test: { argv: ["node", "probe.js", "--flag"], args: ["a/*"] } } }, ["a/b"]);
    expect(planned.kind).toBe("command");
    expect(planned.argv).toEqual(["probe.js", "--flag", "a/b"]);
    expect(planned.cwd).toBe(root);
    expect(planned.env.CI).toBe("1");
  });
  it("validates package.json: size, BOM, JSON, scripts shape", () => {
    const set = (text: string) => writeFileSync(join(root, "package.json"), text);
    expect(() => plan("test", {})).toThrow(/no readable package\.json/);
    set("{ not json"); expect(() => plan("test", {})).toThrow(/no readable package\.json/);
    set(" ".repeat(4 * 1024 * 1024 + 1)); expect(() => plan("test", {})).toThrow(/larger than 4 MiB/);
    for (const text of ["null", "[]", "5", "{}", '{"scripts":null}', '{"scripts":5}', '{"scripts":{"test":5}}', '{"scripts":{"other":"x"}}']) {
      set(text); expect(() => plan("test", {})).toThrow(/package\.json has no script "test"/);
    }
    set('\uFEFF{"scripts":{"test":"node x.js"}}');
    expect(plan("test", {}).argv.slice(-2)).toEqual(["run", "test"]);
  });
  it("uses the default timeout when none is configured and tolerates a missing commands map", () => {
    project(root);
    const cfg = { scripts: ["test"] } as unknown as RunConfig;
    expect(planRun({ script: "test", cwd: root }, root, cfg, hostOf(testEnv())).timeoutMs).toBe(600_000);
    expect(() => planRun({ script: "other", cwd: root }, root, { } as unknown as RunConfig, hostOf(testEnv()))).toThrow(/not in routing\.run/);
    for (const ms of [0, -5, Number.NaN, "5" as never]) expect(plan("test", { timeoutMs: ms }).timeoutMs).toBe(600_000);
    expect(plan("test", { timeoutMs: 1500.9 }).timeoutMs).toBe(1500);
  });
  it("plans an absolute-path executable command and refuses missing, inside-root and shell targets", () => {
    const tool = join(sibling, WIN ? "mytool.exe" : "mytool");
    writeFileSync(tool, "");
    const planned = plan("abs", { commands: { abs: { argv: [tool, "--x"] } } });
    expect(planned.executable.toLowerCase()).toBe(realpathSync.native(tool).toLowerCase());
    expect(planned.argv).toEqual(["--x"]);
    expect(() => plan("abs", { commands: { abs: { argv: [join(sibling, "missing.exe")] } } })).toThrow(/command executable not found/);
    const inside = join(root, WIN ? "inner.exe" : "inner");
    writeFileSync(inside, "");
    expect(() => plan("abs", { commands: { abs: { argv: [inside] } } })).toThrow(/inside the work root/);
    if (WIN) {
      writeFileSync(join(sibling, "data.txt"), "");
      expect(() => plan("abs", { commands: { abs: { argv: [join(sibling, "data.txt")] } } })).toThrow(/\.exe or \.com/);
      expect(() => plan("abs", { commands: { abs: { argv: [join(sibling, "x.cmd")] } } })).toThrow(/\.exe or \.com/);
    }
    expect(() => plan("abs", { commands: { abs: { argv: ["nonexistent-tool-xyz"] } } })).toThrow(/not found on an absolute PATH entry/);
  });
  it("runs an absolute-path executable command through router_run", async () => {
    const copy = join(sibling, WIN ? "copied-node.exe" : "copied-node");
    copyFileSync(process.execPath, copy);
    if (!WIN) chmodSync(copy, 0o755);
    const out = await makeTool({ config: () => config({ commands: { ver: { argv: [copy, "--version"] } } }) })({ script: "ver", cwd: root });
    expect(out).toMatch(/command "ver": exit code: 0/);
    expect(out).toContain(process.version);
  }, SPAWN_TIMEOUT);
});

describe("router_run node and npm lookup", () => {
  function fakeBunLayout() {
    const bunDir = join(home, "bun-node-1a2b3c");
    const other = join(home, "other-bin");
    mkdirSync(bunDir); mkdirSync(other);
    const bun = join(bunDir, WIN ? "bun.exe" : "bun");
    writeFileSync(bun, "");
    return { bunDir, other, bun };
  }
  it("under a Bun-style runtime skips Bun's temporary node link and picks the PATH node", () => {
    const { bunDir, other, bun } = fakeBunLayout();
    const real = join(other, NODE_NAME);
    writeFileSync(real, "");
    const env = { PATH: [`"${bunDir}"`, "", "relative/bin", `"${other}"`].join(SEP) } as NodeJS.ProcessEnv;
    withExecPath(bun, () => {
      expect(resolveNodeExecutable(hostOf(env), [root]).toLowerCase()).toBe(realpathSync.native(real).toLowerCase());
    });
  });
  it("skips a PATH node that is the runtime's own hard link, and reports when none remains", () => {
    const { bunDir, other, bun } = fakeBunLayout();
    linkSync(bun, join(other, NODE_NAME));
    const env = { PATH: `${bunDir}${SEP}${other}` } as NodeJS.ProcessEnv;
    withExecPath(bun, () => {
      expect(() => resolveNodeExecutable(hostOf(env), [root])).toThrow(/node executable not found/);
      expect(() => resolveNodeExecutable(hostOf({}), [root])).toThrow(/node executable not found/);
    });
  });
  it.skipIf(WIN)("skips a PATH node that resolves to bun", () => {
    const { other, bun } = fakeBunLayout();
    symlinkSync(bun, join(other, "node"));
    withExecPath(bun, () => {
      expect(() => resolveNodeExecutable(hostOf({ PATH: other } as NodeJS.ProcessEnv), [root])).toThrow(/node executable not found/);
    });
  });
  it("refuses a Bun-style PATH whose only node is inside the work root, and falls through to a later one", () => {
    const { bun, other } = fakeBunLayout();
    const inside = join(root, "bin");
    mkdirSync(inside);
    writeFileSync(join(inside, NODE_NAME), "");
    const onlyInside = { PATH: inside } as NodeJS.ProcessEnv;
    withExecPath(bun, () => {
      expect(() => resolveNodeExecutable(hostOf(onlyInside), [root])).toThrow(/refusing a node executable inside the work root/);
      writeFileSync(join(other, NODE_NAME), "");
      const both = { PATH: `${inside}${SEP}${other}` } as NodeJS.ProcessEnv;
      expect(resolveNodeExecutable(hostOf(both), [root]).toLowerCase()).toBe(realpathSync.native(join(other, NODE_NAME)).toLowerCase());
    });
  });
  it("accepts the node seam only as an absolute file outside the work root", () => {
    expect(() => resolveNodeExecutable(hostOf({}, { nodeExecPath: "node" }), [root])).toThrow(/not an absolute path to a file/);
    expect(() => resolveNodeExecutable(hostOf({}, { nodeExecPath: join(sibling, "missing") }), [root])).toThrow(/not an absolute path to a file/);
    // Returned as found, not as its real path (a version-manager directory link stays as given, QA-P13-1-3).
    expect(resolveNodeExecutable(hostOf({}, { nodeExecPath: process.execPath }), [root])).toBe(process.execPath);
  });
  it("finds npm-cli.js beside node, and refuses a missing or in-root one", () => {
    const prefix = join(sibling, "prefix");
    mkdirSync(join(prefix, "node_modules", "npm", "bin"), { recursive: true });
    const node = join(prefix, NODE_NAME);
    writeFileSync(node, "");
    expect(() => resolveNpmCli(node, process.platform, [root])).toThrow(/npm-cli\.js not found/);
    const cli = join(prefix, "node_modules", "npm", "bin", "npm-cli.js");
    writeFileSync(cli, "");
    expect(resolveNpmCli(node, process.platform, [root]).toLowerCase()).toBe(realpathSync.native(cli).toLowerCase());
    expect(() => resolveNpmCli(node, process.platform, [prefix])).toThrow(/refusing npm-cli\.js inside the work root/);
  });
  it.skipIf(WIN)("finds npm-cli.js under ../lib/node_modules/npm on POSIX layouts", () => {
    const prefix = join(sibling, "prefix");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "lib", "node_modules", "npm", "bin"), { recursive: true });
    const node = join(prefix, "bin", "node");
    const cli = join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    writeFileSync(node, ""); writeFileSync(cli, "");
    expect(resolveNpmCli(node, "linux", [root])).toBe(realpathSync.native(cli));
  });
  it("treats the platform seam as POSIX when asked: /bin/sh only", () => {
    if (WIN) expect(() => resolveSystemShell({ platform: "linux", env: {} }, [root])).toThrow(/no absolute system shell/);
    else expect(resolveSystemShell({ platform: "linux", env: {} }, [root])).toBe("/bin/sh");
    expect(() => resolveNpmCli("/nonexistent/bin/node", "linux", [root])).toThrow(/npm-cli\.js not found/);
  });
});

describe("router_run system shell and ComSpec", () => {
  it.skipIf(WIN)("pins /bin/sh as npm's script shell, never a repo .npmrc script-shell (evil.sh)", async () => {
    project(root);
    writeFileSync(join(root, "evil.sh"), "#!/bin/sh\necho evil > \"$(dirname \"$0\")/shell-marker.txt\"\n");
    chmodSync(join(root, "evil.sh"), 0o755);
    writeFileSync(join(root, ".npmrc"), "script-shell=./evil.sh\n");
    expect(resolveSystemShell(hostOf({}), [root])).toBe("/bin/sh"); // as found, never its realpath (busybox, bash's sh mode)
    expect(await makeTool()({ script: "test", cwd: root })).toMatch(/exit code: 0/);
    expect(existsSync(join(root, "shell-marker.txt"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "ran.json"), "utf8")).shell).toBe("/bin/sh");
  }, SPAWN_TIMEOUT);

  describe.skipIf(!WIN)("win32 ComSpec", () => {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    it("uses a valid ComSpec, falls back to System32 cmd.exe for a relative or in-root one", () => {
      const real = realpathSync.native(system32).toLowerCase();
      expect(resolveSystemShell(hostOf({ ComSpec: system32 }), [root]).toLowerCase()).toBe(real);
      expect(resolveSystemShell(hostOf({ ComSpec: "cmd.exe" }), [root]).toLowerCase()).toBe(real);
      expect(resolveSystemShell(hostOf({ ComSpec: "..\\evil\\cmd.exe" }), [root]).toLowerCase()).toBe(real);
      expect(resolveSystemShell(hostOf({}), [root]).toLowerCase()).toBe(real);
      const planted = join(root, "cmd.exe");
      writeFileSync(planted, "");
      expect(resolveSystemShell(hostOf({ ComSpec: planted }), [root]).toLowerCase()).toBe(real);
    });
    it("refuses when every candidate is relative, missing or inside the work root", () => {
      const fakeRoot = join(root, "fake-windows");
      mkdirSync(join(fakeRoot, "System32"), { recursive: true });
      writeFileSync(join(fakeRoot, "System32", "cmd.exe"), "");
      const env = { SystemRoot: fakeRoot, ComSpec: "cmd.exe" } as NodeJS.ProcessEnv;
      expect(() => resolveSystemShell(hostOf(env), [root])).toThrow(/no absolute system shell/);
      expect(() => resolveSystemShell(hostOf({ SystemRoot: join(sibling, "none") }), [root])).toThrow(/no absolute system shell/);
    });
    it("plans a validated ComSpec into the run environment, and tolerates no shell for a plain command", () => {
      const tool = join(sibling, "plain.exe");
      writeFileSync(tool, "");
      const cfg = config({ commands: { plain: { argv: [tool] } } });
      const ok = planRun({ script: "plain", cwd: root }, root, cfg, hostOf(testEnv({ ComSpec: "cmd.exe" })));
      expect(ok.env.ComSpec?.toLowerCase()).toBe(realpathSync.native(system32).toLowerCase());
      const fakeRoot = join(root, "fake-windows");
      mkdirSync(join(fakeRoot, "System32"), { recursive: true });
      writeFileSync(join(fakeRoot, "System32", "cmd.exe"), "");
      const noShellEnv = Object.fromEntries(Object.entries(testEnv()).filter(([key]) => !/^(SystemRoot|ComSpec)$/i.test(key)));
      const none = planRun({ script: "plain", cwd: root }, root, cfg, hostOf({ ...noShellEnv, SystemRoot: fakeRoot, ComSpec: "cmd.exe" }));
      expect(none.executable.toLowerCase()).toBe(realpathSync.native(tool).toLowerCase());
      project(root);
      const npmPlan = () => planRun({ script: "n", cwd: root }, root, config({ commands: { n: { argv: ["npm", "test"] } } }), hostOf({ ...noShellEnv, SystemRoot: fakeRoot, ComSpec: "cmd.exe" }));
      expect(npmPlan).toThrow(/no absolute system shell/);
    });
  });
});

describe("router_run command resolution on POSIX paths (platform seam)", () => {
  it("resolves bare names only from absolute PATH entries and refuses shells and shims by stem", () => {
    const posix = (env: NodeJS.ProcessEnv) => ({ platform: "linux" as const, env });
    expect(() => resolveCommandExecutable("tool", posix({ PATH: "/nonexistent-dir-a:relative" }), [root])).toThrow(/not found on an absolute PATH entry/);
    expect(() => resolveCommandExecutable("/usr/bin/bash", posix({}), [root])).toThrow(/is a shell/);
    expect(() => resolveCommandExecutable("/opt/yarn", posix({}), [root])).toThrow(/reads repository configuration/);
    expect(() => resolveCommandExecutable("rel/tool", posix({}), [root])).toThrow(/absolute or a bare name/);
    expect(() => resolveCommandExecutable("/nonexistent/tool", posix({}), [root])).toThrow(/command executable not found/);
    expect(() => resolveCommandExecutable("tool.cmd", posix({ PATH: "/nonexistent" }), [root])).not.toThrow(/\.exe or \.com/);
  });
  it.skipIf(WIN)("resolves a real bare-name tool on POSIX and refuses one inside the work root", () => {
    const dir = join(sibling, "bin");
    mkdirSync(dir);
    writeFileSync(join(dir, "mytool"), "");
    expect(resolveCommandExecutable("mytool", hostOf({ PATH: `"${dir}"` }), [root])).toBe(realpathSync.native(join(dir, "mytool")));
    expect(() => resolveCommandExecutable("mytool", hostOf({ PATH: dir }), [dir])).toThrow(/inside the work root/);
  });
});

describe("spawnBounded tail mode", () => {
  const script = (lines: number) => `let s=''; for (let i=0;i<${lines};i++) s += 'L'+String(i).padStart(5,'0')+'\\n'; process.stdout.write(s);`;
  const full = (lines: number) => Array.from({ length: lines }, (_, i) => `L${String(i).padStart(5, "0")}\n`).join("");

  it("keeps the first maxBytes, a rolling window of the last tailBytes and counts the omitted middle", async () => {
    const lines = 5000, total = full(lines);
    const result = await spawnBounded(process.execPath, ["-e", script(lines)], root, { env: process.env, maxBytes: 1000, tailBytes: 500, timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.output.toString()).toBe(total.slice(0, 1000));
    expect(result.tail!.toString()).toBe(total.slice(total.length - 500));
    expect(result.omitted).toBe(total.length - 1000 - 500);
    expect(result.failure).toBeUndefined();
    const text = renderRunOutput(result);
    expect(text).toContain(`[router_run] output truncated: ${total.length - 1500} bytes omitted;`);
    expect(text.endsWith(total.slice(total.length - 400))).toBe(true);
  }, SPAWN_TIMEOUT);
  it("reports no omission when the output fits the head and tail", async () => {
    const result = await spawnBounded(process.execPath, ["-e", "process.stdout.write('abc\\n'); process.stderr.write('def\\n')"], root,
      { env: process.env, maxBytes: 1000, tailBytes: 500, mergeStderr: true, timeoutMs: 60_000 });
    expect(result.truncated).toBe(false);
    expect(result.tail!.length).toBe(0);
    expect(result.omitted).toBe(0);
    expect(result.output.toString().replace(/\r/g, "").split("\n").filter(Boolean).sort()).toEqual(["abc", "def"]);
    expect(renderRunOutput(result)).toMatch(/^abc|def/);
    expect(result.stderr.length).toBe(0);
  }, SPAWN_TIMEOUT);
  it("keeps a separate rolling stderr tail when stderr is merged (stderrTailBytes)", async () => {
    const script = "process.stderr.write('E'.repeat(300) + 'ERR-LAST\\n'); setTimeout(() => process.stdout.write('o'.repeat(100000)), 300);";
    const result = await spawnBounded(process.execPath, ["-e", script], root,
      { env: process.env, maxBytes: 1000, tailBytes: 500, mergeStderr: true, stderrTailBytes: 64, timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    expect(result.tail!.toString()).toBe("o".repeat(500)); // the merged tail lost the stderr line
    expect(result.stderrTail!.toString()).toBe(`${"E".repeat(55)}ERR-LAST\n`);
    expect(result.stderrTotal).toBe(309);
    const plain = await spawnBounded(process.execPath, ["-e", "process.stderr.write('x')"], root, { env: process.env, mergeStderr: true, timeoutMs: 60_000 });
    expect(plain.stderrTail).toBeUndefined();
    const separate = await spawnBounded(process.execPath, ["-e", "process.stderr.write('y')"], root, { env: process.env, stderrTailBytes: 8, timeoutMs: 60_000 });
    expect(separate.stderrTail).toBeUndefined(); // only with mergeStderr; router_git keeps its separate stderr (I1)
    expect(separate.stderr.toString()).toBe("y");
  }, SPAWN_TIMEOUT);
  it("settles on failure with partial output instead of rejecting, and rejects without settleOnFailure", async () => {
    const hang = "console.log('partial'); setInterval(() => {}, 1000);";
    const settled = await spawnBounded(process.execPath, ["-e", hang], root, { env: process.env, timeoutMs: 1_500, tailBytes: 100, settleOnFailure: true, label: { message: "router_run", tag: "router_run", program: "the run" } });
    expect(settled.failure).toBe("router_run timed out");
    expect(settled.output.toString()).toContain("partial");
    await expect(spawnBounded(process.execPath, ["-e", hang], root, { env: process.env, timeoutMs: 1_500 })).rejects.toThrow(/Git inspection timed out/);
    await expect(spawnBounded(process.execPath, ["-e", "1"], join(root, "missing"), { env: process.env })).rejects.toThrow(/directory does not exist/);
  }, SPAWN_TIMEOUT);
});

describe("router_run output rendering edge cases", () => {
  it("renders every truncation shape", () => {
    const out = (o: Partial<Parameters<typeof renderRunOutput>[0]>) => renderRunOutput({ output: Buffer.from(""), truncated: false, ...o });
    expect(out({ output: Buffer.from("plain\n") })).toBe("plain\n");
    expect(out({ output: Buffer.from("a"), tail: Buffer.from("b"), omitted: 0, truncated: true })).toBe("ab");
    const noTail = out({ output: Buffer.from("head-without-newline"), truncated: true });
    expect(noTail).toMatch(/^head-without-newline\n\[router_run\] output truncated: showing at most/);
    expect(noTail.endsWith("\n")).toBe(true);
    const emptyHead = out({ output: Buffer.from(""), truncated: true, omitted: 3, tail: Buffer.from("x\ny\n") });
    expect(emptyHead.startsWith("[router_run] output truncated: 3 bytes omitted;")).toBe(true);
    expect(emptyHead.endsWith("y\n")).toBe(true);
  });
  it("caps the decoded text when invalid UTF-8 expands to U+FFFD (QA-P13-1-13)", () => {
    const tail = Buffer.concat([Buffer.from("\n"), Buffer.alloc(RUN_TAIL_BYTES - 1, 0xff)]);
    const invalid = renderRunOutput({ output: Buffer.alloc(RUN_HEAD_BYTES, 0xff), truncated: true, omitted: 10, tail });
    expect(Buffer.byteLength(invalid)).toBeLessThanOrEqual(RUN_RENDERED_MAX_BYTES);
    expect(invalid).toContain("[router_run] rendered output capped at");
    expect(capRendered("short")).toBe("short");
    const capped = capRendered(`ok https://bob:${"p".repeat(200)}`, 60);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(60 + 200); // the notice may exceed a tiny cap
    expect(capped).not.toContain("bob:");
  });
});

describe("QA-P13-1-1 argument confinement", () => {
  it("refuses .. segments and absolute or drive paths, also after = or an option lead", () => {
    for (const arg of ["test/../../x/scripts/x.js", "..", "../x", "a/..", "--out=../x", "--out=/etc/x", "/abs", "\\abs", "C:/x", "c:x",
      "@/etc/passwd", "--config=C:/x", "-/x", "+/x", "a:..", "x=..\\y"]) {
      expect(escapesWorkRoot(arg), arg).toBe(true);
    }
    for (const arg of ["test/a.ts", "test/...", "--reporter=dot", "a.b..c", "--grep=xy:z", "test:unit", "@scope/pkg", "-ofile", "-Isrc", "--x=a+b", "-v"]) {
      expect(escapesWorkRoot(arg), arg).toBe(false);
    }
  });
  it("refuses values glued to short options, after a later = : @ +, and URLs (QA-P13-2-1)", () => {
    const forms = [
      "-o/abs", "-I../x", "-r../../x.js", "-oC:/x", "-o\\abs", "-I..",                    // glued to a two-character short option
      "--define=K=/abs", "--define=K=..", "--a=b=C:x",                                    // a later =
      "--alias=x:/abs", "--alias=x:..", "pkg@/abs", "pkg@..", "x+/abs", "x+..", "a:C:x", // after : @ +
      "file:///D:/x/evil.mjs", "--test-reporter=file:///tmp/r.mjs", "http://h/x", "x//y", "--x=//host/share", // URLs, UNC, //
    ];
    for (const arg of forms) expect(escapesWorkRoot(arg), arg).toBe(true);
  });
  it("refuses any /, \\ or .. in a single-dash argument: short-option clusters carry paths at any offset (QA-P13-3-1)", async () => {
    for (const arg of ["-br../evil.js", "-bc/abs/x.js", "-ofoo/abs", "-x..", "-ab\\c", "-o.../x", "-r./x.js"]) expect(escapesWorkRoot(arg), arg).toBe(true);
    for (const arg of ["-ofile", "-Isrc", "-v", "-abc", "-n=5", "--out=src/x.js", "--require=./setup.js"]) expect(escapesWorkRoot(arg), arg).toBe(false);
    project(root);
    const run = makeTool({ config: () => config({ commands: { files: { argv: ["node", "probe.js"], args: ["-*", "--*"] } } }) });
    for (const arg of ["-br../evil.js", "-bc/abs/x.js", "-ofoo/abs"]) {
      expect(await run({ script: "files", args: [arg], cwd: root }), arg).toMatch(/refused: argument 1 names a path outside the work root/);
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(await run({ script: "files", args: ["--out=src/x.js", "-v"], cwd: root })).toContain("PROBE-OK --out=src/x.js -v");
  }, SPAWN_TIMEOUT);
  it("treats -, @ and + as option leads that need a pattern with the same lead", () => {
    expect(optionLead("--x")).toBe("-"); expect(optionLead("@file")).toBe("@"); expect(optionLead("+opt")).toBe("+"); expect(optionLead("a")).toBeUndefined();
    expect(argAllowed(["*"], "@file")).toBe(false);
    expect(argAllowed(["*"], "+opt")).toBe(false);
    expect(argAllowed(["@*"], "@file")).toBe(true);
    expect(argAllowed(["-*"], "@file")).toBe(false);
    expect(argAllowed(["+opt"], "+opt")).toBe(true);
    expect(argAllowed(["", 5 as never], "x")).toBe(false);
  });
  it("refuses escaping arguments through the tool and option-like ones for a node entry without a fixed script", async () => {
    project(root);
    const run = makeTool({ config: () => config({ commands: {
      files: { argv: ["node", "probe.js"], args: ["test/*", "*", "-*", "@*"] },
      runner: { argv: ["node", "--test"], args: ["test/*", "-*"] },
      separated: { argv: ["node", "--", "probe.js"], args: ["-*"] },
    } }) });
    for (const arg of ["test/../../x/scripts/x.js", "C:/x", "/abs", "--out=../x", "@/etc/passwd", "-o/abs", "-r../../x.js", "--define=K=/abs",
      "--alias=x:/abs", "pkg@/abs", "--test-reporter=file:///tmp/evil.mjs"]) {
      expect(await run({ script: "files", args: [arg], cwd: root }), arg).toMatch(/refused: argument 1 names a path outside the work root/);
    }
    expect(await run({ script: "runner", args: ["--require=evil.js"], cwd: root })).toMatch(/refused: option-like arguments to the node command "runner" need a fixed script first/);
    expect(await run({ script: "separated", args: ["--x"], cwd: root })).toMatch(/need a fixed script first/);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(await run({ script: "files", args: ["--flag", "@resp", "test/a.ts"], cwd: root })).toContain("PROBE-OK --flag @resp test/a.ts");
  }, SPAWN_TIMEOUT);
});

describe("QA-P13-1-2 background processes", () => {
  const background = [
    "const { spawn } = require('child_process');",
    "const c = spawn(process.execPath, ['-e', \"require('fs').writeFileSync('bg.pid', String(process.pid)); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
    "c.unref(); const t = setInterval(() => { if (require('fs').existsSync('bg.pid')) { clearInterval(t); process.exit(0); } }, 50);",
  ].join("\n");
  const kill = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };

  it.skipIf(WIN)("kills a background child left by a normally exiting run (POSIX process group; win32 has no tree after the parent exits)", async () => {
    project(root);
    writeFileSync(join(root, "bg.js"), background);
    const out = await makeTool({ config: () => config({ commands: { bg: { argv: ["node", "bg.js"] } } }) })({ script: "bg", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    const pid = Number(readFileSync(join(root, "bg.pid"), "utf8"));
    try { expect(await waitUntil(() => !alive(pid))).toBe(true); } finally { kill(pid); }
  }, SPAWN_TIMEOUT);
  it.skipIf(WIN)("router_git keeps its behaviour: without killGroupOnSettle the group is not killed (I1)", async () => {
    writeFileSync(join(root, "bg.js"), background);
    const result = await spawnBounded(process.execPath, ["bg.js"], root, { env: process.env, timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    const pid = Number(readFileSync(join(root, "bg.pid"), "utf8"));
    try { expect(alive(pid)).toBe(true); } finally { kill(pid); }
  }, SPAWN_TIMEOUT);
});

describe("QA-P13-1-3 executables as found", () => {
  it.skipIf(!WIN)("accepts ComSpec only when it names cmd.exe; returns a PATH tool by its found (junction) spelling", () => {
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe").toLowerCase();
    const other = join(sibling, "pwsh.exe");
    writeFileSync(other, "");
    expect(resolveSystemShell({ platform: "win32", env: { ComSpec: other } }, [root]).toLowerCase()).toBe(system32);
    const realBin = join(sibling, "real-bin");
    const linkBin = join(home, "link-bin");
    mkdirSync(realBin);
    writeFileSync(join(realBin, "tool.exe"), "");
    symlinkSync(realBin, linkBin, "junction");
    expect(resolveCommandExecutable("tool", { platform: "win32", env: { PATH: linkBin } }, [root])).toBe(join(linkBin, "tool.exe"));
    expect(() => resolveCommandExecutable("tool", { platform: "win32", env: { PATH: linkBin } }, [realBin])).toThrow(/inside the work root/);
  });
  it.skipIf(WIN)("spawns symlinked node by its found path and finds npm-cli.js beside the found and the real node (Homebrew)", () => {
    const brew = join(sibling, "brew");
    const cellarBin = join(brew, "Cellar", "node", "24", "bin");
    mkdirSync(cellarBin, { recursive: true });
    mkdirSync(join(brew, "bin"));
    writeFileSync(join(cellarBin, "node"), "");
    symlinkSync(join(cellarBin, "node"), join(brew, "bin", "node"));
    const found = join(brew, "bin", "node");
    expect(resolveNodeExecutable({ platform: "linux", env: {}, nodeExecPath: found }, [root])).toBe(found);
    expect(() => resolveNpmCli(found, "linux", [root])).toThrow(/npm-cli\.js not found/);
    const viaReal = join(brew, "Cellar", "node", "24", "lib", "node_modules", "npm", "bin");
    mkdirSync(viaReal, { recursive: true });
    writeFileSync(join(viaReal, "npm-cli.js"), "");
    expect(resolveNpmCli(found, "linux", [root])).toBe(join(viaReal, "npm-cli.js"));
    const viaFound = join(brew, "lib", "node_modules", "npm", "bin");
    mkdirSync(viaFound, { recursive: true });
    writeFileSync(join(viaFound, "npm-cli.js"), "");
    expect(resolveNpmCli(found, "linux", [root])).toBe(join(viaFound, "npm-cli.js"));
    expect(() => resolveNodeExecutable({ platform: "linux", env: {}, nodeExecPath: found }, [cellarBin])).toThrow(/inside the work root/);
  });
});

describe("QA-P13-1-4 npm stays in the work root", () => {
  function workspaces() {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ws-root", private: true, workspaces: ["packages/*"], scripts: { test: "node probe.js" } }));
    project(root, { test: "node probe.js" });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ws-root", private: true, workspaces: ["packages/*"], scripts: { test: "node probe.js" } }));
    const pkg = join(root, "packages", "a");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", scripts: { test: "node -e \"require('fs').writeFileSync('ws-marker.txt','x')\"" } }));
    return pkg;
  }
  it("refuses a work-root .npmrc that selects workspaces (positive control: npm with the flags does not run the root script)", async () => {
    const pkg = workspaces();
    writeFileSync(join(root, ".npmrc"), "workspace=packages/a\n");
    const planned = planRun({ script: "probe", cwd: root }, root, config({ scripts: [], commands: { probe: { argv: ["node", "probe.js"] } } }), { platform: process.platform, env: testEnv() });
    const shell = resolveSystemShell({ platform: process.platform, env: testEnv() }, [root]);
    const node = planned.executable;
    const cli = resolveNpmCli(node, process.platform, [root]);
    // Depending on the npm version the .npmrc switches to the workspace's script or makes npm fail;
    // either way the hardening flags alone do not keep `npm run test` on the root's script.
    let failed = false;
    const pins = npmConfigPins(node, cli, planned.env, process.platform, [root]);
    try { execFileSync(node, [cli, ...npmHardeningFlags(shell, pins), "run", "test"], { cwd: root, env: planned.env, stdio: "ignore", windowsHide: true }); } catch { failed = true; }
    expect(failed || existsSync(join(pkg, "ws-marker.txt"))).toBe(true);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
    rmSync(join(pkg, "ws-marker.txt"), { force: true });
    const run = makeTool({ config: () => config({ commands: { t: { argv: ["npm", "test"] } } }) });
    for (const text of ["workspace=packages/a\n", "workspaces=true\n", "include-workspace-root = true\n", "workspace[]=packages/a\n", "; c\nWorkspace=packages/a\n"]) {
      writeFileSync(join(root, ".npmrc"), text);
      expect(await run({ script: "test", cwd: root })).toMatch(/refused: the work root's \.npmrc sets "(workspace|workspaces|include-workspace-root|Workspace)"/);
      expect(await run({ script: "t", cwd: root })).toMatch(/refused: the work root's \.npmrc sets/);
    }
    expect(existsSync(join(pkg, "ws-marker.txt"))).toBe(false);
    writeFileSync(join(root, ".npmrc"), "# workspace=packages/a\nfund=false\n");
    expect(await run({ script: "test", cwd: root })).toMatch(/exit code: 0/);
  }, SPAWN_TIMEOUT);
  it("reads .npmrc keys with npm's own ini parser: every spelling npm resolves to workspace is refused (QA-P13-2-2)", async () => {
    workspaces();
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    // ROUTER_RUN_EMPTY_VAR is defined and empty: every npm version substitutes `${ROUTER_RUN_EMPTY_VAR}` with "".
    const clean = { ...Object.fromEntries(Object.entries(planned.env).filter(([key]) => !/^npm_/i.test(key))), ROUTER_RUN_EMPTY_VAR: "" };
    const npmGet = (key: string) => spawnSync(planned.executable, [planned.argv[0]!, "config", "get", key], { cwd: root, env: clean, encoding: "utf8", windowsHide: true });
    // `npm config` refuses to run (ENOWORKSPACES) exactly when a workspace is configured.
    const npmSeesWorkspace = () => {
      const result = npmGet("fund");
      return result.status !== 0 && /ENOWORKSPACES/.test(result.stderr);
    };
    const run = makeTool({ env: testEnv({ ROUTER_RUN_EMPTY_VAR: "" }) });
    writeFileSync(join(root, ".npmrc"), "fund=false\n");
    expect(npmSeesWorkspace()).toBe(false);
    // QA-P13-3-2: the `${VAR?}` modifier exists only in some npm versions (not npm 10.9.9 / 11.5.1); probe it.
    writeFileSync(join(root, ".npmrc"), "init-version=${ROUTER_RUN_UNSET_VAR?}1.2.3\n");
    const probe = npmGet("init-version");
    const questionModifier = probe.status === 0 && probe.stdout.trim() === "1.2.3";
    const spellings = ["fund=false\rworkspace=packages/a\n", "workspace;comment=packages/a\n", "\"work\\u0073pace\"=packages/a\n",
      "work${ROUTER_RUN_EMPTY_VAR}space=packages/a\n", "work${ROUTER_RUN_UNSET_VAR?}space=packages/a\n", "workspace#x=packages/a\n"];
    for (const text of spellings) {
      writeFileSync(join(root, ".npmrc"), text);
      // Control: npm itself reads this spelling as the workspace setting (the `?` spelling only where npm has the modifier).
      if (!text.includes("?}") || questionModifier) expect(npmSeesWorkspace(), JSON.stringify(text)).toBe(true);
      // The refusal never depends on the npm version.
      expect(await run({ script: "test", cwd: root }), JSON.stringify(text)).toMatch(/^\[router_run\] error: refused: the work root's \.npmrc (sets "workspace"|has a key with environment substitution)/);
    }
    const decode = loadNpmIni(planned.argv[0]!, process.platform, [root]);
    expect(Object.keys(decode("a=1\n#b=2\n;c\n d = 4 \n\"e\"=5\nf[]=6\ng\rh=1\n"))).toEqual(["a", "d", "e", "f", "g", "h"]);
    expect(loadNpmIni(planned.argv[0]!, process.platform, [root])).toBe(decode);
    expect(() => loadNpmIni(join(sibling, "no-npm", "bin", "npm-cli.js"), process.platform, [root])).toThrow(/ini parser is missing/);
  }, SPAWN_TIMEOUT);
  it("pins userconfig and globalconfig: a project .npmrc cannot move the user config, nor a user config the global one (QA-P13-2-2)", async () => {
    project(root);
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    const flags = planned.argv.slice(1, 8);
    const clean = Object.fromEntries(Object.entries(planned.env).filter(([key]) => !/^npm_/i.test(key)));
    const get = (extra: string[], key: string) => execFileSync(planned.executable, [planned.argv[0]!, ...extra, "config", "get", key],
      { cwd: root, env: clean, encoding: "utf8", windowsHide: true }).trim();
    // The defaults npm computes itself equal the pins.
    expect(get([], "userconfig").toLowerCase()).toBe(flags[5]!.slice("--userconfig=".length).toLowerCase());
    expect(get([], "globalconfig").toLowerCase()).toBe(flags[6]!.slice("--globalconfig=".length).toLowerCase());
    // A project .npmrc moving userconfig to a repository file.
    writeFileSync(join(root, "u.npmrc"), "init-version=9.9.9\n");
    writeFileSync(join(root, ".npmrc"), "userconfig=./u.npmrc\n");
    expect(get([], "userconfig")).toMatch(/u\.npmrc$/);
    expect(get([], "init-version")).toBe("9.9.9");
    expect(get(flags, "userconfig")).not.toMatch(/u\.npmrc$/);
    expect(get(flags, "init-version")).not.toBe("9.9.9");
    // The chain project .npmrc → userconfig (a repository file) → globalconfig is closed by the userconfig pin:
    writeFileSync(join(root, "u.npmrc"), `globalconfig=${join(root, "g.npmrc").replaceAll("\\", "/")}\n`);
    expect(get([], "globalconfig")).toMatch(/g\.npmrc$/);
    expect(get(flags, "globalconfig")).not.toMatch(/g\.npmrc$/);
    // Documented residual: the user's OWN ~/.npmrc can still move globalconfig; npm ranks it above --globalconfig
    // (`config ls -l`: "overridden by user"). That file is user-owned, outside every work root.
    writeFileSync(join(home, ".npmrc"), `globalconfig=${join(sibling, "user-chosen.npmrc").replaceAll("\\", "/")}\n`);
    rmSync(join(root, ".npmrc"));
    expect(get(flags, "globalconfig")).toMatch(/user-chosen\.npmrc$/);
    rmSync(join(home, ".npmrc"));
    // The redirected user file selects a workspace: plain npm fails, the pinned run stays on the root script.
    writeFileSync(join(root, "u.npmrc"), "workspace=packages/a\n");
    writeFileSync(join(root, ".npmrc"), "userconfig=./u.npmrc\n");
    const control = spawnSync(planned.executable, [planned.argv[0]!, "run", "test"], { cwd: root, env: clean, encoding: "utf8", windowsHide: true });
    expect(control.status).not.toBe(0);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
    // The pinned flags alone would keep this run on the root script; the tool refuses the redirect outright (QA-P13-3-3).
    expect(spawnSync(planned.executable, [planned.argv[0]!, ...flags, "run", "test"], { cwd: root, env: clean, encoding: "utf8", windowsHide: true }).status).toBe(0);
    rmSync(join(root, "ran.json"));
    expect(await makeTool()({ script: "test", cwd: root })).toMatch(/refused: the work root's \.npmrc sets "userconfig"/);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
    // npm's ${VAR} substitution, as the npm child sees it.
    expect(npmEnvReplace("${A}/x/${B?}/${C}", { A: "a" }, "linux")).toBe("a/x//${C}");
    expect(npmEnvReplace("\\${A}", { A: "a" }, "linux")).toBe("${A}");
    expect(npmEnvReplace("${appdata}", { APPDATA: "r" }, "win32")).toBe("r");
  }, SPAWN_TIMEOUT);
  it("refuses a .npmrc that moves globalconfig, userconfig or prefix: a planted global file beats --globalconfig (QA-P13-3-3)", async () => {
    const pkg = workspaces();
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    const flags = planned.argv.slice(1, 8);
    expect(flags[6]).toMatch(/^--globalconfig=/);
    const clean = Object.fromEntries(Object.entries(planned.env).filter(([key]) => !/^npm_/i.test(key)));
    const planted = join(root, "g.npmrc");
    writeFileSync(planted, "workspace=packages/a\n");
    writeFileSync(join(root, ".npmrc"), `globalconfig=${planted.replaceAll("\\", "/")}\n`);
    // Control: even with every hardening flag (including --globalconfig) npm loads the planted global file:
    // its workspace setting collides with --workspaces=false (or, depending on the version, ENOWORKSPACES).
    const control = spawnSync(planned.executable, [planned.argv[0]!, ...flags, "config", "get", "fund"], { cwd: root, env: clean, encoding: "utf8", windowsHide: true });
    expect(control.status).not.toBe(0);
    expect(control.stderr).toMatch(/ENOWORKSPACES|--no-workspaces and --workspace/);
    // Without the planted file the same command succeeds.
    rmSync(join(root, ".npmrc"));
    expect(spawnSync(planned.executable, [planned.argv[0]!, ...flags, "config", "get", "fund"], { cwd: root, env: clean, encoding: "utf8", windowsHide: true }).status).toBe(0);
    const run = makeTool({ config: () => config({ commands: { t: { argv: ["npm", "test"] } } }) });
    const path = planted.replaceAll("\\", "/");
    for (const text of [`globalconfig=${path}\n`, `GlobalConfig=${path}\n`, `"global\\u0063onfig"=${path}\n`, `fund=false\rglobalconfig=${path}\n`,
      `globalconfig;x=${path}\n`, `userconfig=${path}\n`, `prefix=${sibling.replaceAll("\\", "/")}\n`]) {
      writeFileSync(join(root, ".npmrc"), text);
      for (const script of ["test", "t"]) {
        expect(await run({ script, cwd: root }), JSON.stringify(text)).toMatch(/^\[router_run\] error: refused: the work root's \.npmrc sets "(globalconfig|GlobalConfig|userconfig|prefix)": npm would load config files the tool does not check/);
      }
    }
    expect(existsSync(join(pkg, "ws-marker.txt"))).toBe(false);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
  }, SPAWN_TIMEOUT);
  it("refuses an npm command entry without a package.json in the work root itself", async () => {
    const nested = join(sibling, "nested");
    mkdirSync(nested);
    project(sibling); // a package.json one level up: npm would walk up to it
    const run = makeTool({ resolveWorkRoot: () => bind(nested), config: () => config({ commands: { t: { argv: ["npm", "test"] } } }) });
    expect(await run({ script: "t", cwd: nested })).toMatch(/refused: no readable package\.json in the work root \(npm would walk up/);
    expect(await run({ script: "test", cwd: nested })).toMatch(/refused: no readable package\.json in the work root/);
    expect(existsSync(join(sibling, "ran.json"))).toBe(false);
  }, SPAWN_TIMEOUT);
  it("writes no npm log file (--logs-max=0)", async () => {
    project(root);
    expect(npmHardeningFlags("/bin/sh", { userconfig: "/h/.npmrc", globalconfig: "/p/etc/npmrc" })).toContain("--logs-max=0");
    expect(await makeTool()({ script: "test", cwd: root })).toMatch(/exit code: 0/);
    const logs = join(home, WIN ? "Local" : ".npm", ...(WIN ? ["npm-cache", "_logs"] : ["_logs"]));
    expect(existsSync(logs) ? readdirSyncSafe(logs) : []).toEqual([]);
  }, SPAWN_TIMEOUT);
});
function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

describe("QA-P13-1-5 node and npm are always pinned", () => {
  const plan = (cfg: Partial<RunConfig>, script = "c", args?: string[]) =>
    planRun({ script, args, cwd: root }, root, config(cfg), hostOf(testEnv()));
  it("routes bare node/npm spellings to the pinned install and refuses them by path or by real name", () => {
    project(root);
    const pinnedNode = resolveNodeExecutable(hostOf(testEnv()), [root]);
    for (const program of ["node", "node.exe", "NODE"]) expect(plan({ commands: { c: { argv: [program, "probe.js"] } } }).executable).toBe(pinnedNode);
    expect(plan({ commands: { c: { argv: ["npm.cmd", "test"] } } }).argv[0]).toMatch(/npm-cli\.js$/);
    for (const program of ["/usr/bin/npm", "/usr/local/bin/node", "C:\\Program Files\\nodejs\\node.exe", "nodejs", "npm-cli.js"]) {
      expect(() => plan({ commands: { c: { argv: [program, "x"] } } })).toThrow(/is node or npm|is a shell|absolute or a bare name|not found/);
    }
    const copy = join(sibling, WIN ? "node.exe" : "node");
    writeFileSync(copy, "");
    expect(() => plan({ commands: { c: { argv: [copy] } } })).toThrow(/is node or npm/);
  });
  it("allows only npm script runners, a fixed script name for run, and no npm options before --", () => {
    project(root, { test: "node probe.js", build: "node probe.js" });
    for (const fixed of [["exec", "--", "evil"], ["x"], ["install"], ["--prefix=..", "run", "test"], ["ru", "test"], []]) {
      expect(() => plan({ commands: { c: { argv: ["npm", ...fixed] } } }), fixed.join(" ")).toThrow(/must start with one of run, run-script, test, start, stop, restart/);
    }
    for (const fixed of [["run"], ["run", "--", "test"], ["run-script"]]) {
      expect(() => plan({ commands: { c: { argv: ["npm", ...fixed] } } }), fixed.join(" ")).toThrow(/must name its script right after "run/);
    }
    for (const fixed of [["run", "test", "--workspace=a"], ["test", "--scr=x"], ["run", "test", "-C", "x"], ["run", "-w", "test"]]) {
      expect(() => plan({ commands: { c: { argv: ["npm", ...fixed] } } }), fixed.join(" ")).toThrow(/fixes the npm option/);
    }
    expect(() => plan({ commands: { c: { argv: ["npm", "run", "missing"] } } })).toThrow(/package\.json has no script "missing"/);
    expect(() => plan({ commands: { c: { argv: ["npm", "start"] } } })).toThrow(/package\.json has no script "start"/);
    expect(plan({ commands: { c: { argv: ["npm", "run", "build", "--silent", "--", "--x=1"] } } }).argv.slice(-5)).toEqual(["run", "build", "--silent", "--", "--x=1"]);
    expect(plan({ commands: { c: { argv: ["npm", "run-script", "test", "--if-present"] } } }).argv.slice(-3)).toEqual(["run-script", "test", "--if-present"]);
  });
  it("strips relative and guarded PATH entries from the run's PATH", async () => {
    project(root);
    const inside = join(root, "bin");
    const outsideDir = join(sibling, "bin");
    mkdirSync(inside); mkdirSync(outsideDir);
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
    const env = testEnv({ [pathKey]: [inside, "relative/bin", outsideDir, process.env[pathKey] ?? ""].join(SEP) });
    const out = await makeTool({ env, config: () => config({ commands: { p: { argv: ["node", "-p", "process.env.PATH"] } } }) })({ script: "p", cwd: root });
    expect(out).toMatch(/exit code: 0/);
    expect(out).toContain(outsideDir);
    expect(out).not.toContain(inside + SEP);
    expect(out).not.toContain("relative/bin");
    const stripped = runEnvironment({ PATH: ["/a", "rel", "", "/work/x", "/b"].join(":") }, "linux", undefined, { guards: ["/work"] });
    expect(stripped.PATH).toBe("/a:/b");
  }, SPAWN_TIMEOUT);
  it.skipIf(!WIN)("cmd.exe does not run a program from the work root's current directory (NoDefaultCurrentDirectoryInExePath)", async () => {
    project(root, { test: "evilcmd" });
    writeFileSync(join(root, "evilcmd.cmd"), "@echo off\r\necho evil> \"%~dp0cwd-marker.txt\"\r\n");
    // Positive control (QA-P13-2-5): the same cmd.exe and environment without the variable does run it.
    const planned = planRun({ script: "test", cwd: root }, root, config(), { platform: process.platform, env: testEnv() });
    const shell = planned.argv[1]!.slice("--script-shell=".length);
    const withoutVar = Object.fromEntries(Object.entries(planned.env).filter(([key]) => !/^NoDefaultCurrentDirectoryInExePath$/i.test(key)));
    execFileSync(shell, ["/d", "/s", "/c", "evilcmd"], { cwd: root, env: withoutVar, stdio: "ignore", windowsHide: true });
    expect(existsSync(join(root, "cwd-marker.txt"))).toBe(true);
    rmSync(join(root, "cwd-marker.txt"));
    const out = await makeTool()({ script: "test", cwd: root });
    expect(out).not.toMatch(/exit code: 0;/);
    expect(existsSync(join(root, "cwd-marker.txt"))).toBe(false);
  }, SPAWN_TIMEOUT);
});

describe("QA-P13-2-3 guard set", () => {
  const fold = (path: string) => (WIN ? path.toLowerCase() : path);
  function repo(dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["config", "commit.gpgsign", "false"]]) git(dir, ...args);
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  }
  it("guards the checkout of the plugin's working directory, never the working directory itself (a)", () => {
    const checkout = join(sibling, "plugin-repo");
    repo(checkout);
    mkdirSync(join(checkout, "sub"));
    vi.spyOn(process, "cwd").mockReturnValue(join(checkout, "sub"));
    const guards = workRootGuards(root).map(fold);
    expect(guards).toContain(fold(checkout));
    expect(guards).not.toContain(fold(join(checkout, "sub")));
    vi.spyOn(process, "cwd").mockReturnValue(sibling);
    expect(workRootGuards(root).map(fold)).toEqual([fold(root)]);
  }, SPAWN_TIMEOUT);
  it("always guards the work root itself, even the home directory or a filesystem root (c)", () => {
    vi.spyOn(process, "cwd").mockReturnValue(sibling);
    expect(workRootGuards(homedir()).map(fold)).toContain(fold(homedir()));
    const fsRoot = parse(root).root;
    expect(workRootGuards(fsRoot)[0]).toBe(fsRoot);
  });
  it("guards a bare repository behind a linked worktree (b)", () => {
    const source = join(sibling, "source");
    repo(source);
    const bare = join(sibling, "bare-repo");
    git(sibling, "clone", "-q", "--bare", source, bare);
    const linked = join(sibling, "linked");
    git(bare, "worktree", "add", "-q", "--detach", linked);
    expect(fold(mainWorktree(realpathSync.native(linked)) ?? "")).toBe(fold(realpathSync.native(bare)));
    vi.spyOn(process, "cwd").mockReturnValue(home);
    expect(workRootGuards(realpathSync.native(linked)).map(fold)).toContain(fold(realpathSync.native(bare)));
  }, SPAWN_TIMEOUT);
  it.skipIf(WIN)("deduplicates case-sensitively on POSIX (d)", () => {
    const upper = join(sibling, "Repo");
    const lower = join(sibling, "repo");
    repo(upper); repo(lower);
    vi.spyOn(process, "cwd").mockReturnValue(lower);
    expect(workRootGuards(upper)).toEqual([upper, lower]);
  }, SPAWN_TIMEOUT);
  it("strips a PATH entry whose real path is inside a guard, and refuses '..' in operator executable paths (e, QA-P13-2-7)", () => {
    const inside = join(root, "bin");
    mkdirSync(inside);
    const link = join(home, "link-into-root");
    symlinkSync(inside, link, WIN ? "junction" : "dir");
    const outsideDir = join(sibling, "bin");
    mkdirSync(outsideDir);
    const env = runEnvironment({ PATH: [link, outsideDir].join(SEP) }, process.platform, undefined, { guards: [root] });
    expect(env.PATH).toBe(outsideDir);
    const tool = join(sibling, WIN ? "tool.exe" : "tool");
    writeFileSync(tool, "");
    const s = WIN ? "\\" : "/";
    const dotted = `${sibling}${s}bin${s}..${s}${WIN ? "tool.exe" : "tool"}`; // names the same file; refused, not normalised
    expect(() => resolveCommandExecutable(dotted, hostOf({}), [root])).toThrow(/must not contain a "\.\." segment/);
    expect(() => resolveNodeExecutable(hostOf({}, { nodeExecPath: dotted }), [root])).toThrow(/must not contain a "\.\." segment/);
    expect(resolveCommandExecutable(tool, hostOf({}), [root])).toBe(tool);
  });
});

describe("QA-P13-2-4 bounded pointer files", () => {
  it("ignores an oversized .git pointer or commondir instead of reading it whole", () => {
    const checkout = join(sibling, "wt");
    mkdirSync(checkout);
    writeFileSync(join(checkout, ".git"), `gitdir: ${"x".repeat(5000)}\n`);
    expect(mainWorktree(checkout)).toBeUndefined();
    const gitdir = join(sibling, "gitdir");
    mkdirSync(gitdir);
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, "commondir"), "y".repeat(5000));
    expect(mainWorktree(checkout)).toBeUndefined();
    writeFileSync(join(gitdir, "commondir"), "../main/.git\n");
    expect(fold2(mainWorktree(checkout))).toBe(fold2(join(sibling, "main")));
  });
  it.skipIf(WIN)("does not block on a FIFO .git pointer", () => {
    const checkout = join(sibling, "fifo");
    mkdirSync(checkout);
    execFileSync("mkfifo", [join(checkout, ".git")]);
    const started = performance.now();
    expect(mainWorktree(checkout)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
const fold2 = (path: string | undefined) => (WIN ? (path ?? "").toLowerCase() : path ?? "");

describe("QA-P13-2-5 router_run in a real sibling worktree", () => {
  it("runs in a `git worktree add` sibling bound as the work root, proven by a marker file", async () => {
    project(root);
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["config", "commit.gpgsign", "false"]]) git(root, ...args);
    git(root, "add", "-A"); git(root, "commit", "-qm", "init");
    const worktree = join(sibling, "phase-worktree");
    git(root, "worktree", "add", "-q", "--detach", worktree);
    const records: RunRecord[] = [];
    const run = makeTool({ resolveWorkRoot: () => bind(worktree) }, records);
    const out = await run({ script: "test", cwd: worktree }, context("child", root));
    expect(out).toMatch(/exit code: 0/);
    expect(existsSync(join(worktree, "ran.json"))).toBe(true);
    expect(existsSync(join(root, "ran.json"))).toBe(false);
    expect(fold2(JSON.parse(readFileSync(join(worktree, "ran.json"), "utf8")).cwd)).toBe(fold2(realpathSync.native(worktree)));
    expect(await run({ script: "test", cwd: root }, context("child", root))).toMatch(/refused: cwd is not this dispatch's work root/);
    const guards = workRootGuards(realpathSync.native(worktree)).map(fold2);
    expect(guards).toContain(fold2(root)); // the sibling's main worktree
    expect(records.map(r => r.exitCode)).toEqual([0]);
  }, SPAWN_TIMEOUT);
});

describe("QA-P13-1-6 guards cover the plugin's checkout and a sibling worktree's main checkout", () => {
  it("includes the work root and the plugin working directory's checkout, never a filesystem root", () => {
    const guards = workRootGuards(root).map(dir => dir.toLowerCase());
    expect(guards).toContain(root.toLowerCase());
    // The plugin's checkout is guarded; its working directory itself is not (QA-P13-2-3a), so outside a checkout only the root remains.
    const pluginCheckout = nearestCheckout(process.cwd());
    if (pluginCheckout !== undefined) expect(guards).toContain(pluginCheckout.toLowerCase());
    else expect(guards).toEqual([root.toLowerCase()]);
    for (const dir of guards) expect(dir === join(dir, "..").toLowerCase()).toBe(false);
  });
});

describe("QA-P13-1-7 UNC work roots", () => {
  it("refuses a UNC root for script and npm plans, before any file access", () => {
    const unc = "\\\\localhost\\C$\\no-such-router-run-root";
    const host = { platform: "win32" as const, env: {} };
    expect(() => planRun({ script: "test", cwd: unc }, unc, config(), host)).toThrow(/work root is a UNC path/);
    expect(() => planRun({ script: "t", cwd: unc }, unc, config({ commands: { t: { argv: ["npm", "test"] } } }), host)).toThrow(/work root is a UNC path/);
  });
  it.skipIf(!WIN)("refuses a real UNC work root through the tool (admin share)", async (ctx) => {
    project(root);
    const unc = `\\\\localhost\\${root[0]}$${root.slice(2)}`;
    if (!existsSync(unc)) ctx.skip("the localhost admin share is not available");
    let canonical: string;
    try { canonical = realpathSync.native(unc); } catch { ctx.skip("the admin share cannot be canonicalised"); return; }
    if (!canonical.startsWith("\\\\")) ctx.skip("the admin share canonicalises to a drive path");
    expect(await makeTool({ resolveWorkRoot: () => bind(unc) })({ script: "test", cwd: unc })).toMatch(/refused: the work root is a UNC path/);
  }, SPAWN_TIMEOUT);
});

describe("QA-P13-1-8 package.json is read as a bounded regular file", () => {
  it("refuses a directory, never quotes invalid JSON, and reads at most max+1 bytes", () => {
    mkdirSync(join(root, "package.json"));
    expect(() => planRun({ script: "test", cwd: root }, root, config(), hostOf(testEnv()))).toThrow(/package\.json is not a regular file/);
    rmSync(join(root, "package.json"), RM);
    writeFileSync(join(root, "package.json"), '{"scripts": "hunter2-secret');
    let message = "";
    try { planRun({ script: "test", cwd: root }, root, config(), hostOf(testEnv())); } catch (error) { message = (error as Error).message; }
    expect(message).toBe("no readable package.json in the work root (not valid JSON)");
    writeFileSync(join(root, "big.txt"), "x".repeat(100));
    expect(() => readBoundedRegularFile(join(root, "big.txt"), 50, "big.txt")).toThrow(/larger than/);
    expect(readBoundedRegularFile(join(root, "big.txt"), 100, "big.txt")).toBe("x".repeat(100));
    expect(readBoundedRegularFile(join(root, "missing.txt"), 100, "missing.txt")).toBeUndefined();
  });
  it.skipIf(WIN)("refuses a FIFO and a character device without blocking", () => {
    execFileSync("mkfifo", [join(root, "package.json")]);
    const started = performance.now();
    expect(() => planRun({ script: "test", cwd: root }, root, config(), hostOf(testEnv()))).toThrow(/not a regular file/);
    expect(performance.now() - started).toBeLessThan(5_000);
    rmSync(join(root, "package.json"));
    symlinkSync("/dev/zero", join(root, "package.json"));
    expect(() => planRun({ script: "test", cwd: root }, root, config(), hostOf(testEnv()))).toThrow(/not a regular file/);
  });
});

describe("QA-P13-1-9 credential environment", () => {
  it("strips credential-like variables unless passed through, and says so in the description", async () => {
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_KEY", "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID", "HF_TOKEN", "DB_PASSWORD", "MY_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "SSH_PRIVATE_KEY", "DATABASE_URL", "apikey"]) {
      expect(isCredentialEnv(name), name).toBe(true);
    }
    for (const name of ["PATH", "HOME", "SSH_AUTH_SOCK", "TOKENIZER_MODE", "KEYBOARD", "CI"]) expect(isCredentialEnv(name), name).toBe(false);
    const env = runEnvironment({ HOME: "/h", GITHUB_TOKEN: "t", OPENAI_API_KEY: "k", DATABASE_URL: "u" }, "linux", undefined, { passthrough: ["database_url"] });
    expect(env).toEqual({ HOME: "/h", DATABASE_URL: "u", CI: "1" });
    project(root);
    writeFileSync(join(root, "env.js"), "console.log('TOKEN=' + (process.env.ROUTER_RUN_FAKE_TOKEN ?? 'absent') + ' PASS=' + (process.env.KEEP_PASSWORD ?? 'absent'));");
    const out = await makeTool({ env: testEnv({ ROUTER_RUN_FAKE_TOKEN: "s3cr3t", KEEP_PASSWORD: "kept" }), envPassthrough: ["KEEP_PASSWORD"],
      config: () => config({ commands: { e: { argv: ["node", "env.js"] } } }) })({ script: "e", cwd: root });
    expect(out).toContain("TOKEN=absent PASS=kept");
    const description = (routerRunTool({ config: () => config(), resolveWorkRoot: () => bind(root) }) as unknown as { description: string }).description;
    expect(description).toMatch(/best effort, not a secret scanner/);
    expect(description).toMatch(/credential-like environment variables are not passed/);
  }, SPAWN_TIMEOUT);
});
