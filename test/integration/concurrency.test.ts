import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

describe("concurrency isolation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  // Defined at describe scope — captures the `hooks` let-binding by reference,
  // so each test invocation uses whichever hooks was set by beforeEach.
  const callBefore = (sid: string, tool: string, args: any) =>
    hooks["tool.execute.before"]({ tool, sessionID: sid, callID: "c" }, { args });

  // Simulate completed execution so the after-hook updates consecutiveNonProducing.
  // Required for read_budget: the counter is only incremented via tool.execute.after.
  const callAfter = (sid: string, tool: string, args: any) =>
    hooks["tool.execute.after"]({ tool, sessionID: sid, args, callID: "c" }, { output: "" });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlc-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    invalidateConfigCache();

    const ctx = {
      directory: dir,
      worktree: dir,
      client: {
        session: {
          create: async () => ({ data: { id: "x" } }),
          prompt: async () => ({ data: { parts: [] } }),
        },
      },
    };
    hooks = await ModelRouterPlugin(ctx as any);

    // Register two subagent sessions with NON-trivial dispatch text so the
    // guard is fully enforced (no trivial-bypass for either session).
    // §2.9 E6 golden — before: agent "fast"; after: "medium", because the
    // read-only fast tier now gets the reader profile (no read/draft denial),
    // and these tests exercise the producer read budget per session.
    await hooks["chat.message"](
      { sessionID: "CC_A", agent: "medium" },
      { parts: [{ type: "text", text: "analyze the module deeply" }] },
    );
    await hooks["chat.message"](
      { sessionID: "CC_B", agent: "medium" },
      { parts: [{ type: "text", text: "inspect the other module deeply" }] },
    );
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("per-session read budget is isolated", async () => {
    // Interleave distinct-path reads — each pair of before+after increments
    // the session's consecutiveNonProducing counter by 1.
    await callBefore("CC_A", "read", { file_path: "/f/a1" });
    await callAfter("CC_A", "read", { file_path: "/f/a1" }); // A.cnp = 1

    await callBefore("CC_B", "read", { file_path: "/f/b1" });
    await callAfter("CC_B", "read", { file_path: "/f/b1" }); // B.cnp = 1

    await callBefore("CC_A", "read", { file_path: "/f/a2" });
    await callAfter("CC_A", "read", { file_path: "/f/a2" }); // A.cnp = 2

    await callBefore("CC_A", "read", { file_path: "/f/a3" });
    await callAfter("CC_A", "read", { file_path: "/f/a3" }); // A.cnp = 3

    // A's 4th read: consecutiveNonProducing(3) >= readDraftCap(3) → blocked.
    await expect(
      callBefore("CC_A", "read", { file_path: "/f/a4" }),
    ).rejects.toThrow();

    // B had only 1 read (cnp=1) — must still be allowed (proves budget is per-session).
    await expect(
      callBefore("CC_B", "read", { file_path: "/f/b2" }),
    ).resolves.toBeUndefined();
  });

  it("a self-script block in one session does not affect the other", async () => {
    // A attempts a bash heredoc that writes a script — must be blocked.
    await expect(
      callBefore("CC_A", "bash", {
        command: "cat <<'EOF' > x.sh\\necho hi\\nEOF",
      }),
    ).rejects.toThrow();

    // B performs a normal read — must resolve (not affected by A's block).
    await expect(
      callBefore("CC_B", "read", { file_path: "/f/b1" }),
    ).resolves.toBeUndefined();
  });

  it("each session is independently blockable on its own budget", async () => {
    // Drive A: 3 reads + after-hooks → A.cnp = 3.
    await callBefore("CC_A", "read", { file_path: "/f/a1" });
    await callAfter("CC_A", "read", { file_path: "/f/a1" });
    await callBefore("CC_A", "read", { file_path: "/f/a2" });
    await callAfter("CC_A", "read", { file_path: "/f/a2" });
    await callBefore("CC_A", "read", { file_path: "/f/a3" });
    await callAfter("CC_A", "read", { file_path: "/f/a3" });
    // A's 4th read is blocked.
    await expect(
      callBefore("CC_A", "read", { file_path: "/f/a4" }),
    ).rejects.toThrow();

    // Drive B: 3 reads + after-hooks → B.cnp = 3.
    await callBefore("CC_B", "read", { file_path: "/f/b1" });
    await callAfter("CC_B", "read", { file_path: "/f/b1" });
    await callBefore("CC_B", "read", { file_path: "/f/b2" });
    await callAfter("CC_B", "read", { file_path: "/f/b2" });
    await callBefore("CC_B", "read", { file_path: "/f/b3" });
    await callAfter("CC_B", "read", { file_path: "/f/b3" });
    // B's 4th read is also blocked — each session independently enforced.
    await expect(
      callBefore("CC_B", "read", { file_path: "/f/b4" }),
    ).rejects.toThrow();
  });

  // QA-P15-1-12 (§2.9 E6): through the hooks, the read-only fast tier is a reader.
  it("a fast-tier session's 4th consecutive read is allowed (reader profile)", async () => {
    await hooks["chat.message"](
      { sessionID: "CC_F", agent: "fast" },
      { parts: [{ type: "text", text: "analyze the module deeply" }] },
    );
    for (const f of ["/f/f1", "/f/f2", "/f/f3"]) {
      await callBefore("CC_F", "read", { file_path: f });
      await callAfter("CC_F", "read", { file_path: f });
    }
    await expect(callBefore("CC_F", "read", { file_path: "/f/f4" })).resolves.toBeUndefined();
  });

  // QA-P15-1-3: the cap reaches the guard from the session store before the first
  // call, and a resume with a numeric cap makes the session a producer again.
  it("CAP:none + reason: is a reader from the first call and only for its dispatch round", async () => {
    await hooks["chat.message"](
      { sessionID: "CC_U", agent: "heavy" },
      { parts: [{ type: "text", text: "CAP:none\nreason: whole-module review\nanalyze the module deeply" }] },
    );
    for (let i = 0; i < 3; i++) {
      await callBefore("CC_U", "router_git_log", { n: i });
      await callAfter("CC_U", "router_git_log", { n: i });
    }
    await expect(callBefore("CC_U", "read", { file_path: "/f/u1" })).resolves.toBeUndefined();
    await callAfter("CC_U", "read", { file_path: "/f/u1" });

    await hooks["chat.message"](
      { sessionID: "CC_U", agent: "heavy" },
      { parts: [{ type: "text", text: "CAP:8\nanalyze the module deeply" }] },
    );
    await expect(callBefore("CC_U", "read", { file_path: "/f/u2" })).rejects.toThrow(/read\/draft budget exhausted/);
  });
});
