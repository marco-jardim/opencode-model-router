/**
 * test/integration/layer2-wiring.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove Layer-2 wiring
 * deterministically (no live models, no network).
 *
 * Option (i) — verify-dispatch appends a forcing note when a task result fails
 *              a deterministic DoD, and is a no-op when enforcement is off.
 * Option (ii) — delegate tool returns accepted vs unmet correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Fake ctx builder
// ---------------------------------------------------------------------------

function makeCtx(dir: string, promptReply: string) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({
          data: { id: "sess_" + Math.random().toString(36).slice(2) },
        }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: promptReply }] },
        }),
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Layer-2 wiring", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml2-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    // Redirect homedir so loadConfig never reads the real user state file.
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // Ensure MODEL_ROUTER_ENFORCE is clean (tests that need it set it themselves).
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
  });

  afterEach(() => {
    // Restore HOME / USERPROFILE.
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedUserProfile !== undefined) {
      process.env.USERPROFILE = savedUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    // Clean up enforcement override.
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    // Best-effort temp dir removal.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Option (i): verify-dispatch via tool.execute.after
  // -------------------------------------------------------------------------

  describe("Option (i) verify-dispatch — tool.execute.after", () => {
    it("CASE A: appends forcing note when deterministic DoD FAILS (file missing)", async () => {
      process.env.MODEL_ROUTER_ENFORCE = "1";
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "grader/producer reply") as any);

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the report.\n[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE: report created.\n</task_result>",
        metadata: { sessionId: "child1" },
      };

      await hooks["tool.execute.after"](input, output);

      expect(output.output).toContain("NOT ACCEPTED");
    });

    it("CASE B: does NOT append note when deterministic DoD PASSES (file exists)", async () => {
      process.env.MODEL_ROUTER_ENFORCE = "1";
      fs.writeFileSync(path.join(dir, "present-file.txt"), "ok");
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "grader/producer reply") as any);

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the file.\n[acceptance]\ncheck: fileExists path=present-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE.\n</task_result>",
        metadata: { sessionId: "child2" },
      };
      const original = output.output;

      await hooks["tool.execute.after"](input, output);

      expect(output.output).not.toContain("NOT ACCEPTED");
      expect(output.output).toBe(original);
    });

    it("CASE C: is a no-op when enforcement is OFF (GA-1 preserved)", async () => {
      // MODEL_ROUTER_ENFORCE not set => resolveEnforcementMode returns "off"
      // shouldVerifyTask("task","off",...) => false => entire verify block skipped
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "grader/producer reply") as any);

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the report.\n[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE: report created.\n</task_result>",
        metadata: { sessionId: "child3" },
      };
      const original = output.output;

      await hooks["tool.execute.after"](input, output);

      expect(output.output).toBe(original);
      expect(output.output).not.toContain("NOT ACCEPTED");
    });
  });

  // -------------------------------------------------------------------------
  // Option (ii): delegate tool
  // -------------------------------------------------------------------------

  describe("Option (ii) delegate tool", () => {
    it("CASE D: returns accepted on deterministic PASS", async () => {
      fs.writeFileSync(path.join(dir, "deliver.txt"), "x");
      const hooks: any = await ModelRouterPlugin(
        makeCtx(dir, "I created deliver.txt as requested.") as any,
      );

      const out: string = await hooks.tool.delegate.execute({
        task: "Write the file.\n[acceptance]\ncheck: fileExists path=deliver.txt\n[/acceptance]",
        tier: "fast",
      });

      expect(out).toContain("accepted: deterministic");
    });

    it("CASE E: returns honest unmet on deterministic FAIL", async () => {
      // Fresh temp dir, nope.txt never created.
      const hooks: any = await ModelRouterPlugin(
        makeCtx(dir, "I totally did it (lying).") as any,
      );

      const out: string = await hooks.tool.delegate.execute({
        task: "Write the file.\n[acceptance]\ncheck: fileExists path=nope.txt\n[/acceptance]",
        tier: "fast",
      });

      expect(out).toContain("status: unmet");
      expect(out).not.toContain("accepted: ");
    });
  });
});
