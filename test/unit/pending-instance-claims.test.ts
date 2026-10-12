// QA-2.1-19: a session claim names its owner by pid AND per-instance token, so a second plugin instance of the same
// process can never adopt (and post or wake for) a session the first one is still running a dispatch for.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimPendingSession, createInstanceClaimToken, releasePendingClaim } from "../../src/verify/pending";

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
