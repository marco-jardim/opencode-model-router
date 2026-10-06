/**
 * QA-2.4-R2-11: the copy of the shipped `tiers.json` the advisor compares tiers with is refreshed on every config reload.
 *
 * `loadConfig` hands out a new `RouterConfig` object whenever it reloads (a plugin update replaces `tiers.json`), so the advisor reads the
 * shipped file once per config object: a config in use is not re-read on every check, and a reloaded one sees the new file instead of
 * flagging every tier of the updated bundled preset as "modified" for the rest of the process.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../../src/router/config";
import type { RouterConfig } from "../../src/router/config";
import { runAdvisor } from "../../src/routing/advisor";
import type { AdvisorCatalogModel } from "../../src/routing/advisor";

const seam = vi.hoisted(() => ({ shipped: null as string | null, reads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const read = (...args: Parameters<typeof actual.readFileSync>): ReturnType<typeof actual.readFileSync> => {
    const [path] = args;
    if (seam.shipped !== null && typeof path === "string" && path.endsWith("tiers.json")) {
      seam.reads += 1;
      return seam.shipped;
    }
    return actual.readFileSync(...args);
  };
  const readFileSync = Object.assign(read, actual.readFileSync) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const here = dirname(fileURLToPath(import.meta.url));
const SHIPPED = readFileSync(join(here, "../../tiers.json"), "utf-8"); // before the seam is armed: the real file

const model = (id: string, cost: number): AdvisorCatalogModel => ({
  providerID: "anthropic",
  id,
  enabled: true,
  status: "active",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: ["low", "medium", "high", "xhigh", "max"].map((variant) => ({ id: variant })),
  cost: [{ input: cost, output: cost * 5, cache: { read: 0, write: 0 } }],
  limit: { context: 1_000_000, output: 64_000 },
});
const CATALOG: AdvisorCatalogModel[] = [model("claude-sonnet-5-5", 3), model("claude-opus-5-5", 15), model("claude-haiku-4-5", 1)];

/** The bundled `anthropic` preset as a config, with the medium tier's `costRatio` set to `ratio` (what a plugin update may change). */
function configWith(shippedText: string, ratio: number | null): RouterConfig {
  const raw = JSON.parse(shippedText) as { activePreset: string; routing?: unknown; presets: Record<string, Record<string, { costRatio?: number }>> };
  raw.activePreset = "anthropic";
  raw.routing = {};
  if (ratio !== null) raw.presets.anthropic!.medium!.costRatio = ratio;
  return validateConfig(raw);
}

const effortOnMedium = (cfg: RouterConfig) => runAdvisor(cfg, { agents: [] }, CATALOG).find((f) => f.id === "variant-effort" && f.subject === "medium");

describe("the advisor's copy of the shipped tiers.json (QA-2.4-R2-11)", () => {
  afterEach(() => {
    seam.shipped = null;
    seam.reads = 0;
  });

  it("is read once per loaded config, and again for a reloaded one", () => {
    seam.shipped = SHIPPED;
    const before = configWith(SHIPPED, null);
    expect(effortOnMedium(before)).toMatchObject({ bundledTier: true, notify: false });
    expect(seam.reads).toBe(1);
    effortOnMedium(before);
    runAdvisor(before, { agents: [] }, CATALOG);
    expect(seam.reads).toBe(1); // the same config object: not re-read on every check

    // a plugin update replaces tiers.json (medium is dearer now); the config is reloaded and is exactly the new shipped preset
    const raw = JSON.parse(SHIPPED) as { presets: Record<string, Record<string, { costRatio?: number }>> };
    raw.presets.anthropic!.medium!.costRatio = 6;
    seam.shipped = JSON.stringify(raw);
    const reloaded = configWith(seam.shipped, null);
    expect(effortOnMedium(reloaded)).toMatchObject({ bundledTier: true, notify: false }); // a stale copy would call the tier "modified" and notify
    expect(seam.reads).toBe(2);

    // and a tier the user really changed (an override over the NEW file) is still told apart
    const overridden = configWith(seam.shipped, 7);
    expect(effortOnMedium(overridden)).toMatchObject({ bundledTier: false, notify: true });
  });

  it("an unreadable shipped file is reported once per config, and every tier then counts as the user's own", () => {
    seam.shipped = "{not json";
    const cfg = configWith(SHIPPED, null);
    const errors: string[] = [];
    const logger = { warn: (message: string) => errors.push(message) };
    expect(runAdvisor(cfg, { agents: [] }, CATALOG, logger).find((f) => f.id === "variant-effort" && f.subject === "medium")).toMatchObject({ bundledTier: false, notify: true });
    runAdvisor(cfg, { agents: [] }, CATALOG, logger);
    expect(errors.filter((message) => message.includes("bundled-preset"))).toHaveLength(1);
  });
});
