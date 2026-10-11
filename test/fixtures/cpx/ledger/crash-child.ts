// Child process of test/integration/executor-ledger-crash.test.ts: runs the REAL ledger store against a real directory and stops
// (hangs, never exits) at one named crash point so the parent can kill it there. Bundled to .mjs by the test; not imported by it.
//
// argv: <home> <crash point>. stdout: one line `READY <point> <in-memory seq>` once the child is parked at the crash point.
import { createLedgerStore, createNodeFileSystem } from "../../../../src/executor/ledger.js";
import type { LedgerWriter } from "../../../../src/executor/types.js";
import { addTask, buildDraft, holderOf, PLAN_ID } from "./builders.js";
import { interceptFs, type FsCall } from "./fakes.js";
import { hostname } from "node:os";

// `dispatched-before-launch` keeps the dispatched batch only in the journal (no snapshot covers it); `dispatched-snapshotted` lets the
// snapshot cadence (every 3 events) cover it before the child parks.
type Point =
  | "after-journal-before-snapshot"
  | "during-temp-write"
  | "after-temp-write-before-rename"
  | "dispatched-before-launch"
  | "dispatched-snapshotted";

function isPoint(v: string | undefined): v is Point {
  return v === "after-journal-before-snapshot" || v === "during-temp-write" || v === "after-temp-write-before-rename" ||
    v === "dispatched-before-launch" || v === "dispatched-snapshotted";
}

const home = process.argv[2];
const point = process.argv[3];
if (home === undefined || !isPoint(point)) {
  process.stderr.write("usage: crash-child <home> <point>\n");
  process.exit(2);
}

const keepAlive = setInterval(() => undefined, 1_000);
let writer: LedgerWriter | null = null;
let armed = false;

function park(): Promise<void> {
  process.stdout.write(`READY ${point} ${writer === null ? 0 : writer.ledger.seq}\n`);
  return new Promise<void>(() => undefined);
}

const isSnapshotTmp = (p: string): boolean => /ledger\.\d+\.json\.tmp-/.test(p);

const fs = interceptFs(
  createNodeFileSystem(),
  async (call: FsCall) => {
    if (!armed) return;
    if (point === "after-journal-before-snapshot" && call.op === "writeText" && isSnapshotTmp(call.path)) await park();
    if (point === "during-temp-write" && call.op === "writeText" && isSnapshotTmp(call.path)) {
      armed = false;
      return { writePartial: Math.floor((call.data ?? "").length / 2) };
    }
    if (point === "after-temp-write-before-rename" && call.op === "rename" && isSnapshotTmp(call.path)) await park();
  },
  // After the partial temp write the process is "killed": park for the parent.
  () => park(),
);

const store = createLedgerStore({ home, fs, snapshotEvery: point === "dispatched-before-launch" ? 200 : 3 });
writer = await store.create(buildDraft(2), holderOf("child", process.pid, hostname()));
// Last fsynced state before the crash window: seq 2.
await writer.append([addTask("T3")]);

if (point === "dispatched-before-launch" || point === "dispatched-snapshotted") {
  armed = false;
  await writer.append([{ type: "task-transition", taskId: "T1", from: "pending", to: "ready", trigger: "deps-satisfied", detail: null }]);
  const n = (writer.ledger.tasks.T1?.attempts.length ?? 0) + 1;
  await writer.append([
    {
      type: "attempt-started",
      taskId: "T1",
      attempt: { n, nonce: "0".repeat(31) + "1", callID: null, childSessionID: null, startedAt: "2026-10-11T00:00:00.000Z", endedAt: null, outcome: null, verdict: null, context: "" },
    },
    { type: "task-slot", taskId: "T1", slot: "slot-1", branch: `omr/${PLAN_ID}/t/T1` },
    { type: "task-transition", taskId: "T1", from: "ready", to: "dispatched", trigger: "launch", detail: null },
  ]);
  // The dispatched batch is fsynced and `append` has resolved; the launch would be next.
  await park();
} else {
  armed = true;
  // Seq 3 and 4 fill the snapshot window; the third append since the rotation triggers the snapshot.
  await writer.append([addTask("T4")]);
  await writer.append([addTask("T5")]);
  // Unreachable for the snapshot points: the interceptor parks the process inside the snapshot.
  process.stderr.write("crash point was not reached\n");
  clearInterval(keepAlive);
  process.exit(3);
}
