// Phase 2.2 task 2.2.3: crash points of the ledger store, injected by killing a real child process that runs the real store.
// The child (test/fixtures/cpx/ledger/crash-child.ts) parks at a named point; this test kills it there and reloads the plan.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLedgerStore } from "../../src/executor/ledger.js";
import type { LedgerV1 } from "../../src/executor/types.js";
import { holderOf, PLAN_ID } from "../fixtures/cpx/ledger/builders.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHILD_ENTRY = join(REPO_ROOT, "test", "fixtures", "cpx", "ledger", "crash-child.ts");

interface Parked {
  child: ChildProcess;
  pid: number;
  seq: number;
}

let bundleDir = "";
let bundlePath = "";
const workDirs: Array<{ dir: string; pids: number[] }> = [];

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "omr-ledger-crash-bundle-"));
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
        output: { format: "es", entryFileNames: "crash-child.mjs" },
      },
    },
  });
  bundlePath = join(bundleDir, "crash-child.mjs");
}, 300_000);

afterEach(async () => {
  const todo = workDirs.splice(0);
  for (const w of todo) await removeDirWhenReleased(w.dir, { pids: w.pids, deadlineMs: 20_000 });
}, 60_000);

afterAll(async () => {
  if (bundleDir !== "") await removeDirWhenReleased(bundleDir, { deadlineMs: 20_000 });
}, 60_000);

/** Starts the child at `point` and resolves once it reports `READY`; it is still running (parked) then. */
async function runToPoint(home: string, point: string, work: { dir: string; pids: number[] }): Promise<Parked> {
  const child = spawn(process.execPath, [bundlePath, home, point], { cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  if (pid === undefined) throw new Error("child did not start");
  work.pids.push(pid);
  let out = "";
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    err += d;
  });
  child.stdout.setEncoding("utf8");
  const seq = await new Promise<number>((res, rej) => {
    child.stdout.on("data", (d: string) => {
      out += d;
      const m = /READY (\S+) (\d+)\n/.exec(out);
      if (m !== null) res(Number(m[2]));
    });
    child.once("error", rej);
    child.once("exit", (code, signal) => rej(new Error(`child exited early (${String(code)}/${String(signal)}): ${out}${err}`)));
  });
  return { child, pid, seq };
}

async function kill(p: Parked): Promise<void> {
  const exited = new Promise<void>((res) => p.child.once("exit", () => res()));
  p.child.kill();
  await exited;
}

async function crashAt(point: string): Promise<{ home: string; parked: Parked }> {
  const dir = await mkdtemp(join(tmpdir(), "omr-ledger-crash-"));
  const work = { dir, pids: [] as number[] };
  workDirs.push(work);
  const home = join(dir, "omr-executor");
  const parked = await runToPoint(home, point, work);
  await kill(parked);
  return { home, parked };
}

const planFiles = async (home: string): Promise<string[]> => (await readdir(join(home, PLAN_ID))).sort();

/** Reload as a reader and as the next writer (the dead child's lock is stale by dead pid). */
async function reloadBoth(home: string, expectedSeq: number): Promise<LedgerV1> {
  const store = createLedgerStore({ home });
  const asReader = await store.read(PLAN_ID);
  expect(asReader.seq).toBe(expectedSeq);
  const writer = await store.takeover(PLAN_ID, holderOf("parent", process.pid, hostname()), "recover after crash");
  try {
    // Same ledger, plus the journaled lock-takeover event.
    expect(writer.ledger.seq).toBe(expectedSeq + 1);
    expect({ ...writer.ledger, seq: expectedSeq }).toEqual(asReader);
    expect((await planFiles(home)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  } finally {
    await writer.close();
  }
  const after = await store.read(PLAN_ID);
  expect(after.seq).toBe(expectedSeq + 1);
  return asReader;
}

describe("ledger store: crash points (child process killed)", () => {
  it("after a journal write, before the snapshot: the load yields the last fsynced state", async () => {
    const { home, parked } = await crashAt("after-journal-before-snapshot");
    expect(parked.seq).toBe(4);
    const snapshot = JSON.parse(await readFile(join(home, PLAN_ID, "ledger.json"), "utf8")) as LedgerV1;
    expect(snapshot.seq).toBe(1); // the snapshot never got written: the journal carries seq 2..4
    const files = await planFiles(home);
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    const ledger = await reloadBoth(home, 4);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });

  it("during the temp write: a torn temp file is ignored and cleaned; the load yields the last fsynced state", async () => {
    const { home, parked } = await crashAt("during-temp-write");
    expect(parked.seq).toBe(4);
    const tmps = (await planFiles(home)).filter((f) => f.startsWith("ledger.json.tmp-"));
    expect(tmps).toHaveLength(1);
    const torn = await readFile(join(home, PLAN_ID, tmps[0] as string), "utf8");
    expect(() => JSON.parse(torn)).toThrow(); // half a snapshot
    const snapshot = JSON.parse(await readFile(join(home, PLAN_ID, "ledger.json"), "utf8")) as LedgerV1;
    expect(snapshot.seq).toBe(1);
    const ledger = await reloadBoth(home, 4);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });

  it("after the temp write, before the rename: the complete temp file is not trusted; the journal wins", async () => {
    const { home, parked } = await crashAt("after-temp-write-before-rename");
    expect(parked.seq).toBe(4);
    const tmps = (await planFiles(home)).filter((f) => f.startsWith("ledger.json.tmp-"));
    expect(tmps).toHaveLength(1);
    const full = JSON.parse(await readFile(join(home, PLAN_ID, tmps[0] as string), "utf8")) as LedgerV1;
    expect(full.seq).toBe(4);
    const snapshot = JSON.parse(await readFile(join(home, PLAN_ID, "ledger.json"), "utf8")) as LedgerV1;
    expect(snapshot.seq).toBe(1);
    const ledger = await reloadBoth(home, 4);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
  });

  const expectDispatchedSurvives = async (point: string): Promise<void> => {
    const { home, parked } = await crashAt(point);
    expect(parked.seq).toBe(6); // init, T3, ready, attempt-started, task-slot, dispatched
    const ledger = await reloadBoth(home, parked.seq);
    const t1 = ledger.tasks.T1;
    expect(t1?.state).toBe("dispatched");
    expect(t1?.slot).toBe("slot-1");
    expect(t1?.attempts).toHaveLength(1);
    expect(t1?.attempts[0]?.outcome).toBeNull();
    expect(t1?.attempts[0]?.childSessionID).toBeNull(); // the launch never happened
  };

  it("between a `dispatched` fsync and the launch (batch covered by a snapshot): the dispatched state and its open attempt survive", async () => {
    await expectDispatchedSurvives("dispatched-snapshotted");
  });

  // The dispatched batch has three events and no snapshot covers it: the load must replay a multi-event batch from the journal.
  it("between a `dispatched` fsync and the launch (batch only in the journal): the dispatched state survives", async () => {
    await expectDispatchedSurvives("dispatched-before-launch");
  });
});
