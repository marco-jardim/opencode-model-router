/**
 * test/integration/v2-tier-child.test.ts
 *
 * QA round 2, N1: on OpenCode v2 a TIER agent's `subagent` call carries its child session into verification.
 * The v2 host reports the child only in the structured result (`result.output.sessionID`, no metadata); the adapter
 * (src/compat/v2-hooks.ts) falls back to it for tier calls, as it already did for role calls. Without that, the child's
 * tool-observed edits and its unobservable-writer tally (bash/shell, router_run, execute, MCP) never reached the producer
 * lineage, so deferral, the trivial skip and the unattributed-writers caveat never ran for v2 tier calls.
 *
 * End to end through the adapter: the real plugin (src/index) and gate on a real temporary git repository, wired to a fake v2
 * context through registerV2Hooks; the harness is unattributed-writers.test.ts's (tree snapshots pinned through the
 * `src/verify/tree` mock seam), driven with v2 tool names (`subagent`, `shell`, `read`, `edit`) and v2 events
 * (`execute.before` / `execute.after`). Every case is deterministic: no retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import { invalidateConfigCache } from "../../src/router/config";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** While `tree` is set, every router call to snapshotTree gets it. */
const pinned = vi.hoisted(() => ({ tree: undefined as Tree }));

vi.mock("../../src/verify/tree", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/tree")>();
  return {
    ...actual,
    snapshotTree: (...args: Parameters<typeof actual.snapshotTree>) =>
      (pinned.tree !== undefined ? Promise.resolve(pinned.tree) : actual.snapshotTree(...args)),
  };
});

const SYNC_DOD = "[acceptance]\ncheck: fileExists path=index.ts\n[/acceptance]";
const TESTS_ONLY_DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
const CAVEAT = (tools: string): RegExp =>
  new RegExp(`no change was observed in \\S+ but the producer ran ${tools}; a write those tools made cannot be seen, so this is not a verified pass`);
const ANY_CAVEAT = /no change was observed in \S+ but the producer ran /;

const ORCHESTRATOR = "orch";
const CHILD = "child1";

let home = "";
let repo = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const cleanups: Array<() => Promise<void>> = [];

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** Takes a real snapshot of the repository as it is now (no time bound) and pins it for the router's snapshot calls. */
async function pinTree(): Promise<void> {
  pinned.tree = undefined;
  const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const tree = await snapshotTree(repo, new AbortController().signal, { digestPaths: [] });
  if (tree === undefined) throw new Error("the real snapshot of the test repository failed");
  pinned.tree = tree;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-v2tier-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "omr-v2tier-repo-"));
  fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 0;\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
}, 60_000); // setup only: git init/add/commit are slow when the whole suite runs in parallel

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  pinned.tree = undefined;
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
  invalidateConfigCache();
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Harness {
  readonly legacy: any;
  readonly toolHooks: Record<string, (event: any) => Promise<void>>;
}

/** The real plugin on the repository, registered through the v2 adapter on a fake v2 context. */
async function makeHarness(): Promise<Harness> {
  const legacyCtx = {
    directory: repo,
    worktree: repo,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => ({ data: { id: "grader_1" } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "DONE: implemented." }] } }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  const legacy = await ModelRouterPlugin(legacyCtx as unknown as Parameters<typeof ModelRouterPlugin>[0]);

  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const agents = [{ id: "fast", mode: "subagent" }, { id: "build", mode: "primary" }];
  const editors = {
    agent: { update: (_id: string, _apply: (agent: any) => void) => {} },
    command: { add: (_command: any) => {} },
    tool: { add: (_definition: any) => {} },
  };
  const ctx = {
    location: { directory: repo, project: { directory: repo } },
    agent: { reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: agents })), transform: vi.fn(async (cb: any) => { cb(editors.agent); return register(); }) },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async (cb: any) => { cb(editors.command); return register(); }) },
    tool: {
      transform: vi.fn(async (cb: any) => { cb(editors.tool); return register(); }),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: sessionID === CHILD ? ORCHESTRATOR : undefined, agent: "fast" })),
      update: vi.fn(async (_input: unknown) => {}),
      context: vi.fn(async () => [] as any[]),
      prompt: vi.fn(async () => {}),
      synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (_name: string, _cb: any) => register()),
    },
    permission: { hook: vi.fn(async (_name: string, _cb: any) => register()) },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        // No host events in these cases: wait for the adapter to be disposed.
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      },
    },
  };
  cleanups.push(await registerV2Hooks(ctx as unknown as Context, legacy as Hooks));
  // The clean tree that the dispatch snapshot sees.
  await pinTree();
  return { legacy, toolHooks };
}

let callCounter = 0;

/** One completed v2 tool call of the child session: `execute.before`, then `execute.after`. No file is written by the harness. */
async function childCall(h: Harness, tool: string, input: Record<string, unknown>, content = ""): Promise<void> {
  const event: any = { sessionID: CHILD, agent: "fast", messageID: "m", id: `c${++callCounter}`, tool, input };
  await h.toolHooks["execute.before"]!(event);
  await h.toolHooks["execute.after"]!({ ...event, status: "completed", result: { content } });
}

/** The visible text of a v2 tool result: its content parts and the structured output text. */
function visibleText(result: any): string {
  const content = typeof result.content === "string" ? result.content
    : Array.isArray(result.content) ? result.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
  const structured = result.output && typeof result.output === "object" && typeof result.output.output === "string" ? result.output.output : "";
  return `${content}\n${structured}`;
}

/**
 * A tier orchestrator (session "orch") calls `subagent` on the tier agent `fast`; `work` runs the child session's tool calls
 * between the call's before and after hooks. The host reports the child only as `result.output.sessionID`: no metadata.
 */
async function runTierSubagent(h: Harness, prompt: string, work: () => Promise<void>): Promise<{ text: string; result: any }> {
  const event: any = {
    sessionID: ORCHESTRATOR, agent: "build", messageID: "m", id: `s${++callCounter}`, tool: "subagent",
    input: { agent: "fast", prompt, description: "the work" },
  };
  await h.toolHooks["execute.before"]!(event);
  await work();
  event.status = "completed";
  event.result = { content: [{ type: "text", text: "DONE: implemented." }], output: { sessionID: CHILD, status: "completed", output: "DONE: implemented." } };
  await h.toolHooks["execute.after"]!(event);
  return { text: visibleText(event.result), result: event.result };
}

/** The child ran `shell` (v2 name, mapped to `bash`), changed no file, and the unchanged tree is pinned for the gate. */
const ranShellOnly = (h: Harness) => async (): Promise<void> => {
  await childCall(h, "shell", { command: "echo hi" }, "hi");
  await pinTree();
};

describe("a v2 tier subagent call carries the structured child session into verification (N1)", () => {
  it("a child that only ran shell and changed no file is unverified, with the unobservable-writers caveat", async () => {
    const h = await makeHarness();
    const { text, result } = await runTierSubagent(h, `Implement it.\n${SYNC_DOD}`, ranShellOnly(h));
    expect(text).toMatch(CAVEAT("bash"));
    expect(text).toContain("UNVERIFIED");
    expect(text).not.toContain("✓ verified");
    // The structured result keeps naming the child the host reported.
    expect(result.output.sessionID).toBe(CHILD);
  }, 60_000);

  it("a child that only read leaves no caveat (control)", async () => {
    const h = await makeHarness();
    const { text } = await runTierSubagent(h, `Implement it.\n${SYNC_DOD}`, async () => {
      await childCall(h, "read", { path: path.join(repo, "index.ts") }, "export const v = 0;");
      await pinTree();
    });
    expect(text).not.toMatch(ANY_CAVEAT);
  }, 60_000);

  it("a child's observed edit makes a testsPass-only deferred DoD really deferred: the call returns a vrf_ handle", async () => {
    const h = await makeHarness();
    const { text } = await runTierSubagent(h, `Implement it.\n${TESTS_ONLY_DEFERRED_DOD}`, async () => {
      await childCall(h, "edit", { path: path.join(repo, "index.ts"), oldString: "v = 0", newString: "v = 1" }, "edited");
      fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 1;\n");
      await pinTree();
    });
    expect(text, text).toMatch(/vrf_[0-9a-f]{24}/);
    expect(text).not.toContain("✓ verified");
  }, 90_000);
});
