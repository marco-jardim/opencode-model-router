import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCapDirective } from "../../src/router/sessions";
import { buildAcceptedSuffix, buildForcingNote } from "../../src/verify/dispatch";
import { parseVerifyDirectives } from "../../src/verify/directives";
import type { DoD } from "../../src/verify/dod";
import type { RiskAssessment } from "../../src/verify/risk";
import type { ChangedPath } from "../../src/verify/runner";
import type { PerimeterObservation } from "../../src/verify/gate";
import type { LinkPin } from "../../src/verify/pin";
import type { CheckPlacement, ReferenceState } from "../../src/verify/types";
import {
  ABANDONED_REASON,
  BACKGROUND_MAX_ATTEMPTS,
  BACKGROUND_QUEUE_MAX,
  BACKGROUND_RETRY_BASE_MS,
  BACKGROUND_SETTLE_MS,
  DISPOSED_REASON,
  LATE_NOTICE_MIXED_HEADER,
  LATE_NOTICE_REPLAY_LINE,
  LATE_NOTICES_MAX,
  LATE_NOTICES_PER_SESSION,
  MAX_HANDLES_PER_CALL,
  REPORTED_MEMO_MAX,
  createBackgroundQueue,
  lateNoticeFor,
  type BackgroundOutcome,
  type BackgroundQueueOptions,
  type BackgroundTimers,
  EXPIRED_HANDLE_TEXT,
  HANDLE_MAX_DRAWS,
  HANDLE_PATTERN,
  MAX_DESCRIPTION_CHARS,
  MAX_LEDGER_IDS,
  MAX_LEDGER_PER_SESSION,
  MAX_STORED_CHANGED_FILES,
  PENDING_LIST_MIXED_HEADER,
  REFERENCE_FAILED_REASON,
  REFERENCE_SHED_REASON,
  RELEASED_REASON,
  TOMBSTONE_MAX,
  UNATTRIBUTED_RISK_REASON,
  UNKNOWN_HANDLE_TEXT,
  VERIFYING_ELSEWHERE_TEXT,
  appendRouterFooter,
  buildDeferredFooter,
  buildLateNoticeBlock,
  buildLineageCaveat,
  buildPendingListBlock,
  createPendingRegistry,
  type PendingRecord,
  driftedPaths,
  formatRisk,
  neutralizeDirectives,
  normalizeHandle,
  sanitizeDescription,
  unattributedRisk,
  type ClaimResult,
  type DeferredPerimeter,
  type EvictionCause,
  type PendingEntry,
  type PendingRegistration,
  type PendingRegistryOptions,
  type SettledVerification,
  type VerificationResult,
} from "../../src/verify/pending";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const TTL = 3_600_000;
const MAX_VERIFYING = 60_000;
const DIRECTIVE = /\b(?:VERIFY|VERIFY_WAIT|CAP)\s*:/i;

const DOD: DoD = { kind: "deterministic", checks: [], criteria: [], deliverable: null, source: "explicit" };
const RISK: RiskAssessment = { level: "medium", reasons: ["6-15 files changed"] };

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (v: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

/** Deterministic random: counter in the last bytes, so every draw is distinct. */
function counterRandom(): (bytes: number) => Uint8Array {
  let n = 0;
  return (bytes) => {
    n += 1;
    const out = new Uint8Array(bytes);
    out[bytes - 1] = n & 0xff;
    out[bytes - 2] = (n >> 8) & 0xff;
    return out;
  };
}

function hexOf(n: number): string {
  return `vrf_${n.toString(16).padStart(24, "0")}`;
}

function paths(n: number): ChangedPath[] {
  return Array.from({ length: n }, (_, i) => ({ path: `/repo/f${i}.ts`, status: "M" }));
}

function captured(untracked: number, tracked: number): ReferenceState {
  const map = (n: number, p: string): Map<string, string> =>
    new Map(Array.from({ length: n }, (_, i) => [`${p}${i}`, "0".repeat(64)]));
  return {
    kind: "captured",
    reference: {
      root: "/repo",
      head: "a".repeat(40),
      commit: "b".repeat(40),
      untracked: map(untracked, "u"),
      tracked: map(tracked, "t"),
      captureReasons: [],
      capturedAt: 0,
    },
  };
}

function reg(overrides: Partial<PendingRegistration> = {}): PendingRegistration {
  return {
    orchestratorSessionID: "orch",
    dispatchID: nextDispatchID(),
    producerSessionID: "child",
    producerTier: "fast",
    description: "fix the parser",
    cwd: "/repo",
    root: "/repo",
    dispatchedAt: 999_000,
    dod: DOD,
    reference: Promise.resolve<ReferenceState>({ kind: "disabled" }),
    changedFiles: paths(2),
    risk: RISK,
    ...overrides,
  };
}

function setup(extra: Partial<PendingRegistryOptions> = {}) {
  const c = clock();
  const evictions: Array<{ handle: string; cause: EvictionCause }> = [];
  const registry = createPendingRegistry({
    ttlMs: TTL,
    maxVerifyingMs: MAX_VERIFYING,
    now: c.now,
    random: counterRandom(),
    onEvict: (entry, cause) => evictions.push({ handle: entry.handle, cause }),
    ...extra,
  });
  const add = (overrides: Partial<PendingRegistration> = {}): string => {
    const r = registry.register(reg(overrides));
    if (!r.ok) throw new Error(`register failed: ${r.code}`);
    return r.handle;
  };
  return { c, registry, evictions, add };
}

/** register is idempotent on dispatchID (phase 2.1): entries that must differ get different ids. */
let dispatchSeq = 0;
function nextDispatchID(): string {
  dispatchSeq += 1;
  return `d${dispatchSeq}`;
}

function claimed(result: ClaimResult): Extract<ClaimResult, { kind: "claimed" }> {
  if (result.kind !== "claimed") throw new Error(`expected claimed, got ${result.kind}`);
  return result;
}

const PASS: VerificationResult = {
  verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: ["tests pass"] },
  retryable: false,
};
const BUSY: VerificationResult = {
  verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["slot busy"] },
  retryable: true,
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stateOf(registry: ReturnType<typeof setup>["registry"], sid: string, handle: string): string {
  const found = registry.get(sid, handle);
  return found.kind === "found" ? found.entry.state : found.kind;
}

// ---------------------------------------------------------------------------------------------
// R3 cross-repo P2e: a deferred entry's perimeter and placements
// ---------------------------------------------------------------------------------------------

const P2E_OBSERVATION: PerimeterObservation = {
  w: { root: "/repo", name: "repo" },
  roots: [{ root: "/other", name: "other", status: "unchanged" }],
};
const P2E_PIN: LinkPin = {
  kind: "pinned",
  root: "/lib",
  head: "c".repeat(40),
  fingerprint: "f".repeat(16),
  ignored: "",
  nested: [],
};
const P2E_PLACEMENTS: readonly (CheckPlacement | undefined)[] = [
  { cwd: "/repo", top: "/repo", foreign: false },
  undefined,
  { cwd: "/lib", top: "/lib", foreign: true, scope: "full" },
];

function p2ePerimeter(pins: Promise<readonly LinkPin[]> = Promise.resolve([P2E_PIN])): DeferredPerimeter {
  return {
    observation: P2E_OBSERVATION,
    workingSet: [{ root: "/repo", name: "repo" }, { root: "/other" }],
    links: [
      {
        at: "/repo/node_modules/lib",
        root: "/lib",
        name: "lib",
        head: "c".repeat(40),
        fingerprint: "f".repeat(16),
        admit: () => true,
      },
    ],
    pins,
  };
}

function foundEntry(registry: ReturnType<typeof setup>["registry"], handle: string): PendingEntry {
  const found = registry.get("orch", handle);
  if (found.kind !== "found") throw new Error(`expected found, got ${found.kind}`);
  return found.entry;
}

describe("R3 cross-repo P2e: perimeter and placements", () => {
  it("#107: linkBase (the W the links were read from) is stored with the frozen perimeter", () => {
    const { registry, add } = setup();
    const handle = add({ perimeter: { ...p2ePerimeter(), linkBase: "/repo/packages/web" } });
    const perimeter = foundEntry(registry, handle).perimeter;
    expect(perimeter?.linkBase).toBe("/repo/packages/web");
    expect(Object.isFrozen(perimeter)).toBe(true);
    const without = add({ perimeter: p2ePerimeter() });
    expect(foundEntry(registry, without).perimeter?.linkBase).toBeUndefined();
  });

  it("P3c.4: the admission (parents in both spellings, depth, exclude, working set) is stored as a frozen copy", () => {
    const { registry, add } = setup();
    const parents = ["/Parent", "/real/parent"];
    const exclude = ["/real/parent/skip-*"];
    const workingSet = [{ worktree: "/repo", name: "repo" }, { worktree: "/other" }];
    const handle = add({ perimeter: { ...p2ePerimeter(), admission: { parents, depth: 2, exclude, workingSet } } });
    const admission = foundEntry(registry, handle).perimeter?.admission;
    expect(admission).toEqual({
      parents: ["/Parent", "/real/parent"],
      depth: 2,
      exclude: ["/real/parent/skip-*"],
      workingSet: [{ worktree: "/repo", name: "repo" }, { worktree: "/other" }],
    });
    if (admission === undefined) throw new Error("admission missing");
    // Frozen at every level, and never aliasing the caller's arrays: a later change by the caller is not seen.
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.parents)).toBe(true);
    expect(Object.isFrozen(admission.exclude)).toBe(true);
    expect(Object.isFrozen(admission.workingSet)).toBe(true);
    for (const entry of admission.workingSet) expect(Object.isFrozen(entry)).toBe(true);
    parents.push("/late");
    exclude.length = 0;
    workingSet[0] = { worktree: "/late" };
    expect(admission.parents).toEqual(["/Parent", "/real/parent"]);
    expect(admission.exclude).toEqual(["/real/parent/skip-*"]);
    expect(admission.workingSet[0]).toEqual({ worktree: "/repo", name: "repo" });
    expect(registry.listPending("orch")[0]?.perimeter?.admission).toEqual(admission);
    // Absent stays absent (exclude too): router_verify then reads W's package links only, as before P3c.
    const without = add({ perimeter: p2ePerimeter() });
    expect(foundEntry(registry, without).perimeter?.admission).toBeUndefined();
    const noExclude = add({ perimeter: { ...p2ePerimeter(), admission: { parents, depth: 1, workingSet: [] } } });
    expect(foundEntry(registry, noExclude).perimeter?.admission).not.toHaveProperty("exclude");
  });

  it("stored and frozen in get/list", () => {
    const { registry, add } = setup();
    const handle = add({ perimeter: p2ePerimeter(), placements: P2E_PLACEMENTS });
    const lists = [
      foundEntry(registry, handle),
      registry.listUnverified("orch")[0],
      registry.listOpen("orch")[0],
      registry.listPending("orch")[0],
    ];
    for (const entry of lists) {
      if (entry === undefined) throw new Error("entry missing from a list");
      const perimeter = entry.perimeter;
      if (perimeter === undefined) throw new Error("perimeter missing");
      expect(perimeter.observation).toBe(P2E_OBSERVATION);
      expect(perimeter.workingSet).toEqual([{ root: "/repo", name: "repo" }, { root: "/other" }]);
      expect(perimeter.links.map((l) => [l.at, l.root, l.name, l.head, l.fingerprint])).toEqual([
        ["/repo/node_modules/lib", "/lib", "lib", "c".repeat(40), "f".repeat(16)],
      ]);
      expect(perimeter.links[0]?.admit?.("/lib")).toBe(true);
      expect(entry.placements).toEqual(P2E_PLACEMENTS);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(perimeter)).toBe(true);
      expect(Object.isFrozen(perimeter.workingSet)).toBe(true);
      expect(Object.isFrozen(perimeter.workingSet[0])).toBe(true);
      expect(Object.isFrozen(perimeter.links)).toBe(true);
      expect(Object.isFrozen(perimeter.links[0])).toBe(true);
      expect(Object.isFrozen(entry.placements)).toBe(true);
    }
  });

  it("an entry without them has neither key", () => {
    const { registry, add } = setup();
    const handle = add();
    const entries = [foundEntry(registry, handle), ...registry.listUnverified("orch"), ...registry.listOpen("orch")];
    expect(entries.length).toBe(3);
    for (const entry of entries) {
      expect("perimeter" in entry).toBe(false);
      expect("placements" in entry).toBe(false);
    }
    expect(registry.stats().weight).toBe(2);
  });

  it("terminal settle releases them; retryable keeps them", () => {
    const { registry, add } = setup();
    const handle = add({ perimeter: p2ePerimeter(), placements: P2E_PLACEMENTS });
    expect(registry.stats().weight).toBe(2 + 2 + 1 + 3);
    claimed(registry.markVerifying("orch", handle)).settle(BUSY);
    const kept = foundEntry(registry, handle);
    expect(kept.state).toBe("unverified");
    expect(kept.perimeter?.workingSet.length).toBe(2);
    expect(kept.placements).toEqual(P2E_PLACEMENTS);
    expect(registry.stats().weight).toBe(8);
    claimed(registry.markVerifying("orch", handle)).settle(PASS);
    const released = foundEntry(registry, handle);
    expect(released.state).toBe("verified");
    expect("perimeter" in released).toBe(false);
    expect("placements" in released).toBe(false);
    expect(registry.stats().weight).toBe(0);
  });

  it("eviction releases them", () => {
    const { registry, add, c, evictions } = setup();
    const handle = add({ perimeter: p2ePerimeter(), placements: P2E_PLACEMENTS });
    expect(registry.stats().weight).toBe(8);
    c.advance(TTL);
    expect(registry.get("orch", handle)).toEqual({ kind: "expired", handle });
    expect(evictions).toEqual([{ handle, cause: "ttl" }]);
    expect(registry.stats().weight).toBe(0);
    expect(registry.stats().entries).toBe(0);
  });

  it("pins stored by identity; a rejection normalises to []", async () => {
    const { registry, add } = setup();
    const pins: readonly LinkPin[] = [P2E_PIN];
    const handle = add({ perimeter: p2ePerimeter(Promise.resolve(pins)) });
    const first = foundEntry(registry, handle).perimeter?.pins;
    const second = foundEntry(registry, handle).perimeter?.pins;
    if (first === undefined) throw new Error("pins missing");
    expect(second).toBe(first);
    expect(await first).toBe(pins);

    const rejected = add({ perimeter: p2ePerimeter(Promise.reject(new Error("pin failed"))) });
    const normalised = foundEntry(registry, rejected).perimeter?.pins;
    if (normalised === undefined) throw new Error("pins missing");
    await expect(normalised).resolves.toEqual([]);
  });

  it("they count toward the weight", () => {
    const { registry, add } = setup({ maxWeight: 10 });
    add({ changedFiles: paths(2), perimeter: p2ePerimeter(), placements: P2E_PLACEMENTS });
    expect(registry.stats().weight).toBe(8);
    expect(
      registry.register(reg({ changedFiles: paths(0), perimeter: p2ePerimeter(), placements: P2E_PLACEMENTS })),
    ).toMatchObject({ ok: false, code: "registry-full" });
    expect(
      registry.register(reg({ changedFiles: paths(0), placements: P2E_PLACEMENTS.slice(0, 2) })),
    ).toMatchObject({ ok: true });
    expect(registry.stats().weight).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// R2 handles
// ---------------------------------------------------------------------------------------------

describe("handles (R2)", () => {
  it("issues vrf_ + 24 lowercase hex from the default random source", () => {
    const registry = createPendingRegistry({ ttlMs: TTL, maxVerifyingMs: MAX_VERIFYING });
    const r = registry.register(reg());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.handle).toMatch(HANDLE_PATTERN);
  });

  it("uses the injected random source", () => {
    const { add } = setup();
    expect(add()).toBe(hexOf(1));
    expect(add()).toBe(hexOf(2));
  });

  it("redraws a collision with a live handle", () => {
    const draws = [1, 1, 1, 2];
    const random = (bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      out[bytes - 1] = draws.shift() ?? 9;
      return out;
    };
    const { add } = setup({ random });
    expect(add()).toBe(hexOf(1));
    expect(add()).toBe(hexOf(2));
  });

  it("returns handle-collision after HANDLE_MAX_DRAWS draws, evicting nothing", () => {
    let calls = 0;
    const random = (bytes: number): Uint8Array => {
      calls += 1;
      return new Uint8Array(bytes);
    };
    const { registry, add, evictions } = setup({ random, maxPerSession: 1 });
    // Verified, so the cap plans its eviction; the collision then evicts nothing.
    claimed(registry.markVerifying("orch", add())).settle(PASS);
    calls = 0;
    const r = registry.register(reg());
    expect(r).toMatchObject({ ok: false, code: "handle-collision" });
    expect(calls).toBe(HANDLE_MAX_DRAWS);
    expect(evictions).toEqual([]);
    expect(registry.stats().entries).toBe(1);
  });

  it("never reissues a tombstoned handle", () => {
    const draws = [1, 1, 2];
    const random = (bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      out[bytes - 1] = draws.shift() ?? 9;
      return out;
    };
    const { registry, add } = setup({ random });
    const first = add();
    registry.forgetSession("other");
    registry.sweep(Number.MAX_SAFE_INTEGER);
    expect(registry.get("orch", first).kind).toBe("expired");
    expect(add()).toBe(hexOf(2));
  });

  it("redraws a random source that does not yield 12 bytes", () => {
    const sizes = [3, 12];
    const random = (): Uint8Array => new Uint8Array(sizes.shift() ?? 12).fill(0xab);
    const { add } = setup({ random });
    expect(add()).toBe(`vrf_${"ab".repeat(12)}`);
  });

  it("normalizeHandle trims, strips one pair of quotes/backticks and lowercases", () => {
    const h = hexOf(0xabc);
    expect(normalizeHandle(`  ${h}  `)).toBe(h);
    expect(normalizeHandle(`\`${h}\``)).toBe(h);
    expect(normalizeHandle(`"${h}"`)).toBe(h);
    expect(normalizeHandle(`'${h}'`)).toBe(h);
    expect(normalizeHandle(h.toUpperCase())).toBe(h);
    expect(normalizeHandle(`""${h}""`)).toBeUndefined();
    expect(normalizeHandle(`"${h}'`)).toBeUndefined();
    expect(normalizeHandle(`${h}0`)).toBeUndefined();
    expect(normalizeHandle("vrf_xyz")).toBeUndefined();
    expect(normalizeHandle("")).toBeUndefined();
    expect(normalizeHandle("`")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// R3/R5 register
// ---------------------------------------------------------------------------------------------

describe("register (R3, R5)", () => {
  it("rejects empty or identical session ids as invalid-input", () => {
    const { registry } = setup();
    expect(registry.register(reg({ orchestratorSessionID: "" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.register(reg({ producerSessionID: "" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.register(reg({ producerSessionID: "orch" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.stats().entries).toBe(0);
  });

  it("stores the registration with a sanitized description and createdAt = now", () => {
    const { registry, add, c } = setup();
    const handle = add({ description: "fix\tthe `parser`\n now" });
    const found = registry.get("orch", handle);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.entry).toMatchObject({
      handle,
      orchestratorSessionID: "orch",
      dispatchID: expect.stringMatching(/^d\d+$/),
      producerSessionID: "child",
      producerTier: "fast",
      description: "fix the 'parser' now",
      createdAt: c.now(),
      state: "unverified",
      verifyingSince: undefined,
      result: undefined,
      changedFilesDropped: 0,
      digests: undefined,
      dod: DOD,
    });
    expect(found.entry.changedFiles).toEqual(paths(2));
    expect(registry.stats().weight).toBe(2);
  });

  it("stores more than MAX_STORED_CHANGED_FILES paths as unavailable with the dropped count", () => {
    const { registry, add } = setup();
    const handle = add({ changedFiles: paths(MAX_STORED_CHANGED_FILES + 1) });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.changedFiles).toBe("unavailable");
    expect(found.entry.changedFilesDropped).toBe(MAX_STORED_CHANGED_FILES + 1);
    expect(registry.stats().weight).toBe(0);
    const exact = add({ changedFiles: paths(MAX_STORED_CHANGED_FILES) });
    const e2 = registry.get("orch", exact);
    if (e2.kind !== "found") throw new Error("not found");
    expect(e2.entry.changedFiles).toHaveLength(MAX_STORED_CHANGED_FILES);
  });

  it("keeps unavailable changed files as unavailable", () => {
    const { registry, add } = setup();
    const handle = add({ changedFiles: "unavailable" });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.changedFiles).toBe("unavailable");
    expect(found.entry.changedFilesDropped).toBe(0);
  });

  it("normalizes a rejected reference and rejected digests (never rejects)", async () => {
    const { registry, add } = setup();
    const handle = add({
      reference: Promise.reject(new Error("boom")),
      digests: Promise.reject(new Error("fs")),
    });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    await expect(found.entry.reference).resolves.toEqual({ kind: "none", reason: REFERENCE_FAILED_REASON });
    await expect(found.entry.digests).resolves.toBeUndefined();
  });

  it("passes resolved digests through", async () => {
    const { registry, add } = setup();
    const digests = new Map([["/repo/a.ts", "x"]]);
    const handle = add({ digests: Promise.resolve(digests) });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    await expect(found.entry.digests).resolves.toBe(digests);
  });

  it("returns frozen snapshots that later transitions do not mutate", () => {
    const { registry, add } = setup();
    const handle = add();
    const before = registry.get("orch", handle);
    if (before.kind !== "found") throw new Error("not found");
    expect(Object.isFrozen(before.entry)).toBe(true);
    registry.markVerifying("orch", handle);
    expect(before.entry.state).toBe("unverified");
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
  });
});

// ---------------------------------------------------------------------------------------------
// R6 scoping
// ---------------------------------------------------------------------------------------------

describe("scoping (R6)", () => {
  it("reports unknown for another session, the producer session, malformed and never-issued handles", () => {
    const { registry, add } = setup();
    const handle = add();
    add({ orchestratorSessionID: "other", producerSessionID: "child2" });
    const unknown = { kind: "unknown" };
    expect(registry.get("other", handle)).toMatchObject(unknown);
    expect(registry.get("child", handle)).toMatchObject(unknown);
    expect(registry.get("orch", "not-a-handle")).toMatchObject(unknown);
    expect(registry.get("orch", hexOf(0xfff))).toMatchObject(unknown);
    expect(registry.markVerifying("other", handle)).toMatchObject(unknown);
    expect(registry.markVerifying("child", handle)).toMatchObject(unknown);
    expect(registry.listUnverified("child")).toEqual([]);
    expect(registry.listOpen("child")).toEqual([]);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([handle]);
  });

  it("reports expired for the own session's tombstone and unknown for any other session", () => {
    const { registry, add, c } = setup();
    const handle = add();
    c.advance(TTL);
    expect(registry.get("orch", handle)).toEqual({ kind: "expired", handle });
    expect(registry.markVerifying("orch", handle)).toEqual({ kind: "expired", handle });
    expect(registry.get("other", handle)).toEqual({ kind: "unknown", handle });
  });

  it("bounds tombstones FIFO at TOMBSTONE_MAX", () => {
    const { registry, add } = setup({ onEvict: undefined });
    // Verified entries, so the global cap may evict them (QA-2.4-4: never an unverified one).
    const first = add();
    claimed(registry.markVerifying("orch", first)).settle(PASS);
    for (let i = 0; i < TOMBSTONE_MAX; i += 1) {
      const sid = `s${i}`;
      claimed(registry.markVerifying(sid, add({ orchestratorSessionID: sid }))).settle(PASS);
    }
    registry.sweep(Number.MAX_SAFE_INTEGER);
    expect(registry.stats().tombstones).toBe(TOMBSTONE_MAX);
    expect(registry.get("orch", first).kind).toBe("unknown");
  });

  it("exports the stable phrases", () => {
    expect(UNKNOWN_HANDLE_TEXT).toBe("unknown handle");
    expect(EXPIRED_HANDLE_TEXT).toBe("expired handle: older than pendingTtlMs or evicted; it can no longer be verified");
    expect(VERIFYING_ELSEWHERE_TEXT).toBe(
      "still being verified by another router_verify call; call again for its verdict",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// R4 transitions, R8 join
// ---------------------------------------------------------------------------------------------

describe("transitions (R4, R8)", () => {
  it("unverified -> verifying (claimed) -> joined -> verified (terminal) -> settled", async () => {
    const { registry, add, c } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.entry.state).toBe("verifying");
    expect(claim.entry.verifyingSince).toBe(c.now());
    const joined = registry.markVerifying("orch", handle);
    expect(joined.kind).toBe("joined");
    if (joined.kind !== "joined") return;
    expect(joined.run).toBe(claim.run);
    c.advance(5);
    expect(claim.settle(PASS)).toBe(true);
    const settled = await claim.run;
    expect(await joined.run).toBe(settled);
    expect(settled).toMatchObject({ handle, settledAt: c.now(), retryable: false, verdict: PASS.verdict });
    const again = registry.markVerifying("orch", handle);
    expect(again).toMatchObject({ kind: "settled", result: settled });
    expect(stateOf(registry, "orch", handle)).toBe("verified");
    expect(registry.listOpen("orch")).toEqual([]);
    expect(registry.listUnverified("orch")).toEqual([]);
  });

  it("N concurrent markVerifying calls produce exactly one claim and one run", () => {
    const { registry, add } = setup();
    const handle = add();
    const results = Array.from({ length: 5 }, () => registry.markVerifying("orch", handle));
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "joined")).toHaveLength(4);
    const runs = new Set(results.map((r) => ("run" in r ? r.run : undefined)));
    expect(runs.size).toBe(1);
    expect(registry.stats().verifying).toBe(1);
  });

  it("settle is single-use", () => {
    const { registry, add } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.settle(PASS)).toBe(true);
    expect(claim.settle(BUSY)).toBe(false);
    expect(stateOf(registry, "orch", handle)).toBe("verified");
  });

  it("a retryable (non-informative) result returns the entry to unverified with lastResult", async () => {
    const { registry, add } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.settle(BUSY)).toBe(true);
    const settled = await claim.run;
    expect(settled.retryable).toBe(true);
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.state).toBe("unverified");
    expect(found.entry.result).toBe(settled);
    expect(found.entry.verifyingSince).toBeUndefined();
    expect(found.entry.dod).toBe(DOD);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([handle]);
    const second = claimed(registry.markVerifying("orch", handle));
    expect(second.run).not.toBe(claim.run);
    expect(claim.settle(PASS)).toBe(false);
  });

  it("reaps an abandoned claim lazily and ignores its stale settle", async () => {
    const { registry, add, c } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    c.advance(MAX_VERIFYING - 1);
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
    c.advance(1);
    expect(stateOf(registry, "orch", handle)).toBe("unverified");
    const settled: SettledVerification = await claim.run;
    expect(settled).toMatchObject({ handle, retryable: true, settledAt: c.now() });
    expect(settled.verdict).toEqual({
      pass: false,
      outcome: "unverifiable",
      method: "deterministic",
      reasons: [ABANDONED_REASON],
      caveats: [ABANDONED_REASON],
    });
    expect(claim.settle(PASS)).toBe(false);
    const next = claimed(registry.markVerifying("orch", handle));
    expect(next.settle(PASS)).toBe(true);
  });

  it("releases the heavy fields on a terminal settle", async () => {
    const { registry, add } = setup();
    const handle = add({ digests: Promise.resolve(new Map()) });
    expect(registry.stats().weight).toBe(2);
    claimed(registry.markVerifying("orch", handle)).settle(PASS);
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.dod).toBeUndefined();
    expect(found.entry.digests).toBeUndefined();
    expect(found.entry.changedFiles).toBe("unavailable");
    await expect(found.entry.reference).resolves.toEqual({ kind: "none", reason: RELEASED_REASON });
    expect(registry.stats().weight).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R7 TTL, caps, weight, eviction order
// ---------------------------------------------------------------------------------------------

describe("TTL and eviction (R7)", () => {
  it("expires at read time without a sweep (get, listUnverified, listOpen, markVerifying)", () => {
    const { registry, add, c, evictions } = setup();
    const a = add();
    c.advance(10);
    const b = add();
    c.advance(TTL - 10);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([b]);
    expect(evictions).toEqual([{ handle: a, cause: "ttl" }]);
    expect(registry.listOpen("orch").map((e) => e.handle)).toEqual([b]);
    c.advance(10);
    expect(registry.listUnverified("orch")).toEqual([]);
    expect(registry.markVerifying("orch", b)).toEqual({ kind: "expired", handle: b });
  });

  it("sweep evicts and counts; future stamps never expire", () => {
    const { registry, add, c } = setup();
    add();
    add();
    expect(registry.sweep(c.now() - 5_000_000)).toBe(0);
    expect(registry.sweep(c.now() + TTL - 1)).toBe(0);
    expect(registry.sweep(c.now() + TTL)).toBe(2);
    expect(registry.stats().entries).toBe(0);
    expect(registry.sweep()).toBe(0);
  });

  it("never evicts a verifying entry by TTL, and evicts it at settle once past its TTL", () => {
    const { registry, add, c, evictions } = setup({ maxVerifyingMs: TTL * 2 });
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    c.advance(TTL + 1);
    expect(registry.sweep()).toBe(0);
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
    expect(claim.settle(PASS)).toBe(true);
    expect(evictions).toEqual([{ handle, cause: "ttl" }]);
    expect(registry.get("orch", handle).kind).toBe("expired");
  });

  it("ignores a throwing onEvict hook", () => {
    const { registry, add, c } = setup({
      onEvict: () => {
        throw new Error("log failure");
      },
    });
    const handle = add();
    c.advance(TTL);
    expect(registry.sweep()).toBe(1);
    expect(registry.get("orch", handle).kind).toBe("expired");
  });

  it("QA-2.4-4: the session cap evicts verified entries oldest first, never an unverified or verifying one", () => {
    const { registry, add, c, evictions } = setup({ maxPerSession: 3 });
    const u1 = add();
    c.advance(1);
    const v1 = add();
    claimed(registry.markVerifying("orch", v1)).settle(PASS);
    c.advance(1);
    const v2 = add();
    claimed(registry.markVerifying("orch", v2)).settle(PASS);
    c.advance(1);
    const r1 = registry.register(reg());
    expect(r1).toMatchObject({ ok: true, evicted: [v1] });
    expect(evictions).toEqual([{ handle: v1, cause: "session-cap" }]);
    const r2 = registry.register(reg());
    expect(r2).toMatchObject({ ok: true, evicted: [v2] });
    // Only unverified entries are left: the cap refuses, and nothing is dropped silently.
    const full = registry.register(reg());
    expect(full).toMatchObject({ ok: false, code: "registry-full" });
    expect(evictions).toHaveLength(2);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toContain(u1);
    expect(registry.get("orch", u1).kind).toBe("found");
    if (!r1.ok) return;
    claimed(registry.markVerifying("orch", r1.handle));
    expect(registry.register(reg())).toMatchObject({ ok: false, code: "registry-full" });
    expect(registry.stats()).toMatchObject({ entries: 3, verifying: 1 });
    // Other sessions are unaffected by the session cap.
    expect(registry.register(reg({ orchestratorSessionID: "other" })).ok).toBe(true);
  });

  it("an expired entry is removed before the cap is applied", () => {
    const { registry, add, c, evictions } = setup({ maxPerSession: 1 });
    const old = add();
    c.advance(TTL);
    expect(registry.register(reg())).toMatchObject({ ok: true, evicted: [] });
    expect(evictions).toEqual([{ handle: old, cause: "ttl" }]);
  });

  it("QA-2.4-4: the global cap evicts another session's verified entry, never its unverified one", () => {
    const { registry, add, c, evictions } = setup({ maxGlobal: 2 });
    const a = add({ orchestratorSessionID: "s1" });
    c.advance(1);
    const b = add({ orchestratorSessionID: "s2" });
    c.advance(1);
    // Both unverified: a registration in another session is refused, and nothing is evicted.
    expect(registry.register(reg({ orchestratorSessionID: "s3" }))).toMatchObject({ ok: false, code: "registry-full" });
    expect(evictions).toEqual([]);
    expect(registry.listUnverified("s1").map((e) => e.handle)).toEqual([a]);
    // A verified entry may go, whichever session holds it.
    claimed(registry.markVerifying("s1", a)).settle(PASS);
    const r = registry.register(reg({ orchestratorSessionID: "s3" }));
    expect(r).toMatchObject({ ok: true, evicted: [a] });
    expect(evictions).toEqual([{ handle: a, cause: "global-cap" }]);
    expect(registry.stats().sessions).toBe(2);
    claimed(registry.markVerifying("s2", b));
    expect(registry.register(reg({ orchestratorSessionID: "s4" }))).toMatchObject({ ok: false, code: "registry-full" });
    expect(registry.get("s2", b).kind).toBe("found");
  });

  it("a zero per-session cap refuses every registration", () => {
    const { registry } = setup({ maxPerSession: 0 });
    expect(registry.register(reg())).toMatchObject({ ok: false, code: "registry-full" });
  });

  it("QA-2.4-4: the weight cap refuses a registration rather than evict an unverified entry", () => {
    const { registry, add, c, evictions } = setup({ maxWeight: 10 });
    const a = add({ changedFiles: paths(4) });
    c.advance(1);
    add({ changedFiles: paths(4) });
    c.advance(1);
    expect(registry.register(reg({ changedFiles: paths(4) }))).toMatchObject({ ok: false, code: "registry-full" });
    expect(evictions).toEqual([]);
    expect(registry.stats().weight).toBe(8);
    // A verified entry is released (weight 0) and may be evicted; the new entry then fits.
    claimed(registry.markVerifying("orch", a)).settle(PASS);
    expect(registry.stats().weight).toBe(4);
    expect(registry.register(reg({ changedFiles: paths(4) }))).toMatchObject({ ok: true, evicted: [] });
    expect(registry.register(reg({ changedFiles: paths(11) }))).toMatchObject({ ok: false, code: "registry-full" });
    expect(registry.stats().entries).toBe(3);
  });

  it("QA-2.4-4: a captured reference over the weight cap is shed; its entry stays unverified and listed", async () => {
    const { registry, add, c, evictions } = setup({ maxWeight: 21 });
    const a = add({ changedFiles: paths(2) });
    c.advance(1);
    let resolveRef: (s: ReferenceState) => void = () => undefined;
    const pendingRef = new Promise<ReferenceState>((resolve) => {
      resolveRef = resolve;
    });
    const b = add({ changedFiles: paths(3), reference: pendingRef });
    await flush();
    expect(registry.stats().weight).toBe(5);
    resolveRef(captured(10, 5));
    await flush();
    expect(registry.stats().weight).toBe(20);
    const c2 = add({ changedFiles: paths(1), reference: Promise.resolve(captured(1, 0)) });
    await flush();
    expect(evictions).toEqual([]);
    // c2's own path fits (21); its reference (+1) would not, so it is shed.
    expect(registry.stats().weight).toBe(21);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([c2, b, a]);
    const shed = registry.get("orch", c2);
    if (shed.kind !== "found") throw new Error(shed.kind);
    expect(await shed.entry.reference).toEqual({ kind: "none", reason: REFERENCE_SHED_REASON });
    const kept = registry.get("orch", b);
    if (kept.kind !== "found") throw new Error(kept.kind);
    expect((await kept.entry.reference).kind).toBe("captured");
  });

  it("does not add reference weight after the entry is gone or released", async () => {
    const { registry, add } = setup();
    let resolveRef: (s: ReferenceState) => void = () => undefined;
    const ref = new Promise<ReferenceState>((resolve) => {
      resolveRef = resolve;
    });
    const handle = add({ reference: ref });
    claimed(registry.markVerifying("orch", handle)).settle(PASS);
    resolveRef(captured(4, 4));
    await flush();
    expect(registry.stats().weight).toBe(0);
  });

  it("listUnverified is newest first with registration order breaking ties, and honours limit", () => {
    const { registry, add, c } = setup();
    const a = add();
    const b = add();
    c.advance(1);
    const d = add();
    const verifying = add();
    registry.markVerifying("orch", verifying);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([d, b, a]);
    expect(registry.listUnverified("orch", 2).map((e) => e.handle)).toEqual([d, b]);
    expect(registry.listUnverified("orch", -1)).toEqual([]);
    expect(registry.listOpen("orch").map((e) => e.handle)).toEqual([verifying, d, b, a]);
    expect(registry.listUnverified("nobody")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// forgetSession, dispose
// ---------------------------------------------------------------------------------------------

describe("forgetSession and dispose (R5)", () => {
  it("forgetSession evicts entries, tombstones and rejections; a verifying entry is evicted at settle", async () => {
    const { registry, add, evictions } = setup();
    const gone = add();
    const busy = add();
    const other = add({ orchestratorSessionID: "other" });
    const claim = claimed(registry.markVerifying("orch", busy));
    registry.recordRejection({ orchestratorSessionID: "orch", root: "/repo", label: "x", landedAt: 0, introduced: ["t1"] });
    registry.forgetSession("orch");
    expect(evictions).toEqual([{ handle: gone, cause: "session-gone" }]);
    expect(registry.get("orch", gone).kind).toBe("unknown");
    expect(stateOf(registry, "orch", busy)).toBe("verifying");
    expect(registry.stats().rejections).toBe(0);
    expect(claim.settle(BUSY)).toBe(true);
    await claim.run;
    expect(evictions).toContainEqual({ handle: busy, cause: "session-gone" });
    expect(registry.get("orch", busy).kind).toBe("expired");
    expect(stateOf(registry, "other", other)).toBe("unverified");
  });

  it("a doomed verifying entry that is reaped is evicted", () => {
    const { registry, add, c, evictions } = setup();
    const busy = add();
    claimed(registry.markVerifying("orch", busy));
    registry.forgetSession("orch");
    c.advance(MAX_VERIFYING);
    registry.sweep();
    expect(evictions).toEqual([{ handle: busy, cause: "session-gone" }]);
  });

  it("dispose resolves claimers and joiners with DISPOSED and later settles return false", async () => {
    const { registry, add, evictions } = setup();
    const busy = add();
    const idle = add();
    const claim = claimed(registry.markVerifying("orch", busy));
    const join = registry.markVerifying("orch", busy);
    registry.dispose();
    const settled = await claim.run;
    expect(settled.verdict.reasons).toEqual([DISPOSED_REASON]);
    expect(settled.retryable).toBe(true);
    if (join.kind === "joined") expect(await join.run).toBe(settled);
    expect(claim.settle(PASS)).toBe(false);
    expect(evictions.map((e) => e.cause)).toEqual(["disposed", "disposed"]);
    expect(evictions.map((e) => e.handle).sort()).toEqual([busy, idle].sort());
    expect(registry.stats()).toMatchObject({ entries: 0, sessions: 0, verifying: 0, weight: 0, rejections: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// R11 lineage
// ---------------------------------------------------------------------------------------------

describe("held entries, idempotent register and persistence (phase 2.1)", () => {
  const options = { ttlMs: 60_000, maxVerifyingMs: 60_000 };

  it("reserves a handle, registers a held entry under it and registers once per dispatchID", () => {
    const registry = createPendingRegistry(options);
    const handle = registry.reserveHandle("orch");
    expect(handle).toMatch(/^vrf_[0-9a-f]{24}$/);
    const hold = { childSessionID: "child", callID: "call-1" };
    const first = registry.register(reg({ dispatchID: "call-1", producerSessionID: "child", handle, hold }));
    expect(first).toMatchObject({ ok: true, handle });
    expect(registry.register(reg({ dispatchID: "call-1", producerSessionID: "child" }))).toMatchObject({ ok: true, handle });
    const found = registry.findByDispatch("call-1");
    expect(found).toMatchObject({ handle, state: "held", hold });
    expect(registry.listHeld("orch").map((e) => e.handle)).toEqual([handle]);
    expect(registry.listPending("orch")).toEqual([]);
    expect(registry.findByDispatch("other")).toBeUndefined();
  });

  it("fires onVerdict once on the terminal settle of a held entry, and a retryable settle returns it to held", () => {
    const verdicts: string[] = [];
    const registry = createPendingRegistry({ ...options, onVerdict: (entry) => verdicts.push(entry.handle) });
    const handle = registry.reserveHandle("orch") ?? "";
    registry.register(reg({ dispatchID: "call-2", producerSessionID: "child", handle, hold: { childSessionID: "child", callID: "call-2" } }));
    const retry = claimed(registry.markVerifying("orch", handle));
    retry.settle({ ...PASS, retryable: true });
    expect(stateOf(registry, "orch", handle)).toBe("held");
    expect(verdicts).toEqual([]);
    claimed(registry.markVerifying("orch", handle)).settle({ ...PASS, retryable: false });
    expect(verdicts).toEqual([handle]);
  });

  it("gives a reserved handle back and honours the caps with reservations", () => {
    const registry = createPendingRegistry({ ...options, maxPerSession: 1 });
    const handle = registry.reserveHandle("orch");
    expect(handle).toBeDefined();
    expect(registry.reserveHandle("orch")).toBeUndefined();
    registry.releaseHandle(handle ?? "");
    expect(registry.reserveHandle("orch")).toBeDefined();
  });

  it("persists entries and state, and restore rebuilds the held entry (held past the TTL ends unverifiable)", async () => {
    const records: PendingRecord[] = [];
    const persist = { append: async (record: PendingRecord) => { records.push(record); } };
    const clock = { now: 1_000_000 };
    const writer = createPendingRegistry({ ...options, persist, now: () => clock.now });
    const handle = writer.reserveHandle("orch") ?? "";
    writer.register(reg({ dispatchID: "call-3", producerSessionID: "child", handle, hold: { childSessionID: "child", callID: "call-3" } }));
    expect(records.map((r) => r.kind)).toEqual(["entry"]);

    const verdicts: string[] = [];
    clock.now += 1_000;
    const reader = createPendingRegistry({ ...options, now: () => clock.now, onVerdict: (entry) => verdicts.push(entry.handle) });
    expect(reader.restore(records, { now: clock.now })).toMatchObject({ restored: 1, expiredHeld: 0 });
    expect(reader.findByDispatch("call-3")).toMatchObject({ handle, state: "held" });

    clock.now += 120_000;
    const late = createPendingRegistry({ ...options, now: () => clock.now, onVerdict: (entry) => verdicts.push(entry.handle) });
    expect(late.restore(records, { now: clock.now })).toMatchObject({ restored: 0, expiredHeld: 1 });
    expect(verdicts).toEqual([handle]);
  });
});

describe("lineage (R11)", () => {
  const base = { orchestratorSessionID: "orch", root: "/repo", label: "vrf_a", landedAt: 100, introduced: ["t1", "t2"] };

  it("matches the newest record of the same session and root with landedAt <= dispatchedAt", () => {
    const { registry } = setup();
    registry.recordRejection(base);
    registry.recordRejection({ ...base, label: "dispatch d9", landedAt: 150, introduced: ["t2", "t3"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: ["t3", "t1", "t2"] }),
    ).toEqual({ label: "dispatch d9", ids: ["t3", "t2"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 120, preexisting: ["t2", "t1"] }),
    ).toEqual({ label: "vrf_a", ids: ["t2", "t1"] });
  });

  it("returns undefined for another session, another root, a later landedAt or no intersection", () => {
    const { registry } = setup();
    registry.recordRejection(base);
    const q = { orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: ["t1"] };
    expect(registry.findLineage(q)).toBeDefined();
    expect(registry.findLineage({ ...q, orchestratorSessionID: "other" })).toBeUndefined();
    expect(registry.findLineage({ ...q, root: "/elsewhere" })).toBeUndefined();
    expect(registry.findLineage({ ...q, dispatchedAt: 99 })).toBeUndefined();
    expect(registry.findLineage({ ...q, preexisting: ["t9"] })).toBeUndefined();
  });

  it("ignores empty records, caps ids and records, and expires records with ttlMs", () => {
    const { registry, c } = setup();
    registry.recordRejection({ ...base, introduced: [] });
    registry.recordRejection({ ...base, root: "" });
    registry.recordRejection({ ...base, orchestratorSessionID: "" });
    expect(registry.stats().rejections).toBe(0);
    const many = Array.from({ length: MAX_LEDGER_IDS + 5 }, (_, i) => `id${i}`);
    registry.recordRejection({ ...base, label: "first", introduced: many });
    const q = { orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: many };
    expect(registry.findLineage(q)?.ids).toHaveLength(MAX_LEDGER_IDS);
    for (let i = 0; i < MAX_LEDGER_PER_SESSION; i += 1) registry.recordRejection({ ...base, label: `r${i}`, introduced: ["x"] });
    expect(registry.stats().rejections).toBe(MAX_LEDGER_PER_SESSION);
    expect(registry.findLineage({ ...q, preexisting: ["x"] })?.label).toBe(`r${MAX_LEDGER_PER_SESSION - 1}`);
    // The oldest record ("first") was dropped by the per-session cap.
    expect(registry.findLineage(q)).toBeUndefined();
    c.advance(TTL);
    expect(registry.findLineage({ ...q, preexisting: ["x"] })).toBeUndefined();
    expect(registry.stats().rejections).toBe(0);
  });

  it("claim.settle records a terminal result with introduced ids and a known root", () => {
    const { registry, add, c } = setup();
    const handle = add();
    const created = c.now();
    claimed(registry.markVerifying("orch", handle)).settle({ ...PASS, verdict: { ...PASS.verdict, pass: false }, introduced: ["t1"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: created, preexisting: ["t1"] }),
    ).toEqual({ label: handle, ids: ["t1"] });
    const noRoot = add({ root: undefined });
    claimed(registry.markVerifying("orch", noRoot)).settle({ ...PASS, introduced: ["t2"] });
    const retry = add();
    claimed(registry.markVerifying("orch", retry)).settle({ ...BUSY, introduced: ["t3"] });
    expect(registry.stats().rejections).toBe(1);
  });

  it("buildLineageCaveat is verbatim and caps ids at 10", () => {
    expect(buildLineageCaveat({ label: "vrf_a", ids: ["t1", "t2"] })).toBe(
      "t1, t2 failed after vrf_a in this session and still fail; that change may still be present in the reference of this delegation, so pre-existing cannot be told apart from not fixed",
    );
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(buildLineageCaveat({ label: "dispatch d1", ids })).toMatch(/^t0, .*t9 \(\+2 more\) failed after dispatch d1 /);
  });
});

// ---------------------------------------------------------------------------------------------
// R9 text
// ---------------------------------------------------------------------------------------------

function entry(handle: string, description: string, risk: RiskAssessment = RISK): PendingEntry {
  return {
    handle,
    orchestratorSessionID: "orch",
    dispatchID: "d",
    producerSessionID: "c",
    producerTier: "",
    description,
    cwd: "/repo",
    root: "/repo",
    dispatchedAt: 0,
    dod: undefined,
    reference: Promise.resolve({ kind: "disabled" }),
    changedFiles: "unavailable",
    changedFilesDropped: 0,
    risk,
    digests: undefined,
    createdAt: 0,
    state: "unverified",
    verifyingSince: undefined,
    result: undefined,
  };
}

describe("text (R9)", () => {
  const h = hexOf(1);

  it("builds the deferred footer verbatim with a handle", () => {
    const footer = buildDeferredFooter({ handle: h, risk: { level: "high", reasons: ["a", "b", "c", "d", "e"] } });
    expect(footer).toBe(
      `[router] unverified \u00b7 ${h} \u00b7 risk high (a; b; c; +2 more)\n` +
        "[router] Call `router_verify` with this handle before building on this work if the risk matters.",
    );
    expect(footer.split("\n")[0].slice("[router] ".length).split(" ")[0]).toBe("unverified");
  });


  it("keeps the label rule even when a reason mentions verified", () => {
    const footer = buildDeferredFooter({ handle: h, risk: { level: "high", reasons: ["cannot be verified"] } });
    expect(footer.startsWith("[router] unverified \u00b7 ")).toBe(true);
  });

  it("formatRisk honours maxReasons and sanitizes reasons", () => {
    expect(formatRisk("medium", ["a", "b"], 3)).toBe("risk medium (a; b)");
    expect(formatRisk("medium", ["a", "b", "c", "d"], 3)).toBe("risk medium (a; b; c; +1 more)");
    expect(formatRisk("medium", ["a", "b"], 0)).toBe("risk medium");
    expect(formatRisk("low", [], 3)).toBe("risk low");
    expect(formatRisk("high", ["x\n`y`"], 1)).toBe("risk high (x 'y')");
  });

  it("appendRouterFooter trims the output end and handles empty output", () => {
    expect(appendRouterFooter("done\n\n  ", "[router] f")).toBe("done\n\n[router] f");
    expect(appendRouterFooter("  \n", "[router] f")).toBe("[router] f");
    expect(appendRouterFooter("", "[router] f")).toBe("[router] f");
  });

  it("buildPendingListBlock is undefined when empty and caps at 5, newest first as given", () => {
    expect(buildPendingListBlock([])).toBeUndefined();
    const two = [entry(hexOf(2), "second"), entry(hexOf(1), "first")];
    expect(buildPendingListBlock(two)).toBe(
      [
        "[router] Unverified delegations in this session (newest first):",
        `- ${hexOf(2)} \u00b7 risk medium \u00b7 second`,
        `- ${hexOf(1)} \u00b7 risk medium \u00b7 first`,
        "[router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.",
      ].join("\n"),
    );
    const seven = Array.from({ length: 7 }, (_, i) => entry(hexOf(7 - i), `d${7 - i}`));
    const block = buildPendingListBlock(seven) ?? "";
    const items = block.split("\n").filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(6);
    expect(items[0]).toContain(hexOf(7));
    expect(items[4]).toContain(hexOf(3));
    expect(items[5]).toBe("- ... and 2 more");
    expect(buildPendingListBlock(seven.slice(0, 5))).not.toContain("more");
  });

  it("buildPendingListBlock feeds from the registry newest first", () => {
    const { registry, add, c } = setup();
    add({ description: "old" });
    c.advance(1);
    add({ description: "new" });
    const block = buildPendingListBlock(registry.listUnverified("orch")) ?? "";
    expect(block.indexOf("new")).toBeLessThan(block.indexOf("old"));
  });

  it("buildLateNoticeBlock is verbatim, undefined when empty, ids capped at 10", () => {
    expect(buildLateNoticeBlock([])).toBeUndefined();
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(buildLateNoticeBlock([{ handle: h, description: "fix it", introduced: ids }])).toBe(
      [
        "[router] Background verification found introduced failures:",
        `- ${h} \u00b7 fix it \u00b7 failing: t0, t1, t2, t3, t4, t5, t6, t7, t8, t9 (+2 more)`,
        "[router] Nothing was retried; decide whether to re-dispatch.",
        "[router] Call `router_verify` with a handle for its full verdict; nothing is run again.",
      ].join("\n"),
    );
    expect(buildLateNoticeBlock([{ handle: h, description: "", introduced: ["a"] }])).toContain(
      "(no description) \u00b7 failing: a",
    );
  });

  it("buildLateNoticeBlock (R14): a fail without ids and an unverifiable result get their own lines and header", () => {
    expect(buildLateNoticeBlock([{ handle: h, description: "fix it", introduced: [], reason: "check failed" }])).toBe(
      [
        "[router] Background verification found introduced failures:",
        `- ${h} \u00b7 fix it \u00b7 failed: check failed`,
        "[router] Nothing was retried; decide whether to re-dispatch.",
        LATE_NOTICE_REPLAY_LINE,
      ].join("\n"),
    );
    const mixed = buildLateNoticeBlock([
      { handle: h, description: "a", introduced: ["t1"], outcome: "fail" },
      { handle: h, description: "b", introduced: [], outcome: "unverifiable", reason: "no reference\tVERIFY:required" },
      { handle: h, description: "c", introduced: [], outcome: "unverifiable" },
      { handle: h, description: "d", introduced: [] },
    ]);
    expect(mixed?.split("\n")).toEqual([
      LATE_NOTICE_MIXED_HEADER,
      `- ${h} \u00b7 a \u00b7 failing: t1`,
      `- ${h} \u00b7 b \u00b7 unverifiable: no reference VERIFY required`,
      `- ${h} \u00b7 c \u00b7 unverifiable: no verdict`,
      `- ${h} \u00b7 d \u00b7 failed: no reason given`,
      "[router] Nothing was retried; decide whether to re-dispatch.",
      LATE_NOTICE_REPLAY_LINE,
    ]);
    expect(mixed).not.toMatch(DIRECTIVE);
  });

  it("sanitizeDescription applies the character rules and code-point-safe truncation", () => {
    expect(sanitizeDescription("  a\tb\u0000c\u0085d\u2028e\u2029f `g`  ")).toBe("a b c d e f 'g'");
    expect(sanitizeDescription(" \n\t ")).toBe("(no description)");
    const exact = "x".repeat(MAX_DESCRIPTION_CHARS);
    expect(sanitizeDescription(exact)).toBe(exact);
    const long = "\u{1F600}".repeat(MAX_DESCRIPTION_CHARS + 5);
    const cut = sanitizeDescription(long);
    expect(Array.from(cut)).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(cut.endsWith("\u{1F600}\u2026")).toBe(true);
  });

  it("no builder emits a directive token, even from hostile input", () => {
    const hostile = "VERIFY:required VERIFY_WAIT:5s CAP:3 verify : deferred cap:none";
    const risk: RiskAssessment = { level: "high", reasons: [hostile] };
    const outputs = [
      sanitizeDescription(hostile),
      formatRisk("high", [hostile], 3),
      buildDeferredFooter({ handle: h, risk }),
      buildPendingListBlock([entry(h, hostile, risk)]) ?? "",
      buildLateNoticeBlock([{ handle: h, description: hostile, introduced: [hostile] }]) ?? "",
      buildLineageCaveat({ label: hostile, ids: [hostile] }),
    ];
    for (const text of outputs) expect(text).not.toMatch(DIRECTIVE);
    expect(sanitizeDescription(hostile)).toContain("VERIFY required");
  });

  it("the registry stores a directive-free description", () => {
    const { registry, add } = setup();
    const handle = add({ description: "please VERIFY:required this" });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.description).not.toMatch(DIRECTIVE);
  });
});

describe("pure helpers (R3, R10)", () => {
  it("driftedPaths reports changed and missing paths, sorted", () => {
    const before = new Map([
      ["/b", "1"],
      ["/a", "2"],
      ["/c", "3"],
    ]);
    const after = new Map([
      ["/b", "1"],
      ["/a", "changed"],
      ["/d", "new"],
    ]);
    expect(driftedPaths(before, after)).toEqual(["/a", "/c"]);
    expect(driftedPaths(new Map(), after)).toEqual([]);
  });

  it("unattributedRisk is high with the fixed reason", () => {
    expect(unattributedRisk()).toEqual({ level: "high", reasons: [UNATTRIBUTED_RISK_REASON] });
  });
});

// ---------------------------------------------------------------------------------------------
// R14: the background queue (2.4.5)
// ---------------------------------------------------------------------------------------------

describe("background queue (R14, 2.4.5)", () => {
  const H = (n: number): string => `vrf_${n.toString(16).padStart(24, "0")}`;
  const PASS: VerificationResult = { verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] }, retryable: false };
  const fail = (ids: string[]): VerificationResult => ({
    verdict: { pass: false, outcome: "fail", method: "deterministic", reasons: ["introduced failures"] },
    retryable: false,
    introduced: ids,
  });
  const unverifiable = (reason: string, retryable = false): VerificationResult => ({
    verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: [reason], caveats: [reason] },
    retryable,
  });
  const judged = (handle: string, result: VerificationResult): BackgroundOutcome => ({
    kind: "judged",
    handle,
    description: `work ${handle.slice(-2)}`,
    result: { ...result, handle, settledAt: 0 },
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };

  interface Call {
    readonly sessionID: string;
    readonly handles: readonly string[];
    readonly signal: AbortSignal;
    resolve(outcomes: readonly BackgroundOutcome[]): void;
    reject(error: unknown): void;
  }

  function harness(over: Partial<BackgroundQueueOptions> = {}) {
    const c = clock(0);
    const scheduled: Array<{ at: number; cb: () => void; id: number }> = [];
    let ids = 0;
    const timers: BackgroundTimers = {
      setTimeout(cb, ms) {
        ids += 1;
        scheduled.push({ at: c.now() + ms, cb, id: ids });
        return ids;
      },
      clearTimeout(handle) {
        const i = scheduled.findIndex(s => s.id === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    };
    const calls: Call[] = [];
    const verify = vi.fn(
      (sessionID: string, handles: readonly string[], signal: AbortSignal) =>
        new Promise<readonly BackgroundOutcome[]>((resolve, reject) => {
          calls.push({ sessionID, handles: [...handles], signal, resolve, reject });
        }),
    );
    const errors: unknown[] = [];
    const queue = createBackgroundQueue({ verify, ttlMs: TTL, now: c.now, timers, platform: "linux", onError: e => errors.push(e), ...over });
    /** Moves the clock and fires every timer due by then, in order. */
    const advance = async (ms: number): Promise<void> => {
      c.advance(ms);
      for (;;) {
        const due = scheduled.filter(s => s.at <= c.now()).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        scheduled.splice(scheduled.indexOf(due), 1);
        due.cb();
        await flush();
      }
      await flush();
    };
    const add = (n: number, files: string[] = [`/src/${n}.ts`], sessionID = "orch"): string => {
      queue.enqueue({ sessionID, handle: H(n), files });
      return H(n);
    };
    return { queue, c, scheduled, calls, verify, errors, advance, add };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lateNoticeFor: nothing for a pass or a retryable result; a fail names its ids, an unverifiable its reason", () => {
    expect(lateNoticeFor(H(1), "d", PASS)).toBeUndefined();
    expect(lateNoticeFor(H(1), "d", unverifiable("verification slot busy", true))).toBeUndefined();
    expect(lateNoticeFor(H(1), "d", fail(["t > a"]))).toEqual({
      handle: H(1), description: "d", introduced: ["t > a"], outcome: "fail", reason: "introduced failures",
    });
    expect(lateNoticeFor(H(1), "d", unverifiable("no reference"))).toMatchObject({ outcome: "unverifiable", introduced: [], reason: "no reference" });
    // A drift-downgraded pass has no reason of its own: the notice names the last caveat.
    const drifted: VerificationResult = {
      verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: [], caveats: ["n2 note", "tree drifted"] },
      retryable: false,
    };
    expect(lateNoticeFor(H(1), "d", drifted)?.reason).toBe("tree drifted");
    // outcome inferred from pass when absent; no reason at all -> no reason field.
    const bare: VerificationResult = { verdict: { pass: false, method: "none", reasons: [] }, retryable: false };
    expect(lateNoticeFor(H(1), "d", bare)).toEqual({ handle: H(1), description: "d", introduced: [], outcome: "fail" });
    expect(lateNoticeFor(H(1), "d", { verdict: { pass: true, method: "deterministic", reasons: [] }, retryable: false })).toBeUndefined();
  });

  it("a fresh request runs after the settle delay; the session's requests share one run; no debounce", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    expect(queue.stats()).toMatchObject({ queued: 1, running: false, timerArmed: true });
    await advance(BACKGROUND_SETTLE_MS / 2);
    add(2);
    await advance(BACKGROUND_SETTLE_MS / 2 - 1);
    expect(calls).toHaveLength(0);
    // The first request's timer is not pushed back by the second (no debounce), and 2 rides along.
    await advance(1);
    expect(calls.map(c => [c.sessionID, c.handles])).toEqual([["orch", [H(1), H(2)]]]);
    expect(queue.stats()).toMatchObject({ queued: 0, running: true, runs: 1 });
    calls[0].resolve([judged(H(1), PASS), judged(H(2), PASS)]);
    await flush();
    expect(queue.stats()).toMatchObject({ queued: 0, running: false, timerArmed: false, notices: 0 });
    expect(queue.takeNotices("orch")).toEqual([]);
  });

  it("a fail or an unverifiable result is one late notice, delivered once; a pass is none; sessions are separate", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    add(2);
    add(3);
    await advance(BACKGROUND_SETTLE_MS);
    calls[0].resolve([judged(H(1), fail(["t > a"])), judged(H(2), unverifiable("no reference")), judged(H(3), PASS)]);
    await flush();
    expect(queue.stats().notices).toBe(2);
    expect(queue.takeNotices("other")).toEqual([]);
    const notices = queue.takeNotices("orch");
    expect(notices.map(n => [n.handle, n.outcome])).toEqual([[H(1), "fail"], [H(2), "unverifiable"]]);
    expect(buildLateNoticeBlock(notices)?.split("\n")[0]).toBe(LATE_NOTICE_MIXED_HEADER);
    expect(queue.takeNotices("orch")).toEqual([]);
    expect(queue.stats().notices).toBe(0);
  });

  it("coalescing: a newer request with overlapping files drops a queued older one of the same session only", async () => {
    const { queue, calls, advance, add } = harness();
    add(1, ["/src/a.ts", "/src/b.ts"]);
    add(2, ["/src/a.ts"], "orch2");
    add(3, ["/src/b.ts", "/src/c.ts"]);
    add(4, ["/src/d.ts"]);
    expect(queue.stats()).toMatchObject({ queued: 3, superseded: 1 });
    await advance(BACKGROUND_SETTLE_MS);
    // FIFO: orch2's request came first and runs alone (verifyHandles is session-scoped).
    expect(calls[0].handles).toEqual([H(2)]);
    // Duplicates and empty ids are ignored.
    queue.enqueue({ sessionID: "orch", handle: H(3), files: [] });
    queue.enqueue({ sessionID: "", handle: H(9), files: [] });
    queue.enqueue({ sessionID: "orch", handle: "", files: [] });
    expect(queue.stats().queued).toBe(2);
    calls[0].resolve([judged(H(2), PASS)]);
    await flush();
    await advance(0);
    // H(1) is gone from the queue (it stays unverified in the registry).
    expect(calls[1].handles).toEqual([H(3), H(4)]);
  });

  it("coalescing folds case and separators on win32", () => {
    const { queue, add } = harness({ platform: "win32" });
    add(1, ["C:\\Repo\\src\\A.ts"]);
    add(2, ["c:/repo/src/a.ts"]);
    expect(queue.stats()).toMatchObject({ queued: 1, superseded: 1 });
  });

  it("one run at a time: a request of another session waits for the run in flight, then runs alone", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS);
    add(2, undefined, "orch2");
    // A request for the handle being verified is not queued again.
    queue.enqueue({ sessionID: "orch", handle: H(1), files: [] });
    await advance(BACKGROUND_SETTLE_MS * 5);
    expect(calls).toHaveLength(1);
    expect(queue.stats()).toMatchObject({ running: true, queued: 1 });
    calls[0].resolve([judged(H(1), PASS)]);
    await flush();
    await advance(0);
    expect(calls.map(c => [c.sessionID, c.handles])).toEqual([["orch", [H(1)]], ["orch2", [H(2)]]]);
  });

  it("a retryable result backs off (no hot loop), is retried at most BACKGROUND_MAX_ATTEMPTS times, then stays unverified", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS);
    for (let attempt = 1; attempt <= BACKGROUND_MAX_ATTEMPTS; attempt += 1) {
      expect(calls).toHaveLength(attempt);
      calls[attempt - 1].resolve([judged(H(1), unverifiable("verification slot busy", true))]);
      await flush();
      if (attempt === BACKGROUND_MAX_ATTEMPTS) break;
      const wait = BACKGROUND_RETRY_BASE_MS * 2 ** (attempt - 1);
      expect(queue.stats()).toMatchObject({ queued: 1, running: false, timerArmed: true });
      // Quiet while backing off.
      await expect(queue.whenIdle()).resolves.toBeUndefined();
      await advance(wait - 1);
      expect(calls).toHaveLength(attempt);
      await advance(1);
    }
    expect(queue.stats()).toMatchObject({ queued: 0, running: false, timerArmed: false, notices: 0, runs: BACKGROUND_MAX_ATTEMPTS });
  });

  it("a handle missing from the outcomes, a rejected run and a throwing verify count as retryable; errors are reported", async () => {
    let throwNow = false;
    const { queue, calls, advance, add, errors } = harness({
      verify: (sessionID, handles, signal) => {
        if (throwNow) throw new Error("sync boom");
        return new Promise((resolve, reject) => calls.push({ sessionID, handles: [...handles], signal, resolve, reject }));
      },
      maxAttempts: 4,
      retryBaseMs: 10,
      onError: e => {
        errors.push(e);
        throw new Error("the hook itself throws");
      },
    });
    add(1);
    add(2);
    await advance(BACKGROUND_SETTLE_MS);
    calls[0].resolve([judged(H(1), PASS)]);
    await flush();
    expect(queue.stats().queued).toBe(1);
    await advance(10);
    calls[1].reject(new Error("run rejected"));
    await flush();
    expect(errors).toHaveLength(1);
    throwNow = true;
    await advance(20);
    expect(errors).toHaveLength(2);
    expect(queue.stats()).toMatchObject({ queued: 1, running: false, runs: 3 });
    // A retry is superseded by a newer overlapping request queued meanwhile.
    throwNow = false;
    add(3, ["/src/2.ts"]);
    expect(queue.stats()).toMatchObject({ queued: 1, superseded: 1 });
  });

  it("a fresh request during a backoff re-arms the timer earlier: it runs after the settle delay, not the backoff", async () => {
    const { queue, calls, advance, add, scheduled } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS);
    calls[0].resolve([judged(H(1), unverifiable("verification slot busy", true))]);
    await flush();
    expect(scheduled.map(s => s.at)).toEqual([BACKGROUND_SETTLE_MS + BACKGROUND_RETRY_BASE_MS]);
    add(2, undefined, "orch2");
    expect(scheduled.map(s => s.at)).toEqual([2 * BACKGROUND_SETTLE_MS]);
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls[1].handles).toEqual([H(2)]);
    calls[1].resolve([judged(H(2), PASS)]);
    await flush();
    // Back to the backed-off retry.
    expect(scheduled.map(s => s.at)).toEqual([BACKGROUND_SETTLE_MS + BACKGROUND_RETRY_BASE_MS]);
    expect(queue.stats().queued).toBe(1);
  });

  it("a timer left armed for a forgotten request fires, finds nothing due, and re-arms for the next one", async () => {
    const { queue, calls, advance, add, scheduled } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS / 2);
    add(2, undefined, "orch2");
    queue.forgetSession("orch");
    // The earlier timer is kept (never moved later); it now has nothing due.
    expect(scheduled.map(s => s.at)).toEqual([BACKGROUND_SETTLE_MS]);
    await advance(BACKGROUND_SETTLE_MS / 2);
    expect(calls).toHaveLength(0);
    expect(scheduled.map(s => s.at)).toEqual([BACKGROUND_SETTLE_MS * 1.5]);
    await advance(BACKGROUND_SETTLE_MS / 2);
    expect(calls.map(c => c.handles)).toEqual([[H(2)]]);
  });

  it("a retry is dropped when a newer overlapping request of the session arrived during its run", async () => {
    const { queue, calls, advance, add } = harness();
    add(1, ["/src/a.ts"]);
    await advance(BACKGROUND_SETTLE_MS);
    add(2, ["/src/a.ts"]);
    calls[0].resolve([judged(H(1), unverifiable("verification slot busy", true))]);
    await flush();
    expect(queue.stats()).toMatchObject({ queued: 1, superseded: 1 });
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls[1].handles).toEqual([H(2)]);
  });

  it("reported and gone outcomes are dropped; markReported suppresses a notice before and after it exists", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    add(2);
    add(3);
    add(4);
    queue.markReported([H(3)]);
    await advance(BACKGROUND_SETTLE_MS);
    calls[0].resolve([
      { kind: "reported", handle: H(1) },
      { kind: "gone", handle: H(2) },
      judged(H(3), fail(["t > a"])),
      judged(H(4), fail(["t > b"])),
    ]);
    await flush();
    expect(queue.stats()).toMatchObject({ queued: 0, notices: 1 });
    queue.markReported([H(4)]);
    expect(queue.stats().notices).toBe(0);
    expect(queue.takeNotices("orch")).toEqual([]);
  });

  it("forgetSession drops the session's requests and notices and aborts its run; that run's results are ignored", async () => {
    const { queue, calls, advance, add } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS);
    calls[0].resolve([judged(H(1), fail(["t > a"]))]);
    await flush();
    expect(queue.stats().notices).toBe(1);
    add(2);
    await advance(BACKGROUND_SETTLE_MS);
    add(3);
    add(4, undefined, "orch2");
    queue.forgetSession("orch");
    expect(calls[1].signal.aborted).toBe(true);
    expect(queue.stats()).toMatchObject({ queued: 1, notices: 0, running: true });
    calls[1].resolve([judged(H(2), fail(["t > b"]))]);
    await flush();
    expect(queue.stats()).toMatchObject({ notices: 0, running: false });
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls[2].sessionID).toBe("orch2");
    // Forgetting a session with nothing queued is harmless.
    queue.forgetSession("nobody");
  });

  it("dispose aborts the run, clears the timer and drops everything; later calls are no-ops", async () => {
    const { queue, calls, advance, add, scheduled } = harness();
    add(1);
    await advance(BACKGROUND_SETTLE_MS);
    add(2, undefined, "orch2");
    await advance(BACKGROUND_SETTLE_MS);
    const idle = queue.whenIdle();
    queue.dispose();
    await idle;
    expect(calls[0].signal.aborted).toBe(true);
    expect(scheduled).toEqual([]);
    expect(queue.stats()).toMatchObject({ queued: 0, timerArmed: false, notices: 0 });
    calls[0].resolve([judged(H(1), fail(["t > a"]))]);
    await flush();
    add(3);
    queue.dispose();
    expect(queue.stats()).toMatchObject({ queued: 0, running: false, notices: 0, timerArmed: false });
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });

  it("sweep drops notices older than the TTL; whenIdle waits for the run", async () => {
    const { queue, calls, advance, add, c } = harness();
    add(1);
    let idle = false;
    const waiting = queue.whenIdle().then(() => {
      idle = true;
    });
    await advance(BACKGROUND_SETTLE_MS);
    expect(idle).toBe(false);
    calls[0].resolve([judged(H(1), fail(["t > a"]))]);
    await waiting;
    expect(idle).toBe(true);
    expect(queue.sweep(c.now() + TTL - 1)).toBe(0);
    expect(queue.sweep(c.now() + TTL)).toBe(1);
    expect(queue.stats().notices).toBe(0);
    expect(queue.sweep()).toBe(0);
  });

  it("caps: the queue, the notices per session and in total, and the reported memo are bounded", async () => {
    const { queue, calls, advance, add } = harness();
    for (let i = 0; i <= BACKGROUND_QUEUE_MAX; i += 1) add(i);
    expect(queue.stats().queued).toBe(BACKGROUND_QUEUE_MAX);
    queue.forgetSession("orch");

    // 33 failing handles in one session: the oldest notice is dropped.
    for (let i = 0; i <= LATE_NOTICES_PER_SESSION; i += 1) add(1000 + i);
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls[0].handles).toHaveLength(MAX_HANDLES_PER_CALL);
    calls[0].resolve(calls[0].handles.map(h => judged(h, fail(["t"]))));
    await flush();
    await advance(0);
    calls[1].resolve(calls[1].handles.map(h => judged(h, fail(["t"]))));
    await flush();
    const mine = queue.takeNotices("orch");
    expect(mine).toHaveLength(LATE_NOTICES_PER_SESSION);
    expect(mine[0].handle).toBe(H(1001));

    // More sessions than the global cap allows: the oldest notices go first.
    const sessions = Math.ceil(LATE_NOTICES_MAX / LATE_NOTICES_PER_SESSION) + 1;
    for (let s = 0; s < sessions; s += 1) {
      for (let i = 0; i < LATE_NOTICES_PER_SESSION; i += 1) add(2000 + s * 100 + i, undefined, `s${s}`);
    }
    for (let s = 0; s < sessions; s += 1) {
      await advance(BACKGROUND_SETTLE_MS);
      const call = calls[calls.length - 1];
      call.resolve(call.handles.map(h => judged(h, fail(["t"]))));
      await flush();
    }
    expect(queue.stats().notices).toBe(LATE_NOTICES_MAX);
    expect(queue.takeNotices("s0")).toEqual([]);

    // The reported memo is FIFO-bounded: the oldest handle can be noticed again.
    queue.markReported(Array.from({ length: REPORTED_MEMO_MAX + 1 }, (_, i) => H(5000 + i)));
    add(5000);
    add(5001);
    await advance(BACKGROUND_SETTLE_MS);
    const last = calls[calls.length - 1];
    last.resolve([judged(H(5000), fail(["t"])), judged(H(5001), fail(["t"]))]);
    await flush();
    expect(queue.takeNotices("orch").map(n => n.handle)).toEqual([H(5000)]);
  });

  it("the default timers are unref'd real timers", async () => {
    vi.useFakeTimers();
    const verify = vi.fn(async (): Promise<readonly BackgroundOutcome[]> => []);
    const queue = createBackgroundQueue({ verify, ttlMs: TTL, maxAttempts: 1 });
    queue.enqueue({ sessionID: "orch", handle: H(1), files: [] });
    await vi.advanceTimersByTimeAsync(BACKGROUND_SETTLE_MS - 1);
    expect(verify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(verify).toHaveBeenCalledTimes(1);
    queue.enqueue({ sessionID: "orch", handle: H(2), files: [] });
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// QA-2.4 round 1
// ---------------------------------------------------------------------------------------------

describe("QA-2.4-6: directive keys in router text", () => {
  const defaults = { defaultVerify: "deferred" as const, captureWaitMs: 5_000, baselineTimeoutMs: 15_000 };
  const noDirective = (text: string): void => {
    expect(parseVerifyDirectives(text, defaults)).toEqual({ mode: "deferred", waitMs: 5_000, modeSource: "default", waitSource: "default" });
    expect(parseVerifyDirectives(text, { ...defaults, defaultVerify: "required" }).mode).toBe("required");
    expect(parseCapDirective(text)).toBeNull();
  };
  const producerId = "test/a.test.ts > VERIFY:deferred CAP:3 VERIFY_WAIT:0s keeps state";

  it("neutralizeDirectives drops every colon after a key, any case, and keeps the lines", () => {
    expect(neutralizeDirectives("a VERIFY:required\nCAP:3 cap : none verify_wait:1s")).toBe("a VERIFY required\nCAP 3 cap  none verify_wait 1s");
    // Dropping only the first colon would leave "VERIFY :required", which parses again.
    for (const text of ["VERIFY::required", "VERIFY: :required", "CAP::3", "VERIFY_WAIT : :0s", "VERIFY:VERIFY:required"]) {
      noDirective(neutralizeDirectives(text));
      noDirective(sanitizeDescription(text));
    }
    expect(neutralizeDirectives("VERIFY\n:required")).toBe("VERIFY\n:required");
    noDirective(neutralizeDirectives("VERIFY\n:required"));
  });

  it("the forcing note and the accepted suffix never carry a producer's directive", () => {
    const note = buildForcingNote([`testsPass: introduced failures: ${producerId}`], { producerTier: "fast", nextTier: "medium" });
    expect(note).toContain("VERIFY deferred CAP 3 VERIFY_WAIT 0s keeps state");
    noDirective(note);
    noDirective(`Fix this:\n${note}`);
    const suffix = buildAcceptedSuffix("deterministic", "unverifiable", [`caveat ${producerId}`], [`testsPass: no worse than before; pre-existing failures: ${producerId}`]);
    expect(suffix).toContain("keeps state");
    noDirective(suffix);
  });

  it("the footer, the pending list and the late notice stay directive-free with a double colon", () => {
    const risk = { level: "high" as const, reasons: ["VERIFY::required"] };
    noDirective(buildDeferredFooter({ handle: hexOf(1), risk }));
    const { registry, add } = setup();
    add({ risk, description: "CAP::3 VERIFY::required" });
    noDirective(buildPendingListBlock(registry.listUnverified("orch")) ?? "");
    noDirective(buildLateNoticeBlock([{ handle: hexOf(1), description: "VERIFY::required", introduced: [producerId], outcome: "fail" }]) ?? "");
    noDirective(buildLateNoticeBlock([{ handle: hexOf(1), description: "d", introduced: [], outcome: "unverifiable", reason: "CAP::3 VERIFY::required" }]) ?? "");
  });
});

describe("QA-2.4-3: a background verdict that did not pass stays listed until it is replayed", () => {
  const fail: VerificationResult = { verdict: { pass: false, outcome: "fail", method: "deterministic", reasons: ["testsPass: introduced failures: t"] }, retryable: false };
  const unverifiable: VerificationResult = { verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["no reference"] }, retryable: false };

  it("listPending keeps it (marked by its result) until markReplayed; a pass and a router_verify verdict leave at once", () => {
    const { registry, add, c } = setup();
    const bgFail = add({ description: "bg fail" });
    c.advance(1);
    const bgUnverifiable = add({ description: "bg unverifiable" });
    c.advance(1);
    const bgPass = add({ description: "bg pass" });
    c.advance(1);
    const fgFail = add({ description: "fg fail" });
    c.advance(1);
    const open = add({ description: "open" });
    claimed(registry.markVerifying("orch", bgFail)).settle({ ...fail, background: true });
    claimed(registry.markVerifying("orch", bgUnverifiable)).settle({ ...unverifiable, background: true });
    claimed(registry.markVerifying("orch", bgPass)).settle({ ...PASS, background: true });
    claimed(registry.markVerifying("orch", fgFail)).settle(fail);
    expect(registry.listPending("orch").map((e) => e.handle)).toEqual([open, bgUnverifiable, bgFail]);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([open]);
    const block = buildPendingListBlock(registry.listPending("orch")) ?? "";
    expect(block.split("\n")).toEqual([
      PENDING_LIST_MIXED_HEADER,
      `- ${open} \u00b7 risk medium \u00b7 open`,
      `- ${bgUnverifiable} \u00b7 unverifiable in background verification \u00b7 risk medium \u00b7 bg unverifiable`,
      `- ${bgFail} \u00b7 fail in background verification \u00b7 risk medium \u00b7 bg fail`,
      "[router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.",
    ]);
    // Another session's replay changes nothing; this session's does.
    registry.markReplayed("other", [bgFail]);
    expect(registry.listPending("orch").map((e) => e.handle)).toContain(bgFail);
    registry.markReplayed("orch", [bgFail, bgUnverifiable, "vrf_unknown"]);
    expect(registry.listPending("orch").map((e) => e.handle)).toEqual([open]);
    expect(buildPendingListBlock(registry.listPending("orch"))?.split("\n")[0]).toBe("[router] Unverified delegations in this session (newest first):");
  });

  it("verifying entries are listed only on request; the TTL still ends a listed verdict", () => {
    const { registry, add, c } = setup();
    const busy = add();
    claimed(registry.markVerifying("orch", busy));
    const judged = add();
    claimed(registry.markVerifying("orch", judged)).settle({ ...fail, background: true });
    expect(registry.listPending("orch").map((e) => e.handle)).toEqual([judged]);
    expect(registry.listPending("orch", { verifying: true }).map((e) => e.handle).sort()).toEqual([busy, judged].sort());
    c.advance(TTL);
    expect(registry.listPending("orch").map((e) => e.handle)).toEqual([]);
    expect(registry.get("orch", judged).kind).toBe("expired");
  });

  it("a cap never evicts it, as for an unverified entry; once replayed it may go", () => {
    const { registry, add, c, evictions } = setup({ maxPerSession: 1 });
    const judged = add();
    claimed(registry.markVerifying("orch", judged)).settle({ ...fail, background: true });
    c.advance(1);
    expect(registry.register(reg())).toMatchObject({ ok: false, code: "registry-full" });
    expect(evictions).toEqual([]);
    registry.markReplayed("orch", [judged]);
    expect(registry.register(reg())).toMatchObject({ ok: true, evicted: [judged] });
  });
});

describe("QA-2.4-5: foreground precedence in the background queue", () => {
  const H = (n: number): string => `vrf_${n.toString(16).padStart(24, "0")}`;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const retryable: VerificationResult = { verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["router_verify was cancelled before a verdict"] }, retryable: true };
  const judged = (handle: string, result: VerificationResult): BackgroundOutcome => ({ kind: "judged", handle, description: "d", result: { ...result, handle, settledAt: 0 } });

  function harness(busy: () => boolean = () => false) {
    const c = clock(0);
    const scheduled: Array<{ at: number; cb: () => void; id: number }> = [];
    let ids = 0;
    const timers: BackgroundTimers = {
      setTimeout(cb, ms) {
        ids += 1;
        scheduled.push({ at: c.now() + ms, cb, id: ids });
        return ids;
      },
      clearTimeout(handle) {
        const i = scheduled.findIndex(s => s.id === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    };
    const calls: Array<{ handles: readonly string[]; signal: AbortSignal; resolve: (o: readonly BackgroundOutcome[]) => void }> = [];
    const verify = vi.fn(
      (_sid: string, handles: readonly string[], signal: AbortSignal) =>
        new Promise<readonly BackgroundOutcome[]>(resolve => {
          calls.push({ handles: [...handles], signal, resolve });
        }),
    );
    const queue = createBackgroundQueue({ verify, ttlMs: TTL, now: c.now, timers, platform: "linux", maxAttempts: 1, busy });
    const advance = async (ms: number): Promise<void> => {
      c.advance(ms);
      for (;;) {
        const due = scheduled.filter(s => s.at <= c.now()).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        scheduled.splice(scheduled.indexOf(due), 1);
        due.cb();
        await flush();
      }
      await flush();
    };
    return { queue, calls, verify, advance, scheduled, c };
  }

  it("preempt aborts the run, resolves when it finished, and requeues it with backoff without using an attempt", async () => {
    const { queue, calls, verify, advance } = harness();
    await expect(queue.preempt()).resolves.toBeUndefined();
    queue.enqueue({ sessionID: "orch", handle: H(1), files: ["/a"] });
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls).toHaveLength(1);
    let finished = false;
    const preempted = queue.preempt().then(() => {
      finished = true;
    });
    expect(calls[0].signal.aborted).toBe(true);
    await flush();
    expect(finished).toBe(false);
    calls[0].resolve([judged(H(1), retryable)]);
    await preempted;
    // maxAttempts is 1: a counted retry would have ended the request here.
    expect(queue.stats()).toMatchObject({ queued: 1, running: false, notices: 0 });
    await advance(BACKGROUND_RETRY_BASE_MS - 1);
    expect(verify).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(verify).toHaveBeenCalledTimes(2);
    // A verdict the preempted run had already reached is kept (not requeued).
    calls[1].resolve([judged(H(1), { verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] }, retryable: false })]);
    await flush();
    expect(queue.stats()).toMatchObject({ queued: 0, running: false });
  });

  it("QA-2.4-12 (M17): enqueue never coalesces across sessions: another session's overlapping queued request survives", async () => {
    const { queue, calls, advance } = harness();
    queue.enqueue({ sessionID: "s1", handle: H(1), files: ["/shared.ts"] });
    queue.enqueue({ sessionID: "s2", handle: H(2), files: ["/shared.ts"] });
    expect(queue.stats()).toMatchObject({ queued: 2, superseded: 0 });
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls.map(c => c.handles)).toEqual([[H(1)]]);
    calls[0].resolve([]);
    await flush();
    await advance(BACKGROUND_RETRY_BASE_MS * 4);
    expect(calls.map(c => c.handles)).toContainEqual([H(2)]);
  });

  it("no run starts while foreground verification is busy: the due requests back off, uncounted, and run once it is not", async () => {
    let busy = true;
    const { queue, calls, advance } = harness(() => busy);
    queue.enqueue({ sessionID: "orch", handle: H(1), files: ["/a"] });
    await advance(BACKGROUND_SETTLE_MS);
    expect(calls).toHaveLength(0);
    // Postponed requests are neither fresh nor due: the queue is idle, and no hot loop runs.
    await expect(queue.whenIdle()).resolves.toBeUndefined();
    await advance(BACKGROUND_RETRY_BASE_MS);
    expect(calls).toHaveLength(0);
    busy = false;
    await advance(BACKGROUND_RETRY_BASE_MS * 2);
    expect(calls).toHaveLength(1);
    expect(calls[0].handles).toEqual([H(1)]);
  });
});
