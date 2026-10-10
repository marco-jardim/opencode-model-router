/**
 * test/integration/branch-switch.test.ts
 *
 * I7 (P0.2, S9/S12): a branch switch of the verified working tree makes the verdict unverifiable, never a pass:
 * - during the dispatch, on the synchronous native `task` and `delegate` paths (the dispatch snapshot against the gate's);
 * - during the dispatch of a deferred delegation: it is not deferred (finishDeferred answers "branch-switched"), and the
 *   required gate refuses it at once, so no handle is issued that could verify the other branch later;
 * - between the producer's return and `router_verify` (the checkout recorded at registration against the current tree), and
 *   when the current tree cannot be read there while a branch was recorded.
 *
 * The harness is test/integration/change-root-threading.test.ts's: a real temporary git repository, the real plugin and gate,
 * and real tree snapshots that the test takes itself, without a time bound, and pins through the `src/verify/tree` mock seam.
 * Every case is deterministic: no retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import * as gateModule from "../../src/verify/gate";
import * as headModule from "../../src/verify/head";
import { invalidateConfigCache } from "../../src/router/config";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** While `tree` is set, every router call to snapshotTree gets it; `absent` makes every call resolve undefined. */
const pinned = vi.hoisted(() => ({ tree: undefined as Tree, absent: false }));

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

const SYNC_DOD = "[acceptance]\ncheck: fileExists path=index.ts\n[/acceptance]";
const DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\ncheck: fileExists path=index.ts\n[/acceptance]`;
const DURING = /the working tree \S+ switched from branch \S+ to branch other during the dispatch; the checks would verify another branch/;
const SINCE = /the working tree \S+ switched from branch \S+ to branch other since the producer returned; the checks would verify another branch/;
const UNCONFIRMED = /cannot confirm the branch of \S+: the working tree could not be read at router_verify, so the checks could verify another branch/;
const ANY_BRANCH_REASON = /switched from|moved from|cannot confirm the branch/;

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

/** `git checkout -b other`: a new branch at the same commit, which fails closed as a switch. */
const checkout = (): void => git("checkout", "-q", "-b", "other");

/** Takes a real snapshot of the repository as it is now (no time bound) and pins it for the router's snapshot calls. */
async function pinTree(): Promise<void> {
  pinned.tree = undefined;
  const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const tree = await snapshotTree(repo, new AbortController().signal, { digestPaths: [] });
  if (tree === undefined) throw new Error("the real snapshot of the test repository failed");
  pinned.tree = tree;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-branch-home-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "omr-branch-repo-"));
  fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 0;\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  pinned.absent = false;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
}, 60_000); // setup only: git init/add/commit are slow when the whole suite runs in parallel

afterEach(() => {
  pinned.tree = undefined;
  pinned.absent = false;
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

/**
 * The producer edits index.ts (reported through the write tool's after hook), then runs `after` (a checkout, for a switch
 * during the dispatch), then the tree it left is pinned for the gate-time (or deferred-finish) snapshot.
 */
async function produce(hooks: any, sessionID: string, after?: () => void): Promise<void> {
  const file = path.join(repo, "index.ts");
  fs.writeFileSync(file, `export const v = ${++editCounter};\n`);
  await hooks["tool.execute.after"](
    { tool: "write", sessionID, callID: `w${editCounter}`, args: { filePath: file } },
    { title: "", output: "", metadata: {} },
  );
  after?.();
  await pinTree();
}

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
  // The clean tree, on the initial branch, that the dispatch snapshot sees.
  await pinTree();
  return holder.hooks;
}

/** Runs one native `task` dispatch whose child session does the producer's work between the before and after hooks. */
async function runTask(hooks: any, prompt: string, after?: () => void): Promise<string> {
  const input: any = { tool: "task", sessionID: "orch", callID: "call1", args: { subagent_type: "fast", prompt, description: "the work" } };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  await produce(hooks, "child1", after);
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  return output.output;
}

describe("a branch switch of the verified working tree is never verified (I7, P0.2)", () => {
  describe.each(["task", "delegate"] as const)("synchronous gate, %s path", dispatch => {
    async function run(after?: () => void): Promise<string> {
      if (dispatch === "task") return runTask(await makePlugin(async () => undefined), `Implement it.\n${SYNC_DOD}`, after);
      const hooks = await makePlugin((h, sid) => produce(h, sid, after));
      return String(await hooks.tool.delegate.execute({ task: `Implement it.\n${SYNC_DOD}`, tier: "fast" }, { sessionID: "orch" }));
    }

    it("a checkout of another branch during the dispatch is unverifiable", async () => {
      expect(await run(checkout)).toMatch(DURING);
    }, 60_000);

    it("no switch: no branch reason (control)", async () => {
      expect(await run()).not.toMatch(ANY_BRANCH_REASON);
    }, 60_000);
  });

  describe("deferred verification", () => {
    async function deferredRun(after?: () => void) {
      const hooks = await makePlugin(async () => undefined);
      const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, after);
      return { hooks, out, handle: /vrf_[0-9a-f]{24}/.exec(out)?.[0] };
    }
    const verify = async (hooks: any, handle: string | undefined): Promise<string> =>
      String(await hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" }));

    it("a switch during the dispatch is not deferred: no handle, and the required gate refuses it at once", async () => {
      const { out, handle } = await deferredRun(checkout);
      expect(handle, out).toBeUndefined();
      expect(out).toMatch(DURING);
    }, 90_000);

    it("a checkout after the producer returned is unverifiable at router_verify", async () => {
      const { hooks, out, handle } = await deferredRun();
      expect(handle, out).toBeDefined();
      checkout();
      await pinTree();
      expect(await verify(hooks, handle)).toMatch(SINCE);
    }, 90_000);

    it("an absent full snapshot with a readable HEAD on the same branch does not say \"cannot confirm\" at router_verify", async () => {
      // The branch is decided from the cheap head state (git, not mocked here); the pinned snapshot seam only removes the full tree.
      const { hooks, out, handle } = await deferredRun();
      expect(handle, out).toBeDefined();
      pinned.absent = true;
      const verdict = await verify(hooks, handle);
      expect(verdict).not.toMatch(UNCONFIRMED);
      expect(verdict).not.toMatch(ANY_BRANCH_REASON);
    }, 90_000);

    it("no switch: router_verify gives no branch reason (control)", async () => {
      const { hooks, out, handle } = await deferredRun();
      expect(handle, out).toBeDefined();
      expect(await verify(hooks, handle)).not.toMatch(ANY_BRANCH_REASON);
    }, 90_000);
  });
});

/**
 * Commit 7c757ae: a switch is decided from the head state (src/verify/head.ts, real git on the temporary repository, not mocked),
 * before the commit diff, and kept even when the dispatch snapshot is unavailable. gateModule.accept and headModule.readHeadState
 * are spied (calling through) to see the artefact the gate got and to fail one precise head read.
 */
describe("a branch switch is decided from the head state, before the commit diff (7c757ae)", () => {
  type Artefact = Parameters<typeof gateModule.accept>[1];
  let acceptSpy: MockInstance<typeof gateModule.accept>;

  beforeEach(() => {
    acceptSpy = vi.spyOn(gateModule, "accept");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const artefacts = (): Artefact[] => acceptSpy.mock.calls.map(call => call[1]);
  const commit = (file: string): void => {
    fs.writeFileSync(path.join(repo, file), `export const x = "${file}";\n`);
    git("add", file);
    git("commit", "-q", "-m", `add ${file}`);
  };
  /** `git checkout -b feat`, a commit there, then back: the branch name is the same at both ends. */
  const roundTrip = (): void => {
    git("checkout", "-q", "-b", "feat");
    commit("feat.ts");
    git("checkout", "-q", "-");
  };

  describe.each(["task", "delegate"] as const)("synchronous gate, %s path", dispatch => {
    /** `snapshotAbsent`: the dispatch-time snapshot resolves undefined (the gate-time one is the real, pinned tree). */
    async function run(after: () => void, snapshotAbsent = false): Promise<string> {
      const during = snapshotAbsent
        ? (): void => {
          pinned.absent = false;
          after();
        }
        : after;
      if (dispatch === "task") {
        const hooks = await makePlugin(async () => undefined);
        pinned.absent = snapshotAbsent;
        return runTask(hooks, `Implement it.\n${SYNC_DOD}`, during);
      }
      const hooks = await makePlugin((h, sid) => produce(h, sid, during));
      pinned.absent = snapshotAbsent;
      return String(await hooks.tool.delegate.execute({ task: `Implement it.\n${SYNC_DOD}`, tier: "fast" }, { sessionID: "orch" }));
    }

    // B1
    it("the dispatch snapshot unavailable and a checkout of another branch during the dispatch: unverifiable, from the head state", async () => {
      expect(await run(checkout, true)).toMatch(DURING);
    }, 60_000);

    // B5
    it("a round trip (checkout -b feat, commit, checkout back) during the dispatch: unverifiable, by the reflog", async () => {
      const out = await run(roundTrip);
      expect(out).toContain('reflog: "checkout:');
      expect(out).not.toMatch(/verified: deterministic/);
    }, 60_000);

    it("commits on the same branch during the dispatch are not refused for a branch reason, and are in the change set", async () => {
      const out = await run(() => commit("committed.ts"));
      expect(out).not.toMatch(ANY_BRANCH_REASON);
      expect(out).not.toContain("reflog:");
      expect(out).toMatch(/verified: deterministic/);
      expect(artefacts()).toHaveLength(1);
      const artefact = artefacts()[0];
      expect(artefact?.branchSwitch).toBeUndefined();
      expect(artefact?.changeBaseline).toBe("available");
      const files = artefact?.changedFiles.map(file => path.basename(file.path));
      expect(files).toContain("committed.ts");
      expect(files).toContain("index.ts");
    }, 60_000);

    // B8
    it("on a switch the other branch's committed files are not in the change set the gate gets", async () => {
      const out = await run(() => {
        checkout();
        commit("other-only.ts");
      });
      expect(out).toMatch(DURING);
      expect(artefacts()).toHaveLength(1);
      const artefact = artefacts()[0];
      expect(artefact?.branchSwitch).toMatch(DURING);
      expect(artefact?.changeBaseline).toBe("unavailable");
      expect(artefact?.changedFiles.map(file => path.basename(file.path))).not.toContain("other-only.ts");
    }, 60_000);
  });

  // B2
  it("deferred: the gate's own head read fails after finishDeferred saw the switch: still unverifiable, with the finish's reason", async () => {
    const actual = headModule.readHeadState;
    // The observeChange reads carry timeoutMs (the dispatch-time read does not): the first is finishDeferred's, the second the gate's.
    let observed = 0;
    const headSpy = vi.spyOn(headModule, "readHeadState").mockImplementation(async (cwd, opts) => {
      if (opts?.timeoutMs === undefined) return actual(cwd, opts);
      observed += 1;
      return observed === 2 ? undefined : actual(cwd, opts);
    });
    const hooks = await makePlugin(async () => undefined);
    // The dispatch snapshot is unavailable too, so the snapshot comparison cannot supply the reason: only the finish's detail can.
    pinned.absent = true;
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, () => {
      pinned.absent = false;
      checkout();
    });
    expect(headSpy.mock.calls.filter(([, opts]) => opts?.timeoutMs !== undefined)).toHaveLength(2);
    expect(/vrf_[0-9a-f]{24}/.exec(out)?.[0], out).toBeUndefined();
    expect(out).toMatch(DURING);
    expect(artefacts()).toHaveLength(1);
    expect(artefacts()[0]?.branchSwitch).toMatch(DURING);
  }, 90_000);
});