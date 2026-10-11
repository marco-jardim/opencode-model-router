import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimPendingSession,
  createPendingFileJournal,
  createPendingRegistry,
  foldDormantRecords,
  HANDLE_PATTERN,
  HELD_TTL_REASON,
  processedKeyOf,
  REFERENCE_UNRESTORED_REASON,
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

  it("posted closes a hold; tomb closes a hold and the inflight of its callID", () => {
    const { sessions } = foldDormantRecords(
      [
        rec("hold", { handle: "vrf_a", parent: "p1", child: "k1", callID: "c1" }),
        rec("hold", { handle: "vrf_b", parent: "p1", child: "k2", callID: "c2" }),
        rec("hold", { handle: "vrf_c", parent: "p1", child: "k3", callID: "c3" }),
        rec("inflight", { callID: "c2", parent: "p1", child: "k2", at: NOW }),
        rec("posted", { handle: "vrf_a", at: NOW }),
        rec("tomb", { handle: "vrf_b", callID: "c2", cause: "ttl", at: NOW }),
      ],
      { now: NOW, ttlMs: TTL },
    );
    expect(sessions.get("p1")?.holds.map((r) => r.handle)).toEqual(["vrf_c"]);
    expect(sessions.get("p1")?.inflight).toEqual([]);
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
});

describe("claim files (memo 11.3)", () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it("the first process takes the claim and writes {pid, at}", () => {
    const claims = join(dir, "pending.claims");
    expect(claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) })).toBe(true);
    const body: unknown = JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"));
    expect(body).toEqual({ pid: 100, at: 5 });
  });

  it("a second live process is refused", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([100]) })).toBe(false);
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 100, at: 5 });
  });

  it("a claim of a dead pid is stale and is taken over", () => {
    const claims = join(dir, "pending.claims");
    claimPendingSession(claims, "ses_1", { pid: 100, now: 5, isAlive: alive([]) });
    expect(claimPendingSession(claims, "ses_1", { pid: 200, now: 6, isAlive: alive([]) })).toBe(true);
    expect(JSON.parse(readFileSync(join(claims, "ses_1"), "utf8"))).toEqual({ pid: 200, at: 6 });
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
