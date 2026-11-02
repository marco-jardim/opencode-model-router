import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, statePath } from "../../src/router/config";
import {
  adaptiveStatePath,
  readAdaptiveSnapshotFile,
  resetAdaptiveViewCache,
  writeAdaptiveSnapshotAtomic,
} from "../../src/router/adaptive-store";

// ---------------------------------------------------------------------------
// Causal RED on the WEEKLY REVIEW RUNTIME (slice A1), driven through the REAL
// plugin's chat.message hook — exactly the entrypoint the v2 adapter invokes
// on every root prompt (src/compat/v2-hooks.ts "prompt" -> legacy
// chat.message). No exports-gated seams, no fake pure helpers.
//
// Confirmed liveness defect (src/index.ts): startAdaptiveReview is called ONLY
// inside `if (!catalogFetchStarted)` (turn 1) and `adaptiveReviewStarted` is
// set forever, so
//   * an opt-in that appears AFTER turn 1 never starts a review, and
//   * a snapshot that becomes due again next week is never re-reviewed.
//
// The fix must re-check on EVERY root turn, read the LATEST config (not the
// startup one), keep one in-flight review per process (released in finally),
// never await network on the chat hot path, and never fetch when the store
// says the review is not due. No timers, no daemon, no model calls.
//
// Isolation mirrors the protected suites: HOME is a temp directory, a guard
// fails the test before it writes anywhere else, and global fetch is stubbed
// so no test ever touches the network.
// ---------------------------------------------------------------------------

let tmpHome = "";
let tmpProject = "";
let restoreHomeEnv: () => void = () => {};
let disposePlugin: (() => Promise<void>) | undefined;

function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `adaptive-weekly-runtime.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}"`,
    );
  }
}

function writeGlobalConfig(extra: Record<string, unknown> = {}): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      activePreset: "workstation",
      presets: {
        workstation: {
          fast: { model: "base/g-model" },
          medium: { model: "base/g-model-medium" },
          heavy: { model: "base/g-model-heavy" },
        },
      },
      ...extra,
    }),
    "utf-8",
  );
  invalidateConfigCache();
}

const ADAPTIVE_BLOCK = { managedTiers: { workstation: ["fast", "medium", "heavy"] }, local: false };

async function makePlugin(): Promise<(input: unknown, output: unknown) => Promise<void>> {
  const childRunner = {
    async run() { return { sessionID: "unused", text: "" }; },
    async dispose() {},
  };
  const ctx = {
    directory: tmpProject,
    worktree: tmpProject,
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
        create: async () => ({ data: { id: "unused" } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "" }] } }),
        delete: async () => ({}),
      },
    },
    routerHost: "v2" as const,
    routerChildRunner: childRunner,
    routerCatalog: async () => [],
  };
  const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as {
    "chat.message"(input: unknown, output: unknown): Promise<void>;
    dispose(): Promise<void>;
  };
  const prevDispose = disposePlugin;
  disposePlugin = async () => {
    await prevDispose?.();
    await hooks.dispose();
  };
  return (input: unknown, output: unknown) => hooks["chat.message"](input, output);
}

/** One root turn: the shape the v2 adapter builds for a root prompt. */
async function rootTurn(chatMessage: (input: unknown, output: unknown) => Promise<void>, n: number): Promise<void> {
  await chatMessage(
    { sessionID: `root-${n}`, agent: "orchestrator" },
    { message: { agent: "orchestrator" }, parts: [{ type: "text", text: "hello" }] },
  );
}

async function waitFor(what: string, predicate: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`adaptive-weekly-runtime.test: timed out waiting for ${what}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotGeneration(): number | undefined {
  return readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot?.generation;
}

beforeEach(() => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  restoreHomeEnv = () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  };
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-weekly-"));
  tmpProject = mkdtempSync(join(tmpdir(), "oc-mr-weekly-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) throw new Error("adaptive-weekly-runtime.test: os.homedir() is not the temporary home");
  assertInsideTmpHome(overridePath());
  assertInsideTmpHome(statePath());
  invalidateConfigCache();
  resetAdaptiveViewCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await disposePlugin?.();
  disposePlugin = undefined;
  restoreHomeEnv();
  if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (tmpProject !== "") rmSync(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpHome = "";
  tmpProject = "";
  invalidateConfigCache();
  resetAdaptiveViewCache();
});

describe("adaptive weekly review runtime liveness (slice A1)", () => {
  it("an opt-in that appears after turn 1 starts a review on the next root turn", async () => {
    // Turn 1 without the opt-in: nothing may ever be written.
    writeGlobalConfig();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "" })));
    const chatMessage = await makePlugin();
    await rootTurn(chatMessage, 1);
    await sleep(250);
    expect(existsSync(adaptiveStatePath())).toBe(false);

    // The user opts in globally; the NEXT root turn must pick it up without a restart.
    writeGlobalConfig({ adaptiveRouting: ADAPTIVE_BLOCK });
    await rootTurn(chatMessage, 2);
    await waitFor("the snapshot to appear after a later opt-in", () => existsSync(adaptiveStatePath()));
    const snap = readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot;
    expect(snap?.generation).toBe(1);
    expect(snap?.lastAttemptAt).not.toBeNull();
  });

  it("a snapshot that becomes due again after a week is re-reviewed on a later root turn", async () => {
    writeGlobalConfig({ adaptiveRouting: ADAPTIVE_BLOCK });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, text: async () => "" })));
    const chatMessage = await makePlugin();

    await rootTurn(chatMessage, 1);
    // Wait for the FULL settle, not just the claim: the claim already writes
    // generation 1, and the commit (a hold here — the stubbed source fails)
    // is the last thing the background review does. Aging before the commit
    // would let that commit overwrite the aged file back to "fresh".
    await waitFor(
      "the first review to commit",
      () => (readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot?.reasons.length ?? 0) > 0,
    );
    const first = readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot!;
    expect(first.generation).toBe(1);
    await sleep(100); // let the settled promise chain run its finally

    // Age the committed snapshot past the week (no timers, no clock hacks in src):
    // the same plugin instance must re-run the review on the next root turn.
    await writeAdaptiveSnapshotAtomic(adaptiveStatePath(), {
      ...first,
      lastAttemptAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    } as typeof first);
    resetAdaptiveViewCache();
    await rootTurn(chatMessage, 2);
    await waitFor("the next-week review to commit", () => (snapshotGeneration() ?? 0) >= 2);
  });

  it("resolves the source revision once per review and never claims a second review while one is in flight", async () => {
    writeGlobalConfig({ adaptiveRouting: ADAPTIVE_BLOCK });
    const urls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        if (String(url).includes("/commits/main")) await gate;
        return { ok: false, text: async () => "" };
      }),
    );
    const chatMessage = await makePlugin();

    await rootTurn(chatMessage, 1);
    await rootTurn(chatMessage, 2); // still in flight: must not start a second review
    // The review is fire-and-forget: wait until the gated resolution call has
    // actually started before counting it.
    await waitFor("the in-flight resolution call to start", () => urls.some((u) => u.includes("/commits/main")));
    expect(urls.filter((u) => u.includes("/commits/main"))).toHaveLength(1);

    release!();
    await waitFor(
      "the in-flight review to commit",
      () => (readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot?.reasons.length ?? 0) > 0,
    );
    expect(snapshotGeneration()).toBe(1);
  });
});
