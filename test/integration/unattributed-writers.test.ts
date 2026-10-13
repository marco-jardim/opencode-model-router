/**
 * test/integration/unattributed-writers.test.ts
 *
 * P0.3 part 2: the "unattributed writers" tallied from the changed-file store (tools that may have written but whose writes
 * the store cannot see: bash, router_run, execute, MCP tools) reach the gate on every path:
 * - the synchronous native `task` path and the `delegate` path;
 * - the deferred no-change shortcut (a testsPass-only DoD with an empty change set is not deferred, so the required gate runs);
 * - a really deferred delegation, through registration, the pending store and `router_verify`.
 * With a green gate, an empty change set and a producer that ran such a tool, the verdict is unverifiable (never "verified");
 * a producer that only read (read, router_git_status) leaves no caveat.
 *
 * The harness is test/integration/branch-switch.test.ts's: a real temporary git repository, the real plugin and gate, and
 * real tree snapshots pinned through the `src/verify/tree` mock seam. Every case is deterministic: no retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
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
const DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\ncheck: fileExists path=index.ts\n[/acceptance]`;
const CAVEAT = (tools: string): RegExp =>
  new RegExp(`no change was observed in \\S+ but the producer ran ${tools}; a write those tools made cannot be seen, so this is not a verified pass`);
const ANY_CAVEAT = /no change was observed in \S+ but the producer ran /;

let home = "";
let repo = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-unattr-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "omr-unattr-repo-"));
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

afterEach(() => {
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

let callCounter = 0;

/** The harness reports one tool call of the producer session: before and after hooks, with `tool` and no file written. */
async function runTool(hooks: any, sessionID: string, tool: string, args: Record<string, unknown>): Promise<void> {
  const callID = `c${++callCounter}`;
  await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args: { ...args } });
  await hooks["tool.execute.after"]({ tool, sessionID, callID, args }, { title: "", output: "", metadata: {} });
}

/** The producer runs `tools` (one call each) and writes nothing; then the unchanged tree is pinned for the gate's snapshot. */
const ranOnly = (...tools: string[]) => async (hooks: any, sessionID: string): Promise<void> => {
  for (const tool of tools) await runTool(hooks, sessionID, tool, tool === "bash" ? { command: "echo hi" } : {});
  await pinTree();
};

/** A plugin whose directory is the repository. `onProducer` runs the producer's work inside its prompt. */
async function makePlugin(onProducer: (hooks: any, sessionID: string) => Promise<void>) {
  const created: string[] = [];
  const holder: { hooks: any } = { hooks: undefined };
  const ctx = {
    directory: repo,
    worktree: repo,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => {
          const id = `sess_${created.length + 1}`;
          created.push(id);
          return { data: { id } };
        },
        prompt: async (req: { path?: { id?: string }; body?: { system?: unknown } }) => {
          // A grader carries a system prompt; the producer does not.
          if (req.body?.system === undefined) await onProducer(holder.hooks, req.path?.id ?? "");
          return { data: { parts: [{ type: "text", text: "DONE: implemented." }] } };
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  holder.hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  // The clean tree that the dispatch snapshot sees.
  await pinTree();
  return holder.hooks;
}

/** Runs one native `task` dispatch whose child session does `work` between the before and after hooks. */
async function runTask(hooks: any, prompt: string, work: (hooks: any, sessionID: string) => Promise<void>): Promise<string> {
  const input: any = { tool: "task", sessionID: "orch", callID: "call1", args: { subagent_type: "fast", prompt, description: "the work" } };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  await work(hooks, "child1");
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  return output.output;
}

const verify = async (hooks: any, handle: string | undefined): Promise<string> =>
  String(await hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" }));

describe("an unobservable write tool with no observed change is never verified (P0.3 part 2)", () => {
  describe.each(["task", "delegate"] as const)("synchronous gate, %s path", dispatch => {
    async function run(work: (hooks: any, sessionID: string) => Promise<void>): Promise<string> {
      if (dispatch === "task") return runTask(await makePlugin(async () => undefined), `Implement it.\n${SYNC_DOD}`, work);
      const hooks = await makePlugin(work);
      return String(await hooks.tool.delegate.execute({ task: `Implement it.\n${SYNC_DOD}`, tier: "fast" }, { sessionID: "orch" }));
    }

    it("a producer that only ran bash and changed no file is unverified, with the caveat", async () => {
      const out = await run(ranOnly("bash"));
      expect(out).toMatch(CAVEAT("bash"));
      expect(out).toContain("UNVERIFIED");
      expect(out).not.toContain("✓ verified");
    }, 60_000);

    it("a producer that only read and checked git status leaves no caveat (control)", async () => {
      const out = await run(ranOnly("read", "router_git_status"));
      expect(out).not.toMatch(ANY_CAVEAT);
    }, 60_000);
  });

  describe("deferred verification", () => {
    it("a testsPass-only DoD with an empty change set is not deferred, and the required gate shows the caveat", async () => {
      const hooks = await makePlugin(async () => undefined);
      const out = await runTask(hooks, `Implement it.\n${TESTS_ONLY_DEFERRED_DOD}`, ranOnly("bash"));
      expect(out, out).not.toMatch(/vrf_[0-9a-f]{24}/);
      expect(out).toMatch(CAVEAT("bash"));
      expect(out).toContain("UNVERIFIED");
    }, 90_000);

    it("a really deferred delegation with an empty change set carries the writers to router_verify", async () => {
      const hooks = await makePlugin(async () => undefined);
      const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, ranOnly("bash", "router_run"));
      const handle = /vrf_[0-9a-f]{24}/.exec(out)?.[0];
      expect(handle, out).toBeDefined();
      const verdict = await verify(hooks, handle);
      expect(verdict).toMatch(CAVEAT("bash, router_run"));
      expect(verdict).not.toContain("✓ verified");
    }, 90_000);

    it("a deferred delegation whose producer only read leaves no caveat at router_verify (control)", async () => {
      const hooks = await makePlugin(async () => undefined);
      const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, ranOnly("read"));
      const handle = /vrf_[0-9a-f]{24}/.exec(out)?.[0];
      expect(handle, out).toBeDefined();
      expect(await verify(hooks, handle)).not.toMatch(ANY_CAVEAT);
    }, 90_000);
  });
});
