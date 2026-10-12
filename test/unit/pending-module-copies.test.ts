// QA-DF1-18 / QA-DF1-22: two separately loaded copies of src/verify/pending.ts in one process (one per booted location)
// share the pending journal, its writer marks and the instance beat files without dropping each other's state.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type PendingModule = typeof import("../../src/verify/pending");

/** A separately loaded copy of the module (its own `PROCESS_CLAIM_TOKEN`, shared-journal map and live tokens). */
async function loadCopy(): Promise<PendingModule> {
  vi.resetModules();
  return import("../../src/verify/pending");
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omr-pending-copies-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function marks(dir: string, writersDir: string): string[] {
  const path = join(dir, writersDir);
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function setMtime(path: string, ms: number): void {
  const seconds = ms / 1000;
  utimesSync(path, seconds, seconds);
}

function journalLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Records of a kind the compaction does not know: always kept (`compactPendingRecords`). */
function note(key: string): { v: 1; kind: string; key: string } {
  return { v: 1, kind: "x-test-note", key };
}

/** A `state` record of a handle with no entry: the start-up compaction drops it, so its presence shows no compaction ran. */
const EXPIRED = { v: 1, kind: "state", handle: "vrf_ghost", state: "verified", key: "ghost" } as const;

describe("QA-DF1-18 two module copies share the pending journal", () => {
  it("QA-DF1-18 the first copy's writer mark and append survive the second copy's start", async () => {
    const dir = tempDir();
    const file = join(dir, "pending.jsonl");
    const copyA = await loadCopy();
    const journalA = copyA.createPendingFileJournal(file, { compactAtStart: false });
    await journalA.append(note("a-1"));
    await journalA.flush();
    const [markA] = marks(dir, copyA.PENDING_WRITERS_DIRNAME);
    expect(markA).toMatch(new RegExp(`^${process.pid}\\.`));
    // A record the start-up compaction would drop: if the second copy compacted, it would be gone.
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(EXPIRED)}\n`);

    const copyB = await loadCopy();
    expect(copyB).not.toBe(copyA);
    const journalB = copyB.createPendingFileJournal(file, {});
    await journalB.load();
    await journalB.flush();

    const both = marks(dir, copyA.PENDING_WRITERS_DIRNAME);
    expect(both).toHaveLength(2);
    expect(both).toContain(markA);
    expect(journalLines(file).map((record) => record.key)).toEqual(["a-1", EXPIRED.key]);

    await journalA.append(note("a-2"));
    await journalB.append(note("b-1"));
    await Promise.all([journalA.flush(), journalB.flush()]);
    expect(journalLines(file).map((record) => record.key)).toEqual(["a-1", EXPIRED.key, "a-2", "b-1"]);
    expect(marks(dir, copyA.PENDING_WRITERS_DIRNAME)).toContain(markA);
    expect(readdirSync(dir).filter((name) => name.endsWith(".compact"))).toEqual([]);

    await journalB.dispose();
    await journalA.dispose();
    expect(marks(dir, copyA.PENDING_WRITERS_DIRNAME)).toEqual([]);
  });

  it("QA-DF1-18 a recreate in one copy merges the snapshot of the other copy's journal", async () => {
    const dir = tempDir();
    const file = join(dir, "pending.jsonl");
    const copyA = await loadCopy();
    const journalA = copyA.createPendingFileJournal(file, { compactAtStart: false });
    journalA.setSnapshotProvider(() => [note("a-held")]);
    await journalA.append(note("a-held"));
    await journalA.flush();
    const copyB = await loadCopy();
    const journalB = copyB.createPendingFileJournal(file, { compactAtStart: false });
    await journalB.append(note("b-held"));
    await journalB.flush();

    rmSync(file); // the journal vanished
    await journalB.recreate([note("b-held")]);
    expect(journalLines(file).map((record) => record.key)).toEqual(["b-held", "a-held"]);
    expect(marks(dir, copyA.PENDING_WRITERS_DIRNAME)).toHaveLength(2);

    // A disposed copy's provider is gone: a later recreate holds only the live copy's records.
    await journalA.dispose();
    rmSync(file);
    await journalB.recreate([note("b-held")]);
    expect(journalLines(file).map((record) => record.key)).toEqual(["b-held"]);
    await journalB.dispose();
  });

  it("QA-DF1-18 a stale same-pid mark of another token without a fresh beat is removed and the journal compacts", async () => {
    const dir = tempDir();
    const file = join(dir, "pending.jsonl");
    const copy = await loadCopy();
    const writers = join(dir, copy.PENDING_WRITERS_DIRNAME);
    mkdirSync(writers, { recursive: true });
    const old = Date.now() - copy.WRITER_MARK_STALE_MS - 60_000;
    const earlier = `${process.pid}.0123456789abcdef`;
    writeFileSync(join(writers, earlier), `${JSON.stringify({ pid: process.pid, token: "0123456789abcdef", at: old })}\n`);
    writeFileSync(file, `${JSON.stringify(note("live"))}\n${JSON.stringify(EXPIRED)}\n`);

    const journal = copy.createPendingFileJournal(file, {});
    await journal.load();
    await journal.flush();
    expect(marks(dir, copy.PENDING_WRITERS_DIRNAME)).not.toContain(earlier);
    expect(journalLines(file).map((record) => record.key)).toEqual(["live"]);
    await journal.dispose();
  });

  it("QA-DF1-18 a fresh same-pid mark of another token blocks the compaction and is kept, with no beat file", async () => {
    const dir = tempDir();
    const file = join(dir, "pending.jsonl");
    const copy = await loadCopy();
    const writers = join(dir, copy.PENDING_WRITERS_DIRNAME);
    mkdirSync(writers, { recursive: true });
    const mark = `${process.pid}.00112233aabbccdd`;
    writeFileSync(join(writers, mark), `${JSON.stringify({ pid: process.pid, token: "00112233aabbccdd", at: Date.now() })}\n`);
    writeFileSync(file, `${JSON.stringify(note("live"))}\n${JSON.stringify(EXPIRED)}\n`);

    const journal = copy.createPendingFileJournal(file, {});
    await journal.load();
    await journal.flush();
    expect(marks(dir, copy.PENDING_WRITERS_DIRNAME)).toContain(mark);
    expect(journalLines(file).map((record) => record.key)).toEqual(["live", EXPIRED.key]);
    await journal.dispose();
  });

  it("QA-DF1-18 a stale same-pid mark whose copy still beats in pending.instances blocks the compaction", async () => {
    const dir = tempDir();
    const file = join(dir, "pending.jsonl");
    const copy = await loadCopy();
    const writers = join(dir, copy.PENDING_WRITERS_DIRNAME);
    mkdirSync(writers, { recursive: true });
    const siblingToken = "fedcba9876543210";
    const mark = `${process.pid}.${siblingToken}`;
    writeFileSync(join(writers, mark), `${JSON.stringify({ pid: process.pid, token: siblingToken, at: Date.now() - copy.WRITER_MARK_STALE_MS - 60_000 })}\n`);
    copy.writeInstanceBeat(join(dir, copy.PENDING_INSTANCES_DIRNAME), `${siblingToken}.abcd0123`, { pid: process.pid, now: Date.now() });
    writeFileSync(file, `${JSON.stringify(note("live"))}\n${JSON.stringify(EXPIRED)}\n`);

    const journal = copy.createPendingFileJournal(file, {});
    await journal.load();
    await journal.flush();
    expect(marks(dir, copy.PENDING_WRITERS_DIRNAME)).toContain(mark);
    expect(journalLines(file).map((record) => record.key)).toEqual(["live", EXPIRED.key]);
    await journal.dispose();
  });
});

describe("QA-DF1-22 instance beats", () => {
  it("QA-DF1-22 writes a beat via temp file and rename, leaving no temp file", async () => {
    const pending = await loadCopy();
    const beats = join(tempDir(), pending.PENDING_INSTANCES_DIRNAME);
    pending.writeInstanceBeat(beats, "tok.1", { pid: process.pid, now: 1_000 });
    pending.writeInstanceBeat(beats, "tok.1", { pid: process.pid, now: 2_000 });
    expect(readdirSync(beats)).toEqual([encodeURIComponent("tok.1")]);
    expect(JSON.parse(readFileSync(join(beats, encodeURIComponent("tok.1")), "utf8"))).toEqual({ pid: process.pid, token: "tok.1", at: 2_000 });
  });

  it("QA-DF1-22 a half-written beat with a fresh mtime keeps the sibling's claim (fail closed)", async () => {
    const pending = await loadCopy();
    const dir = tempDir();
    const claims = join(dir, "pending.claims");
    const beats = join(dir, pending.PENDING_INSTANCES_DIRNAME);
    const sibling = "sibling.0001";
    mkdirSync(claims, { recursive: true });
    mkdirSync(beats, { recursive: true });
    const now = Date.now();
    writeFileSync(join(claims, "ses_1"), `${JSON.stringify({ pid: process.pid, token: sibling, at: now })}\n`);
    writeFileSync(join(beats, encodeURIComponent(sibling)), '{"pid":'); // torn
    const seams = { pid: process.pid, now, isAlive: () => true, token: "mine.0001", beatsDir: beats };
    expect(pending.claimPendingSession(claims, "ses_1", seams)).toBe(false);
  });

  it("QA-DF1-22 a half-written beat with an old mtime no longer protects the claim", async () => {
    const pending = await loadCopy();
    const dir = tempDir();
    const claims = join(dir, "pending.claims");
    const beats = join(dir, pending.PENDING_INSTANCES_DIRNAME);
    const sibling = "sibling.0002";
    mkdirSync(claims, { recursive: true });
    mkdirSync(beats, { recursive: true });
    const now = Date.now();
    writeFileSync(join(claims, "ses_2"), `${JSON.stringify({ pid: process.pid, token: sibling, at: now })}\n`);
    const beat = join(beats, encodeURIComponent(sibling));
    writeFileSync(beat, '{"pid":');
    setMtime(beat, now - pending.CLAIM_STALE_MS - 60_000);
    const seams = { pid: process.pid, now, isAlive: () => true, token: "mine.0002", beatsDir: beats };
    expect(pending.claimPendingSession(claims, "ses_2", seams)).toBe(true);
  });

  it("QA-DF1-22 sweepInstanceBeats removes stale beats and temp files and keeps fresh ones", async () => {
    const pending = await loadCopy();
    const beats = join(tempDir(), pending.PENDING_INSTANCES_DIRNAME);
    const now = Date.now();
    pending.writeInstanceBeat(beats, "fresh.1", { pid: process.pid, now });
    pending.writeInstanceBeat(beats, "stale.1", { pid: process.pid, now: now - pending.CLAIM_STALE_MS - 1 });
    writeFileSync(join(beats, "torn.fresh"), "{");
    const tornOld = join(beats, "torn.old");
    writeFileSync(tornOld, "{");
    setMtime(tornOld, now - pending.CLAIM_STALE_MS - 60_000);
    const oldTemp = join(beats, "gone.1.beat-tmp");
    writeFileSync(oldTemp, "{");
    setMtime(oldTemp, now - pending.CLAIM_STALE_MS - 60_000);
    expect(pending.sweepInstanceBeats(beats, { now })).toBe(3);
    expect(readdirSync(beats).sort()).toEqual([encodeURIComponent("fresh.1"), "torn.fresh"].sort());
  });

  it("QA-DF1-22 a new instance token sweeps the stale beats at start", async () => {
    const pending = await loadCopy();
    const beats = join(tempDir(), pending.PENDING_INSTANCES_DIRNAME);
    pending.writeInstanceBeat(beats, "crashed.1", { pid: process.pid, now: Date.now() - pending.CLAIM_STALE_MS - 1 });
    const claim = pending.createInstanceClaimToken(beats);
    expect(existsSync(join(beats, encodeURIComponent("crashed.1")))).toBe(false);
    claim.beat();
    expect(readdirSync(beats)).toEqual([encodeURIComponent(claim.token)]);
    claim.release();
    expect(readdirSync(beats)).toEqual([]);
  });
});
