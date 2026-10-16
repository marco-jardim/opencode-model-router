import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { processIdentity, processToken } from "../../src/executor/process-identity.js";

describe("executor process identity", () => {
  it("uses the existing v2 global token slot and the actual pid and hostname", () => {
    const self = processIdentity();
    expect(self).toEqual({ pid: process.pid, hostname: hostname(), token: processToken() });
    expect(self.token).toBe(Reflect.get(globalThis, Symbol.for("opencode-model-router.v2.process-token")));
    expect(self.token).toMatch(/^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
    expect(processIdentity()).toEqual(self);
  });

  it("module reloads share the same process identity through Symbol.for", async () => {
    const self = processIdentity();
    vi.resetModules();
    const copy = await import("../../src/executor/process-identity.js");
    expect(copy.processIdentity()).toEqual(self);
    expect(copy.processToken()).toBe(self.token);
  });
});
