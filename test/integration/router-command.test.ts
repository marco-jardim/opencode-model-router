import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { loadConfig, invalidateConfigCache } from "../../src/router/config";
import { resetAgentOptionsEffortWarnings } from "../../src/router/agent-options";

describe("router-command integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = join(tmpdir(), `oc-mr-router-cmd-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);
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
    invalidateConfigCache();
  });

  it("enforce enforced persists + reload", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, out);
    expect(out.parts[0].text).toContain("enforced");
    expect(out.parts[0].text).toContain("persisted");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("enforced");
  });

  it("enforce off persists", async () => {
    // Prime to enforced first so "off" is a meaningful state transition.
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, { parts: [] as any[] });
    invalidateConfigCache();

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce off" }, out);
    expect(out.parts[0].text).toContain("off");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("off");
  });

  it("enforce with no mode shows current + usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce" }, out);
    expect(out.parts[0].text).toContain("Usage:");
    expect(out.parts[0].text).toContain("Current enforcement mode");
  });

  it("invalid mode shows usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce loud" }, out);
    expect(out.parts[0].text).toContain("Usage:");
  });

  it("bare /router shows status", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    expect(out.parts[0].text).toContain("Enforcement:");
    expect(out.parts[0].text).toContain("/router overrides");
  });

  it("overrides shows both layer paths + precedence", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "overrides" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("config overrides");
    expect(text).toContain("opencode-model-router.overrides.jsonc"); // global path
    expect(text).toContain(".opencode"); // project path
    expect(text).toContain("Active preset");
  });
  // A preset defined in an overrides file may carry only `model` per tier. The
  // /tiers renderer used to assume description/whenToUse were always present, so
  // a minimal preset crashed the command on `tier.whenToUse.join(...)`.
  it("renders a model-only override preset without crashing", async () => {
    const overrides = join(
      testHomeDir,
      ".config/opencode/opencode-model-router.overrides.jsonc",
    );
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(
      overrides,
      JSON.stringify({
        presets: { local: { fast: { model: "local/qwen3" } } },
        activePreset: "local",
      }),
      "utf-8",
    );
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "tiers", arguments: "" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("local/qwen3");
    expect(text).not.toContain("undefined");
  });
});

describe("router-command — model catalog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  // Mock opencode client exposing config.providers(). Only anthropic is
  // configured and it carries a single model, so the default anthropic preset
  // (which also names sonnet and opus) surfaces missing-model issues.
  const ctx = {
    directory: ".",
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active" },
                  // separator drift against the default `opus-4-8` pattern.
                  // isStrongModel now normalizes separators, so this MATCHES
                  // and is not an orphan — kept as the regression fixture for
                  // exactly that.
                  "claude-opus-4.8": { id: "claude-opus-4.8", status: "active" },
                },
              },
            ],
            default: { anthropic: "claude-haiku-4-5" },
          },
        }),
      },
    },
  };

  beforeEach(async () => {
    testHomeDir = join(tmpdir(), `oc-mr-catalog-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin(ctx as any);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    invalidateConfigCache();
  });

  it("/router models lists configured providers and model ids", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "models" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("available models");
    expect(text).toContain("anthropic");
    expect(text).toContain("anthropic/claude-haiku-4-5");
  });

  it("/router models <provider> with no match explains what is available", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "models openai" }, out);
    expect(out.parts[0].text).toContain("No configured provider matches");
  });

  it("bare /router appends model issues for the active preset", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    const text = out.parts[0].text;
    expect(text).toContain("Model issues in the active preset");
    // suggests the one model the catalog does have
    expect(text).toContain("anthropic/claude-haiku-4-5");
  });

  // -------------------------------------------------------------------------
  // The passive catalog check must not put a network round-trip in front of the
  // first message of every session. Turn 1 starts the fetch and returns; a later
  // turn reports what it found.
  // -------------------------------------------------------------------------

  const flush = () => new Promise<void>((r) => setImmediate(r));

  it("turn 1 returns without awaiting the catalog fetch", async () => {
    invalidateConfigCache();
    let release!: (v: any) => void;
    const pending = new Promise<any>((r) => {
      release = r;
    });
    let calls = 0;
    const slow: any = {
      directory: ".",
      client: {
        config: {
          providers: () => {
            calls++;
            return pending;
          },
        },
      },
    };
    const h: any = await ModelRouterPlugin(slow);
    // If the hook awaited the fetch, this never settles and the test times out.
    await h["chat.message"]({ sessionID: "s-slow" }, { parts: [] });
    expect(calls).toBe(1);
    release({ data: { providers: [], default: {} } });
    await flush();
  });

  it("emits the passive model warning on a later turn, not on turn 1", async () => {
    invalidateConfigCache();
    const h: any = await ModelRouterPlugin(ctx as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const warnings = () => warn.mock.calls.map((c) => String(c[0]));

      // turn 1 emits nothing at all: both the stale-model check and the
      // orphaned-pattern check need the catalog, so both are deferred
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      expect(warnings()).toEqual([]);

      await flush();

      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      const late = warnings();
      expect(late.some((m) => m.includes("model-missing"))).toBe(true);
      // No pattern warning. This catalog serves claude-opus-4.8 against the
      // default `opus-4-8`, which is precisely the separator drift the matcher
      // now absorbs — so the pattern is live, not orphaned. The remaining
      // defaults match nothing here, but a shipped default matching nothing is
      // the normal state of a cross-provider union and is never reported.
      expect(late.some((m) => m.includes("strong-model pattern"))).toBe(false);

      // and it stays a one-shot: a third turn adds nothing
      const before = late.length;
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      expect(warnings()).toHaveLength(before);
    } finally {
      warn.mockRestore();
    }
  });

  // The one orphan case that still reports end to end. Everything above
  // asserts silence, so without this the warning could stop firing entirely
  // and the integration suite would stay green.
  it("still warns about a user-authored pattern that matches nothing served", async () => {
    const overrides = join(
      testHomeDir,
      ".config/opencode/opencode-model-router.overrides.jsonc",
    );
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(
      overrides,
      JSON.stringify({
        // the tier resolves, so nothing else has anything to say about it
        presets: { local: { fast: { model: "anthropic/claude-haiku-4-5" } } },
        activePreset: "local",
        // a claim about THIS environment, and it is wrong
        modelGenerations: { strong: ["ghost-model-9"] },
      }),
      "utf-8",
    );
    invalidateConfigCache();
    const h: any = await ModelRouterPlugin(ctx as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      await flush();
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });

      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(
        msgs.some((m) => m.includes("strong-model pattern 'ghost-model-9'")),
      ).toBe(true);
      // and the tier itself is fine, so nothing else fires about it
      expect(msgs.some((m) => m.includes("model-missing"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not cache a turn-1 fetch failure into /router models", async () => {
    invalidateConfigCache();
    let calls = 0;
    const flaky: any = {
      directory: ".",
      client: {
        config: {
          providers: async () => {
            calls++;
            if (calls === 1) throw new Error("not ready");
            return {
              data: {
                providers: [
                  {
                    id: "anthropic",
                    models: { "claude-haiku-4-5": { id: "claude-haiku-4-5" } },
                  },
                ],
                default: {},
              },
            };
          },
        },
      },
    };
    const h: any = await ModelRouterPlugin(flaky);
    await h["chat.message"]({ sessionID: "s2" }, { parts: [] });
    await flush();

    const out = { parts: [] as any[] };
    await h["command.execute.before"]({ command: "router", arguments: "models" }, out);
    expect(out.parts[0].text).toContain("anthropic/claude-haiku-4-5");
  });

  // A failed or unavailable fetch must degrade to a message, not an exception.
  it("reports the catalog as unavailable when the provider call throws", async () => {
    invalidateConfigCache();
    const failing: any = {
      directory: ".",
      client: { config: { providers: async () => { throw new Error("not ready"); } } },
    };
    const h: any = await ModelRouterPlugin(failing);
    const out = { parts: [] as any[] };
    await h["command.execute.before"]({ command: "router", arguments: "models" }, out);
    expect(out.parts[0].text).toContain("Model catalog unavailable");
  });
});

// The reported symptom was a warning painted over the TUI. console output from
// a plugin goes to the server's stderr, which the terminal does not own; the
// /log endpoint is the channel that does not.
describe("router-command — passive warnings go to opencode's log", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  const ctxWithLog = (logged: unknown[]) => ({
    directory: ".",
    client: {
      app: {
        log: async (req: unknown) => {
          logged.push(req);
        },
      },
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active" },
                },
              },
            ],
            default: { anthropic: "claude-haiku-4-5" },
          },
        }),
      },
    },
  });

  beforeEach(() => {
    testHomeDir = join(tmpdir(), `oc-mr-log-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    invalidateConfigCache();
  });

  it("routes stale-model warnings to app.log and leaves the console alone", async () => {
    const logged: any[] = [];
    const h: any = await ModelRouterPlugin(ctxWithLog(logged) as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      await flush();
      await h["chat.message"]({ sessionID: "s1" }, { parts: [] });
      await flush();

      expect(logged.length).toBeGreaterThan(0);
      const entry = logged[0].body;
      expect(entry.service).toBe("model-router");
      expect(entry.level).toBe("warn");
      expect(entry.message).toContain("model-missing");
      // the service tag replaces the old inline prefix
      expect(entry.message).not.toContain("[model-router]");
      // nothing reached stderr, which is the whole point
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // The registration path warns too, and it is the noisiest of the lot: the
  // anthropic-fix dependency notice is ~230 characters, which is exactly the
  // line the original bug report watched smear across the TUI. It fires from
  // the `config` hook, so nothing above reaches it.
  it("routes the agent-options effort warning to app.log and leaves the console alone", async () => {
    // A Claude-backed tier carrying a string `effort` is what makes
    // buildAgentOptions emit `options.effort`, which is the trigger.
    const overrides = join(
      testHomeDir,
      ".config/opencode/opencode-model-router.overrides.jsonc",
    );
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(
      overrides,
      JSON.stringify({
        presets: {
          local: { fast: { model: "anthropic/claude-haiku-4-5", effort: "high" } },
        },
        activePreset: "local",
      }),
      "utf-8",
    );
    invalidateConfigCache();
    // warnAgentOptionsEffortOnce dedupes through a module-level Set that lives
    // for the whole process, and this key is a fixed string rather than one
    // qualified by tier. Any earlier test in this file that registered a
    // Claude tier with an effort would have consumed it and left this
    // assertion passing on an empty log. Reset it so the test is deterministic
    // regardless of what ran before.
    resetAgentOptionsEffortWarnings();

    const logged: any[] = [];
    const h: any = await ModelRouterPlugin(ctxWithLog(logged) as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h["config"]({});
      await flush();

      const entry = logged.find((l) =>
        String(l.body.message).includes("opencode-anthropic-fix"),
      );
      expect(entry).toBeDefined();
      expect(entry.body.service).toBe("model-router");
      expect(entry.body.level).toBe("warn");
      // the regression: this used to reach stderr because the call site
      // dropped the logger argument and fell through to console.warn
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      resetAgentOptionsEffortWarnings();
    }
  });
});
