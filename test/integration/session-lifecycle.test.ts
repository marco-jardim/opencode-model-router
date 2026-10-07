import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Model } from "@opencode-ai/sdk";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { TASK_VERIFICATION } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import * as sessions from "../../src/router/sessions";
import { buildDispatchHeader } from "../../src/router/dispatch-header";
import { snapshotTree } from "../../src/verify/tree";
// Session lifecycle tests must not launch this repository's real test suite as
// a background baseline. Baseline I/O has separate store/wiring/adapter tests.
vi.mock("../../src/verify/tree", () => ({ snapshotTree: vi.fn(async () => undefined) }));

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
  graderPrompts: string[];
  aborted: string[];
  deleted: string[];
  getSession: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  graderPromptRejects?: boolean;
  graderPass?: boolean;
  producerPromptRejects?: boolean;
  parentID?: string;
  sessionGetRejects?: boolean;
  sessionGetError?: boolean;
  onProducer?: () => Promise<void>;
} = {}): Harness {
  const createdIDs: string[] = [];
  const createOptions: any[] = [];
  const graderIDs: string[] = [];
  const graderPrompts: string[] = [];
  const aborted: string[] = [];
  const deleted: string[] = [];
  let counter = 0;
  const getSession = vi.fn(async () => {
    if (opts.sessionGetRejects) throw new Error("session lookup failure");
    if (opts.sessionGetError) return { data: undefined, error: { message: "not found" } };
    return { data: { parentID: opts.parentID } };
  });

  const client = {
    session: {
      get: getSession,
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
          graderPrompts.push(request.body.parts[0].text);
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
        await opts.onProducer?.();
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

  return { ctx, createdIDs, createOptions, graderIDs, graderPrompts, aborted, deleted, getSession };
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
    vi.mocked(snapshotTree).mockResolvedValue(undefined);
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
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
  });

  it.each([
    { mode: "task", digests: true },
    { mode: "delegate", digests: true },
    { mode: "task", digests: false },
    { mode: "delegate", digests: false },
  ])("$mode grader receives the dispatch-time delta, not the dirty tree (digests: $digests)", async ({ mode, digests }) => {
    const cfg = loadConfig();
    cfg.enforcement ??= {}; cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.testBaseline = false;
    const old = join(process.cwd(), "predating.ts");
    const added = join(process.cwd(), "producer.ts");
    // As the real snapshotTree does: the dispatch snapshot digests its listed paths, the gate
    // snapshot digests the dispatch snapshot's paths. predating.ts is unchanged between the two.
    // Without digests (over the digest bounds) nothing proves predating.ts unchanged (QA-2.1-14).
    const unchanged = new Map([[old, "file:predating"]]);
    const before = {
      cwd: process.cwd(), head: "head", fingerprint: "before", dirty: true, files: [{ path: old, status: " M" }],
      digests: digests ? unchanged : "unavailable" as const,
    };
    vi.mocked(snapshotTree).mockResolvedValue(before);
    const after = {
      ...before, fingerprint: "after", files: [...before.files, { path: added, status: "??" }],
      digests: digests ? new Map(unchanged) : "unavailable" as const,
    };
    const h = makeHarness({ onProducer: async () => { vi.mocked(snapshotTree).mockResolvedValue(after); } });
    if (mode === "delegate") await runDelegate(h);
    else {
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const input = { tool: "task", sessionID: ORCHESTRATOR_SID, callID: "baseline-task" };
      const args = { subagent_type: "fast", prompt: "Investigate.\n[acceptance]\ncriteria: investigation complete\n[/acceptance]" };
      await hooks["tool.execute.before"]!(input, { args });
      vi.mocked(snapshotTree).mockResolvedValue(after);
      await hooks["tool.execute.after"]!({ ...input, args }, { title: "task", output: "findings", metadata: { sessionId: "child" } });
    }
    expect(h.graderPrompts).toHaveLength(1);
    expect(h.graderPrompts[0]).toContain("Producer delta only");
    expect(h.graderPrompts[0]).toContain(added);
    if (digests) expect(h.graderPrompts[0]).not.toContain(old);
    else expect(h.graderPrompts[0]).toContain(old);
  });

  describe("task false-refusal detection", () => {
    it.each([
      { calls: 0, text: "ESCALATE: tools unavailable", enabled: true, id: true, tool: "task", suspected: true },
      { calls: 1, text: "ESCALATE: tools unavailable", enabled: true, id: true, tool: "task", suspected: false },
      { calls: 0, text: "DONE: no tools needed", enabled: true, id: true, tool: "task", suspected: false },
      { calls: 0, text: "ESCALATE: tools unavailable", enabled: false, id: true, tool: "task", suspected: false },
      { calls: 0, text: "ESCALATE: tools unavailable", enabled: true, id: false, tool: "task", suspected: false },
      { calls: 0, text: "ESCALATE: tools unavailable", enabled: true, id: true, tool: "read", suspected: false },
    ])("annotates only suspected returns: %j", async ({ calls, text, enabled, id, tool, suspected }) => {
      loadConfig().falseRefusalDetection = enabled;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      await hooks.event!({ event: { type: "session.created", properties: { info: {
        id: "refusal-child", parentID: ORCHESTRATOR_SID, projectID: "project",
        directory: process.cwd(), title: "child", version: "1", time: { created: 0, updated: 0 },
      } } } });
      for (let i = 0; i < calls; i++) {
        await hooks["tool.execute.after"]!({ tool: "read", sessionID: "refusal-child", callID: `read-${i}`, args: {} }, { title: "read", output: "contents", metadata: {} });
      }
      const output = { title: "task", output: text, metadata: id ? { sessionId: "refusal-child" } : {} };
      await hooks["tool.execute.after"]!({ tool, sessionID: ORCHESTRATOR_SID, callID: "task-result", args: {} }, output);
      if (suspected) {
        expect(output.output).toBe('[router] FALSE-REFUSAL SUSPECT — this delegate returned a hand-back after 0 tool calls. No tool call was observed for this child, so the capability claim in its answer is untested rather than demonstrated. Re-dispatch the same work with task_id="refusal-child" and an instruction to attempt it, or do it yourself; do not escalate a tier on this result.\n\n' + text);
      } else {
        expect(output.output).toBe(text);
      }
    });
  });

  describe("task dispatch headers", () => {
    it.each(["enforced", "off"])("marks the legacy output only when task verification engages (%s)", async (mode) => {
      vi.stubEnv("MODEL_ROUTER_ENFORCE", mode === "enforced" ? "1" : "0");
      const cfg = loadConfig();
      cfg.enforcement ??= {}; cfg.enforcement.verify ??= {};
      cfg.enforcement.verify.require = "always";
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", prompt: "Do the work" } };
      try {
        await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "verification-marker" }, output);
        expect((output as Record<PropertyKey, unknown>)[TASK_VERIFICATION]).toBe(mode === "enforced" ? true : undefined);
        expect(Object.getOwnPropertySymbols(output.args)).toEqual([]);
      } finally {
        await hooks.dispose?.();
        vi.unstubAllEnvs();
      }
    });

    it.each([
      { prompt: "Do the work", cap: 11 },
      { prompt: "CAP:7\nDo the work", cap: 7 },
      { prompt: "CAP:none\nreason: inspect related modules\nDo the work", cap: "none" },
      { prompt: "CAP:none\nDo the work", cap: 11 },
      { prompt: "Do the work\nCAP:7\nReturn results", cap: 7 },
      { prompt: "Do the work\nCAP:none\nreason: inspect related modules\nReturn results", cap: "none" },
      { prompt: "Read-only budget: uncapped for this dispatch", cap: 11 },
    ] as const)("announces the registered budget for $prompt", async ({ prompt, cap }) => {
      const cfg = loadConfig();
      cfg.tierCaps = { ...cfg.tierCaps, fast: 11 };
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", prompt: String(prompt) } };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      const header = output.args.prompt.split("\n\n---\n\n")[0]!;
      const announcement = cap === "none" ? "uncapped for this dispatch" : `${cap} calls`;
      expect(header).toContain(`Read-only budget: ${announcement}.`);
      expect(output.args.prompt).toBe(buildDispatchHeader({ tier: "fast", cap, projectDirectory: process.cwd() }) + "\n\n---\n\n" + prompt);

      // Pin equality against registration, not just the header builder. Also
      // register the emitted prompt: instructional examples must not change caps.
      for (const text of [prompt, output.args.prompt]) {
        const store = sessions.createSessionStore();
        expect(store.registerFromChatMessage(
          { agent: "fast", sessionID: "budget-child" },
          { parts: [{ type: "text", text }] }, cfg, Object.keys(getActiveTiers(cfg)),
        ).registered).toBe(true);
        const result = { output: "contents" };
        store.recordToolCall({ sessionID: "budget-child", tool: "read", args: { filePath: "file.ts" } }, result);
        const announced = header.match(/Read-only budget: (\d+) calls\./)?.[1] ?? "∞";
        expect(result.output).toContain(`[cap: 1/${announced}]`);
      }
    });

    it.each(["subagent_type", "subagentType"])("prepends using %s and is idempotent", async (field) => {
      const cfg = loadConfig();
      cfg.tierCaps = { ...cfg.tierCaps, fast: 11 };
      const h = makeHarness();
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { args: { [field]: "fast", prompt: "Do the work" } };
      const call = { tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" };
      await hooks["tool.execute.before"]!(call, output);
      const expected = buildDispatchHeader({ tier: "fast", cap: 11, projectDirectory: process.cwd() }) + "\n\n---\n\nDo the work";
      expect(output.args.prompt).toBe(expected);
      await hooks["tool.execute.before"]!(call, output);
      expect(output.args.prompt).toBe(expected);
    });

    it.each([
      { tool: "read", args: { subagent_type: "fast", prompt: "original" } },
      { tool: "task", args: { subagent_type: "unknown", prompt: "original" } },
      { tool: "task", args: { prompt: "original" } },
      { tool: "task", args: { subagent_type: "toString", prompt: "original" } },
      { tool: "task", args: { subagent_type: "fast", prompt: 42 } },
      { tool: "task", args: null },
      { tool: "task", args: { subagent_type: "fast", prompt: "[router] You are @fast. Existing header" } },
    ])("leaves unsupported or already-prefixed calls unchanged: %j", async ({ tool, args }) => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args };
      const before = structuredClone(output);
      await hooks["tool.execute.before"]!({ tool, sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output.args).toEqual(before.args);
    });

    it("can be disabled by config", async () => {
      loadConfig().dispatchHeader = false;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", prompt: "original" } };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output.args.prompt).toBe("original");
    });

    it.each(["fast", "custom"])("resolves default cap for %s", async (tier) => {
      const cfg = loadConfig();
      cfg.tierCaps = undefined;
      getActiveTiers(cfg).custom = { model: "test/model" };
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: tier, prompt: "original" } };
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output);
      expect(output.args.prompt).toContain(`Read-only budget: ${sessions.DEFAULT_TIER_CAPS[tier] ?? 5} calls.`);
    });

    it("does not throw if dispatch args cannot be mutated", async () => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: Object.freeze({ subagent_type: "fast", prompt: "original" }) };
      await expect(hooks["tool.execute.before"]!({ tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" }, output)).resolves.toBeUndefined();
      expect(output.args.prompt).toBe("original");
    });
  });

  describe("task prompt repair", () => {
    const call = { tool: "task", sessionID: ORCHESTRATOR_SID, callID: "dispatch" };

    it("leaves a call with a real prompt untouched", async () => {
      loadConfig().dispatchHeader = false;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", description: "greet", prompt: "Do the work" } };
      const before = structuredClone(output);
      await hooks["tool.execute.before"]!(call, output);
      expect(output.args).toEqual(before.args);
    });

    it.each([undefined, null, "", "   \n"])("fills a missing prompt (%j) from the trimmed description", async (prompt) => {
      loadConfig().dispatchHeader = false;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", description: "  Reply to the greeting  ", ...(prompt === undefined ? {} : { prompt }) } };
      await hooks["tool.execute.before"]!(call, output);
      expect(output.args).toEqual({ subagent_type: "fast", description: "  Reply to the greeting  ", prompt: "Reply to the greeting" });
    });

    it("hands the repaired prompt to the dispatch header", async () => {
      const cfg = loadConfig();
      cfg.tierCaps = { ...cfg.tierCaps, fast: 11 };
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output: { args: Record<string, unknown> } = { args: { subagent_type: "fast", description: "Reply to the greeting" } };
      await hooks["tool.execute.before"]!(call, output);
      expect(output.args.prompt).toBe(buildDispatchHeader({ tier: "fast", cap: 11, projectDirectory: process.cwd() }) + "\n\n---\n\nReply to the greeting");
    });

    it.each([{}, { description: "" }, { description: "  " }, { description: 7 }])("refuses a call with no prompt and no usable description: %j", async (extra) => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const output = { args: { subagent_type: "fast", ...extra } };
      const before = structuredClone(output);
      await expect(hooks["tool.execute.before"]!(call, output)).rejects.toThrow(
        "[router] This task call carried no prompt, and the task tool needs a non-empty `prompt` stating the work for the delegate. " +
        "Re-issue the call with the work restated as an instruction in `prompt`. If the request carries no task at all " +
        "(a greeting, an acknowledgement), do not delegate: answer it directly instead.",
      );
      expect(output.args).toEqual(before.args);
    });

    it("can be disabled by config, turning off both the repair and the refusal", async () => {
      const cfg = loadConfig();
      cfg.taskPromptRepair = false;
      cfg.dispatchHeader = false;
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const repairable = { args: { subagent_type: "fast", description: "Reply to the greeting" } };
      await hooks["tool.execute.before"]!(call, repairable);
      expect(repairable.args).toEqual({ subagent_type: "fast", description: "Reply to the greeting" });
      const refusable = { args: { subagent_type: "fast" } };
      await expect(hooks["tool.execute.before"]!(call, refusable)).resolves.toBeUndefined();
      expect(refusable.args).toEqual({ subagent_type: "fast" });
    });

    it("ignores other tools and does not throw on frozen args", async () => {
      const hooks = await ModelRouterPlugin(makeHarness().ctx as PluginInput);
      const other = { args: { description: "" } };
      await expect(hooks["tool.execute.before"]!({ ...call, tool: "read" }, other)).resolves.toBeUndefined();
      expect(other.args).toEqual({ description: "" });
      const frozen = { args: Object.freeze({ subagent_type: "fast", description: "Reply to the greeting" }) };
      await expect(hooks["tool.execute.before"]!(call, frozen)).resolves.toBeUndefined();
      expect(frozen.args).toEqual({ subagent_type: "fast", description: "Reply to the greeting" });
    });
  });

  // -------------------------------------------------------------------------
  // parentID
  // -------------------------------------------------------------------------

  describe("system transform session resolver", () => {
    const model: Model = {
      id: "test-model",
      providerID: "test-provider",
      api: { id: "test-model", url: "http://localhost", npm: "test" },
      name: "Test model",
      capabilities: {
        temperature: true, reasoning: false, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1000, output: 100 },
      status: "active",
      options: {},
      headers: {},
    };

    it("skips an unknown child before session.created and marks it as a subagent", async () => {
      const storeSpy = vi.spyOn(sessions, "createSessionStore");
      const h = makeHarness({ parentID: ORCHESTRATOR_SID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { system: [] as string[] };

      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, output);

      expect(output.system).toEqual([]);
      expect(storeSpy.mock.results[0].value.isSubagent("child")).toBe(true);
      expect(h.getSession).toHaveBeenCalledWith({ path: { id: "child" } });
    });

    it("injects exactly one entry for an unknown root", async () => {
      const h = makeHarness();
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const output = { system: [] as string[] };

      await hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output);

      expect(output.system).toHaveLength(1);
    });

    it.each([true, false])("filters global instructions only for children (child=%s)", async (child) => {
      const h = makeHarness({ parentID: child ? ORCHESTRATOR_SID : undefined });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      // Removal is bounded by the named file's contents, so the fixture must exist on disk.
      const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const root = join(tmpdir(), "opencode");
      mkdirSync(root, { recursive: true });
      const dir = mkdtempSync(join(root, "lifecycle-"));
      try {
        const file = join(dir, "CLAUDE.md");
        writeFileSync(file, "Orchestrate");
        const global = `Instructions from: ${file}\nOrchestrate`;
        const output = { system: ["provider", global] };
        await hooks["experimental.chat.system.transform"]!({ sessionID: "instructions", model }, output);
        if (child) {
          expect(output.system).toEqual(["provider"]);
        } else {
          expect(output.system).toHaveLength(3);
          expect(output.system.slice(0, 2)).toEqual(["provider", global]);
          expect(output.system[2]).toContain("fast");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });

    it.each([undefined, ORCHESTRATOR_SID])("looks up each session once (parentID=%s)", async (parentID) => {
      const h = makeHarness({ parentID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      for (let i = 0; i < 2; i++) {
        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({ sessionID: "session", model }, output);
        expect(output.system).toHaveLength(parentID ? 0 : 1);
      }
      expect(h.getSession).toHaveBeenCalledTimes(1);
    });

    it.each(["rejection", "error response"])("throttles %s for 30s, then recovers without memoising root", async (failure) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const opts = { sessionGetRejects: failure === "rejection", sessionGetError: failure === "error response", parentID: ORCHESTRATOR_SID };
      const h = makeHarness(opts);
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      for (let i = 0; i < 2; i++) {
        now = i * 29_999;
        const output = { system: [] as string[] };
        await expect(hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output)).resolves.toBeUndefined();
        expect(output.system).toHaveLength(1);
        expect(store.isSubagent("root")).toBe(false);
      }
      expect(h.getSession).toHaveBeenCalledTimes(1);
      opts.sessionGetRejects = false;
      opts.sessionGetError = false;
      now = 30_000;
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "root", model }, output);
      expect(output.system).toEqual([]);
      expect(store.isSubagent("root")).toBe(true);
      expect(h.getSession).toHaveBeenCalledTimes(2);
    });

    it("re-marks a memoised child after idle eviction", async () => {
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const h = makeHarness({ parentID: ORCHESTRATOR_SID });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, { system: [] });
      store.sweep(Date.now(), 0);
      expect(store.isSubagent("child")).toBe(false);
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "child", model }, output);
      expect(store.isSubagent("child")).toBe(true);
      expect(output.system).toEqual([]);
      expect(h.getSession).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("evicts deleted session memo, failure stamp and store (failed=%s)", async (sessionGetError) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = sessions.createSessionStore();
      vi.spyOn(sessions, "createSessionStore").mockReturnValue(store);
      const opts = { sessionGetError, parentID: undefined as string | undefined };
      const h = makeHarness(opts);
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      await hooks["experimental.chat.system.transform"]!({ sessionID: "deleted", model }, { system: [] });
      store.registerProducerSession("deleted", "fast", loadConfig());
      // The SDK declares properties.info: Session; only id is consumed here.
      const eventHook = hooks.event as (input: { event: { type: "session.deleted"; properties: { info: { id: string } } } }) => Promise<void>;
      await eventHook({ event: { type: "session.deleted", properties: { info: { id: "deleted" } } } });
      expect(store.isSubagent("deleted")).toBe(false);
      expect(store.getTier("deleted")).toBeNull();
      opts.sessionGetError = false;
      opts.parentID = ORCHESTRATOR_SID;
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ sessionID: "deleted", model }, output);
      expect(output.system).toEqual([]);
      expect(h.getSession).toHaveBeenCalledTimes(2);
    });

    it("bounds failed lookups to 500 sessions with oldest-first eviction", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(Date, "now").mockReturnValue(0);
      const h = makeHarness({ sessionGetError: true });
      const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
      const transform = hooks["experimental.chat.system.transform"]!;
      for (let i = 0; i <= 500; i++) {
        await transform({ sessionID: `failed-${i}`, model }, { system: [] });
      }
      await transform({ sessionID: "failed-1", model }, { system: [] });
      expect(h.getSession).toHaveBeenCalledTimes(501);
      await transform({ sessionID: "failed-0", model }, { system: [] });
      expect(h.getSession).toHaveBeenCalledTimes(502);
    });
  });

  it("emits both steps and legacy maxSteps for every tier agent", async () => {
    const h = makeHarness();
    const hooks = await ModelRouterPlugin(h.ctx as PluginInput);
    const config: { agent: Record<string, { steps?: number; maxSteps?: number }> } = { agent: {} };
    await hooks.config!(config);
    for (const [name, tier] of Object.entries(getActiveTiers(loadConfig()))) {
      expect(config.agent[name]).toHaveProperty("steps", tier.steps);
      expect(config.agent[name]).toHaveProperty("maxSteps", tier.steps);
    }
  });

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
