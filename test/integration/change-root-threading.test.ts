/**
 * test/integration/change-root-threading.test.ts
 *
 * S4/F3 (P0.1): the gate compares a changed path with the git top-level the change was observed in (`Artefact.changeRoot`),
 * not with the DoD's cwd. The unit tests in test/unit/gate.test.ts pass `changeRoot` by hand; this file proves the three
 * places that build the artefact thread it: index.ts's `delegate` path, index.ts's native `task` path and the deferred
 * `router_verify` artefact in wiring.ts. Deleting any one of those lines makes a test here fail.
 *
 * A real temporary git repository with the plugin directory at packages/a, the real plugin and the real gate. The producer's
 * edits are real files plus the host's `tool.execute.after` events. The tree snapshots are real too (`snapshotTree` on that
 * repository), but the test takes them itself, without a time bound, and serves them through the `src/verify/tree` mock seam
 * that test/integration/deferred-verification.test.ts also uses. The router's own snapshot calls run under fixed bounds (the
 * deferred finish under DEFERRED_FINISH_MS, 2 s), which a real `git status` can miss while the whole suite runs in parallel;
 * a missed bound leaves the change set unavailable and made the deferred cases load-dependent. Pinned, every case is
 * deterministic: no retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** The snapshot every router call to snapshotTree gets while set; unset, the real snapshotTree runs. */
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
const DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\ncheck: fileExists path=index.ts\n[/acceptance]`;
const MIXED_REASON = /also changed files outside (\S+): /;

let home = "";
let repo = "";
let scratch = "";
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
  const tree = await snapshotTree(path.join(repo, "packages", "a"), new AbortController().signal, { digestPaths: [] });
  if (tree === undefined) throw new Error("the real snapshot of the test repository failed");
  pinned.tree = tree;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-croot-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "omr-croot-repo-"));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omr-croot-scratch-"));
  for (const pkg of ["a", "b"]) {
    fs.mkdirSync(path.join(repo, "packages", pkg), { recursive: true });
    fs.writeFileSync(path.join(repo, "packages", pkg, "index.ts"), "export const v = 0;\n");
  }
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
  for (const dir of [home, repo, scratch]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** a, b: packages/a and packages/b of the repository; scratch: a file outside it (no temp-directory exemption: fail closed). */
type Edit = "a" | "b" | "scratch";
let editCounter = 0;

/**
 * The producer writes these files on disk and the host reports each through the write tool's after hook. Then the tree the
 * producer left is pinned, so the gate-time (or deferred-finish) snapshot sees exactly these edits.
 */
async function produce(hooks: any, sessionID: string, edits: Edit[]): Promise<void> {
  for (const edit of edits) {
    const file = edit === "scratch" ? path.join(scratch, "notes.txt") : path.join(repo, "packages", edit, "index.ts");
    fs.writeFileSync(file, `export const v = ${++editCounter};\n`);
    await hooks["tool.execute.after"](
      { tool: "write", sessionID, callID: `w${editCounter}`, args: { filePath: file } },
      { title: "", output: "", metadata: {} },
    );
  }
  await pinTree();
}

/** A plugin whose directory is packages/a (the DoD's cwd) inside the repository's top-level. `onProducer` runs the producer's edits. */
async function makePlugin(onProducer: (hooks: any, sessionID: string) => Promise<void>) {
  const created: string[] = [];
  const holder: { hooks: any } = { hooks: undefined };
  const ctx = {
    directory: path.join(repo, "packages", "a"),
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
  // The clean tree the dispatch snapshot sees.
  await pinTree();
  return holder.hooks;
}

/** Runs one native `task` dispatch whose child session performs `edits` between the before and after hooks. */
async function runTask(hooks: any, prompt: string, edits: Edit[]): Promise<string> {
  const input: any = { tool: "task", sessionID: "orch", callID: "call1", args: { subagent_type: "fast", prompt, description: "the work" } };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  await produce(hooks, "child1", edits);
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  return output.output;
}

describe("the change root reaches the gate from every artefact builder", () => {
  describe.each(["task", "delegate"] as const)("synchronous gate, %s path", dispatch => {
    async function run(edits: Edit[]): Promise<string> {
      if (dispatch === "task") return runTask(await makePlugin(async () => undefined), `Implement it.\n${SYNC_DOD}`, edits);
      const hooks = await makePlugin((h, sid) => produce(h, sid, edits));
      return hooks.tool.delegate.execute({ task: `Implement it.\n${SYNC_DOD}`, tier: "fast" }, { sessionID: "orch" });
    }

    it("edits in packages/a and its sibling packages/b are one repository: not flagged", async () => {
      const out = await run(["a", "b"]);
      expect(out).not.toMatch(MIXED_REASON);
    }, 60_000);

    it("a scratch file outside the repository, mixed with repository edits, is unverifiable and names the repository root", async () => {
      const out = await run(["a", "b", "scratch"]);
      const match = MIXED_REASON.exec(out);
      expect(match, out).not.toBeNull();
      // The root is the git top-level, not the plugin directory packages/a.
      expect(match?.[1]).not.toMatch(/packages/);
      expect(out).toContain(path.join(scratch, "notes.txt"));
    }, 60_000);
  });

  // The deferred finish (registration) and router_verify both see the pinned tree, so the entry always records the change set
  // and the root it was observed in: this covers the branch where the deferred finish completed inside its bound.
  describe("deferred router_verify", () => {
    async function verifyAfter(edits: Edit[]): Promise<string> {
      const hooks = await makePlugin(async () => undefined);
      const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, edits);
      const handle = /vrf_[0-9a-f]{24}/.exec(out)?.[0];
      expect(handle, out).toBeDefined();
      return String(await hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" }));
    }

    it("edits in packages/a and packages/b are one repository: not flagged", async () => {
      expect(await verifyAfter(["a", "b"])).not.toMatch(MIXED_REASON);
    }, 90_000);

    it("a scratch file outside the repository, mixed with repository edits, is unverifiable and names the repository root", async () => {
      const text = await verifyAfter(["a", "b", "scratch"]);
      const match = MIXED_REASON.exec(text);
      expect(match, text).not.toBeNull();
      expect(match?.[1]).not.toMatch(/packages/);
    }, 90_000);
  });
});
