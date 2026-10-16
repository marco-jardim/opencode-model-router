import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

describe("G-6: process lifecycle test isolation", () => {
  it("keeps exec.test.ts in the default run, in a later single-fork project with the same home guard", () => {
    expect(config.test?.projects).toEqual([
      expect.objectContaining({ test: expect.objectContaining({
        name: "default", include: ["test/**/*.test.ts"],
        exclude: expect.arrayContaining(["test/smoke/**", "test/unit/exec.test.ts"]),
        setupFiles: ["test/setup/home-guard.ts"], sequence: { groupOrder: 0 },
      }) }),
      expect.objectContaining({ test: expect.objectContaining({
        name: "exec-serial", include: ["test/unit/exec.test.ts"], pool: "forks", maxWorkers: 1,
        fileParallelism: false, setupFiles: ["test/setup/home-guard.ts"], sequence: { groupOrder: 1 },
      }) }),
    ]);
    expect(config.test?.coverage).toMatchObject({
      provider: "v8", include: ["src/**/*.ts"],
    });
    expect(config.test?.globalSetup).toEqual(["test/setup/global-guard.ts"]);
  });
});
