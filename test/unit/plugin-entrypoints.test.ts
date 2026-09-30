import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as legacyModule from "../../src/index";

// OpenCode v2's actual module contract (not the old { server } v1 wrapper):
// anomalyco/opencode@74dbc509/packages/core/src/plugin/module.ts.
const callable = Schema.declare<(...args: any[]) => unknown>(
  (input): input is (...args: any[]) => unknown => typeof input === "function",
);
const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({ id: Schema.String, effect: callable }),
    Schema.Struct({ id: Schema.String, setup: callable }),
  ]),
});

describe("OpenCode plugin entrypoints (#40)", () => {
  it("reproduces v2 rejecting the v1 function default export", () => {
    expect(() => Schema.decodeUnknownSync(Module)(legacyModule)).toThrow(/Expected object/);
    expect(() => Schema.decodeUnknownSync(Module)(legacyModule)).toThrow(/default/);
  });

  it("keeps the v1 entrypoint's single callable export for old loaders", () => {
    expect(Object.keys(legacyModule)).toEqual(["default"]);
    expect(typeof legacyModule.default).toBe("function");
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.main).toBe("./src/index.ts");
  });

  it("provides an object definition at the server entrypoint v2 resolves first", async () => {
    const entry = resolve("server.ts");
    // Before the fix v2 can only receive the legacy default. Keep the fallback
    // so the regression fails with the reported schema error on the base tree.
    const mod = existsSync(entry) ? await import(entry) : legacyModule;
    const plugin = Schema.decodeUnknownSync(Module)(mod).default;
    expect(plugin.id).toBe("opencode-model-router");
    expect("setup" in plugin && typeof plugin.setup).toBe("function");
    expect(mod.default.server).toBe(legacyModule.default);
  });
});
