// Coverage tests for `commitTaskInSlot` in src/executor/runtime.ts: index.lock recovery (`removeIndexLock`), the
// identity error and the D11 clean-tree arms. Every git answer is scripted (`ScriptedGit`); no runtime is built. The
// runtime's own arms are covered by executor-runtime-coverage-a.test.ts and executor-runtime-coverage-b.test.ts, which
// keep the lists of the arms left uncovered on purpose.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commitTaskInSlot } from "../../src/executor/runtime.js";
import { ExecutorError, type GitRunner, type ProcOpts, type ProcessResult, type SlotLease } from "../../src/executor/types.js";
import { PLAN_ID } from "../fixtures/cpx/ledger/builders.js";

vi.setConfig({ testTimeout: 30_000 });

const SHA = "c".repeat(40);

// ---------------------------------------------------------------------------------------------------------------
// commitTaskInSlot: index.lock recovery (removeIndexLock), identity errors and the D11 clean-tree arms
// ---------------------------------------------------------------------------------------------------------------

/** A GitRunner scripted per call: each answer is consumed in order (a function answer may throw). */
class ScriptedGit implements GitRunner {
  readonly calls: string[] = [];
  constructor(private readonly answers: Array<Partial<ProcessResult> | (() => Partial<ProcessResult>)>) {}
  async run(args: readonly string[], _o: ProcOpts): Promise<ProcessResult> {
    this.calls.push(args.join(" "));
    const next = this.answers.shift();
    const a = typeof next === "function" ? next() : (next ?? {});
    return { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, ...a };
  }
}

const LOCK_ERR = { code: 128, stderr: "fatal: Unable to create '.git/index.lock': File exists." };

describe("commitTaskInSlot: index.lock and error arms", () => {
  const lease = (path: string): SlotLease => ({ slot: "slot-1", path, planId: PLAN_ID, owner: "o", commit: SHA });

  it("removes a relative index.lock under the slot and retries the step once (removeIndexLock relative arm)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "index.lock"), "");
    const git = new ScriptedGit([LOCK_ERR, { stdout: ".git/index.lock\n" }, { stdout: "" }]);
    const out = await commitTaskInSlot(git, { slot: lease(dir), branch: "b", message: "m", timeoutMs: 1000 });
    expect(out).toEqual({ changed: false });
    expect(git.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock", "status --porcelain"]);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("removes an absolute index.lock path as given (removeIndexLock absolute arm)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    const lockPath = join(dir, "index.lock");
    await writeFile(lockPath, "");
    const git = new ScriptedGit([LOCK_ERR, { stdout: `${lockPath}\n` }, { stdout: " M a.ts\n" }, {}, {}, {}, { stdout: `${SHA}\n` }]);
    const out = await commitTaskInSlot(git, { slot: lease("C:/elsewhere"), branch: "b", message: "m", timeoutMs: 1000 });
    expect(out).toEqual({ changed: true, commit: SHA });
    expect(existsSync(lockPath)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not retry when the lock path is unknown (rev-parse fails or prints nothing) and throws E_GIT (removeIndexLock unknown-path arms)", async () => {
    for (const lockAnswer of [{ code: 1, stdout: "x" }, { stdout: "  \n" }]) {
      const git = new ScriptedGit([LOCK_ERR, lockAnswer]);
      const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ExecutorError);
      expect(err instanceof ExecutorError ? err.code : null).toBe("E_GIT");
      expect(git.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock"]);
    }
  });

  it("swallows a throwing rev-parse inside the lock removal (removeIndexLock catch) and removes a lock only once", async () => {
    const git = new ScriptedGit([
      LOCK_ERR,
      () => {
        throw new Error("spawn failed");
      },
    ]);
    const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_GIT");
    // A second lock failure after one removal is not retried again (the `!lockRemoved` arm of commitTaskInSlot's step).
    const dir = await mkdtemp(join(tmpdir(), "omr-rt-lock-"));
    const git2 = new ScriptedGit([LOCK_ERR, { stdout: "index.lock" }, LOCK_ERR]);
    const err2 = await commitTaskInSlot(git2, { slot: lease(dir), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err2 instanceof ExecutorError ? err2.code : null).toBe("E_GIT");
    expect(git2.calls).toEqual(["status --porcelain", "rev-parse --git-path index.lock", "status --porcelain"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies a missing identity as E_IDENTITY (commitTaskInSlot step: identity arm)", async () => {
    const git = new ScriptedGit([{ stdout: " M a.ts\n" }, {}, {}, { code: 128, stderr: "Author identity unknown\n" }]);
    const err = await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err instanceof ExecutorError ? err.code : null).toBe("E_IDENTITY");
  });

  it("a clean tree with the trailer on HEAD but a failing or empty rev-parse is unchanged (commitTaskInSlot D11 clean-tree arms)", async () => {
    const trailer = "Omr-Attempt: plan-one/T1/1/abc";
    const body = { stdout: `subject\n\n${trailer}\n` };
    for (const head of [{ code: 1, stdout: SHA }, { stdout: "\n" }]) {
      const git = new ScriptedGit([{ stdout: "" }, body, head]);
      expect(await commitTaskInSlot(git, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000, trailer })).toEqual({
        changed: false,
      });
    }
    const failedLog = new ScriptedGit([{ stdout: "" }, { code: 1, stdout: trailer }]);
    expect(await commitTaskInSlot(failedLog, { slot: lease("C:/s"), branch: "b", message: "m", timeoutMs: 1000, trailer })).toEqual({
      changed: false,
    });
    expect(failedLog.calls).toEqual(["status --porcelain", "log -1 --format=%B"]);
  });
});
