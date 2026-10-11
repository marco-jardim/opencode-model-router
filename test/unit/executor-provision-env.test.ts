import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applySlotEnv, registerSlot, slotEnvFor, unregisterSlot } from "../../src/executor/slots/env";

describe("slot environment: VIRTUAL_ENV (QA-2.4-18)", () => {
  let root = "";
  let nodeSlot = "";
  let pySlot = "";

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-slot-env-")));
    nodeSlot = join(root, "node-slot");
    pySlot = join(root, "py-slot");
    mkdirSync(nodeSlot);
    mkdirSync(pySlot);
    registerSlot({ root: nodeSlot, managers: ["pnpm"] });
    registerSlot({ root: pySlot, managers: ["pip", "pnpm"] });
  });
  afterAll(() => {
    unregisterSlot(nodeSlot);
    unregisterSlot(pySlot);
    rmSync(root, { recursive: true, force: true });
  });

  const inherited = (): NodeJS.ProcessEnv => ({ PATH: process.platform === "win32" ? "C:\\tools" : "/usr/bin", VIRTUAL_ENV: "/elsewhere/.venv" });

  it("a Node-only slot drops an inherited VIRTUAL_ENV and prepends only node_modules/.bin", () => {
    const slot = slotEnvFor(nodeSlot);
    expect(slot?.prependPath).toEqual([join(nodeSlot, "node_modules", ".bin")]);
    const env = applySlotEnv(inherited(), slot, process.platform);
    expect(env["VIRTUAL_ENV"]).toBeUndefined();
    expect(env["PATH"]?.startsWith(join(nodeSlot, "node_modules", ".bin"))).toBe(true);
  });

  it("a slot with a Python manager sets VIRTUAL_ENV to its own .venv and prepends the venv directory first", () => {
    const slot = slotEnvFor(pySlot);
    const env = applySlotEnv(inherited(), slot, process.platform);
    expect(env["VIRTUAL_ENV"]).toBe(join(pySlot, ".venv"));
    expect(env["PATH"]?.startsWith(join(pySlot, ".venv", process.platform === "win32" ? "Scripts" : "bin"))).toBe(true);
    expect(env["PATH"]).toContain(join(pySlot, "node_modules", ".bin"));
  });
});
