import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

/**
 * Regression coverage for the child-session leak.
 *
 * The plugin creates backend sessions for the producer (one per ladder attempt)
 * and for the grader. Before the fix these were created with no `parentID` and
 * were never aborted or deleted, so every delegation left permanent top-level
 * sessions in the OpenCode TUI — happy path included, and one extra per retry.
 *
 * These tests drive the real `delegate` tool against a mocked client and assert
 * the full lifecycle: parented on creation, aborted and deleted on every exit
 * path including when `session.prompt` rejects.
 */

const ORCHESTRATOR_SID = "orchestrator-session";

interface Harness {
  ctx: Record<string, unknown>;
  createdIDs: string[];
  createOptions: any[];
  graderIDs: string[];
  aborted: string[];
  deleted: string[];
}

function makeHarness(opts: {
  graderPromptRejects?: boolean;
  graderPass?: boolean;
  producerPromptRejects?: boolean;
} = {}): Harness {
  const createdIDs: string[] = [];
  const createOptions: any[] = [];
  const graderIDs: string[] = [];
  const aborted: string[] = [];
  const deleted: string[] = [];
  let counter = 0;

  const client = {
    session: {
      create: async (options: any) => {
        counter += 1;
        const id = `sess-${counter}`;
        createdIDs.push(id);
        createOptions.push(options);
        return { data: { id } };
      },
      prompt: async (request: any) => {
        // dispatchGrader is the only caller that sets `system`.
        const isGrader = request?.body?.system !== undefined;
        if (isGrader) {
          graderIDs.push(request?.path?.id);
          if (opts.graderPromptRejects) {
            throw new Error("grader transport failure");
          }
          const pass = opts.graderPass ?? true;
          return {
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    pass,
                    reasons: pass ? [] : ["criterion not evidenced"],
                  }),
                },
              ],
            },
          };
        }
        if (opts.producerPromptRejects) {
          throw new Error("producer transport failure");
        }
        return { data: { parts: [{ type: "text", text: "producer output" }] } };
      },
      abort: async (options: any) => {
        aborted.push(options?.path?.id);
        return true;
      },
      delete: async (options: any) => {
        deleted.push(options?.path?.id);
        return true;
      },
    },
  };

  const ctx = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: client as any,
  };

  return { ctx, createdIDs, createOptions, graderIDs, aborted, deleted };
}

async function runDelegate(
  h: Harness,
  ...toolCtxArg: [{ sessionID?: string } | undefined] | []
): Promise<string> {
  const hooks: any = await ModelRouterPlugin(h.ctx as any);
  const toolCtx = toolCtxArg.length > 0 ? toolCtxArg[0] : { sessionID: ORCHESTRATOR_SID };
  return hooks.tool.delegate.execute(
    {
      task: "do the thing",
      tier: "fast",
      acceptance: "[acceptance]\ncriteria: the thing is done\n[/acceptance]",
    },
    toolCtx,
  );
}

describe("child session lifecycle", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    const dir = join(tmpdir(), `oc-mr-session-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
  });

  // -------------------------------------------------------------------------
  // parentID
  // -------------------------------------------------------------------------

  it("creates every child session with the orchestrator as parentID", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.createOptions.length).toBeGreaterThan(0);
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBe(ORCHESTRATOR_SID);
    }
  });

  it("creates a grader session, not just a producer session", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.graderIDs.length).toBeGreaterThan(0);
    // Grader sessions are also parented.
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBe(ORCHESTRATOR_SID);
    }
  });

  it("omits parentID when no orchestrator session is available", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h, undefined);

    expect(h.createOptions.length).toBeGreaterThan(0);
    for (const options of h.createOptions) {
      expect(options?.body?.parentID).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // abort + delete on the happy path
  // -------------------------------------------------------------------------

  it("aborts and deletes every session it created", async () => {
    const h = makeHarness({ graderPass: true });
    await runDelegate(h);

    expect(h.createdIDs.length).toBeGreaterThan(0);
    for (const id of h.createdIDs) {
      expect(h.aborted, `session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `session never deleted: ${id}`).toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // abort + delete when prompt rejects
  // -------------------------------------------------------------------------

  it("aborts and deletes the grader session when session.prompt rejects", async () => {
    const h = makeHarness({ graderPromptRejects: true });
    await runDelegate(h);

    expect(h.graderIDs.length).toBeGreaterThan(0);
    for (const id of h.graderIDs) {
      expect(h.aborted, `grader session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `grader session never deleted: ${id}`).toContain(id);
    }
  });

  it("aborts and deletes the producer session when session.prompt rejects", async () => {
    const h = makeHarness({ producerPromptRejects: true, graderPass: true });
    await runDelegate(h);

    const producerIDs = h.createdIDs.filter((id) => !h.graderIDs.includes(id));
    expect(producerIDs.length).toBeGreaterThan(0);
    for (const id of producerIDs) {
      expect(h.aborted, `producer session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `producer session never deleted: ${id}`).toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // every ladder iteration cleans up its own session
  // -------------------------------------------------------------------------

  it("cleans up each ladder retry's producer session, not just the last", async () => {
    // A failing grader verdict drives the escalation ladder, so the delegate
    // loop creates a fresh producer session per attempt.
    const h = makeHarness({ graderPass: false });
    await runDelegate(h);

    const producerIDs = h.createdIDs.filter((id) => !h.graderIDs.includes(id));
    expect(
      producerIDs.length,
      "expected the ladder to retry and create more than one producer session",
    ).toBeGreaterThan(1);

    for (const id of producerIDs) {
      expect(h.aborted, `retry producer session never aborted: ${id}`).toContain(id);
      expect(h.deleted, `retry producer session never deleted: ${id}`).toContain(id);
    }
  });

  it("leaves no created session undisposed across a full retry ladder", async () => {
    const h = makeHarness({ graderPass: false });
    await runDelegate(h);

    const undisposed = h.createdIDs.filter(
      (id) => !h.aborted.includes(id) || !h.deleted.includes(id),
    );
    expect(undisposed, `leaked sessions: ${undisposed.join(", ")}`).toEqual([]);
  });
});
