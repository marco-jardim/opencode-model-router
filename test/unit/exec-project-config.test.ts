import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import config from "../../vitest.config";

describe("G-6 / G-9: process lifecycle and heartbeat test isolation", () => {
  it("keeps both serial files in the default run exactly once, in a later single-fork project with the same home guard", () => {
    expect(config.test?.projects).toEqual([
      expect.objectContaining({ test: expect.objectContaining({
        name: "default", include: ["test/**/*.test.ts"],
        exclude: expect.arrayContaining(["test/smoke/**", "test/unit/exec.test.ts", "test/unit/executor-integrate-queue-heartbeat.test.ts"]),
        setupFiles: ["test/setup/home-guard.ts"], sequence: { groupOrder: 0 },
      }) }),
      expect.objectContaining({ test: expect.objectContaining({
        name: "exec-serial", include: ["test/unit/exec.test.ts", "test/unit/executor-integrate-queue-heartbeat.test.ts"], pool: "forks", maxWorkers: 1,
        exclude: ["test/smoke/**", "node_modules/**", "dist/**", "tmp/**"],
        fileParallelism: false, setupFiles: ["test/setup/home-guard.ts"], sequence: { groupOrder: 1 },
      }) }),
    ]);
    expect(config.test?.coverage).toMatchObject({
      provider: "v8", include: ["src/**/*.ts"],
    });
    expect(config.test?.globalSetup).toEqual(["test/setup/global-guard.ts"]);
  });

  it("moves the heartbeat case out of the parallel file without duplicating or retiming it; npm test uses the default run", () => {
    const original = readFileSync(new URL("./executor-integrate-queue.test.ts", import.meta.url), "utf8");
    const moved = readFileSync(new URL("./executor-integrate-queue-heartbeat.test.ts", import.meta.url), "utf8");
    const name = 'it("a re-armed heartbeat keeps beating on every period", async () => {';
    expect(original).not.toContain(name);
    expect(moved.split(name)).toHaveLength(2);
    expect(moved).toContain("vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });");
    expect(moved).toContain("const deadline = Date.now() + 20_000;");
    const pkg: { scripts: { test: string } } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
  });
});
