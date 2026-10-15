// Phase 4.2 task 4.2.6 (real restart, memo phase-4.2 §10 "integration restart"): the plugin-side executor runs as a REAL Node child
// process (test/fixtures/cpx/recovery/restart-child.ts, bundled to .mjs like the ledger crash child) against a temp git repo; it is
// killed at a signalled kill point (K1, K2, K3) and restarted. The host simulator lives in this process and keeps child sessions on
// disk, so they survive the killed process. The final state must equal an uninterrupted control run.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { integrationBranchName } from "../../src/executor/git.js";
import { createLedgerStore } from "../../src/executor/ledger.js";
import type { LedgerV1 } from "../../src/executor/types.js";
import {
  appendMessages,
  contextOf,
  eventLine,
  finishedAnswer,
  listSessions,
  midToolCall,
  readSession,
  writeSession,
  type ChildConfig,
  type ChildScript,
  type KillPoint,
  type StoredSession,
} from "../fixtures/cpx/recovery/host-store.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHILD_ENTRY = join(REPO_ROOT, "test", "fixtures", "cpx", "recovery", "restart-child.ts");
/** Real git on Windows is slow; the first test also pays for the control run. */
const SLOW = 900_000;

let bundleDir = "";
let bundlePath = "";
const workDirs: Array<{ dir: string; pids: number[] }> = [];

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "omr-recovery-restart-bundle-"));
  const req = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
  const vite = req("vite") as { build(config: Record<string, unknown>): Promise<unknown> };
  await vite.build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: "silent",
    // Everything but node builtins goes into the bundle, so the .mjs runs from the temp dir (no node_modules next to it).
    ssr: { noExternal: true },
    build: {
      ssr: CHILD_ENTRY,
      write: true,
      outDir: bundleDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        output: { format: "es", entryFileNames: "restart-child.mjs" },
      },
    },
  });
  bundlePath = join(bundleDir, "restart-child.mjs");
}, 300_000);

afterEach(async () => {
  const todo = workDirs.splice(0);
  for (const w of todo) await removeDirWhenReleased(w.dir, { pids: w.pids, deadlineMs: 30_000 });
}, 120_000);

afterAll(async () => {
  if (bundleDir !== "") await removeDirWhenReleased(bundleDir, { deadlineMs: 20_000 });
}, 60_000);

// ---------- git in the temp repo (isolated config, no autocrlf)

interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
}

function gitEnv(work: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "omr test",
    GIT_AUTHOR_EMAIL: "omr@test.invalid",
    GIT_COMMITTER_NAME: "omr test",
    GIT_COMMITTER_EMAIL: "omr@test.invalid",
  };
}

function git(work: string, cwd: string, args: readonly string[]): Promise<GitOut> {
  return new Promise<GitOut>((res, rej) => {
    const c = spawn("git", [...args], { cwd, env: gitEnv(work), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d: string) => (stdout += d));
    c.stderr.on("data", (d: string) => (stderr += d));
    c.once("error", rej);
    c.once("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

async function gitOk(work: string, cwd: string, args: readonly string[]): Promise<string> {
  const r = await git(work, cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr}${r.stdout}`);
  return r.stdout;
}

// ---------- the executor child process

/** One run of the executor child; `lines` collects its stdout protocol lines. */
interface ExecProc {
  child: ChildProcess;
  pid: number;
  lines: string[];
  err: () => string;
  /** Exit code, every stdout line and the stderr tail (for failure messages). */
  diag: () => string;
  /** Resolves with the first line matching `re` (rejects when the process exits first). */
  waitLine(re: RegExp, ms: number): Promise<RegExpExecArray>;
  /** Sends one protocol line on stdin. */
  send(line: string): void;
  exited: Promise<number | null>;
}

function startExec(configPath: string, work: { pids: number[] }, env: NodeJS.ProcessEnv): ExecProc {
  const child = spawn(process.execPath, [bundlePath, configPath], {
    cwd: REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("executor child did not start");
  work.pids.push(pid);
  const lines: string[] = [];
  let buf = "";
  let err = "";
  const waiters: Array<{ re: RegExp; res: (m: RegExpExecArray) => void; rej: (e: Error) => void }> = [];
  let exitCode: number | null | undefined;
  /** stdout lines, the stderr tail and the exit code: what every failure of this process reports. */
  const diag = (): string =>
    `exit=${exitCode === undefined ? "running" : String(exitCode)} pid=${pid}\n--- child stdout (${lines.length} lines) ---\n${lines.join("\n")}\n--- child stderr tail ---\n${err.slice(-8000)}`;
  /** A failure line of the child (FATAL: main threw; STUCK: its own deadline) rejects every waiter at once. */
  let failure: string | null = null;
  const onLine = (line: string): void => {
    lines.push(line);
    if (failure === null && /^(FATAL|STUCK|ERROR)\b/.test(line)) failure = line;
    for (const w of [...waiters]) {
      const m = w.re.exec(line);
      if (m !== null) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(m);
      } else if (failure !== null && /^(FATAL|STUCK)\b/.test(line)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.rej(new Error(`executor child reported "${line}" while waiting for ${w.re.source}\n${diag()}`));
      }
    }
  };
  // `close` (not `exit`): every stdout byte has arrived by then, so a last line without a newline is not lost.
  const exited = new Promise<number | null>((res) => child.once("close", (code) => {
    exitCode = code;
    if (buf !== "") {
      const rest = buf.replace(/\r$/, "");
      buf = "";
      onLine(rest);
    }
    for (const w of waiters.splice(0)) w.rej(new Error(`executor child exited (${String(code)}) before ${w.re.source}\n${diag()}`));
    res(code);
  }));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (err += d));
  // A host event sent while the process exits must not crash the test process (EPIPE).
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      onLine(line);
      i = buf.indexOf("\n");
    }
  });
  const waitLine = (re: RegExp, ms: number): Promise<RegExpExecArray> => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m !== null) return Promise.resolve(m);
    }
    if (failure !== null && /^(FATAL|STUCK)\b/.test(failure)) {
      return Promise.reject(new Error(`executor child reported "${failure}" before ${re.source}\n${diag()}`));
    }
    if (exitCode !== undefined) return Promise.reject(new Error(`executor child already exited before ${re.source}\n${diag()}`));
    return new Promise<RegExpExecArray>((res, rej) => {
      const t = setTimeout(() => {
        const at = waiters.findIndex((w) => w.re === re);
        if (at >= 0) waiters.splice(at, 1);
        rej(new Error(`timeout (${ms} ms) waiting for ${re.source}\n${diag()}`));
      }, ms);
      waiters.push({
        re,
        res: (m) => {
          clearTimeout(t);
          res(m);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
    });
  };
  const send = (line: string): void => {
    if (exitCode === undefined) child.stdin.write(`${line}\n`);
  };
  return { child, pid, lines, err: () => err, diag, waitLine, send, exited };
}

async function killExec(p: ExecProc): Promise<void> {
  p.child.kill("SIGKILL");
  await p.exited;
}

// ---------- the world: a temp repo, the executor home, the host simulator's session store

const PLAN = "p-20261013-c0e426";
const ORCH = "ses-orch";
const TASKS = ["T1", "T2", "T3", "T4"] as const;
const WORK: Record<string, { file: string; content: string }> = Object.fromEntries(
  TASKS.map((t) => [t, { file: `src/${t.toLowerCase()}.txt`, content: `${t} was here\n` }]),
);
/** The kill-point task is T1 (normal); the others are in flight when the process dies. */
const SCRIPTS: Record<string, ChildScript> = { T2: "alive", T3: "dead", T4: "finish-while-down" };
const LIVENESS_MS = 1_500;
const LAUNCHER_LIVENESS_MS = 15_000;
const POLL_MS = 200;
const RUN_MS = 420_000;
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "cpx", "integrate", "node-basic");

interface World {
  dir: string;
  work: { dir: string; pids: number[] };
  repo: string;
  c0: string;
  home: string;
  slotsDir: string;
  lockRoot: string;
  hostRoot: string;
  env: NodeJS.ProcessEnv;
  branch: string;
}

async function makeWorld(tag: string): Promise<World> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), `omr-rr-${tag}-`)));
  const work = { dir, pids: [] as number[] };
  workDirs.push(work);
  writeFileSync(join(dir, "gitconfig"), "");
  const emptyHome = join(dir, "empty-home");
  mkdirSync(emptyHome);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  await gitOk(dir, repo, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [
    ["user.name", "Restart Tester"],
    ["user.email", "restart.tester@example.test"],
    ["core.autocrlf", "false"],
    ["core.eol", "lf"],
    ["commit.gpgSign", "false"],
  ] as const) {
    await gitOk(dir, repo, ["config", k, v]);
  }
  cpSync(FIXTURE, repo, { recursive: true });
  writeFileSync(join(repo, "src", "value.txt"), "base\n");
  await gitOk(dir, repo, ["add", "--all"]);
  await gitOk(dir, repo, ["commit", "-q", "--no-verify", "-m", "c0"]);
  const c0 = (await gitOk(dir, repo, ["rev-parse", "HEAD"])).trim();
  const branch = integrationBranchName(PLAN);
  // 5.1 handoff (memo §9): the integration branch exists before the approve; the child creates the integration slot.
  await gitOk(dir, repo, ["branch", branch, c0]);
  const home = join(dir, "home");
  const slotsDir = join(dir, "slots", PLAN);
  const lockRoot = join(dir, "locks");
  const hostRoot = join(dir, "host-sim");
  for (const d of [home, slotsDir, lockRoot, hostRoot]) mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...gitEnv(dir), HOME: emptyHome, USERPROFILE: emptyHome, XDG_CONFIG_HOME: emptyHome };
  return { dir, work, repo, c0, home, slotsDir, lockRoot, hostRoot, env, branch };
}

function configFor(w: World, run: number, o: {
  kill: ChildConfig["kill"]; scripts: ChildConfig["scripts"]; activity: ChildConfig["activity"]; launcherLiveness?: boolean;
  stopAt?: ChildConfig["stopAt"];
}): string {
  const c: ChildConfig = {
    home: w.home,
    toplevel: w.repo,
    slotsDir: w.slotsDir,
    lockRoot: w.lockRoot,
    hostRoot: w.hostRoot,
    planId: PLAN,
    baseBranch: "main",
    baseCommit: w.c0,
    orchestrator: ORCH,
    run,
    kill: o.kill,
    scripts: o.scripts,
    ...(o.stopAt === undefined ? {} : { stopAt: o.stopAt }),
    work: WORK,
    livenessMs: o.launcherLiveness ? LAUNCHER_LIVENESS_MS : LIVENESS_MS,
    pollMs: POLL_MS,
    activity: o.activity,
    ...(o.launcherLiveness ? { launcherLiveness: true } : {}),
  };
  const p = join(w.dir, `config-${run}.json`);
  writeFileSync(p, JSON.stringify(c, null, 2));
  return p;
}

const readLedger = (w: World): Promise<LedgerV1> => createLedgerStore({ home: w.home }).read(PLAN);

/** The ledger as the test sees it (directory, status, tasks with attempts, inbox), or why it cannot be read. */
async function ledgerState(w: World): Promise<string> {
  const dir = join(w.home, PLAN);
  if (!existsSync(dir)) return `ledger dir ${dir} does not exist (home holds: ${existsSync(w.home) ? readdirSync(w.home).join(", ") : "(missing)"})`;
  try {
    const l = await readLedger(w);
    return [
      `ledger dir ${dir}: status=${l.status} seq=${l.seq} head=${l.integration.head}`,
      ...Object.values(l.tasks).map((t) => `  ${t.id}=${t.state} attempts=[${t.attempts.map((a) => `${a.n}:${a.outcome ?? "open"}`).join(" ")}]`),
      ...l.inbox.map((i) => `  inbox ${i.kind}/${i.severity}: ${i.text.slice(0, 300)}`),
    ].join("\n");
  } catch (e) {
    return `ledger dir ${dir} unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * The run is settled only when the child printed SETTLED (every task integrated, gates closed) and then exited 0. An exit
 * before SETTLED, a FATAL/STUCK line, a non-zero exit or a timeout rejects with the child's output and the ledger state.
 */
async function waitSettled(p: ExecProc, w: World): Promise<void> {
  try {
    await p.waitLine(/^SETTLED$/, RUN_MS);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- ledger ---\n${await ledgerState(w)}`);
  }
  const code = await p.exited;
  if (code !== 0) throw new Error(`executor child printed SETTLED but exited ${String(code)}\n${p.diag()}\n--- ledger ---\n${await ledgerState(w)}`);
}

// ---------- what a run leaves behind

interface Outcome {
  status: string;
  gates: string[];
  states: Record<string, string>;
  integrated: string[];
  /** Attempts that count toward maxAttempts (succeeded | failed), per task. */
  counted: Record<string, number>;
  /** Uncounted `lost` attempts, per task. */
  lost: Record<string, number>;
  outcomes: Record<string, string[]>;
  /** `task-integrated` events per task over the whole journal. */
  integratedEvents: Record<string, number>;
  /** Launched children per `<task>#<n>` (sessions the host stores). */
  launches: Record<string, number>;
  sessions: StoredSession[];
  tip: string;
  tree: string;
  /** Commit subjects c0..tip, oldest first, and the same with the attempt number masked. */
  subjects: string[];
  maskedSubjects: string[];
  trailers: string[];
  ledgerHead: string;
  ledger: LedgerV1;
  /** The plan directory the ledger was read from, and how many events `exportPlan` returned. */
  ledgerDir: string;
  exportedEvents: number;
  /** The last executor process's stdout and stderr (diagnostics). */
  childOut: string;
  childErr: string;
}

/** What a failed expectation prints: tasks, attempts, plan status, gates, inbox, branch, and the child's output tail. */
function describeOutcome(o: Outcome): string {
  const l = o.ledger;
  return [
    `ledger dir: ${o.ledgerDir}`,
    `status=${l.status} seq=${l.seq} head=${l.integration.head} tip=${o.tip} gates=${o.gates.join(",")}`,
    ...Object.values(l.tasks).map((t) => `  ${t.id}=${t.state} slot=${t.slot ?? "-"} attempts=[${t.attempts.map((a) => `${a.n}:${a.outcome ?? "open"}${a.verdict === null ? "" : `/${a.verdict}`}`).join(" ")}]`),
    ...l.inbox.map((i) => `  inbox ${i.kind}/${i.severity}${i.answer === null ? "" : " (closed)"}: ${i.text.slice(0, 300)}`),
    `integratedEvents=${JSON.stringify(o.integratedEvents)} exportedEvents=${o.exportedEvents} launches=${JSON.stringify(o.launches)}`,
    `subjects=${JSON.stringify(o.subjects)}`,
    `child stdout tail:\n${o.childOut.slice(-4000)}`,
    `child stderr tail:\n${o.childErr.slice(-4000)}`,
  ].join("\n");
}

/** The session id carries the task and attempt (`ses-r<run>-<task>-<n>-...`, scriptedLauncher). */
function launchKey(s: StoredSession): string {
  const m = /^ses-r\d+-([^-]+)-(\d+)-/.exec(s.id);
  return m === null ? `?${s.id}` : `${m[1]}#${m[2]}`;
}

async function collect(w: World, p: ExecProc | null): Promise<Outcome> {
  const ledgerDir = join(w.home, PLAN);
  if (!existsSync(ledgerDir)) {
    const entries = existsSync(w.home) ? readdirSync(w.home).join(", ") : "(home missing)";
    throw new Error(`collect: no ledger directory ${ledgerDir} (home ${w.home} holds: ${entries})\nchild stdout:\n${p?.lines.join("\n") ?? ""}\nchild stderr tail:\n${p?.err().slice(-6000) ?? ""}`);
  }
  let ledger: LedgerV1;
  let events: Awaited<ReturnType<ReturnType<typeof createLedgerStore>["exportPlan"]>>["events"];
  try {
    ledger = await readLedger(w);
    events = (await createLedgerStore({ home: w.home }).exportPlan(PLAN)).events;
  } catch (e) {
    throw new Error(`collect: the ledger in ${ledgerDir} is unreadable: ${e instanceof Error ? e.message : String(e)}\nchild stderr tail:\n${p?.err().slice(-6000) ?? ""}`);
  }
  const tasks = Object.values(ledger.tasks).sort((a, b) => a.id.localeCompare(b.id));
  // `exportPlan` returns the history-class events (integration steps, wakes, metrics: history.jsonl, kept for the whole plan)
  // plus the journal since the last snapshot only; durable rows such as `task-integrated` are folded into the snapshot and are
  // gone from the export once a snapshot covers them (ledger.ts exportPlan). Integrations are therefore counted from the
  // integration entries that closed `ok`, per task (batchMax 1: one entry per task).
  const okEntries: Record<string, Set<string>> = {};
  for (const e of events) {
    if (e.type !== "integration-step" || e.edge !== "end" || !e.closes || e.result !== "ok") continue;
    for (const id of e.entry.taskIds) (okEntries[id] ??= new Set<string>()).add(e.entry.id);
  }
  const integratedEvents: Record<string, number> = Object.fromEntries(Object.entries(okEntries).map(([k, v]) => [k, v.size]));
  const sessions = await listSessions(w.hostRoot);
  const launches: Record<string, number> = {};
  for (const s of sessions) launches[launchKey(s)] = (launches[launchKey(s)] ?? 0) + 1;
  const tip = (await gitOk(w.dir, w.repo, ["rev-parse", `refs/heads/${w.branch}`])).trim();
  const tree = (await gitOk(w.dir, w.repo, ["rev-parse", `${tip}^{tree}`])).trim();
  const log = await gitOk(w.dir, w.repo, ["log", "--reverse", "--format=%s%x1f%(trailers:key=Omr-Attempt,valueonly)%x1e", `${w.c0}..${tip}`]);
  const rows = log.split("\x1e").map((r) => r.trim()).filter((r) => r !== "");
  const subjects = rows.map((r) => r.split("\x1f")[0] ?? "");
  const trailers = rows.map((r) => (r.split("\x1f")[1] ?? "").trim());
  return {
    status: ledger.status,
    gates: ledger.phases.map((p) => `${p.id}=${p.gate}`),
    states: Object.fromEntries(tasks.map((t) => [t.id, t.state])),
    integrated: tasks.filter((t) => t.state === "integrated").map((t) => t.id),
    counted: Object.fromEntries(tasks.map((t) => [t.id, t.attempts.filter((a) => a.outcome === "succeeded" || a.outcome === "failed").length])),
    lost: Object.fromEntries(tasks.map((t) => [t.id, t.attempts.filter((a) => a.outcome === "lost").length])),
    outcomes: Object.fromEntries(tasks.map((t) => [t.id, t.attempts.map((a) => `${a.n}:${a.outcome ?? "open"}`)])),
    integratedEvents,
    launches,
    sessions,
    tip,
    tree,
    subjects,
    // The task commit's subject names its attempt (`<id>: <title> (attempt <n>)`, runtime.ts commitAndVerify): an uncounted
    // lost attempt shifts n, so subjects are compared with n masked; the trailers carry random nonces and are compared by count.
    maskedSubjects: subjects.map((s) => s.replace(/\(attempt \d+\)/, "(attempt n)")).sort(),
    trailers,
    ledgerHead: ledger.integration.head,
    ledger,
    ledgerDir,
    exportedEvents: events.length,
    childOut: p?.lines.join("\n") ?? "",
    childErr: p?.err() ?? "",
  };
}

/** Invariants every finished run holds on its own: nothing launched twice, nothing committed or integrated twice. */
function expectClean(o: Outcome, label: string): void {
  const dump = describeOutcome(o);
  expect(o.integrated, `${label}: every task integrated\n${dump}`).toEqual([...TASKS]);
  // Each attempt was launched at most once; each counted attempt exactly once.
  for (const [key, n] of Object.entries(o.launches)) expect(n, `${label}: launches of ${key}\n${dump}`).toBe(1);
  for (const t of Object.values(o.ledger.tasks)) {
    for (const a of t.attempts) {
      if (a.outcome === "succeeded" || a.outcome === "failed") expect(o.launches[`${t.id}#${a.n}`], `${label}: launch of counted ${t.id}#${a.n}\n${dump}`).toBe(1);
    }
  }
  // No duplicate commits on the integration branch: one commit per task, every subject and trailer once.
  expect(o.subjects, `${label}: commits on the integration branch\n${dump}`).toHaveLength(TASKS.length);
  for (const t of TASKS) expect(o.subjects.filter((s) => s.startsWith(`${t}: `)), `${label}: commits of ${t}\n${dump}`).toHaveLength(1);
  expect(new Set(o.subjects).size, `${label}: duplicate subjects\n${dump}`).toBe(o.subjects.length);
  expect(new Set(o.trailers).size, `${label}: duplicate trailers ${JSON.stringify(o.trailers)}\n${dump}`).toBe(o.trailers.length);
  for (const tr of o.trailers) expect(tr, `${label}: trailer\n${dump}`).toMatch(new RegExp(`^${PLAN}/T\\d/\\d+/[0-9a-f]+$`));
  // Integrated exactly once each (one integration entry closed ok per task, batchMax 1), and the journal's head is the tip.
  expect(o.integratedEvents, `${label}: integration entries closed ok per task\n${dump}`).toEqual(Object.fromEntries(TASKS.map((t) => [t, 1])));
  for (const t of Object.values(o.ledger.tasks)) expect(t.integrated?.to, `${label}: ${t.id}.integrated\n${dump}`).toBeTruthy();
  expect(o.ledgerHead, `${label}: ledger head vs branch tip\n${dump}`).toBe(o.tip);
}

/** The restart run equals the uninterrupted control run (memo §10). */
function expectSameAsControl(r: Outcome, c: Outcome): void {
  expect(r.states).toEqual(c.states);
  expect(r.integrated).toEqual(c.integrated);
  expect(r.counted).toEqual(c.counted);
  expect(r.status).toBe(c.status);
  expect(r.gates).toEqual(c.gates);
  expect(r.tree).toBe(c.tree);
  expect(r.maskedSubjects).toEqual(c.maskedSubjects);
  expect(r.trailers).toHaveLength(c.trailers.length);
}

// ---------- the host simulator: plays the children that outlive the executor process

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The child does its work in its slot and answers; its session ends idle (what the executor would read on a poll or a restart). */
async function finishChild(w: World, sid: string): Promise<void> {
  const s = await readSession(w.hostRoot, sid);
  if (s === null) throw new Error(`no session ${sid}`);
  if (s.stopped) throw new Error(`stopped worker ${sid} cannot finish`);
  const p = join(s.slotPath, s.file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s.content);
  await appendMessages(w.hostRoot, sid, [
    // QA-4.2-2: the v2 host's real shape (an ended answer step); the adapter derives the terminal entry from it.
    finishedAnswer(s.answer, Date.now()),
  ], "idle");
}

interface RestartResult {
  w: World;
  point: string;
  /** The READY line's detail (K3: the slot the commit ran in). */
  detail: string;
  /** K3: the commit message at the slot's HEAD right after the kill. */
  slotHeadAtKill: string;
  atKill: LedgerV1;
  tipAtKill: string;
  /** Child session per task as launched by the killed process. */
  sids: Record<string, string>;
  o: Outcome;
}

/**
 * Run 0 is killed at `point` with T1 at the point and T2 (alive), T3 (dead) and T4 (finishes during the downtime) in flight;
 * run 1 restarts on the same home, repo and host sessions. The alive child sends host events from the restart on, past the
 * probation deadline, and then finishes (its end arrives as an `execution.completed` host event).
 * QA-4.2-1/-2: every child's first message carries the v2 host preamble line and the scripted children are left mid-tool-call
 * (host-store.ts), read through the real v2 adapter mapping: the alive child must be adopted (not a header mismatch) and the
 * dead one must not be processed as finished.
 */
async function restartRun(point: KillPoint, activity: ChildConfig["activity"]): Promise<RestartResult> {
  const w = await makeWorld(`${point.toLowerCase()}-${activity}`);
  const p0 = startExec(configFor(w, 0, { kill: { point, task: "T1" }, scripts: SCRIPTS, activity }), w.work, w.env);
  const ready = await p0.waitLine(/^READY (K\d) ?(.*)$/, RUN_MS);
  await killExec(p0);
  expect(ready[1]).toBe(point);
  const atKill = await readLedger(w);
  const tipAtKill = (await gitOk(w.dir, w.repo, ["rev-parse", `refs/heads/${w.branch}`])).trim();
  const detail = ready[2] ?? "";
  const slotHeadAtKill = point === "K3" ? await gitOk(w.dir, detail, ["log", "-1", "--format=%B"]) : "";
  const sids: Record<string, string> = {};
  for (const line of p0.lines) {
    const m = /^LAUNCH (\S+) (\d+) (\S+) (\S+)$/.exec(line);
    if (m !== null && m[1] !== undefined && m[3] !== undefined) sids[m[1]] = m[3];
  }
  for (const t of ["T2", "T3", "T4"]) {
    expect(atKill.tasks[t]?.state, `${t} in flight at the kill`).toBe("running");
    expect(atKill.tasks[t]?.attempts.at(-1)?.childSessionID).toBe(sids[t]);
  }

  // ---- downtime: T4's child finishes while no executor runs
  await finishChild(w, need(sids.T4, "T4 session"));

  // ---- run 1: the alive child proves life with host events from the restart on
  const p1 = startExec(configFor(w, 1, { kill: null, scripts: {}, activity }), w.work, w.env);
  const aliveSid = need(sids.T2, "T2 session");
  let beating = true;
  const beat = (async () => {
    while (beating) {
      p1.send(eventLine({ type: "step.started", sessionID: aliveSid, providerID: "prov", modelID: "model-1", at: new Date().toISOString() }));
      await sleep(50);
    }
  })();
  try {
    await p1.waitLine(/^STARTED$/, RUN_MS);
    await sleep(LIVENESS_MS + 10 * POLL_MS);
  } finally {
    beating = false;
    await beat;
  }
  // Well past the probation deadline: the alive child was adopted, never interrupted, its attempt still open.
  expect((await readSession(w.hostRoot, aliveSid))?.interrupted).toBe(0);
  const mid = await readLedger(w);
  expect(mid.tasks.T2?.state).toBe("running");
  expect(mid.tasks.T2?.attempts.map((a) => a.outcome)).toEqual([null]);
  await finishChild(w, aliveSid);
  for (let i = 0; i < 120; i++) {
    p1.send(eventLine({ type: "execution.completed", sessionID: aliveSid, at: new Date().toISOString() }));
    if ((await readLedger(w)).tasks.T2?.state !== "running") break;
    await sleep(500);
  }
  await waitSettled(p1, w);
  return { w, point: ready[1] ?? "", detail, slotHeadAtKill, atKill, tipAtKill, sids, o: await collect(w, p1) };
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

/** The per-child outcomes after the restart (memo §10): alive adopted, dead relaunched once, finished processed. */
async function expectChildren(r: RestartResult, activity: ChildConfig["activity"]): Promise<void> {
  const { o, sids, w } = r;
  expect(o.outcomes).toEqual({ T1: ["1:succeeded"], T2: ["1:succeeded"], T3: ["1:lost", "2:succeeded"], T4: ["1:succeeded"] });
  expect(o.lost).toEqual({ T1: 0, T2: 0, T3: 1, T4: 0 });
  // alive: adopted (attempt 1 is the child launched before the kill), never interrupted
  expect(o.ledger.tasks.T2?.attempts[0]?.childSessionID).toBe(sids.T2);
  expect((await readSession(w.hostRoot, need(sids.T2, "T2")))?.interrupted).toBe(0);
  // finished during the downtime: its result processed, nothing relaunched
  expect(o.ledger.tasks.T4?.attempts[0]?.childSessionID).toBe(sids.T4);
  expect((await readSession(w.hostRoot, need(sids.T4, "T4")))?.interrupted).toBe(0);
  expect(o.launches["T4#2"]).toBeUndefined();
  // dead: closed lost (uncounted) and relaunched once as attempt 2 by the restarted process
  expect(o.ledger.tasks.T3?.attempts[0]?.childSessionID).toBe(sids.T3);
  expect(o.launches["T3#1"]).toBe(1);
  expect(o.launches["T3#2"]).toBe(1);
  expect(o.sessions.find((s) => launchKey(s) === "T3#2")?.run).toBe(1);
  // probation ran out (activity unknown): the silent child was interrupted before the relaunch
  if (activity === "unknown") expect((await readSession(w.hostRoot, need(sids.T3, "T3")))?.interrupted).toBeGreaterThanOrEqual(1);
}

// ---------- the control run (computed once)

let controlRun: Promise<Outcome> | null = null;

function control(): Promise<Outcome> {
  controlRun ??= (async () => {
    const w = await makeWorld("control");
    const p = startExec(configFor(w, 0, { kill: null, scripts: {}, activity: "unknown" }), w.work, w.env);
    await waitSettled(p, w);
    const o = await collect(w, p);
    expectClean(o, "control");
    expect(o.counted, `control: counted attempts\n${describeOutcome(o)}`).toEqual({ T1: 1, T2: 1, T3: 1, T4: 1 });
    expect(o.lost, `control: lost attempts\n${describeOutcome(o)}`).toEqual({ T1: 0, T2: 0, T3: 0, T4: 0 });
    return o;
  })();
  return controlRun;
}

// ---------- the tests

describe("executor restart recovery: a real child process killed at K1/K2/K3 and restarted (4.2.6)", () => {
  it("variant: dead launcher requeues provider-stopped children at once, but a mid-tool child keeps probation", async () => {
    const c = await control();
    const w = await makeWorld("launcher-liveness");
    const p0 = startExec(configFor(w, 0, {
      kill: { point: "K3", task: "T1" }, scripts: SCRIPTS, activity: "unknown", launcherLiveness: true, stopAt: "provider",
    }), w.work, w.env);
    await p0.waitLine(/^READY K3 /, RUN_MS);
    // The host simulator advances T4 into a tool while the launcher is still alive; T2/T3 stay at the provider.
    const t4 = need((await listSessions(w.hostRoot)).find((s) => launchKey(s) === "T4#1"), "T4 session");
    await appendMessages(w.hostRoot, t4.id, midToolCall(Date.now()));
    await killExec(p0);
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
    };
    expect(alive(p0.pid)).toBe(false);
    const atKill = await readLedger(w);
    // Unlike the existing variants, the simulated host stops every busy worker of this dead launcher. It retains the
    // provider/mid-tool history with no terminal entry, and activity remains unknown (as on the v2 adapter).
    const stopped: StoredSession[] = [];
    for (const s of await listSessions(w.hostRoot)) {
      if (s.status !== "busy" || s.launcherPid === undefined || alive(s.launcherPid)) continue;
      const cut = { ...s, stopped: true };
      await writeSession(w.hostRoot, cut);
      stopped.push(cut);
    }
    expect(stopped.map((s) => launchKey(s)).sort()).toEqual(["T2#1", "T3#1", "T4#1"]);
    for (const id of ["T2", "T3", "T4"]) expect(atKill.tasks[id]?.state).toBe("running");
    for (const s of stopped) {
      expect(contextOf(s).toolInFlight).toBe(launchKey(s) === "T4#1");
      expect(contextOf(s).messages.some((m) => m.role === "idle")).toBe(false);
    }

    const restartAt = Date.now();
    const p1 = startExec(configFor(w, 1, {
      kill: null, scripts: {}, activity: "unknown", launcherLiveness: true,
    }), w.work, w.env);
    await waitSettled(p1, w);
    const o = await collect(w, p1);
    expectClean(o, "launcher-liveness");
    expectSameAsControl(o, c);
    expect(o.outcomes).toEqual({ T1: ["1:succeeded"], T2: ["1:lost", "2:succeeded"], T3: ["1:lost", "2:succeeded"], T4: ["1:lost", "2:succeeded"] });
    expect(o.counted).toEqual({ T1: 1, T2: 1, T3: 1, T4: 1 });
    for (const s of stopped) {
      const taskId = launchKey(s).split("#")[0]!;
      const midTool = taskId === "T4";
      expect((await readSession(w.hostRoot, s.id))?.interrupted).toBe(midTool ? 1 : 0);
      expect((await readSession(w.hostRoot, s.id))?.stopped).toBe(true);
      expect(o.ledger.tasks[taskId]?.attempts[0]?.outcome).toBe("lost");
      expect(o.launches[`${taskId}#2`]).toBe(1);
      const firstEnd = Date.parse(need(o.ledger.tasks[taskId]?.attempts[0]?.endedAt, `${taskId} first end`));
      const retryAt = Date.parse(need(o.ledger.tasks[taskId]?.attempts[1]?.startedAt, `${taskId} retry start`));
      expect(retryAt).toBeGreaterThanOrEqual(firstEnd);
      if (midTool) {
        expect(firstEnd - restartAt, "mid-tool child keeps the entire liveness probation").toBeGreaterThanOrEqual(LAUNCHER_LIVENESS_MS);
        expect(retryAt - restartAt, "mid-tool attempt 2 cannot launch before the deadline").toBeGreaterThanOrEqual(LAUNCHER_LIVENESS_MS);
        expect(p1.err()).toContain('the child stopped with a tool call in flight; keeping the liveness probation {"taskId":"T4","n":1}');
        expect(p1.err()).not.toContain(`"taskId":"T4","n":1,"pid":${p0.pid}`);
      } else {
        expect(firstEnd - restartAt, `${taskId} requeues without the liveness probation`).toBeLessThan(LAUNCHER_LIVENESS_MS);
        expect(p1.err()).toContain(`"taskId":"${taskId}","n":1,"pid":${p0.pid}`);
      }
    }
    const events = (await createLedgerStore({ home: w.home }).exportPlan(PLAN)).events;
    const records = events.flatMap((e) => e.type === "metric" && e.metric.name === "counter" && e.metric.key === "child-process" ? [e.metric.labels] : []);
    expect(records).toHaveLength(7); // four original children, three replacements; never relabel a recovery adopt
    for (const s of stopped) expect(records.find((r) => r.child === s.id)?.pid).toBe(String(p0.pid));
    expect(records.filter((r) => r.n === "2").every((r) => r.pid === String(p1.pid))).toBe(true);
  }, SLOW);

  it("K3 (after `git commit` in a slot, before row 21): D11 reuses the commit; alive/dead/finished children recovered; equals the control run", async () => {
    const c = await control();
    const r = await restartRun("K3", "unknown");
    // At the kill: T1 completed, its slot's HEAD is this attempt's commit (trailer), the branch untouched.
    expect(r.atKill.tasks.T1?.state).toBe("completed");
    const nonce = need(r.atKill.tasks.T1?.attempts[0]?.nonce, "T1 attempt 1 nonce");
    expect(r.slotHeadAtKill).toContain(`Omr-Attempt: ${PLAN}/T1/1/${nonce}`);
    expect(r.tipAtKill).toBe(r.w.c0);
    // D11: the restarted process used that commit (same trailer on the branch); it did not commit T1 again.
    expect(r.o.trailers.filter((t) => t.startsWith(`${PLAN}/T1/`))).toEqual([`${PLAN}/T1/1/${nonce}`]);
    expect(r.o.subjects.filter((s) => s.startsWith("T1: "))).toEqual(["T1: Task T1 (attempt 1)"]);
    expectClean(r.o, "K3");
    await expectChildren(r, "unknown");
    expectSameAsControl(r.o, c);
  }, SLOW);

  it("K1 (integration entry's start fsynced, before the fast-forward): resume() redoes it once; equals the control run", async () => {
    const c = await control();
    const r = await restartRun("K1", "unknown");
    expect(r.atKill.tasks.T1?.state).toBe("integrating");
    expect(r.tipAtKill).toBe(r.w.c0); // the branch never moved
    expect(r.atKill.integration.head).toBe(r.w.c0);
    expectClean(r.o, "K1");
    await expectChildren(r, "unknown");
    expectSameAsControl(r.o, c);
  }, SLOW);

  it("K2 (after `update-ref`, before the entry's end event): resume() completes it once; equals the control run", async () => {
    const c = await control();
    const r = await restartRun("K2", "unknown");
    expect(r.atKill.tasks.T1?.state).toBe("integrating");
    expect(r.tipAtKill).not.toBe(r.w.c0); // the branch moved ...
    expect(r.atKill.integration.head).toBe(r.w.c0); // ... and the journal does not know yet
    expectClean(r.o, "K2");
    await expectChildren(r, "unknown");
    expectSameAsControl(r.o, c);
  }, SLOW);

  it("variant: host activity known (alive = active, dead = inactive) at K3: adopt without probation, requeue the dead child at once", async () => {
    const c = await control();
    const r = await restartRun("K3", "scripted");
    expect(r.atKill.tasks.T1?.state).toBe("completed");
    expectClean(r.o, "K3 scripted");
    await expectChildren(r, "scripted");
    expectSameAsControl(r.o, c);
  }, SLOW);
});
