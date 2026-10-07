import { describe, expect, it, vi } from "vitest";
import { withLock } from "../../src/routing/file-lock";
import { nodePersistFs } from "../../src/routing/outcomes/persist";

describe("file lock", () => {
  it("R2-11: a failed put-back of a freshly replaced lock warns and stays busy", async () => {
    const run = vi.fn(async () => 42);
    const logger = { warn: vi.fn() };
    const rename = vi.fn(async (_from: string, to: string) => {
      if (to === "lock") throw new Error("EPERM");
    });
    const fs = {
      ...nodePersistFs(),
      mkdirp: vi.fn(async () => undefined),
      createExclusive: vi.fn(async () => false),
      stat: vi.fn(async (path: string) => ({ size: 0, mtimeMs: path === "lock" ? 0 : 40_000 })),
      rename,
    };
    expect(await withLock(fs, "dir", "lock", () => 40_000, logger, run)).toEqual({ status: "busy" });
    expect(run).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("[router] could not put back a live file lock", { error: "Error: EPERM" });
  });
});
