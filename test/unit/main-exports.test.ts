import { describe, expect, it } from "vitest";
import * as main from "../../src/index";

describe("package main (src/index.ts)", () => {
  // Old v1 loaders invoke every exported value of `main`, so a named export (even a Symbol-valued constant) breaks them.
  it("exports only `default`, and it is the plugin function", () => {
    expect(Object.keys(main)).toEqual(["default"]);
    expect(typeof main.default).toBe("function");
  });
});
