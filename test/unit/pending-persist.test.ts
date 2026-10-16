import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAIM_REFRESH_MS,
  CLAIM_STALE_MS,
  claimPendingSession,
  compactPendingRecords,
  createPendingFileJournal,
  createPendingRegistry,
  foldDormantRecords,
  HANDLE_PATTERN,
  HELD_RESERVATION_TTL_MS,
  HELD_TTL_REASON,
  MAX_DORMANT_POSTED_HOLDS,
  mergePendingSnapshots,
  PENDING_JOURNAL_VANISHED,
  pendingRecordIdentity,
  PENDING_COMPACTION_FAILED,
  PENDING_WRITERS_DIRNAME,
  WRITER_MARK_STALE_MS,
  processedKeyOf,
  REFERENCE_UNRESTORED_REASON,
  refreshPendingClaims,
  releasePendingClaim,
  resolvePendingJournalDir,
  type PendingEntry,
  type PendingRecord,
  type PendingRegistration,
  type PendingRegistryOptions,
} from "../../src/verify/pending";
import type { DoD } from "../../src/verify/dod";
import { isReferenceKept, keepReferences, serializeReference, type DispatchReference } from "../../src/verify/reference";
import type { ChangedPath } from "../../src/verify/runner";
import type { ReferenceState } from "../../src/verify/types";
import { removeDirWhenReleased } from "../helpers/remove-dir";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omr-pending-persist-"));
});

afterEach(async () => {
  await removeDirWhenReleased(dir);
});

const NOW = 10_000_000;
const TTL = 3_600_000;

function rec(kind: string, fields: Record<string, unknown>): PendingRecord {
  return { v: 1, kind, ...fields };
}

describe("processedKeyOf", () => {
  it("prefers an explicit key, else child NUL callID", () => {
    expect(processedKeyOf({ key: "k1", child: "c", callID: "x" })).toBe("k1");
    expect(processedKeyOf({ child: "ses_c", callID: "call1" })).toBe("ses_c\u0000call1");
    expect(processedKeyOf({ child: "ses_c" })).toBeUndefined();
    expect(processedKeyOf({ key: "" })).toBeUndefined();
  });
});

describe("foldDormantRecords (memo 11.3)", () => {
  it("keeps open inflight and hold records per parent session", () => {
    const { sessions, processed } = foldDormantRecords(
      [
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW - 1000 }),
        rec("inflight", { callID: "c2", parentSessionID: "p2", childSessionID: "k2", at: NOW - 1000 }),
        rec("hold", { handle: "vrf_1", parent: "p1", child: "k1", callID: "c1", at: NOW - 1000 }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(processed.size).toBe(0);
    expect([...sessions.keys()].sort()).toEqual(["p1", "p2"]);
    expect(sessions.get("p1")?.inflight.map((r) => r.callID)).toEqual(["c1"]);
    expect(sessions.get("p1")?.holds.map((r) => r.handle)).toEqual(["vrf_1"]);
    expect(sessions.get("p2")?.inflight.map((r) => r.callID)).toEqual(["c2"]);
  });

  it("a processed record closes its inflight and is remembered as a key", () => {
    const { sessions, processed } = foldDormantRecords(
      [
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }),
        rec("processed", { callID: "c1", child: "k1", at: NOW }),
        rec("processed", { key: "explicit-key", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.size).toBe(0);
    expect(processed).toEqual(new Set(["k1\u0000c1", "explicit-key"]));
  });

  it("posted turns a hold into an inactive placeholder (QA-2.1-10); a tomb closes the inflight of its callID but never the hold (QA-2.1-28)", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("hold", { handle: "vrf_a", parent: "p1", child: "k1", callID: "c1" }),
        rec("hold", { handle: "vrf_b", parent: "p1", child: "k2", callID: "c2" }),
        rec("hold", { handle: "vrf_c", parent: "p1", child: "k3", callID: "c3" }),
        rec("inflight", { callID: "c2", parent: "p1", child: "k2", at: NOW }),
        rec("hold-text", { handle: "vrf_a", text: "child said", at: NOW }),
        rec("posting", { handle: "vrf_a", text: "verdict", at: NOW }),
        rec("posted", { handle: "vrf_a", at: NOW }),
        rec("tomb", { handle: "vrf_b", callID: "c2", cause: "ttl", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    // One `hold` record per hold; the posted one is followed by its `posted` record only (its text and posting are gone).
    // QA-2.1-28: the entry tomb of vrf_b leaves its hold (it still owes a verdict); only its callID's inflight is closed.
    expect(sessions.get("p1")?.holds.map((r) => `${r.kind}:${String(r.handle)}`)).toEqual(["hold:vrf_a", "posted:vrf_a", "hold:vrf_b", "hold:vrf_c"]);
    expect(sessions.get("p1")?.holds.filter((r) => r.kind === "hold").map((r) => r.handle)).toEqual(["vrf_a", "vrf_b", "vrf_c"]);
    expect(sessions.get("p1")?.inflight).toEqual([]);
  });

  it("QA-2.1-28: a TTL tomb of a posted hold's entry keeps the placeholder, so the raw completion stays hidden after a restart", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("hold", { handle: "vrf_p", parent: "p1", child: "k1", callID: "c1" }),
        rec("posted", { handle: "vrf_p", at: NOW }),
        rec("tomb", { handle: "vrf_p", cause: "ttl", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.holds.map((r) => `${r.kind}:${String(r.handle)}`)).toEqual(["hold:vrf_p", "posted:vrf_p"]);
  });

  it("QA-2.1-17: a verdict reached but never posting rides with its hold, through the fold and the compaction", () => {
    const verdict = { pass: true, outcome: "pass", method: "deterministic", reasons: [], caveats: [] };
    const label = (r: PendingRecord): string => `${r.kind}:${String(r.handle ?? r.callID ?? "")}`;
    const records = [
      rec("entry", { handle: "vrf_v", parent: "p1", state: "held", createdAt: NOW }),
      rec("hold", { handle: "vrf_v", parent: "p1", child: "k1", callID: "c1" }),
      rec("hold-text", { handle: "vrf_v", text: "done", status: "succeeded", at: NOW }),
      rec("state", { handle: "vrf_v", state: "verifying", at: NOW }),
      rec("state", { handle: "vrf_v", state: "verified", verdict, at: NOW }),
      // A verdict already posting is re-posted from its `posting` record instead: no state record is handed over.
      rec("entry", { handle: "vrf_w", parent: "p1", state: "held", createdAt: NOW }),
      rec("hold", { handle: "vrf_w", parent: "p1", child: "k2", callID: "c2" }),
      rec("state", { handle: "vrf_w", state: "verified", verdict, at: NOW }),
      rec("posting", { handle: "vrf_w", text: "verdict text", at: NOW }),
    ];
    const labels = (input: PendingRecord[]) => foldDormantRecords(input, { now: NOW, ttlMs: TTL }).sessions.get("p1")?.holds.map((r) => `${r.kind}:${String(r.handle)}`);
    expect(labels(records)).toEqual(["hold:vrf_v", "hold-text:vrf_v", "state:vrf_v", "hold:vrf_w", "posting:vrf_w"]);
    const kept = compactPendingRecords(records, { now: NOW, ttlMs: TTL });
    // The verified entry of the unposted hold stays (entry and state); the one already posting goes.
    expect(kept.map(label)).toEqual(["entry:vrf_v", "hold:vrf_v", "hold-text:vrf_v", "state:vrf_v", "hold:vrf_w", "posting:vrf_w"]);
    expect(labels(kept)).toEqual(labels(records));
    // A second compaction keeps it too.
    expect(compactPendingRecords(kept, { now: NOW, ttlMs: TTL }).map(label)).toEqual(kept.map(label));
  });

  it("an open hold carries its hold-text and only its newest posting record (QA-2.1-2, QA-2.1-6)", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("hold", { handle: "vrf_a", parent: "p1", child: "k1", callID: "c1" }),
        rec("hold-text", { handle: "vrf_a", text: "child said", at: NOW }),
        rec("posting", { handle: "vrf_a", text: "first", at: NOW }),
        rec("posting", { handle: "vrf_a", text: "second", at: NOW }),
        rec("posting", { handle: "vrf_unknown", text: "orphan", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.holds.map((r) => [r.kind, r.text])).toEqual([
      ["hold", undefined],
      ["hold-text", "child said"],
      ["posting", "second"],
    ]);
  });

  it("forget removes the session's earlier records but not later ones", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }),
        rec("hold", { handle: "vrf_a", parent: "p1", child: "k1", callID: "c1" }),
        rec("inflight", { callID: "c9", parent: "p9", child: "k9", at: NOW }),
        rec("forget", { session: "p1", at: NOW }),
        rec("inflight", { callID: "c2", parent: "p1", child: "k2", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.inflight.map((r) => r.callID)).toEqual(["c2"]);
    expect(sessions.get("p1")?.holds).toEqual([]);
    expect(sessions.get("p9")?.inflight).toHaveLength(1);
  });

  it("drops inflight records older than the TTL but never hold records", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("inflight", { callID: "old", parent: "p1", child: "k1", at: NOW - TTL - 1 }),
        rec("inflight", { callID: "edge", parent: "p1", child: "k2", at: NOW - TTL }),
        rec("inflight", { callID: "noat", parent: "p1", child: "k3" }),
        rec("hold", { handle: "vrf_old", parent: "p1", child: "k1", callID: "old", at: 1 }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.inflight.map((r) => r.callID)).toEqual(["edge"]);
    expect(sessions.get("p1")?.holds.map((r) => r.handle)).toEqual(["vrf_old"]);
  });

  it("ignores records missing the fields that identify them and unknown kinds", () => {
    const { sessions, processed } = foldDormantRecords(
      [
        rec("inflight", { callID: "", parent: "p1", child: "k1" }),
        rec("inflight", { callID: "c1", child: "k1" }),
        rec("hold", { handle: "", parent: "p1", child: "k1" }),
        rec("hold", { handle: "vrf_x", parent: "p1" }),
        rec("posted", {}),
        rec("tomb", {}),
        rec("forget", {}),
        rec("processed", {}),
        rec("state", { handle: "vrf_x", state: "verified" }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.size).toBe(0);
    expect(processed.size).toBe(0);
  });

  it("a later record for one key replaces the earlier (fold by key)", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", agent: "a", at: NOW }),
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", agent: "b", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.inflight).toHaveLength(1);
    expect(sessions.get("p1")?.inflight[0]?.agent).toBe("b");
  });

  it("another session's records never appear under this one (dormant by parent)", () => {
    const { sessions } = foldDormantRecords(
      [rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }), rec("hold", { handle: "vrf_a", parent: "p2", child: "k2", callID: "c2" })],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.holds).toEqual([]);
    expect(sessions.get("p2")?.inflight).toEqual([]);
    expect(sessions.get("p3")).toBeUndefined();
  });
});

describe("pending.jsonl journal (memo 11.1, 11.2)", () => {
  it("appends one line per record and loads them back in order, with and without fsync", async () => {
    const file = join(dir, "nested", "pending.jsonl");
    const journal = createPendingFileJournal(file);
    await journal.append(rec("inflight", { callID: "c1" }));
    await journal.append(rec("hold", { handle: "vrf_1" }), { fsync: true });
    await journal.append(rec("posted", { handle: "vrf_1" }));
    await journal.flush();
    const loaded = await journal.load();
    expect(loaded.map((r) => r.kind)).toEqual(["inflight", "hold", "posted"]);
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(3);
    await journal.flush(); // the compaction at start runs behind the load
  });

  it("a missing file loads as empty", async () => {
    const journal = createPendingFileJournal(join(dir, "none.jsonl"));
    expect(await journal.load()).toEqual([]);
  });

  it("skips a torn last line, an invalid line, a wrong version and a non-object", async () => {
    const file = join(dir, "pending.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ v: 1, kind: "inflight", callID: "c1" }),
        "not json",
        JSON.stringify({ v: 2, kind: "inflight", callID: "future" }),
        JSON.stringify({ v: 1 }),
        "123",
        "null",
        "",
        JSON.stringify({ v: 1, kind: "hold", handle: "vrf_1" }),
        '{"v":1,"kind":"posted","handle":"vrf_',
      ].join("\n"),
    );
    const loaded = await createPendingFileJournal(file).load();
    expect(loaded.map((r) => r.kind)).toEqual(["inflight", "hold"]);
  });

  it("a later append after a failed one still lands (the chain keeps going)", async () => {
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "a file, not a directory");
    const journal = createPendingFileJournal(join(blocker, "pending.jsonl"));
    await expect(journal.append(rec("inflight", { callID: "c1" }))).rejects.toThrow();
    await journal.flush();
  });

  it("serializes concurrent appends in call order", async () => {
    const file = join(dir, "pending.jsonl");
    const journal = createPendingFileJournal(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => journal.append(rec("inflight", { callID: `c${i}` }), { fsync: i % 2 === 0 })));
    const loaded = await journal.load();
    expect(loaded.map((r) => r.callID)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
    await journal.flush(); // the compaction at start runs behind the load
  });

  it("a journal this process knew that goes missing fails the next load and append, never recreated (QA-2.1-8)", async () => {
    const file = join(dir, "pending.jsonl");
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    await journal.append(rec("inflight", { callID: "c1" }));
    rmSync(file);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    await expect(journal.append(rec("inflight", { callID: "c2" }))).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    await journal.flush();
    expect(existsSync(file)).toBe(false);
  });

  it("a journal read once that goes missing fails the next load (QA-2.1-8)", async () => {
    const file = join(dir, "pending.jsonl");
    writeFileSync(file, `${JSON.stringify(rec("inflight", { callID: "c1" }))}\n`);
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    expect(await journal.load()).toHaveLength(1);
    rmSync(file);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
  });

  it("concurrent loads share one read and hand out separate arrays", async () => {
    const file = join(dir, "pending.jsonl");
    writeFileSync(file, `${JSON.stringify(rec("inflight", { callID: "c1" }))}\n`);
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    const [a, b] = await Promise.all([journal.load(), journal.load()]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.length = 0;
    expect(await journal.load()).toHaveLength(1);
  });

  it("the first load compacts the journal behind it: closed records go, open ones stay in order (QA-2.1-8)", async () => {
    const file = join(dir, "pending.jsonl");
    const lines = [
      rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }),
      rec("processed", { callID: "c1", child: "k1", at: NOW }),
      rec("inflight", { callID: "c2", parent: "p1", child: "k2", at: NOW }),
    ];
    writeFileSync(file, lines.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const journal = createPendingFileJournal(file);
    expect((await journal.load()).map((r) => r.kind)).toEqual(["inflight", "processed", "inflight"]);
    await journal.flush();
    expect(journal.compactionError).toBeUndefined();
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as PendingRecord).callID)).toEqual(["c2"]);
    expect((await journal.load()).map((r) => r.callID)).toEqual(["c2"]);
    // The compacted file exists from now on: a missing one has vanished.
    rmSync(file);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
  });

  it("no compaction while another live process writes the same journal (its writers mark)", async () => {
    const file = join(dir, "pending.jsonl");
    const lines = [rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }), rec("processed", { callID: "c1", child: "k1", at: NOW })];
    writeFileSync(file, lines.map((r) => `${JSON.stringify(r)}\n`).join(""));
    mkdirSync(join(dir, "pending.writers"), { recursive: true });
    writeFileSync(join(dir, "pending.writers", `${process.ppid}.other`), "{}\n");
    const journal = createPendingFileJournal(file);
    await journal.load();
    await journal.flush();
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("compactAtStart: false keeps the file as it is", async () => {
    const file = join(dir, "pending.jsonl");
    writeFileSync(file, `${JSON.stringify(rec("processed", { callID: "c1", child: "k1" }))}\n`);
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    await journal.load();
    await journal.flush();
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("compact rewrites the file with the given records, behind earlier appends", async () => {
    const file = join(dir, "pending.jsonl");
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    void journal.append(rec("inflight", { callID: "c1" }));
    await journal.compact([rec("inflight", { callID: "c9" })]);
    expect((await journal.load()).map((r) => r.callID)).toEqual(["c9"]);
  });

  it("QA-2.1-15: two journals of one path in one process share one queue: appends around the other's start-up compaction are kept", async () => {
    const file = join(dir, "pending.jsonl");
    const closed = [rec("inflight", { callID: "c0", parent: "p1", child: "k0", at: NOW }), rec("processed", { callID: "c0", child: "k0", at: NOW })];
    writeFileSync(file, closed.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const first = createPendingFileJournal(file);
    // Another plugin instance of the same process, with another spelling of the same path.
    const second = createPendingFileJournal(join(dir, ".", "pending.jsonl"));
    const open = (callID: string) => rec("inflight", { callID, parent: "p1", child: `k-${callID}`, at: NOW });
    const before = Array.from({ length: 5 }, (_, i) => first.append(open(`a${i}`), { fsync: true }));
    // The second instance's first load schedules the start-up compaction (closed records go) while the first keeps appending.
    const loading = second.load();
    const during = Array.from({ length: 5 }, (_, i) => first.append(open(`b${i}`), { fsync: i % 2 === 0 }));
    await loading;
    const after = Array.from({ length: 5 }, (_, i) => first.append(open(`c${i + 1}`), { fsync: true }));
    await Promise.all([...before, ...during, ...after]);
    // One queue: the first instance's flush also waits for the compaction the second one scheduled.
    await first.flush();
    expect(first.compactionError).toBeUndefined();
    expect(second.compactionError).toBeUndefined();
    const onDisk = readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as PendingRecord).callID);
    const expected = [...["a", "b"].flatMap((p) => Array.from({ length: 5 }, (_, i) => `${p}${i}`)), ...Array.from({ length: 5 }, (_, i) => `c${i + 1}`)];
    // Compacted (the closed c0 pair is gone) and nothing the first instance fsync'd or appended is lost.
    expect(onDisk).not.toContain("c0");
    expect([...onDisk].sort()).toEqual([...expected].sort());
    expect((await first.load()).map((r) => r.callID).sort()).toEqual([...expected].sort());
    // Exactly one writer mark for this process, whatever the number of journals.
    expect(readdirSync(join(dir, PENDING_WRITERS_DIRNAME)).filter((name) => name.startsWith(`${process.pid}.`))).toHaveLength(1);
    // G-17: this test is bound by disk I/O, not by CPU. The one shared queue runs 13 fsync'd appends (5 before, 3 during,
    // 5 after) one after another, plus the start-up compaction's rewrite. On the shared disk of a windows-latest runner,
    // with the parallel pool writing too, it took 6431 ms against the 5 s default (PR #116, win24). It takes 452 ms on
    // win22. The order and content assertions are unchanged.
  }, 30_000);

  it("QA-2.1-16: recreate rewrites a vanished journal from the caller's records; later loads and appends succeed again", async () => {
    const stateDir = join(dir, "state");
    const file = join(stateDir, "pending.jsonl");
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    await journal.append(rec("hold", { handle: "vrf_1" }), { fsync: true });
    // The whole state directory is cleaned: the journal has vanished and stays fail closed.
    rmSync(stateDir, { recursive: true, force: true });
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    await expect(journal.append(rec("posted", { handle: "vrf_0" }))).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    // The caller rewrites it from its in-memory state.
    await journal.recreate([rec("hold", { handle: "vrf_1" }), rec("inflight", { callID: "c2" })]);
    expect((await journal.load()).map((r) => r.kind)).toEqual(["hold", "inflight"]);
    await journal.append(rec("posted", { handle: "vrf_1" }), { fsync: true });
    expect((await journal.load()).map((r) => r.kind)).toEqual(["hold", "inflight", "posted"]);
    // Another journal of the same path sees the recreated file, and this process is marked as its writer again.
    expect((await createPendingFileJournal(file, { compactAtStart: false }).load()).map((r) => r.kind)).toEqual(["hold", "inflight", "posted"]);
    expect(readdirSync(join(stateDir, PENDING_WRITERS_DIRNAME)).filter((name) => name.startsWith(`${process.pid}.`))).toHaveLength(1);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".compact"))).toEqual([]);
    // A later vanish is detected again (the journal is known).
    rmSync(file);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
  });

  it("QA-2.1-16: a recreate that cannot write rejects and keeps the journal fail closed", async () => {
    const stateDir = join(dir, "state");
    const file = join(stateDir, "pending.jsonl");
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    await journal.append(rec("hold", { handle: "vrf_1" }));
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, "a file where the state directory was");
    await expect(journal.recreate([rec("hold", { handle: "vrf_1" })])).rejects.toThrow();
    await expect(journal.append(rec("posted", { handle: "vrf_1" }))).rejects.toThrow();
    rmSync(stateDir);
    await expect(journal.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    await journal.recreate([rec("hold", { handle: "vrf_1" })]);
    expect((await journal.load()).map((r) => r.handle)).toEqual(["vrf_1"]);
  });

  it("QA-2.1-33: two journals of one path with distinct in-memory records: one instance's recreate writes both sets, each record once", async () => {
    const stateDir = join(dir, "state");
    const file = join(stateDir, "pending.jsonl");
    const first = createPendingFileJournal(file, { compactAtStart: false });
    // Another plugin instance of the same process, with another spelling of the same path.
    const second = createPendingFileJournal(join(stateDir, ".", "pending.jsonl"), { compactAtStart: false });
    const shared = rec("hold", { handle: "vrf_both" }); // both instances loaded it from the journal
    const firstState = [rec("hold", { handle: "vrf_a" }), rec("inflight", { callID: "c-a" }), shared];
    const secondState = [rec("hold", { handle: "vrf_b" }), rec("inflight", { callID: "c-b" }), shared];
    let secondCalls = 0;
    let firstCalls = 0;
    first.setSnapshotProvider(() => {
      firstCalls += 1;
      return firstState;
    });
    // A provider may be async; the second instance does nothing when the first one recreates.
    second.setSnapshotProvider(async () => {
      secondCalls += 1;
      return secondState;
    });
    await first.append(rec("hold", { handle: "vrf_a" }), { fsync: true });
    await second.append(rec("hold", { handle: "vrf_b" }), { fsync: true });
    rmSync(stateDir, { recursive: true, force: true });
    await expect(first.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    // The first instance recreates from its memory (as the plugin does: its own snapshot is also its `records`).
    await first.recreate(firstState);
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toEqual([...firstState, ...secondState.filter((r) => r !== shared)].map((r) => JSON.stringify(r)));
    expect(new Set(lines).size).toBe(lines.length);
    expect(secondCalls).toBe(1);
    // The caller's own provider is not asked again: its state is `records`, counted once.
    expect(firstCalls).toBe(0);
    // Both instances read the recreated file, and both append again.
    expect((await second.load()).map((r) => r.handle ?? r.callID).sort()).toEqual(["c-a", "c-b", "vrf_a", "vrf_b", "vrf_both"]);
    await second.append(rec("posted", { handle: "vrf_b" }));
    expect((await first.load()).map((r) => r.kind)).toEqual(["hold", "inflight", "hold", "hold", "inflight", "posted"]);
    // The other instance recreates next time: now the first one's provider is asked, once.
    rmSync(file);
    await second.recreate(secondState);
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    expect((await second.load()).map((r) => r.handle ?? r.callID)).toEqual(["vrf_b", "c-b", "vrf_both", "vrf_a", "c-a"]);
    // An unregistered provider is not called.
    first.setSnapshotProvider(undefined);
    rmSync(file);
    await second.recreate([rec("hold", { handle: "vrf_only" })]);
    expect((await second.load()).map((r) => r.handle)).toEqual(["vrf_only"]);
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    // Nor is a disposed journal's provider.
    first.setSnapshotProvider(() => {
      firstCalls += 1;
      return firstState;
    });
    await first.dispose();
    rmSync(file);
    await second.recreate([]);
    expect(await second.load()).toEqual([]);
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    await second.dispose();
  });

  it("QA-2.1-33: the same hold from the caller and two providers, with other field values and field order, is written once (newest, most complete)", async () => {
    const stateDir = join(dir, "state");
    const file = join(stateDir, "pending.jsonl");
    const first = createPendingFileJournal(file, { compactAtStart: false });
    const second = createPendingFileJournal(file, { compactAtStart: false });
    const third = createPendingFileJournal(file, { compactAtStart: false });
    const handle = "vrf_same";
    // The caller lists the hold twice (plugin snapshot + adapter records), field order differing.
    const callerHold = { v: 1 as const, kind: "hold", handle, parent: "p1", child: "k1", at: NOW };
    const callerHoldReordered = { child: "k1", parent: "p1", at: NOW, handle, kind: "hold", v: 1 as const };
    // Another instance holds it with a newer time; a third one with the old time but more fields.
    const newer = { kind: "hold", v: 1 as const, at: NOW + 5, handle, child: "k1", parent: "p1" };
    const richer = { v: 1 as const, kind: "hold", handle, parent: "p1", child: "k1", at: NOW, dispatch: { prompt: "x" } };
    second.setSnapshotProvider(() => [newer, rec("hold-text", { handle, text: "t", at: NOW })]);
    third.setSnapshotProvider(async () => [richer, rec("inflight", { key: "k1\u0000c1", callID: "c1", at: NOW })]);
    await first.append(rec("inflight", { callID: "c0" }));
    rmSync(stateDir, { recursive: true, force: true });
    await first.recreate([callerHold, rec("inflight", { key: "k1\u0000c1", callID: "c1", at: NOW - 1 }), callerHoldReordered]);
    const written = readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as PendingRecord);
    // One record per identity, in the caller's order: the hold (newest wins), the attempt (newest wins), then the hold text.
    expect(written.map((r) => `${r.kind}:${String(r.handle ?? r.key)}`)).toEqual([`hold:${handle}`, "inflight:k1\u0000c1", `hold-text:${handle}`]);
    expect(written[0]).toEqual(newer);
    expect(written[1]?.at).toBe(NOW);
    expect(mergePendingSnapshots([[callerHold], [richer]])).toEqual([richer]);
    expect(mergePendingSnapshots([[richer], [callerHoldReordered]])).toEqual([richer]);
    // Records without key or handle are merged by their serialized form only.
    expect(mergePendingSnapshots([[rec("processed", { callID: "c1", child: "k1" })], [rec("processed", { callID: "c1", child: "k1" }), rec("processed", { callID: "c2", child: "k2" })]]))
      .toEqual([rec("processed", { callID: "c1", child: "k1" }), rec("processed", { callID: "c2", child: "k2" })]);
    expect(pendingRecordIdentity(rec("inflight", { key: "k\u0000c", handle: "vrf_x" }))).toBe("inflight\u0000k\u0000c");
    expect(pendingRecordIdentity(rec("hold", { handle: "vrf_x" }))).toBe("hold\u0000vrf_x");
    expect(pendingRecordIdentity(rec("processed", { callID: "c" }))).toBeUndefined();
    await third.dispose();
    await second.dispose();
    await first.dispose();
  });

  it("QA-2.1-33: a throwing snapshot provider fails the recreate, which changes nothing; a retry once it recovers succeeds", async () => {
    const stateDir = join(dir, "state");
    const file = join(stateDir, "pending.jsonl");
    const first = createPendingFileJournal(file, { compactAtStart: false });
    const second = createPendingFileJournal(file, { compactAtStart: false });
    let broken = true;
    second.setSnapshotProvider(() => {
      if (broken) throw new Error("snapshot failed");
      return [rec("hold", { handle: "vrf_b" })];
    });
    await first.append(rec("hold", { handle: "vrf_a" }));
    rmSync(stateDir, { recursive: true, force: true });
    await expect(first.recreate([rec("hold", { handle: "vrf_a" })])).rejects.toThrow("snapshot failed");
    expect(existsSync(file)).toBe(false);
    await expect(first.load()).rejects.toThrow(PENDING_JOURNAL_VANISHED);
    broken = false;
    await first.recreate([rec("hold", { handle: "vrf_a" })]);
    expect((await first.load()).map((r) => r.handle)).toEqual(["vrf_a", "vrf_b"]);
    await second.dispose();
    await first.dispose();
  });

  it("QA-2.1-22: a writer mark carries pid, token and time; it is removed when the last journal of the path is disposed", async () => {
    const file = join(dir, "pending.jsonl");
    const writers = join(dir, PENDING_WRITERS_DIRNAME);
    const first = createPendingFileJournal(file, { compactAtStart: false });
    const second = createPendingFileJournal(file, { compactAtStart: false });
    await first.append(rec("inflight", { callID: "c1" }));
    const marks = readdirSync(writers).filter((name) => name.startsWith(`${process.pid}.`));
    expect(marks).toHaveLength(1);
    const mark = JSON.parse(readFileSync(join(writers, marks[0] ?? ""), "utf8")) as { pid: unknown; token: unknown; at: unknown };
    expect(mark.pid).toBe(process.pid);
    expect(typeof mark.token).toBe("string");
    expect(marks[0]).toBe(`${process.pid}.${String(mark.token)}`);
    expect(typeof mark.at).toBe("number");
    // The other instance still writes: the mark stays.
    await first.dispose();
    await first.dispose(); // idempotent: it never gives back the other instance's share
    expect(readdirSync(writers).filter((name) => name.startsWith(`${process.pid}.`))).toHaveLength(1);
    await second.append(rec("inflight", { callID: "c2" }));
    await second.dispose();
    expect(readdirSync(writers).filter((name) => name.startsWith(`${process.pid}.`))).toEqual([]);
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("QA-2.1-22: stale writer marks do not block the start-up compaction; a fresh one of another live pid does", async () => {
    const lines = [rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }), rec("processed", { callID: "c1", child: "k1", at: NOW })];
    const body = lines.map((r) => `${JSON.stringify(r)}\n`).join("");
    const linesIn = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length;
    const writers = join(dir, PENDING_WRITERS_DIRNAME);
    mkdirSync(writers, { recursive: true });
    const stale = Date.now() - WRITER_MARK_STALE_MS - 60_000;
    // A dead pid's mark, this pid's mark from an earlier process (another token, past the stale age) and a live pid's mark past
    // the stale age (pid reuse). QA-DF1-18: a FRESH mark of this pid under another token is a live module copy of the plugin in
    // this process and blocks (test/unit/pending-module-copies.test.ts).
    const deadPid = 2_147_483_646;
    writeFileSync(join(writers, `${deadPid}.dead`), `${JSON.stringify({ pid: deadPid, token: "dead", at: Date.now() })}\n`);
    writeFileSync(join(writers, `${process.pid}.earlier`), `${JSON.stringify({ pid: process.pid, token: "earlier", at: stale })}\n`);
    writeFileSync(join(writers, `${process.ppid}.reused`), `${JSON.stringify({ pid: process.ppid, token: "reused", at: stale })}\n`);
    const file = join(dir, "pending.jsonl");
    writeFileSync(file, body);
    const journal = createPendingFileJournal(file);
    await journal.load();
    await journal.flush();
    expect(journal.compactionError).toBeUndefined();
    expect(linesIn(file)).toBe(0);
    const names = readdirSync(writers);
    expect(names).not.toContain(`${deadPid}.dead`);
    expect(names).not.toContain(`${process.pid}.earlier`);
    await journal.dispose();

    // A live pid's fresh mark (by its `at`) still blocks: its append could land in the file the rename replaces.
    const other = join(dir, "other");
    const otherWriters = join(other, PENDING_WRITERS_DIRNAME);
    mkdirSync(otherWriters, { recursive: true });
    writeFileSync(join(otherWriters, `${process.ppid}.live`), `${JSON.stringify({ pid: process.ppid, token: "live", at: Date.now() })}\n`);
    const otherFile = join(other, "pending.jsonl");
    writeFileSync(otherFile, body);
    const blocked = createPendingFileJournal(otherFile);
    await blocked.load();
    await blocked.flush();
    expect(blocked.compactionError).toBeUndefined();
    expect(linesIn(otherFile)).toBe(2);
  });

  it("QA-2.1-22: a failed start-up compaction is told once to the warn sink, for every journal of the path", async () => {
    const file = join(dir, "pending.jsonl");
    writeFileSync(file, `${JSON.stringify(rec("processed", { callID: "c1", child: "k1" }))}\n`);
    // The writers directory cannot be made: the compaction fails and the journal stays as it was.
    writeFileSync(join(dir, PENDING_WRITERS_DIRNAME), "a file, not a directory");
    const warn = vi.fn();
    const first = createPendingFileJournal(file, { warn });
    const second = createPendingFileJournal(file, { warn });
    await Promise.all([first.load(), second.load()]);
    await first.flush();
    await second.load();
    await second.flush();
    expect(first.compactionError).toBeDefined();
    expect(second.compactionError).toBe(first.compactionError);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(PENDING_COMPACTION_FAILED);
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(1);
    // An append never fails for its writer mark.
    await first.append(rec("inflight", { callID: "c2" }));
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("QA-2.1-22: a failed rename leaves no .compact temp file behind", async () => {
    const file = join(dir, "pending.jsonl");
    // The journal path is a directory: the temp file is written, and the rename over the journal fails.
    mkdirSync(join(file, "occupied"), { recursive: true });
    const journal = createPendingFileJournal(file, { compactAtStart: false });
    await expect(journal.compact([rec("inflight", { callID: "c1" })])).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".compact"))).toEqual([]);
    await journal.flush();
  });
});

describe("pending journal dir (QA-2.1-8)", () => {
  it("is per user and durable: XDG_STATE_HOME when absolute (not on Windows), else ~/.local/state", () => {
    const home = join(dir, "home");
    const fallback = join(home, ".local", "state", "opencode-model-router");
    expect(resolvePendingJournalDir({ homedir: home, platform: "linux" })).toBe(fallback);
    expect(resolvePendingJournalDir({ homedir: home, platform: "linux", xdgStateHome: join(dir, "xdg") })).toBe(join(dir, "xdg", "opencode-model-router"));
    expect(resolvePendingJournalDir({ homedir: home, platform: "linux", xdgStateHome: "relative/state" })).toBe(fallback);
    expect(resolvePendingJournalDir({ homedir: home, platform: "linux", xdgStateHome: "" })).toBe(fallback);
    expect(resolvePendingJournalDir({ homedir: home, platform: "win32", xdgStateHome: join(dir, "xdg") })).toBe(fallback);
  });

  it("never resolves into the temp directory on its own", () => {
    const resolved = resolvePendingJournalDir({ homedir: "/home/u", platform: "linux" });
    expect(resolved.startsWith(tmpdir())).toBe(false);
  });
});

describe("compactPendingRecords (QA-2.1-8)", () => {
  const label = (r: PendingRecord): string => `${r.kind}:${String(r.handle ?? r.callID ?? "")}`;

  it("drops superseded, verified and closed records and keeps unknown kinds, in journal order", () => {
    const records = [
      rec("entry", { handle: "vrf_1", parent: "p1", state: "unverified", createdAt: NOW }),
      rec("state", { handle: "vrf_1", state: "verifying", at: NOW }),
      rec("state", { handle: "vrf_1", state: "unverified", at: NOW }),
      rec("entry", { handle: "vrf_2", parent: "p1", state: "unverified", createdAt: NOW }),
      rec("state", { handle: "vrf_2", state: "verified", at: NOW }),
      rec("state", { handle: "vrf_unknown", state: "verified", at: NOW }),
      rec("hold", { handle: "vrf_h", parent: "p1", child: "k1", callID: "c1" }),
      rec("hold-text", { handle: "vrf_h", text: "t" }),
      rec("posting", { handle: "vrf_h", text: "v" }),
      rec("posted", { handle: "vrf_h" }),
      rec("inflight", { callID: "c9", parent: "p1", child: "k9", at: NOW }),
      rec("processed", { callID: "c9", child: "k9" }),
      rec("future-kind", { x: 1 }),
    ];
    const kept = compactPendingRecords(records, { now: NOW });
    expect(kept.map(label)).toEqual(["entry:vrf_1", "state:vrf_1", "hold:vrf_h", "posted:vrf_h", "future-kind:"]);
    expect(kept[1]?.state).toBe("unverified");
    // The dormant fold reads the same sessions from the compacted journal.
    expect(foldDormantRecords(kept, { now: NOW, ttlMs: TTL }).sessions).toEqual(foldDormantRecords(records, { now: NOW, ttlMs: TTL }).sessions);
  });

  it("an open hold keeps its hold-text and newest posting (QA-2.1-2)", () => {
    const kept = compactPendingRecords(
      [
        rec("hold", { handle: "vrf_h", parent: "p1", child: "k1", callID: "c1" }),
        rec("hold-text", { handle: "vrf_h", text: "t1" }),
        rec("posting", { handle: "vrf_h", text: "v1" }),
        rec("posting", { handle: "vrf_h", text: "v2" }),
      ],
      { now: NOW },
    );
    expect(kept.map((r) => [r.kind, r.text])).toEqual([
      ["hold", undefined],
      ["hold-text", "t1"],
      ["posting", "v2"],
    ]);
  });

  it("a tomb closes its entry and inflight, a forget its session (both go themselves); a tomb keeps the hold (QA-2.1-28)", () => {
    const kept = compactPendingRecords(
      [
        rec("entry", { handle: "vrf_t", parent: "p1", state: "held", createdAt: NOW }),
        rec("hold", { handle: "vrf_t", parent: "p1", child: "k1", callID: "c1" }),
        rec("inflight", { callID: "c1", parent: "p1", child: "k1", at: NOW }),
        rec("tomb", { handle: "vrf_t", callID: "c1" }),
        rec("entry", { handle: "vrf_f", parent: "p2", state: "unverified", createdAt: NOW }),
        rec("hold", { handle: "vrf_f", parent: "p2", child: "k2", callID: "c2" }),
        rec("forget", { session: "p2" }),
        rec("entry", { handle: "vrf_after", parent: "p2", state: "unverified", createdAt: NOW }),
      ],
      { now: NOW },
    );
    expect(kept.map(label)).toEqual(["hold:vrf_t", "entry:vrf_after"]);
  });

  it("QA-2.1-28: compaction keeps a posted placeholder past its entry's tomb and caps posted placeholders like the load", () => {
    const records: PendingRecord[] = [
      rec("hold", { handle: "vrf_open", parent: "p1", child: "k0", callID: "c0" }),
      rec("hold", { handle: "vrf_tombed", parent: "p1", child: "kt", callID: "ct" }),
      rec("posted", { handle: "vrf_tombed" }),
      rec("tomb", { handle: "vrf_tombed", cause: "ttl" }),
    ];
    for (let i = 0; i < MAX_DORMANT_POSTED_HOLDS + 1; i += 1) {
      records.push(rec("hold", { handle: `vrf_${i}`, parent: "p1", child: `k${i}`, callID: `c${i}` }), rec("posted", { handle: `vrf_${i}` }));
    }
    const kept = compactPendingRecords(records, { now: NOW, ttlMs: TTL });
    const keptHolds = kept.filter((r) => r.kind === "hold").map((r) => r.handle);
    // MAX + 2 posted placeholders: the two oldest go (the tombed one first), the open hold always stays.
    expect(keptHolds).toHaveLength(MAX_DORMANT_POSTED_HOLDS + 1);
    expect(keptHolds[0]).toBe("vrf_open");
    expect(keptHolds[1]).toBe("vrf_1");
    expect(kept.filter((r) => r.kind === "posted")).toHaveLength(MAX_DORMANT_POSTED_HOLDS);
    // The compacted journal folds to the same dormant holds as the full one.
    expect(foldDormantRecords(kept, { now: NOW, ttlMs: TTL }).sessions).toEqual(foldDormantRecords(records, { now: NOW, ttlMs: TTL }).sessions);
    // Below the cap, the tombed placeholder survives compaction.
    const small = compactPendingRecords(records.slice(0, 4), { now: NOW, ttlMs: TTL });
    expect(small.map(label)).toEqual(["hold:vrf_open", "hold:vrf_tombed", "posted:vrf_tombed"]);
  });

  it("with ttlMs, unheld entries and inflight records past it go; held entries stay", () => {
    const kept = compactPendingRecords(
      [
        rec("entry", { handle: "vrf_old", parent: "p1", state: "unverified", createdAt: NOW - TTL }),
        rec("entry", { handle: "vrf_held", parent: "p1", state: "held", createdAt: NOW - TTL }),
        rec("inflight", { callID: "old", parent: "p1", child: "k1", at: NOW - TTL - 1 }),
        rec("inflight", { callID: "edge", parent: "p1", child: "k2", at: NOW - TTL }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(kept.map(label)).toEqual(["entry:vrf_held", "inflight:edge"]);
  });

  it("the dormant fold keeps at most MAX_DORMANT_POSTED_HOLDS posted placeholders, oldest dropped first, never an open hold", () => {
    const records: PendingRecord[] = [rec("hold", { handle: "vrf_open", parent: "p1", child: "k0", callID: "c0" })];
    for (let i = 0; i < MAX_DORMANT_POSTED_HOLDS + 2; i += 1) {
      records.push(rec("hold", { handle: `vrf_${i}`, parent: "p1", child: `k${i}`, callID: `c${i}` }), rec("posted", { handle: `vrf_${i}` }));
    }
    const holds = foldDormantRecords(records, { now: NOW, ttlMs: TTL }).sessions.get("p1")?.holds.filter((r) => r.kind === "hold") ?? [];
    expect(holds).toHaveLength(MAX_DORMANT_POSTED_HOLDS + 1);
    expect(holds[0]?.handle).toBe("vrf_open");
    expect(holds[1]?.handle).toBe("vrf_2");
  });
});

// ---- registry restart: records written by one registry, restored into a fresh one --------------------------------------------

const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const ROOT = "D:/repo";

function memoryJournal() {
  const records: PendingRecord[] = [];
  return {
    records,
    journal: {
      append: async (record: PendingRecord) => {
        records.push(JSON.parse(JSON.stringify(record)) as PendingRecord);
      },
    },
  };
}

function counterRandom(start: number): (bytes: number) => Uint8Array {
  let n = start;
  return (bytes) => {
    n += 1;
    const out = new Uint8Array(bytes);
    out[bytes - 1] = n % 256;
    out[bytes - 2] = Math.floor(n / 256);
    return out;
  };
}

function registry(opts: { now: () => number; persist?: ReturnType<typeof memoryJournal>["journal"]; seed?: number; onVerdict?: PendingRegistryOptions["onVerdict"] }) {
  return createPendingRegistry({
    ttlMs: TTL,
    maxVerifyingMs: 60_000,
    now: opts.now,
    random: counterRandom(opts.seed ?? 0),
    ...(opts.persist === undefined ? {} : { persist: opts.persist }),
    ...(opts.onVerdict === undefined ? {} : { onVerdict: opts.onVerdict }),
  });
}

function registration(n: number, session = "p1", over: Partial<PendingRegistration> = {}): PendingRegistration {
  return {
    orchestratorSessionID: session,
    dispatchID: `call-${session}-${n}`,
    producerSessionID: `child-${session}-${n}`,
    producerTier: "fast",
    description: `work ${n}`,
    cwd: ROOT,
    root: ROOT,
    dispatchedAt: NOW - 100,
    dod: DOD,
    reference: Promise.resolve<ReferenceState>({ kind: "none", reason: "no reference captured" }),
    changedFiles: [{ path: `src/f${n}.ts`, status: "modified" } as ChangedPath],
    risk: { level: "low", reasons: ["r"] },
    ...over,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("QA-SYNC1-3: a held registration journals its perimeter fact, its dispatch-time head and its unattributed writers", () => {
  const head = { root: "/repo", head: "0123456789abcdef0123456789abcdef01234567", branch: "feat/x", reflog: 3 };

  /** A held entry registered on a journaled registry (as finishApi.finish does at child end); its journaled `entry` record. */
  async function heldRecord(over: Partial<PendingRegistration>): Promise<{ records: PendingRecord[]; handle: string; entry: PendingRecord }> {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const handle = first.reserveHandle("p1");
    if (handle === undefined) throw new Error("no handle reserved");
    const reg = first.register(registration(1, "p1", { handle, hold: { childSessionID: "child-p1-1", callID: "call-p1-1" }, ...over }));
    expect(reg.ok).toBe(true);
    await flushMicrotasks();
    const entry = mem.records.find((r) => r.kind === "entry" && r.handle === handle);
    if (entry === undefined) throw new Error("no entry record journaled");
    return { records: mem.records, handle, entry };
  }

  it("writes hadPerimeter, hadHead with the head itself, and the writers to the journal", async () => {
    const { entry } = await heldRecord({ heldPerimeter: true, dispatchHead: head, unattributedWriters: ["bash", "execute"] });
    expect(entry.hadPerimeter).toBe(true);
    expect(entry.hadHead).toBe(true);
    expect(entry.dispatchHead).toEqual(head);
    expect(entry.unattributedWriters).toEqual(["bash", "execute"]);
  });

  it("restores the head as plain data (the branch check runs again), the perimeter as lost, the writers as they were", async () => {
    const { records, handle } = await heldRecord({ heldPerimeter: true, dispatchHead: head, unattributedWriters: ["bash"] });
    const fresh = registry({ now: () => NOW, seed: 1000 });
    expect(fresh.restore(records, { now: NOW }).restored).toBe(1);
    const looked = fresh.get("p1", handle);
    if (looked.kind !== "found") throw new Error(`restored entry not found: ${looked.kind}`);
    expect(looked.entry.dispatchHead).toEqual(head);
    expect(looked.entry.headLost).toBeUndefined();
    expect(looked.entry.perimeterLost).toBe(true);
    expect(looked.entry.unattributedWriters).toEqual(["bash"]);
  });

  it("a record that had a head but carries no value restores headLost; a malformed head drops the record", async () => {
    const { records, handle } = await heldRecord({ heldHead: true });
    const fresh = registry({ now: () => NOW, seed: 1000 });
    expect(fresh.restore(records, { now: NOW }).restored).toBe(1);
    const looked = fresh.get("p1", handle);
    expect(looked.kind === "found" ? looked.entry.headLost : looked.kind).toBe(true);
    for (const bad of [{ ...head, head: "" }, { ...head, branch: 7 }, { ...head, reflog: -1 }, { ...head, extra: 1 }, "HEAD"]) {
      const malformed = records.map((r) => (r.kind === "entry" ? { ...r, hadHead: true, dispatchHead: bad } : r));
      expect(registry({ now: () => NOW, seed: 2000 }).restore(malformed, { now: NOW }).restored).toBe(0);
    }
  });
});

describe("pending registry: the cross-repo registration fields survive a restart", () => {
  const tree = { head: "0123456789abcdef0123456789abcdef01234567", branch: "feat/x", root: "/repo", reflog: 7 };
  const placements = [undefined, { cwd: "/repo/pkg", top: "/repo", foreign: false, scope: "full" as const }];

  /** Registers one entry (with `extra`) on a journaled registry, restores its records into a fresh one, returns that entry. */
  async function roundTrip(extra: Partial<PendingRegistration>): Promise<PendingEntry> {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1, "p1", extra));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const second = registry({ now: () => NOW });
    expect(second.restore(mem.records, { now: NOW })).toEqual({ restored: 1, expiredHeld: 0, dropped: 0 });
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    return found.entry;
  }

  it("returnedTree round-trips through pending.jsonl", async () => {
    expect((await roundTrip({ returnedTree: tree })).returnedTree).toEqual(tree);
    const detached = { head: "0123456789abcdef0123456789abcdef01234567", branch: null };
    expect((await roundTrip({ returnedTree: detached })).returnedTree).toEqual(detached);
  });

  it("unattributedWriters round-trips through pending.jsonl", async () => {
    expect((await roundTrip({ unattributedWriters: ["bash", "router_run"] })).unattributedWriters).toEqual(["bash", "router_run"]);
  });

  it("placements round-trip through pending.jsonl, an empty slot included", async () => {
    expect((await roundTrip({ placements })).placements).toEqual(placements);
  });

  it.each([
    ["returnedTree", { returnedTree: { head: 7 } }],
    ["returnedTree", { returnedTree: { head: "h", branch: 3 } }],
    ["returnedTree", { returnedTree: { head: "h", reflog: -1 } }],
    ["unattributedWriters", { unattributedWriters: ["bash", ""] }],
    ["unattributedWriters", { unattributedWriters: "bash" }],
    ["placements", { placements: [{ cwd: "/repo", foreign: "no" }] }],
    ["placements", { placements: [{ cwd: "/repo", top: "/repo", foreign: false, scope: "some" }] }],
    ["hadPerimeter", { hadPerimeter: "yes" }],
  ])("an entry record with an invalid %s is dropped at restore", async (_field, patch) => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const records = mem.records.map((record) => (record.kind === "entry" ? { ...record, ...patch } : record));
    const second = registry({ now: () => NOW });
    expect(second.restore(records, { now: NOW })).toEqual({ restored: 0, expiredHeld: 0, dropped: 1 });
    expect(second.listUnverified("p1")).toEqual([]);
  });

  it("an entry record with hadPerimeter restores as perimeterLost, and a compaction keeps the flag", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const records = mem.records.map((record) => (record.kind === "entry" ? { ...record, hadPerimeter: true } : record));
    const again = memoryJournal();
    const second = registry({ now: () => NOW, persist: again.journal });
    expect(second.restore(records, { now: NOW }).restored).toBe(1);
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    expect(found.entry.perimeterLost).toBe(true);
    expect(found.entry.perimeter).toBeUndefined();
    const third = registry({ now: () => NOW });
    third.restore(second.persistedRecords(), { now: NOW });
    const kept = third.get("p1", r.handle);
    expect(kept.kind === "found" ? kept.entry.perimeterLost : kept.kind).toBe(true);
  });

  it("an entry record written before these fields were journaled restores without them", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const entry = mem.records.find((record) => record.kind === "entry");
    for (const key of ["returnedTree", "unattributedWriters", "placements", "hadPerimeter"]) expect(entry).not.toHaveProperty(key);
    const second = registry({ now: () => NOW });
    expect(second.restore(mem.records, { now: NOW })).toEqual({ restored: 1, expiredHeld: 0, dropped: 0 });
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    expect(found.entry.returnedTree).toBeUndefined();
    expect(found.entry.unattributedWriters).toBeUndefined();
    expect(found.entry.placements).toBeUndefined();
    expect(found.entry.perimeterLost).toBeUndefined();
  });
});

describe("pending registry: restart restores what the journal wrote (R19, R20)", () => {
  it("a restart with 3 open handles reloads them, verifiable through markVerifying", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const handles = [1, 2, 3].map((n) => {
      const r = first.register(registration(n));
      if (!r.ok) throw new Error(r.detail);
      return r.handle;
    });
    await flushMicrotasks();
    expect(mem.records.filter((r) => r.kind === "entry")).toHaveLength(3);

    const second = registry({ now: () => NOW + 1000, seed: 500 });
    const report = second.restore(mem.records, { now: NOW + 1000 });
    expect(report).toEqual({ restored: 3, expiredHeld: 0, dropped: 0 });
    for (const handle of handles) {
      const found = second.get("p1", handle);
      expect(found.kind).toBe("found");
    }
    expect(second.listUnverified("p1").map((e) => e.handle).sort()).toEqual([...handles].sort());
    const claim = second.markVerifying("p1", handles[0] ?? "");
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "claimed") {
      expect(claim.entry.dod).toEqual(DOD);
      expect(claim.entry.changedFiles).toEqual([{ path: "src/f1.ts", status: "modified" }]);
      expect(claim.settle({ verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [], caveats: [] }, retryable: false })).toBe(true);
    }
  });

  it("another session never sees a restored handle", () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    const second = registry({ now: () => NOW });
    second.restore(mem.records, { now: NOW });
    expect(second.get("p2", r.handle)).toEqual({ kind: "unknown", handle: r.handle });
    expect(second.listUnverified("p2")).toEqual([]);
  });

  it("an entry past pendingTtlMs is dropped at restore", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    first.register(registration(1));
    await flushMicrotasks();
    const second = registry({ now: () => NOW + TTL });
    expect(second.restore(mem.records, { now: NOW + TTL })).toEqual({ restored: 0, expiredHeld: 0, dropped: 1 });
    expect(second.listUnverified("p1")).toEqual([]);
  });

  it("a restored entry has no reference unless a ref record names one: the verification then cannot excuse failures", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const second = registry({ now: () => NOW });
    second.restore(mem.records, { now: NOW });
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    expect(await found.entry.reference).toEqual({ kind: "none", reason: REFERENCE_UNRESTORED_REASON });
  });

  it("a ref record with an unreadable reference is the same as a missing one", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const records = [...mem.records, rec("ref", { handle: r.handle, callID: "call-p1-1", reference: { commit: 7 } })];
    const second = registry({ now: () => NOW });
    second.restore(records, { now: NOW });
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    expect(await found.entry.reference).toEqual({ kind: "none", reason: REFERENCE_UNRESTORED_REASON });
  });

  it("a tomb, a forget and a verified state keep an entry out; a later state of a live entry is applied", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const ids = [1, 2, 3, 4].map((n) => {
      const r = first.register(registration(n, n === 4 ? "p2" : "p1"));
      if (!r.ok) throw new Error(r.detail);
      return r.handle;
    });
    await flushMicrotasks();
    const records = [
      ...mem.records,
      rec("tomb", { handle: ids[0], cause: "ttl", at: NOW }),
      rec("state", { handle: ids[1], state: "verified", at: NOW }),
      rec("forget", { session: "p2", at: NOW }),
    ];
    const second = registry({ now: () => NOW });
    const report = second.restore(records, { now: NOW });
    expect(report.restored).toBe(1);
    expect(second.listUnverified("p1").map((e) => e.handle)).toEqual([ids[2]]);
    expect(second.listUnverified("p2")).toEqual([]);
    expect(report.dropped).toBe(1);
  });

  it("restore is idempotent by handle and by dispatch (a second restore adds nothing)", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    first.register(registration(1));
    await flushMicrotasks();
    const second = registry({ now: () => NOW });
    expect(second.restore(mem.records, { now: NOW }).restored).toBe(1);
    expect(second.restore(mem.records, { now: NOW })).toEqual({ restored: 0, expiredHeld: 0, dropped: 1 });
  });

  it("a replayed finish for a restored dispatch registers once (deduped by callID)", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const second = registry({ now: () => NOW, seed: 900 });
    second.restore(mem.records, { now: NOW });
    const again = second.register(registration(1));
    expect(again).toEqual({ ok: true, handle: r.handle, evicted: [] });
    expect(second.findByDispatch("call-p1-1")?.handle).toBe(r.handle);
  });

  it("malformed entry records are dropped, not thrown", () => {
    const second = registry({ now: () => NOW });
    const report = second.restore(
      [
        rec("entry", { handle: "not-a-handle", parent: "p1", child: "c", callID: "x" }),
        rec("entry", { handle: "vrf_0123456789abcdef01234567", parent: "p1", child: "p1", callID: "x" }),
        rec("entry", { handle: "vrf_0123456789abcdef01234568", callID: "x" }),
        rec("entry", { handle: "vrf_0123456789abcdef01234569", parent: "p1", child: "c" }),
      ],
      { now: NOW },
    );
    expect(report).toEqual({ restored: 0, expiredHeld: 0, dropped: 4 });
  });

  it("an entry with a corrupt risk and files restores with the unattributed risk and unavailable files", () => {
    const second = registry({ now: () => NOW });
    second.restore(
      [
        rec("entry", {
          handle: "vrf_0123456789abcdef01234567",
          parent: "p1",
          child: "c1",
          callID: "x",
          risk: "bogus",
          changedFiles: "nonsense",
          createdAt: NOW,
          state: "unverified",
        }),
      ],
      { now: NOW },
    );
    const found = second.get("p1", "vrf_0123456789abcdef01234567");
    if (found.kind !== "found") throw new Error("not restored");
    expect(found.entry.risk.level).toBe("high");
    expect(found.entry.changedFiles).toBe("unavailable");
  });
});

describe("pending registry: captured references across a restart", () => {
  const captured: DispatchReference = {
    root: ROOT,
    head: "a".repeat(40),
    commit: "b".repeat(40),
    untracked: new Map([["new.ts", "c".repeat(64)]]),
    tracked: new Map([["src/f1.ts", "d".repeat(64)]]),
    captureReasons: [{ cause: "untracked-modified", path: "new.ts" }],
    capturedAt: NOW - 50,
  };

  it("a captured reference is journaled and restored with its commit, digests and inexact reasons", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1, "p1", { reference: Promise.resolve<ReferenceState>({ kind: "captured", reference: captured }) }));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const refRecord = mem.records.find((x) => x.kind === "ref");
    expect(refRecord).toMatchObject({ handle: r.handle, callID: "call-p1-1" });

    const second = registry({ now: () => NOW });
    expect(second.restore(mem.records, { now: NOW }).restored).toBe(1);
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    const state = await found.entry.reference;
    expect(state.kind).toBe("captured");
    if (state.kind === "captured") {
      expect(state.reference.commit).toBe(captured.commit);
      expect(state.reference.root).toBe(ROOT);
      expect([...state.reference.untracked]).toEqual([["new.ts", "c".repeat(64)]]);
      expect([...state.reference.tracked]).toEqual([["src/f1.ts", "d".repeat(64)]]);
      expect(state.reference.captureReasons).toEqual([{ cause: "untracked-modified", path: "new.ts" }]);
    }
  });

  it("a ref record found by callID (no handle) still attaches to its entry", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const r = first.register(registration(1));
    if (!r.ok) throw new Error(r.detail);
    await flushMicrotasks();
    const records = [...mem.records, rec("ref", { callID: "call-p1-1", reference: serializeReference(captured) })];
    const second = registry({ now: () => NOW });
    second.restore(records, { now: NOW });
    const found = second.get("p1", r.handle);
    if (found.kind !== "found") throw new Error("not restored");
    expect((await found.entry.reference).kind).toBe("captured");
  });

  it("keepReferences marks reloaded reference dirs active so the start-time GC spares them, and the release undoes it", () => {
    const names = ["omr-ref-4242-0123456789abcdef", "omr-ref-4243-fedcba9876543210"];
    expect(names.some((n) => isReferenceKept(n))).toBe(false);
    const release = keepReferences(names);
    expect(names.every((n) => isReferenceKept(n))).toBe(true);
    expect(isReferenceKept(join(dir, "omr-ref-4242-0123456789abcdef"))).toBe(true);
    expect(isReferenceKept("omr-ref-1-aaaaaaaaaaaaaaaa")).toBe(false);
    expect(isReferenceKept("not-a-ref-dir")).toBe(false);
    release();
    expect(names.some((n) => isReferenceKept(n))).toBe(false);
  });

  it("keepReferences ignores keys that are not reference dir names", () => {
    const release = keepReferences(["/tmp/other", "omr-ref-x-y", ""]);
    expect(isReferenceKept("/tmp/other")).toBe(false);
    release();
  });
});

describe("pending registry: held entries across a restart (R20)", () => {
  function heldRegistration(n: number): PendingRegistration {
    return registration(n, "p1", { hold: { childSessionID: `child-p1-${n}`, callID: `call-p1-${n}` } });
  }

  it("a held entry is reloaded in the held state and listed as held, never as pending", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const handle = first.reserveHandle("p1");
    if (handle === undefined) throw new Error("no slot");
    const r = first.register({ ...heldRegistration(1), handle });
    expect(r.ok).toBe(true);
    await flushMicrotasks();
    const entry = mem.records.find((x) => x.kind === "entry");
    expect(entry?.state).toBe("held");

    const second = registry({ now: () => NOW + 1000, seed: 300 });
    expect(second.restore(mem.records, { now: NOW + 1000 })).toEqual({ restored: 1, expiredHeld: 0, dropped: 0 });
    expect(second.listHeld("p1").map((e) => e.handle)).toEqual([handle]);
    expect(second.listHeld("p1")[0]?.hold).toEqual({ childSessionID: "child-p1-1", callID: "call-p1-1" });
    expect(second.listPending("p1")).toEqual([]);
    expect(second.listUnverified("p1")).toEqual([]);
  });

  it("a held entry past pendingTtlMs is settled UNVERIFIABLE (and reported), not dropped", async () => {
    const mem = memoryJournal();
    const first = registry({ now: () => NOW, persist: mem.journal });
    const handle = first.reserveHandle("p1");
    if (handle === undefined) throw new Error("no slot");
    first.register({ ...heldRegistration(1), handle });
    await flushMicrotasks();
    const verdicts: Array<{ handle: string; reasons: readonly string[] | undefined }> = [];
    const later = NOW + TTL + 5;
    const second = registry({
      now: () => later,
      seed: 300,
      onVerdict: (entry, result) => void verdicts.push({ handle: entry.handle, reasons: result.verdict.reasons }),
    });
    expect(second.restore(mem.records, { now: later })).toEqual({ restored: 0, expiredHeld: 1, dropped: 0 });
    expect(verdicts).toEqual([{ handle, reasons: [HELD_TTL_REASON] }]);
    // The verdict went out through onVerdict; the entry itself is past its TTL, so the next lookup evicts it.
    expect(second.get("p1", handle)).toEqual({ kind: "expired", handle });
    expect(second.listHeld("p1")).toEqual([]);
  });

  it("the reserved handle is not given to anyone else; releasing it frees the slot", () => {
    const reg = registry({ now: () => NOW });
    const handle = reg.reserveHandle("p1");
    expect(handle).toMatch(HANDLE_PATTERN);
    expect(reg.register({ ...registration(1), handle: "vrf_ffffffffffffffffffffffff" }).ok).toBe(true);
    if (handle !== undefined) reg.releaseHandle(handle);
    expect(reg.reserveHandle("")).toBeUndefined();
  });

  it("a reservation nobody registers nor releases frees its slot after the reservation TTL (QA-2.1-4)", () => {
    let t = NOW;
    const reg = createPendingRegistry({ ttlMs: TTL, maxVerifyingMs: 60_000, now: () => t, random: counterRandom(0), maxPerSession: 1, reservationTtlMs: 1000 });
    expect(reg.reserveHandle("p1")).toMatch(HANDLE_PATTERN);
    expect(reg.hasSlot("p1")).toBe(false);
    t = NOW + 999;
    expect(reg.hasSlot("p1")).toBe(false);
    t = NOW + 1000;
    expect(reg.hasSlot("p1")).toBe(true);
    expect(reg.reserveHandle("p1")).toMatch(HANDLE_PATTERN);
  });

  it("the default reservation TTL outlives the background sweep (6 h)", () => {
    let t = NOW;
    const reg = createPendingRegistry({ ttlMs: TTL, maxVerifyingMs: 60_000, now: () => t, random: counterRandom(0), maxPerSession: 1 });
    reg.reserveHandle("p1");
    t = NOW + 6 * 3600_000;
    expect(reg.hasSlot("p1")).toBe(false);
    t = NOW + HELD_RESERVATION_TTL_MS;
    expect(reg.hasSlot("p1")).toBe(true);
  });
});

describe("claim files (memo 11.3)", () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  // QA-2.1-13: the body carries the process token too (PID reuse); the tokens below stand for two processes.
  it("the first process takes the claim and writes {pid, token, at}", () => {
    const claims = join(dir, "pending.claims");
    expect(claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" })).toBe(true);
    const body: unknown = JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"));
    expect(body).toEqual({ pid: 100, token: "tok-a", at: 5 });
  });

  it("without a token seam the body still names the process with a module token", () => {
    const claims = join(dir, "pending.claims");
    expect(claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) })).toBe(true);
    const body = JSON.parse(readFileSync(join(claims, "ses_1"), "utf8")) as { pid: number; token: unknown; at: number };
    expect(body.pid).toBe(100);
    expect(body.at).toBe(5);
    expect(body.token).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a second live process is refused", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([100]), token: "tok-b" })).toBe(false);
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 100, token: "tok-a", at: 5 });
  });

  it("a second live process is refused even when it shares the module token (two hosts in one test process)", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([100]) })).toBe(false);
  });

  it("a claim of a dead pid is stale and is taken over", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([]), token: "tok-b" })).toBe(true);
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 200, token: "tok-b", at: 6 });
  });

  it("a live pid whose claim is older than staleMs is a reused pid and is taken over (QA-2.1-13)", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 5 + 1000, isAlive: alive([100]), token: "tok-b", staleMs: 1000 })).toBe(false);
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 5 + 1001, isAlive: alive([100]), token: "tok-b", staleMs: 1000 })).toBe(true);
    // QA-2.1-34: minutes, not hours (live owners re-stamp every CLAIM_REFRESH_MS), so a reused pid never blocks recovery for long.
    expect(CLAIM_STALE_MS).toBe(5 * 60_000);
    expect(CLAIM_REFRESH_MS).toBe(60_000);
  });

  it("this pid with another token is a dead process whose pid was reused: taken over (QA-2.1-13)", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-old" });
    expect(claimPendingSession(claims, "ses_1", { pid: 100, now: 6, isAlive: alive([100]), token: "tok-new" })).toBe(true);
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 100, token: "tok-new", at: 6 });
  });

  it("releasePendingClaim removes only this process's own claim (QA-2.1-13)", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" });
    expect(releasePendingClaim(claims, "ses_1", "tok-b")).toBe(false);
    expect(existsSync(join(claims, "ses_1"))).toBe(true);
    expect(releasePendingClaim(claims, "ses_1", "tok-a")).toBe(true);
    expect(existsSync(join(claims, "ses_1"))).toBe(false);
    expect(releasePendingClaim(claims, "ses_missing", "tok-a")).toBe(false);
  });

  it("refreshPendingClaims re-stamps only this process's own claims (QA-2.1-13)", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]), token: "tok-a" });
    claimPendingSession(claims, "ses_2", { pid: 200, now: 5, isAlive: alive([]), token: "tok-b" });
    refreshPendingClaims(claims, ["ses_1", "ses_2", "ses_missing"], { pid: 100, now: 50, token: "tok-a" });
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 100, token: "tok-a", at: 50 });
    expect(JSON.parse(readFileSync(join(claims, "ses_2"), "utf8"))).toEqual({ pid: 200, token: "tok-b", at: 5 });
    expect(existsSync(join(claims, "ses_missing"))).toBe(false);
  });

  it("this process's own earlier claim is stale (a restarted pid reuse) and is retaken", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) });
    expect(claimPendingSession(claims, "ses_1", { pid: 100, now: 9, isAlive: alive([100]) })).toBe(true);
  });

  it("an unreadable claim is stale", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) });
    writeFileSync(join(claims, "ses_1"), "{{ torn");
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([100, 200]) })).toBe(true);
  });

  it("a session id is encoded into a safe file name and claims are per session", () => {
    const claims = join(dir, "pending.claims");
    expect(claimPendingSession(claims, "a/b:c", { pid: 1, now: 1, isAlive: alive([]) })).toBe(true);
    expect(existsSync(join(claims, encodeURIComponent("a/b:c")))).toBe(true);
    expect(claimPendingSession(claims, "other", { pid: 2, now: 1, isAlive: alive([1]) })).toBe(true);
  });
});
