import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepoLockFactory } from "../../src/executor/integrate/queue";
import { FakeClock } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// G-9: moved from executor-integrate-queue.test.ts into exec-serial, not retimed.
// Keep that file's test/hook limits and the same real-filesystem helpers and polling deadline.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const lockRoots: string[] = [];
afterEach(async () => {
  for (const r of lockRoots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
});

async function lockEnv(): Promise<{ root: string; file(repoKey: string): string }> {
  const root = await mkdtemp(join(tmpdir(), "omr-integrate-lock-"));
  lockRoots.push(root);
  return {
    root,
    file: key => join(root, "repos", createHash("sha256").update(key, "utf8").digest("hex"), "integration.lock"),
  };
}

function holder(entryId: string | null = null): { planId: string; entryId: string | null } {
  return { planId: "plan-one", entryId };
}

const realPause = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The heartbeat renames a complete side file over the lock; retry transient Windows sharing errors only. */
async function heartbeatOf(file: string): Promise<number> {
  for (let i = 0; i < 400; i++) {
    try {
      return (JSON.parse(await readFile(file, "utf8")) as { heartbeatAt: number }).heartbeatAt;
    } catch {
      await realPause(5);
    }
  }
  throw new Error("the lock file never parsed");
}

/**
 * G-17: fires the held heartbeat timer and returns the heartbeat the beat left, read only after that beat attempt has
 * finished. The factory signals that by re-arming its timer (`heldCount()` back to 1, queue.ts `beatOnce`). Reading the
 * lock file while the beat renames its side file over it makes the rename fail on Windows (EPERM: the target is open).
 * The product treats that as transient and retries at the next beat, and this fake clock never reaches that beat on its
 * own. That is why polling the file before the attempt finished timed out on CI. A beat that an outside reader (such as
 * an antivirus scan) still made fail is fired again at the same fake instant. The expected heartbeat stays the same,
 * and a beat that never lands still fails at the deadline. QA-62C-7: a failed beat re-arms at the short retry delay
 * (LOCK_HEARTBEAT_RETRY_MS, 1 s), which this fake clock holds like the normal period, so a re-fire runs that retry.
 * QA-62C-8: at most BEAT_REFIRES re-fires; more means the beat keeps failing, which is reported, not hidden.
 */
const BEAT_REFIRES = 3;
async function beatSettled(clock: FakeClock, file: string, want: number, deadline: number): Promise<number> {
  for (let refires = 0; ; refires++) {
    clock.fire();
    while (clock.heldCount() === 0 && Date.now() < deadline) await realPause(5);
    const got = await heartbeatOf(file);
    if (got === want || clock.heldCount() === 0 || Date.now() >= deadline) return got;
    if (refires >= BEAT_REFIRES) {
      throw new Error(`beatSettled: the heartbeat is still ${got}, not ${want}, after ${refires} re-fires (more than ${BEAT_REFIRES} is a beat that keeps failing)`);
    }
  }
}

describe("createRepoLockFactory (M5, I3)", () => {
  it("a re-armed heartbeat keeps beating on every period", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-S", holder(), new AbortController().signal);
    const file = env.file("repo-S");
    const t0 = await heartbeatOf(file);
    const deadline = Date.now() + 20_000;
    for (const k of [1, 2]) {
      clock.advance(1_000);
      expect(await beatSettled(clock, file, t0 + 1_000 * k, deadline)).toBe(t0 + 1_000 * k);
      expect(clock.heldCount()).toBe(1);
    }
    expect(lock.lost.aborted).toBe(false);
    await lock.release();
  });
});
