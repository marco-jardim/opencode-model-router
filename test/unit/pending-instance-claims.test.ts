// QA-2.1-19: a session claim names its owner by pid AND per-instance token, so a second plugin instance of the same
// process can never adopt (and post or wake for) a session the first one is still running a dispatch for.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_REFRESH_MS, CLAIM_STALE_MS, PENDING_INSTANCES_DIRNAME, claimPendingSession, createInstanceClaimToken, refreshPendingClaims, releasePendingClaim,
  writeInstanceBeat,
} from "../../src/verify/pending";

describe("QA-2.1-19: per-instance session claims", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const claimsDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), "omr-claims-"));
    roots.push(root);
    return join(root, "pending.claims");
  };
  const alive = (): boolean => true;

  it("a live instance's claim is refused to another instance of the same process, and kept by its owner", () => {
    const dir = claimsDir();
    const first = createInstanceClaimToken();
    const second = createInstanceClaimToken();
    try {
      expect(first.token).not.toBe(second.token);
      expect(claimPendingSession(dir, "ses_a", { pid: process.pid, now: 1, isAlive: alive, token: first.token })).toBe(true);
      expect(claimPendingSession(dir, "ses_a", { pid: process.pid, now: 2, isAlive: alive, token: second.token })).toBe(false);
      // The refusal never rewrote the claim: it still names the first instance.
      expect(JSON.parse(readFileSync(join(dir, "ses_a"), "utf8"))).toMatchObject({ pid: process.pid, token: first.token });
      expect(claimPendingSession(dir, "ses_a", { pid: process.pid, now: 3, isAlive: alive, token: first.token })).toBe(true);
    } finally {
      first.release();
      second.release();
    }
  });

  it("a disposed instance's claim (token released) is taken over by another instance of the process", () => {
    const dir = claimsDir();
    const first = createInstanceClaimToken();
    const second = createInstanceClaimToken();
    try {
      expect(claimPendingSession(dir, "ses_b", { pid: process.pid, now: 1, isAlive: alive, token: first.token })).toBe(true);
      first.release();
      first.release(); // idempotent
      expect(claimPendingSession(dir, "ses_b", { pid: process.pid, now: 2, isAlive: alive, token: second.token })).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "ses_b"), "utf8"))).toMatchObject({ token: second.token });
      // Only the owner's token removes the claim.
      expect(releasePendingClaim(dir, "ses_b", first.token)).toBe(false);
      expect(releasePendingClaim(dir, "ses_b", second.token)).toBe(true);
    } finally {
      second.release();
    }
  });

  it("another live process's fresh claim is refused whatever the instance token", () => {
    const dir = claimsDir();
    const mine = createInstanceClaimToken();
    try {
      const otherPid = process.pid + 100_000;
      expect(claimPendingSession(dir, "ses_c", { pid: otherPid, now: 1, isAlive: alive, token: "other-process" })).toBe(true);
      expect(claimPendingSession(dir, "ses_c", { pid: process.pid, now: 2, isAlive: alive, token: mine.token })).toBe(false);
      // A dead owner's claim is stale and taken over.
      expect(claimPendingSession(dir, "ses_c", { pid: process.pid, now: 3, isAlive: (pid) => pid === process.pid, token: mine.token })).toBe(true);
    } finally {
      mine.release();
    }
  });
});

describe("QA-2.1-34: pid-reuse-safe claims (refresh every CLAIM_REFRESH_MS, stale after CLAIM_STALE_MS)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const claimsDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), "omr-claims-stale-"));
    roots.push(root);
    return join(root, "pending.claims");
  };
  const alive = (): boolean => true;
  const otherPid = process.pid + 100_000;

  it("the constants: a live owner refreshes at least four times within the stale age, and the stale age is minutes, not hours", () => {
    expect(CLAIM_REFRESH_MS).toBeLessThanOrEqual(60_000);
    expect(CLAIM_STALE_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(CLAIM_STALE_MS).toBeGreaterThanOrEqual(4 * CLAIM_REFRESH_MS);
  });

  it("a claim of a live-but-reused pid older than the stale age is taken over (no refresh happened)", () => {
    const dir = claimsDir();
    const mine = createInstanceClaimToken();
    try {
      const t0 = 1_000_000;
      // The crashed owner's claim; its pid now belongs to an unrelated live process (isAlive says yes).
      expect(claimPendingSession(dir, "ses_reused", { pid: otherPid, now: t0, isAlive: alive, token: "crashed-owner" })).toBe(true);
      // Within the stale age the live pid still protects it.
      expect(claimPendingSession(dir, "ses_reused", { pid: process.pid, now: t0 + CLAIM_STALE_MS, isAlive: alive, token: mine.token })).toBe(false);
      // Past it (the default stale age, no `staleMs` seam): taken over and rewritten for this instance.
      expect(claimPendingSession(dir, "ses_reused", { pid: process.pid, now: t0 + CLAIM_STALE_MS + 1, isAlive: alive, token: mine.token })).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "ses_reused"), "utf8"))).toMatchObject({ pid: process.pid, token: mine.token, at: t0 + CLAIM_STALE_MS + 1 });
    } finally {
      mine.release();
    }
  });

  it("the owner's refresh keeps its claim fresh well past the stale age; once it stops, the claim goes stale", () => {
    const dir = claimsDir();
    const mine = createInstanceClaimToken();
    try {
      const t0 = 2_000_000;
      expect(claimPendingSession(dir, "ses_live", { pid: otherPid, now: t0, isAlive: alive, token: "live-owner" })).toBe(true);
      // The live owner re-stamps every CLAIM_REFRESH_MS for three stale ages; every claim attempt in between is refused.
      let now = t0;
      while (now < t0 + 3 * CLAIM_STALE_MS) {
        now += CLAIM_REFRESH_MS;
        refreshPendingClaims(dir, ["ses_live"], { pid: otherPid, now, token: "live-owner" });
        expect(claimPendingSession(dir, "ses_live", { pid: process.pid, now: now + 1, isAlive: alive, token: mine.token })).toBe(false);
      }
      expect(JSON.parse(readFileSync(join(dir, "ses_live"), "utf8"))).toMatchObject({ pid: otherPid, token: "live-owner", at: now });
      // A refresh under another token never re-stamps the owner's claim.
      refreshPendingClaims(dir, ["ses_live"], { pid: process.pid, now: now + CLAIM_STALE_MS, token: mine.token });
      expect(JSON.parse(readFileSync(join(dir, "ses_live"), "utf8"))).toMatchObject({ token: "live-owner", at: now });
      // The owner stops refreshing (crash, pid reused): past the stale age the claim is taken over.
      expect(claimPendingSession(dir, "ses_live", { pid: process.pid, now: now + CLAIM_STALE_MS + 1, isAlive: alive, token: mine.token })).toBe(true);
    } finally {
      mine.release();
    }
  });

  it("within one process the per-instance token rule still decides, whatever the claim's age", () => {
    const dir = claimsDir();
    const first = createInstanceClaimToken();
    const second = createInstanceClaimToken();
    try {
      expect(claimPendingSession(dir, "ses_same", { pid: process.pid, now: 1, isAlive: alive, token: first.token })).toBe(true);
      // Same pid, another live instance: refused even long past the stale age.
      expect(claimPendingSession(dir, "ses_same", { pid: process.pid, now: 1 + 10 * CLAIM_STALE_MS, isAlive: alive, token: second.token })).toBe(false);
    } finally {
      first.release();
      second.release();
    }
  });
});

describe("DF-1-10: instance beat files (sibling module copies in one host process)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const dirs = (): { claims: string; beats: string } => {
    const root = mkdtempSync(join(tmpdir(), "omr-claims-beat-"));
    roots.push(root);
    return { claims: join(root, "pending.claims"), beats: join(root, PENDING_INSTANCES_DIRNAME) };
  };
  const alive = (): boolean => true;
  // A token of another module copy: never in this copy's live-token set.
  const siblingToken = "sibling-copy-token.0001";

  it("DF-1-10 same pid, other token, fresh heartbeat → refused (the claim stays the owner's)", () => {
    const { claims, beats } = dirs();
    const mine = createInstanceClaimToken(beats);
    try {
      const t0 = 3_000_000;
      expect(claimPendingSession(claims, "ses_live", { pid: process.pid, now: t0, isAlive: alive, token: siblingToken })).toBe(true);
      writeInstanceBeat(beats, siblingToken, { pid: process.pid, now: t0 });
      expect(claimPendingSession(claims, "ses_live", { pid: process.pid, now: t0 + CLAIM_STALE_MS, isAlive: alive, token: mine.token, beatsDir: beats })).toBe(false);
      expect(JSON.parse(readFileSync(join(claims, "ses_live"), "utf8"))).toMatchObject({ pid: process.pid, token: siblingToken, at: t0 });
    } finally {
      mine.release();
    }
  });

  it("DF-1-10 same pid, other token, stale heartbeat → taken; no beat file or another pid's beat → taken (df1 behaviour)", () => {
    const { claims, beats } = dirs();
    const mine = createInstanceClaimToken(beats);
    try {
      const t0 = 4_000_000;
      expect(claimPendingSession(claims, "ses_stale", { pid: process.pid, now: t0, isAlive: alive, token: siblingToken })).toBe(true);
      writeInstanceBeat(beats, siblingToken, { pid: process.pid, now: t0 });
      expect(claimPendingSession(claims, "ses_stale", { pid: process.pid, now: t0 + CLAIM_STALE_MS + 1, isAlive: alive, token: mine.token, beatsDir: beats })).toBe(true);
      expect(JSON.parse(readFileSync(join(claims, "ses_stale"), "utf8"))).toMatchObject({ token: mine.token });

      expect(claimPendingSession(claims, "ses_nobeat", { pid: process.pid, now: t0, isAlive: alive, token: "df1-build-token" })).toBe(true);
      expect(claimPendingSession(claims, "ses_nobeat", { pid: process.pid, now: t0 + 1, isAlive: alive, token: mine.token, beatsDir: beats })).toBe(true);

      expect(claimPendingSession(claims, "ses_otherpid", { pid: process.pid, now: t0, isAlive: alive, token: "reused-pid-token" })).toBe(true);
      writeInstanceBeat(beats, "reused-pid-token", { pid: process.pid + 100_000, now: t0 });
      expect(claimPendingSession(claims, "ses_otherpid", { pid: process.pid, now: t0 + 1, isAlive: alive, token: mine.token, beatsDir: beats })).toBe(true);
    } finally {
      mine.release();
    }
  });

  it("DF-1-10 a second module copy refuses a live instance's claim while it beats, and takes it once that instance releases", async () => {
    const { claims, beats } = dirs();
    vi.resetModules();
    const sibling = await import("../../src/verify/pending");
    const owner = createInstanceClaimToken(beats);
    const other = sibling.createInstanceClaimToken(beats);
    try {
      expect(claimPendingSession(claims, "ses_s", { pid: process.pid, now: Date.now(), isAlive: alive, token: owner.token })).toBe(true);
      // The copies share no live-token set; the owner's beat file is what the sibling copy sees.
      owner.beat();
      expect(readdirSync(beats)).toContain(encodeURIComponent(owner.token));
      expect(sibling.claimPendingSession(claims, "ses_s", { pid: process.pid, now: Date.now(), isAlive: alive, token: other.token, beatsDir: beats })).toBe(false);
      owner.release();
      expect(readdirSync(beats)).not.toContain(encodeURIComponent(owner.token));
      expect(sibling.claimPendingSession(claims, "ses_s", { pid: process.pid, now: Date.now(), isAlive: alive, token: other.token, beatsDir: beats })).toBe(true);
    } finally {
      owner.release();
      other.release();
    }
  });
});
