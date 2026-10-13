/** Phase 5.1.2: capture the frozen v1 tool map, command map and bare /router help before executor registration. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

type Tools = Record<string, {
  description: string;
  args: Record<string, { description?: string }>;
}>;
type Hooks = {
  tool: Tools;
  config(input: { command: Record<string, unknown>; agent: Record<string, unknown> }): Promise<void>;
  "command.execute.before"(input: { command: string; sessionID: string; arguments: string }, output: { parts: { type: string; text: string }[] }): Promise<void>;
  dispose?(): Promise<void>;
};

/** Keep argument key order, but sort the tool names so insertion order cannot obscure a map change. */
function shape(tools: Tools) {
  return Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, definition]) => [name, {
    description: definition.description,
    keys: Object.keys(definition.args),
    described: Object.fromEntries(Object.entries(definition.args).map(([key, schema]) => [key, schema.description ?? null])),
  }]));
}

describe("v1 plugin maps golden (Phase 5.1.2)", () => {
  const homes: string[] = [];
  const tempRoot = tmpdir();
  const envKeys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMP", "TEMP", "TMPDIR", "MODEL_ROUTER_ENFORCE"] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

  beforeEach(() => {
    invalidateConfigCache();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    invalidateConfigCache();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  async function capture(config: Record<string, unknown>) {
    // Each plugin gets its own state/config/data/log tree, including Windows' temp-backed decision logs.
    const home = mkdtempSync(join(tempRoot, "omr-v1-maps-"));
    homes.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData/Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData/Local");
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_STATE_HOME = join(home, ".local/state");
    process.env.XDG_DATA_HOME = join(home, ".local/share");
    const temp = join(home, "temp");
    mkdirSync(temp, { recursive: true });
    for (const key of ["TMP", "TEMP", "TMPDIR"] as const) process.env[key] = temp;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const overrides = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(overrides, JSON.stringify(config), "utf-8");
    invalidateConfigCache();
    const root = join(home, "project");
    mkdirSync(root, { recursive: true });
    const ctx = {
      directory: root,
      worktree: root,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: () => undefined,
      client: {
        session: {
          get: async () => ({ data: {} }),
          create: async () => ({ data: { id: "never" } }),
          prompt: async () => ({ data: { parts: [] } }),
          abort: async () => ({}),
          delete: async () => ({}),
        },
      },
    };
    const hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]) as unknown as Hooks;
    try {
      const output = { command: {} as Record<string, unknown>, agent: {} as Record<string, unknown> };
      await hooks.config(output);
      const help = { parts: [] as { type: string; text: string }[] };
      await hooks["command.execute.before"]({ command: "router", sessionID: "root", arguments: "" }, help);
      return {
        tools: `${JSON.stringify(shape(hooks.tool), null, 2)}\n`,
        commands: `${JSON.stringify(Object.fromEntries(Object.entries(output.command).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, JSON.stringify(entry)])), null, 2)}\n`,
        // The build identity changes with each commit; preserve every other byte of the bare /router output.
        // "last checkpoint=DF4" comes from checked-in docs/qa/cost-aware-routing/dogfood.md, so it is checkout-deterministic.
        help: help.parts.map(part => part.text).join("\n").replace(/^(router: engine=\S+ )build=\S+\+\S+$/gm, "$1build=<normalized>"),
      };
    } finally {
      await hooks.dispose?.();
    }
  }

  it("default and executor/roles configs are byte-identical to the pre-registration v1 maps", async () => {
    // An empty routing block resolves to the defaults. Use it in both captures because existing v1 help
    // intentionally lists stats and the checkout's checkpoint only when the config has a routing block.
    const defaults = await capture({ routing: {} });
    const configured = await capture({ routing: { delegation: "roles", executor: { approve: "ask" } } });
    expect(configured).toEqual(defaults);
    for (const actual of [defaults, configured]) {
      await expect(actual.tools).toMatchFileSnapshot("__snapshots__/v1-plugin-maps.tools.json");
      await expect(actual.commands).toMatchFileSnapshot("__snapshots__/v1-plugin-maps.commands.json");
      await expect(actual.help).toMatchFileSnapshot("__snapshots__/v1-plugin-maps.router-help.txt");
    }
  });
});
