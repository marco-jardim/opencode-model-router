/**
 * test/integration/branch-switch-deferred.test.ts
 *
 * QA findings B4 and B12 on the deferred path: router_verify's branch check reads the cheap head state
 * (src/verify/head.ts), not the full tree snapshot.
 * - B4: a full snapshot that is unavailable at router_verify (a large dirty tree, a submodule) no longer makes the branch
 *   "unconfirmed"; the head state decides.
 * - B12: the root recorded at return is compared too, so a tree that moved to another repository is "relocated".
 * - "cannot confirm" (the head state itself unreadable at router_verify) is retryable: the report says "not judged".
 *
 * The harness is test/integration/branch-switch.test.ts's: a real temporary git repository, the real plugin and gate, and
 * real tree snapshots pinned through the `src/verify/tree` mock seam. The `src/verify/head` mock only fails on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** While `tree` is set, every router call to snapshotTree gets it; `absent` makes every call resolve undefined. */
const pinned = vi.hoisted(() => ({ tree: undefined as Tree, absent: false }));
/** While `on`, every readHeadState call resolves undefined (an unreadable head); otherwise the real implementation. */
const headFail = vi.hoisted(() => ({ on: false }));

vi.mock("../../src/verify/tree", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/tree")>();
  return {
    ...actual,
    snapshotTree: (...args: Parameters<typeof actual.snapshotTree>) =>
      (pinned.absent
        ? Promise.resolve(undefined)
        : pinned.tree !== undefined ? Promise.resolve(pinned.tree) : actual.snapshotTree(...args)),
  };
});

vi.mock("../../src/verify/head", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/head")>();
  return {
    ...actual,
    readHeadState: (...args: Parameters<typeof actual.readHeadState>) =>
      (headFail.on ? Promise.resolve(undefined) : actual.readHeadState(...args)),
  };
});

const DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\ncheck: fileExists path=index.ts\n[/acceptance]`;
const SINCE = /the working tree \S+ switched from branch \S+ to branch other since the producer returned; the checks would verify another branch/;
const ROUND_TRIP = /moved or was rewritten since the producer returned \(reflog: "checkout:/;
const UNCONFIRMED = /cannot confirm the branch of \S+: the working tree could not be read at router_verify, so the checks could verify another branch/;
const RELOCATED = /the working tree \S+ is now \S+ since the producer returned; the checks would verify another tree/;
const REPLACED = /moved or was rewritten since the producer returned \(reflog: "HEAD moved without a reflog entry"\)/;
const ANY_BRANCH_REASON = /switched from|moved from|cannot confirm the branch|moved or was rewritten|is now \S+ since the producer returned/;

let home = "";
let repo = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}
const git = (...args: string[]): void => gitIn(repo, ...args);

/** `git checkout -b other`: a new branch at the same commit. */
const checkout = (): void => git("checkout", "-q", "-b", "other");

/** A full round trip: onto a new branch, one commit there, and back (the branch name and its commit are unchanged on return). */
function roundTrip(): void {
  git("checkout", "-q", "-b", "feat");
  git("commit", "-q", "--allow-empty", "-m", "on feat");
  git("checkout", "-q", "-");
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-bsd-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "omr-bsd-repo-"));
  fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 0;\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  pinned.absent = false;
  headFail.on = false;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
}, 60_000); // setup only: git init/add/commit are slow when the whole suite runs in parallel

afterEach(() => {
  pinned.tree = undefined;
  pinned.absent = false;
  headFail.on = false;
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
  invalidateConfigCache();
  for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let editCounter = 0;

/** The producer edits index.ts (reported through the write tool's after hook); the tree it left is pinned for the snapshots. */
async function produce(hooks: any, sessionID: string): Promise<void> {
  const file = path.join(repo, "index.ts");
  fs.writeFileSync(file, `export const v = ${++editCounter};\n`);
  await hooks["tool.execute.after"](
    { tool: "write", sessionID, callID: `w${editCounter}`, args: { filePath: file } },
    { title: "", output: "", metadata: {} },
  );
  await pinTree();
}

/** A plugin whose directory is the repository. */
async function makePlugin() {
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
        prompt: async () => ({ data: { parts: [{ type: "text", text: "DONE: implemented." }] } }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  holder.hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  await pinTree();
  return holder.hooks;
}

/** One native deferred `task` dispatch whose child session edits index.ts; returns the plugin and the handle. */
async function deferredRun() {
  const hooks = await makePlugin();
  const input: any = {
    tool: "task",
    sessionID: "orch",
    callID: "call1",
    args: { subagent_type: "fast", prompt: `Implement it.\n${DEFERRED_DOD}`, description: "the work" },
  };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  await produce(hooks, "child1");
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  const handle = /vrf_[0-9a-f]{24}/.exec(output.output)?.[0];
  expect(handle, output.output).toBeDefined();
  return { hooks, handle };
}

const verify = async (hooks: any, handle: string | undefined): Promise<string> =>
  String(await hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" }));

describe("router_verify's branch check reads the head state (B4, B12)", () => {
  it("(i) a checkout of another branch after the producer returned is unverifiable", async () => {
    const { hooks, handle } = await deferredRun();
    checkout();
    const out = await verify(hooks, handle);
    expect(out).toMatch(SINCE);
    expect(out).toContain("unverifiable");
    expect(out).not.toContain("not judged");
  }, 90_000);

  it("(ii) a round trip after the producer returned (checkout feat, commit, checkout back) is unverifiable", async () => {
    const { hooks, handle } = await deferredRun();
    roundTrip();
    const out = await verify(hooks, handle);
    expect(out).toMatch(ROUND_TRIP);
    expect(out).toContain("unverifiable");
  }, 90_000);

  it("(iii) commits on the same branch after the producer returned give no branch refusal", async () => {
    const { hooks, handle } = await deferredRun();
    git("commit", "-q", "--allow-empty", "-m", "more work");
    git("commit", "-q", "--allow-empty", "-m", "and more");
    expect(await verify(hooks, handle)).not.toMatch(ANY_BRANCH_REASON);
  }, 90_000);

  it("(iv) a full snapshot that is unavailable at router_verify does not stop a readable head from deciding (B4)", async () => {
    const { hooks, handle } = await deferredRun();
    pinned.absent = true;
    expect(await verify(hooks, handle)).not.toMatch(ANY_BRANCH_REASON);
  }, 90_000);

  it("(iv) ... and the head still catches a checkout while the full snapshot is unavailable (B4)", async () => {
    const { hooks, handle } = await deferredRun();
    checkout();
    pinned.absent = true;
    expect(await verify(hooks, handle)).toMatch(SINCE);
  }, 90_000);

  it("(v) a head state that cannot be read at router_verify cannot confirm the branch, and the result is retryable", async () => {
    const { hooks, handle } = await deferredRun();
    headFail.on = true;
    const out = await verify(hooks, handle);
    expect(out).toMatch(UNCONFIRMED);
    expect(out).toContain("not judged");
    expect(out).toContain("call `router_verify` again");
    // Retryable means the handle stays pending: once the head is readable again, the same handle gets a verdict.
    headFail.on = false;
    const again = await verify(hooks, handle);
    expect(again).not.toMatch(UNCONFIRMED);
    expect(again).not.toContain("not judged");
  }, 90_000);

  it("(vi) B12: the same worktree path now resolving to another repository is relocated", async () => {
    // Registering at one root and verifying at another needs the plugin's directory to stay the same path while its
    // toplevel changes: a directory junction retargeted between the producer's return and router_verify.
    const repoA = repo;
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "omr-bsd-repoB-"));
    const link = path.join(os.tmpdir(), `omr-bsd-link-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(path.join(repoB, "index.ts"), "export const v = 0;\n");
      gitIn(repoB, "init", "-q");
      gitIn(repoB, "add", "-A");
      gitIn(repoB, "commit", "-q", "-m", "init");
      fs.symlinkSync(repoA, link, "junction");
      repo = link;
      const { hooks, handle } = await deferredRun();
      fs.rmSync(link, { recursive: true, force: true });
      fs.symlinkSync(repoB, link, "junction");
      const out = await verify(hooks, handle);
      expect(out).toMatch(RELOCATED);
      expect(out).toContain("unverifiable");
    } finally {
      repo = repoA;
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(repoB, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);

  it("(vii) the repository replaced in place by a fresh one on the same branch name is not a pass", async () => {
    const { hooks, handle } = await deferredRun();
    // Same path, same branch name, same reflog count (one entry), another HEAD. Replacing the whole directory in place is
    // what happens when .git is deleted and re-initialised under the same path (the working files are kept so the drift
    // check is not what refuses it).
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "a different first commit");
    const out = await verify(hooks, handle);
    expect(out).toMatch(REPLACED);
    expect(out).toContain("unverifiable");
  }, 90_000);

  it("no switch: router_verify gives no branch reason (control)", async () => {
    const { hooks, handle } = await deferredRun();
    expect(await verify(hooks, handle)).not.toMatch(ANY_BRANCH_REASON);
  }, 90_000);
});
