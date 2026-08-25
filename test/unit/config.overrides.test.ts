import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import {
  deepMerge,
  loadConfig,
  invalidateConfigCache,
  overridePath,
  localOverridePath,
  findProjectOverride,
  writeState,
} from "../../src/router/config";

// Switch used by the "cannot be read" test below to make exactly one path fail
// at the fs boundary. `vi.mock` factories are hoisted above the imports, so the
// flag it closes over has to be hoisted alongside them. Every other path — the
// bundled tiers.json included — delegates to the real implementation, so this is
// inert for every other test in this file.
const fsMock = vi.hoisted(() => ({
  unreadablePath: null as string | null,
  // Maps a "symlinked" path to what realpathSync should resolve it to. Used by
  // the $HOME boundary test: creating a real symlink needs elevated privileges
  // on Windows, so the link is faked at the fs boundary instead of on disk.
  realpaths: new Map<string, string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      if (fsMock.unreadablePath !== null && String(path) === fsMock.unreadablePath) {
        const err = new Error(
          `EACCES: permission denied, open '${String(path)}'`,
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    realpathSync: (path: unknown, ...rest: unknown[]) => {
      const mapped = fsMock.realpaths.get(String(path));
      if (mapped !== undefined) return mapped;
      return (actual.realpathSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

// The bundled github-copilot heavy tier, read straight from tiers.json. These
// tests are about merge/fallback behaviour, not about which model a preset
// happens to pin, so they assert against the bundled values rather than
// hard-coded model IDs — a preset bump must not break the override suite.
const BUNDLED_HEAVY = JSON.parse(
  readFileSync(join(__dirname, "../../tiers.json"), "utf-8"),
).presets["github-copilot"].heavy as {
  model: string;
  costRatio: number;
  steps: number;
  description: string;
};

// ---------------------------------------------------------------------------
// deepMerge — pure unit tests
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  it("merges nested objects key-by-key, leaving untouched keys intact", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const out = deepMerge(base, { a: { y: 9 } });
    expect(out).toEqual({ a: { x: 1, y: 9 }, b: 3 });
  });

  it("ignores __proto__ and constructor keys rather than reparenting", () => {
    const out = deepMerge(
      { a: 1 },
      JSON.parse('{"__proto__": {"polluted": true}, "b": 2}'),
    ) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, b: 2 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("replaces arrays wholesale (no concatenation)", () => {
    const out = deepMerge({ list: [1, 2, 3] }, { list: [9] });
    expect(out).toEqual({ list: [9] });
  });

  it("replaces scalars", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("skips undefined override values so base survives", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined })).toEqual({ a: 1, b: 2 });
  });

  it("returns the override when either side is not a plain object", () => {
    expect(deepMerge(5, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(deepMerge({ a: 1 }, null)).toBe(null);
  });

  it("preserves sibling tier fields when overriding only one key (canonical case)", () => {
    const base = {
      heavy: { model: "old", variant: "high", costRatio: 20, steps: 120 },
    };
    const out = deepMerge(base, { heavy: { model: "new" } }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out.heavy).toEqual({
      model: "new",
      variant: "high",
      costRatio: 20,
      steps: 120,
    });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { x: 2 } });
    expect(base.a.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — override file integration (HOME redirected to a temp dir so the
// real ~/.config/opencode files are never touched).
// ---------------------------------------------------------------------------

describe("loadConfig — user overrides file", () => {
  let tmpHome: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    tmpHome = join(
      tmpdir(),
      `oc-mr-overrides-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function writeOverride(content: string): void {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    invalidateConfigCache();
  }

  it("returns the bundled config unchanged when no override file exists", () => {
    const cfg = loadConfig();
    expect(cfg.presets["github-copilot"]!.heavy!.model).toBe(BUNDLED_HEAVY.model);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // activePreset is the likeliest key to typo in a hand-edited file. It used to
  // load clean and leave routing on whatever the bundled default was, saying
  // nothing at all.
  it("warns and drops the layer when activePreset names no known preset", () => {
    writeOverride(JSON.stringify({ activePreset: "no-such-preset-xyz" }));
    const cfg = loadConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no-such-preset-xyz"),
    );
    // fell back to the bundled default rather than adopting the bad name
    expect(cfg.activePreset).not.toBe("no-such-preset-xyz");
    expect(cfg.presets[cfg.activePreset]).toBeDefined();
  });

  it("accepts activePreset naming a preset the override itself defines", () => {
    writeOverride(
      JSON.stringify({
        presets: { local: { fast: { model: "local/qwen3" } } },
        activePreset: "local",
      }),
    );
    expect(loadConfig().activePreset).toBe("local");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // An unreadable file is the one fallback path that used to say nothing, which
  // made a permissions problem indistinguishable from having no override at all.
  it("warns when an override file exists but cannot be read", () => {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ activePreset: "anthropic" }), "utf-8");
    // Fail the read at the fs boundary rather than via chmod: mode bits are
    // ignored when running as root and largely do not apply on Windows, so the
    // old approach silently asserted nothing on two very common platforms.
    fsMock.unreadablePath = p;
    invalidateConfigCache();
    try {
      loadConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("cannot read it"),
      );
    } finally {
      fsMock.unreadablePath = null;
    }
  });

  it("accepts activePreset in a different case, matching /preset resolution", () => {
    writeOverride(JSON.stringify({ activePreset: "AnThRoPiC" }));
    expect(loadConfig().presets.anthropic).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("deep-merges a single tier model, preserving sibling fields", () => {
    writeOverride(
      JSON.stringify({
        presets: {
          "github-copilot": { heavy: { model: "github-copilot/custom-opus" } },
        },
      }),
    );
    const heavy = loadConfig().presets["github-copilot"]!.heavy!;
    expect(heavy.model).toBe("github-copilot/custom-opus");
    // sibling fields from the bundled config survive the merge
    expect(heavy.costRatio).toBe(BUNDLED_HEAVY.costRatio);
    expect(heavy.steps).toBe(BUNDLED_HEAVY.steps);
    expect(heavy.description).toBe(BUNDLED_HEAVY.description);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("honors activePreset set in the override file (as a default)", () => {
    writeOverride(JSON.stringify({ activePreset: "openai" }));
    expect(loadConfig().activePreset).toBe("openai");
  });

  it("lets the persisted state file's activePreset win over the override", () => {
    writeOverride(JSON.stringify({ activePreset: "openai" }));
    writeState({ activePreset: "google" }); // runtime /preset selection
    invalidateConfigCache();
    expect(loadConfig().activePreset).toBe("google");
  });

  it("supports comments and trailing commas in the overrides file", () => {
    writeOverride(`{
      // override just the heavy model for github-copilot
      "presets": {
        "github-copilot": {
          "heavy": { "model": "github-copilot/custom-opus" }, /* trailing comma → */
        },
      },
    }`);
    expect(loadConfig().presets["github-copilot"]!.heavy!.model).toBe(
      "github-copilot/custom-opus",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("can add an entirely new preset with only `model` per tier", () => {
    writeOverride(
      JSON.stringify({
        presets: {
          local: {
            fast: { model: "local/qwen3.6-27b-mtp" },
            medium: { model: "local/qwen3.6-27b-mtp" },
            heavy: { model: "local/qwen3.6-27b-mtp" },
          },
        },
        activePreset: "local",
      }),
    );
    const cfg = loadConfig();
    expect(cfg.activePreset).toBe("local");
    expect(cfg.presets.local!.heavy!.model).toBe("local/qwen3.6-27b-mtp");
    expect(warnSpy).not.toHaveBeenCalled(); // no validation failure → layer not dropped

    // name-based defaults are filled in for the omitted costRatio/steps
    const local = cfg.presets.local!;
    expect([local.fast!.costRatio, local.fast!.steps]).toEqual([1, 30]);
    expect([local.medium!.costRatio, local.medium!.steps]).toEqual([5, 50]);
    expect([local.heavy!.costRatio, local.heavy!.steps]).toEqual([20, 120]);
  });

  it("warns and falls back to bundled config on invalid JSON", () => {
    writeOverride("{ not valid json ");
    const cfg = loadConfig();
    expect(cfg.presets["github-copilot"]!.heavy!.model).toBe(BUNDLED_HEAVY.model);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid JSON"),
    );
  });

  it("warns and falls back when the override root is not an object", () => {
    writeOverride(JSON.stringify(["not", "an", "object"]));
    const cfg = loadConfig();
    expect(cfg.presets.anthropic!.fast!.model).toBe("anthropic/claude-sonnet-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected a JSON object at root"),
    );
  });

  it("warns and falls back when the merged config fails validation", () => {
    // model must be a non-empty string; a number makes the merged config invalid
    writeOverride(
      JSON.stringify({ presets: { anthropic: { fast: { model: 123 } } } }),
    );
    const cfg = loadConfig();
    expect(cfg.presets.anthropic!.fast!.model).toBe("anthropic/claude-sonnet-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("must be a non-empty string"),
    );
  });

  // The provider-less ref is the realistic mistake — it looks like a model name,
  // so it reads as correct. What matters is that rejecting it at load DEGRADES:
  // the layer is dropped and the bundled config stands, rather than the plugin
  // failing to start. Reported in #17.
  it("drops the layer, without bricking startup, when a model ref has no provider", () => {
    writeOverride(
      JSON.stringify({
        presets: { anthropic: { fast: { model: "claude-sonnet-5" } } },
      }),
    );
    const cfg = loadConfig();
    expect(cfg.presets.anthropic!.fast!.model).toBe("anthropic/claude-sonnet-5");
    // and the warning names the offending value, not just the field
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("must be 'provider/model' (got 'claude-sonnet-5')"),
    );
  });
});

// ---------------------------------------------------------------------------
// loadConfig — global + project-local override hierarchy. HOME drives the global
// file; process.cwd() drives the project-local file. Both are redirected to
// temp dirs so the real environment is never touched.
// ---------------------------------------------------------------------------

describe("loadConfig — global + project override hierarchy", () => {
  let tmpHome: string;
  let tmpProject: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedCwd = process.cwd();
    const stamp = `${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    tmpHome = join(tmpdir(), `oc-mr-home-${stamp}`);
    tmpProject = join(tmpdir(), `oc-mr-proj-${stamp}`);
    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(tmpProject, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.chdir(tmpProject);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    for (const d of [tmpHome, tmpProject]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    invalidateConfigCache();
  });

  function writeGlobal(obj: unknown): void {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), "utf-8");
  }

  function writeLocal(obj: unknown): void {
    const p = localOverridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj), "utf-8");
  }

  it("localOverridePath resolves to <cwd>/.opencode/opencode-model-router.overrides.jsonc", () => {
    expect(localOverridePath()).toBe(
      join(process.cwd(), ".opencode", "opencode-model-router.overrides.jsonc"),
    );
  });

  it("applies a project-local override", () => {
    writeLocal({
      presets: { anthropic: { fast: { model: "anthropic/project-fast" } } },
    });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/project-fast",
    );
  });

  it("project-local wins over global for the same key", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({
      presets: { anthropic: { fast: { model: "anthropic/project-fast" } } },
    });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/project-fast",
    );
  });

  it("merges distinct keys from both layers", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({
      presets: { anthropic: { heavy: { model: "anthropic/project-heavy" } } },
    });
    invalidateConfigCache();
    const anthropic = loadConfig().presets.anthropic!;
    expect(anthropic.fast!.model).toBe("anthropic/global-fast");
    expect(anthropic.heavy!.model).toBe("anthropic/project-heavy");
  });

  it("a broken global file does not discard a valid project file", () => {
    // global makes the merged config invalid; project is fine on its own
    writeGlobal({ presets: { anthropic: { fast: { model: 123 } } } });
    writeLocal({
      presets: { anthropic: { medium: { model: "anthropic/project-medium" } } },
    });
    invalidateConfigCache();
    const anthropic = loadConfig().presets.anthropic!;
    expect(anthropic.medium!.model).toBe("anthropic/project-medium");
    // fell back to the bundled fast model (global dropped)
    expect(anthropic.fast!.model).toBe("anthropic/claude-sonnet-5");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("combined overrides are invalid"),
    );
  });

  it("a broken project file keeps the valid global file", () => {
    writeGlobal({
      presets: { anthropic: { fast: { model: "anthropic/global-fast" } } },
    });
    writeLocal({ presets: { anthropic: { fast: { model: 999 } } } });
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/global-fast",
    );
  });
});

// ---------------------------------------------------------------------------
// findProjectOverride — upward search from cwd, bounded by the project root.
// ---------------------------------------------------------------------------

describe("findProjectOverride — upward search", () => {
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedCwd: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedCwd = process.cwd();
    tmpRoot = join(
      tmpdir(),
      `oc-mr-walk-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });
    // Isolate the global layer to an empty home so only the project file matters.
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function write(path: string, obj: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj), "utf-8");
  }

  it("finds the project file from a nested subdirectory", () => {
    const project = join(tmpRoot, "repo");
    const file = join(project, ".opencode", "opencode-model-router.overrides.jsonc");
    write(file, { defaultTier: "fast" });
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "src", "feature", "deep");
    mkdirSync(deep, { recursive: true });

    process.chdir(deep);
    expect(findProjectOverride()).toBe(realpathSync(file));
  });

  it("does not escape the project root (stops at .git)", () => {
    // An override above the repo root must NOT be picked up.
    write(join(tmpRoot, ".opencode", "opencode-model-router.overrides.jsonc"), {
      defaultTier: "heavy",
    });
    const project = join(tmpRoot, "repo");
    mkdirSync(join(project, ".git"), { recursive: true });
    const sub = join(project, "sub");
    mkdirSync(sub, { recursive: true });

    process.chdir(sub);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("loadConfig applies the project override when launched from a subdir", () => {
    const project = join(tmpRoot, "repo");
    write(join(project, ".opencode", "opencode-model-router.overrides.jsonc"), {
      presets: { anthropic: { fast: { model: "anthropic/from-subdir" } } },
    });
    mkdirSync(join(project, ".git"), { recursive: true });
    const deep = join(project, "a", "b");
    mkdirSync(deep, { recursive: true });

    process.chdir(deep);
    invalidateConfigCache();
    expect(loadConfig().presets.anthropic!.fast!.model).toBe(
      "anthropic/from-subdir",
    );
  });
});

// ---------------------------------------------------------------------------
// findProjectOverride — walk boundaries. Without a repo marker the walk used to
// run to the filesystem root and silently adopt an unrelated ancestor's file.
// HOME is deliberately parked on a SIBLING directory here so these tests pin the
// depth ceiling and the marker set, not the home-directory boundary.
// ---------------------------------------------------------------------------

describe("findProjectOverride — walk boundaries", () => {
  const OVERRIDES = "opencode-model-router.overrides.jsonc";
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedCwd: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedCwd = process.cwd();
    tmpRoot = join(
      tmpdir(),
      `oc-mr-bound-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    // Sibling of the walk tree, so homedir() is never an ancestor of cwd.
    const fakeHome = join(tmpRoot, "h");
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    invalidateConfigCache();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function write(path: string, obj: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj), "utf-8");
  }

  /** Build `levels` nested single-char dirs under `from`, returning the deepest. */
  function nest(from: string, levels: number): string {
    let dir = from;
    for (let i = 0; i < levels; i++) dir = join(dir, "d");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("stops at the depth ceiling when no repo marker exists anywhere", () => {
    const base = join(tmpRoot, "t");
    // Override sits at the top; cwd is far deeper than the 16-level ceiling.
    write(join(base, ".opencode", OVERRIDES), { defaultTier: "heavy" });
    const deep = nest(base, 20);

    process.chdir(deep);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("still finds a markerless project within the depth ceiling", () => {
    const base = join(tmpRoot, "t");
    const file = join(base, ".opencode", OVERRIDES);
    write(file, { defaultTier: "fast" });
    const deep = nest(base, 3);

    process.chdir(deep);
    expect(findProjectOverride()).toBe(realpathSync(file));
  });

  it("treats .hg as a repo root marker", () => {
    write(join(tmpRoot, "t", ".opencode", OVERRIDES), { defaultTier: "heavy" });
    const repo = join(tmpRoot, "t", "repo");
    mkdirSync(join(repo, ".hg"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });

    process.chdir(sub);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("treats .svn as a repo root marker", () => {
    write(join(tmpRoot, "t", ".opencode", OVERRIDES), { defaultTier: "heavy" });
    const repo = join(tmpRoot, "t", "repo");
    mkdirSync(join(repo, ".svn"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });

    process.chdir(sub);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("does NOT treat package.json as a marker (monorepo packages keep walking)", () => {
    const repo = join(tmpRoot, "repo");
    const file = join(repo, ".opencode", OVERRIDES);
    write(file, { defaultTier: "fast" });
    mkdirSync(join(repo, ".git"), { recursive: true });
    // A nested workspace package with its own manifest must not stop the walk.
    const pkg = join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"app"}', "utf-8");

    process.chdir(pkg);
    expect(findProjectOverride()).toBe(realpathSync(file));
  });

  // The guard above compares cwd() against homedir(). cwd() returns a realpath
  // and homedir() returns $HOME verbatim, so when $HOME is reached through a
  // symlink the two never match and the boundary stops applying. The link is
  // faked at the fs boundary rather than created on disk: symlinkSync needs
  // elevated privileges on Windows, so a real one would assert nothing there.
  it("never adopts ~/.opencode when $HOME is reached through a symlink", () => {
    const realHome = join(tmpRoot, "real-home");
    write(join(realHome, ".opencode", OVERRIDES), { defaultTier: "heavy" });
    const linkedHome = join(tmpRoot, "linked-home");

    // $HOME is the link; it resolves to the same directory cwd() sits under.
    fsMock.realpaths.set(linkedHome, realpathSync(realHome));
    process.env.HOME = linkedHome;
    process.env.USERPROFILE = linkedHome;
    const scratch = join(realHome, "scratch");
    mkdirSync(scratch, { recursive: true });

    process.chdir(scratch);
    try {
      expect(findProjectOverride()).toBeUndefined();
    } finally {
      fsMock.realpaths.clear();
    }
  });

  it("never adopts ~/.opencode from an unrelated directory below home", () => {
    // The original escape: a scratch dir under $HOME with no repo marker.
    const home = join(tmpRoot, "home2");
    write(join(home, ".opencode", OVERRIDES), { defaultTier: "heavy" });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const scratch = join(home, "scratch");
    mkdirSync(scratch, { recursive: true });

    process.chdir(scratch);
    expect(findProjectOverride()).toBeUndefined();
  });

  it("still honours a home directory that is itself a repo root (dotfiles)", () => {
    const home = join(tmpRoot, "home3");
    const file = join(home, ".opencode", OVERRIDES);
    write(file, { defaultTier: "fast" });
    mkdirSync(join(home, ".git"), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const sub = join(home, "sub");
    mkdirSync(sub, { recursive: true });

    process.chdir(sub);
    expect(findProjectOverride()).toBe(realpathSync(file));
  });
});
