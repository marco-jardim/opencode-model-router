// Phase 2.1 (M6): the plugin's verdict and false-refusal call sites feed the outcome store, on v2 and only
// when routing.engine != static. Temp directories only (HOME is redirected; outcomes path is injected).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { rememberDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { acquireOutcomes, DEFAULT_OUTCOME_TUNING, makeKey } from "../../src/routing/outcomes";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { snapshotTree } from "../../src/verify/tree";

// Same isolation as session-lifecycle.test.ts: never launch this repository's real test suite as a baseline.
vi.mock("../../src/verify/tree", () => ({ snapshotTree: vi.fn(async () => undefined) }));

const ORCHESTRATOR = "orchestrator-session";
const KEY = makeKey("implement", { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low");
const FACTS = { class: "implement", risk: "medium", scope: "file", needs: [] as string[], confidence: 0.9, source: "rules" };
const FALSE_REFUSAL = "ESCALATE: tools unavailable";
const logger = { warn: vi.fn() };

let home: string;
let outcomes: string;
const hooksToDispose: Array<{ dispose?: () => Promise<void> }> = [];

function setup(routing?: Record<string, unknown>): void {
  home = mkdtempSync(join(tmpdir(), "router-ingest-wiring-"));
  outcomes = join(home, "outcomes");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify({
    enforcement: { verify: { testBaseline: false } },
    ...(routing ? { routing: { outcomes: { path: outcomes }, ...routing } } : {}),
  }));
  invalidateConfigCache();
}

function client(graderPass: boolean) {
  let counter = 0;
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
      create: async () => ({ data: { id: `sess-${++counter}` } }),
      prompt: async (request: any) => request?.body?.system !== undefined
        ? { data: { parts: [{ type: "text", text: JSON.stringify({ pass: graderPass, reasons: graderPass ? [] : ["criterion not evidenced"] }) }] } }
        : { data: { parts: [{ type: "text", text: "producer output" }] } },
      abort: async () => true,
      delete: async () => true,
    },
  };
}

async function plugin(host: "v1" | "v2", graderPass = true) {
  const hooks: any = await ModelRouterPlugin({
    directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => {},
    client: client(graderPass),
    ...(host === "v2" ? { routerHost: "v2" } : {}),
  } as unknown as PluginInput);
  hooksToDispose.push(hooks);
  return hooks;
}

function register(child: string, over: Partial<Parameters<typeof rememberDispatch>[1]> = {}): void {
  rememberDispatch(child, {
    facts: FACTS, agent: "fast", model: "anthropic/claude-sonnet-5-5", variant: "low", tier: "fast", parentSessionID: ORCHESTRATOR, ...over,
  });
}

/** What the store holds for KEY right now (acquires the shared process bundle, then releases it). */
async function counts() {
  const peek = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
  try {
    return peek.store.snapshot().entries[KEY]?.counts;
  } finally {
    await peek.release();
  }
}

async function refusal(hooks: any, child: string): Promise<string> {
  await hooks.event({ event: { type: "session.created", properties: { info: {
    id: child, parentID: ORCHESTRATOR, projectID: "project", directory: home, title: "child", version: "1", time: { created: 0, updated: 0 },
  } } } });
  const output = { title: "task", output: FALSE_REFUSAL, metadata: { sessionId: child } };
  await hooks["tool.execute.after"]({ tool: "task", sessionID: ORCHESTRATOR, callID: `refusal-${child}`, args: {} }, output);
  return output.output;
}

async function verified(hooks: any, child: string): Promise<void> {
  const input = { tool: "task", sessionID: ORCHESTRATOR, callID: `verify-${child}` };
  const args = { subagent_type: "fast", prompt: "Investigate.\n[acceptance]\ncriteria: investigation complete\n[/acceptance]" };
  await hooks["tool.execute.before"](input, { args });
  await hooks["tool.execute.after"]({ ...input, args }, { title: "task", output: "findings", metadata: { sessionId: child } });
}

beforeEach(() => {
  vi.mocked(snapshotTree).mockResolvedValue(undefined);
  resetDispatchRegistry();
  resetIngestState();
});

afterEach(async () => {
  for (const hooks of hooksToDispose.splice(0)) await hooks.dispose?.();
  vi.unstubAllEnvs();
  invalidateConfigCache();
  resetDispatchRegistry();
  resetIngestState();
  logger.warn.mockReset();
  rmSync(home, { recursive: true, force: true });
});

describe("false-refusal call site", () => {
  it("v2 + shadow: the banner is unchanged and the registered child's key records a failure and a refusal row", async () => {
    setup({ engine: "shadow" });
    const hooks = await plugin("v2");
    register("refusal-child", { decisionID: "d-1" });
    const banner = await refusal(hooks, "refusal-child");
    expect(banner).toContain("FALSE-REFUSAL SUSPECT");
    expect(await counts()).toMatchObject({ pass: 0, fail: 0, falseRefusals: 1 });
    await hooks.dispose();
    const reader = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
    try {
      const rows = (await reader.persister.readRows()).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "refusal", childSessionID: "refusal-child", decisionID: "d-1", attemptID: expect.stringMatching(/^refusal-child:0:\d+$/), key: KEY, sessionID: ORCHESTRATOR });
    } finally {
      await reader.release();
    }
  });

  it("a child that is not registered records nothing, and the banner is unchanged", async () => {
    setup({ engine: "shadow" });
    const hooks = await plugin("v2");
    expect(await refusal(hooks, "unregistered")).toContain("FALSE-REFUSAL SUSPECT");
    expect(existsSync(outcomes)).toBe(false);
  });

  it.each([
    { name: "v2 without a routing block (engine static)", host: "v2" as const, routing: undefined },
    { name: "v2 with engine static", host: "v2" as const, routing: { engine: "static" } },
    { name: "v1 even with engine shadow (D1)", host: "v1" as const, routing: { engine: "shadow" } },
  ])("$name: nothing is recorded and nothing is written", async ({ host, routing }) => {
    setup(routing);
    const hooks = await plugin(host);
    register("refusal-child");
    expect(await refusal(hooks, "refusal-child")).toContain("FALSE-REFUSAL SUSPECT");
    await hooks.dispose();
    expect(existsSync(outcomes)).toBe(false);
  });
});

describe("verification verdict call site", () => {
  it("v2 + shadow: a passing verdict of a registered child scores the key", async () => {
    setup({ engine: "shadow" });
    const hooks = await plugin("v2", true);
    register("child");
    await verified(hooks, "child");
    expect(await counts()).toMatchObject({ pass: 1, fail: 0 });
  });

  it("v2 + shadow: a failing verdict scores a failure", async () => {
    setup({ engine: "shadow" });
    const hooks = await plugin("v2", false);
    register("child");
    await verified(hooks, "child");
    expect(await counts()).toMatchObject({ pass: 0, fail: 1 });
  });

  it("v2 + shadow: a class below minClassConfidence is not scored", async () => {
    setup({ engine: "shadow", minClassConfidence: 0.95 });
    const hooks = await plugin("v2", true);
    register("child");
    await verified(hooks, "child");
    expect(existsSync(outcomes)).toBe(false);
  });

  it.each([
    { name: "v2 without a routing block", host: "v2" as const, routing: undefined },
    { name: "v1 with engine shadow", host: "v1" as const, routing: { engine: "shadow" } },
  ])("$name: nothing is scored and nothing is written", async ({ host, routing }) => {
    setup(routing);
    const hooks = await plugin(host, true);
    register("child");
    await verified(hooks, "child");
    await hooks.dispose();
    expect(existsSync(outcomes)).toBe(false);
  });
});
