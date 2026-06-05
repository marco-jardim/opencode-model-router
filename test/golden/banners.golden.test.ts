import { describe, it, expect } from "vitest";
import {
  fingerprintToolCall,
  buildCapBanner,
  type Cap,
} from "../../src/index";

describe("fingerprintToolCall golden", () => {
  it("read with file_path", () => {
    expect(
      fingerprintToolCall("read", { file_path: "src/index.ts" }),
    ).toMatchSnapshot();
  });

  it("read with filePath", () => {
    expect(
      fingerprintToolCall("read", { filePath: "src/index.ts" }),
    ).toMatchSnapshot();
  });

  it("grep with pattern and path", () => {
    expect(
      fingerprintToolCall("grep", { pattern: "function foo", path: "src/" }),
    ).toMatchSnapshot();
  });

  it("grep with pattern and glob", () => {
    expect(
      fingerprintToolCall("grep", { pattern: "export", glob: "**/*.ts" }),
    ).toMatchSnapshot();
  });

  it("glob with pattern and path", () => {
    expect(
      fingerprintToolCall("glob", { pattern: "**/*.ts", path: "src/" }),
    ).toMatchSnapshot();
  });

  it("ls with path", () => {
    expect(fingerprintToolCall("ls", { path: "src/" })).toMatchSnapshot();
  });

  it("unknown tool bash with args", () => {
    expect(
      fingerprintToolCall("bash", { command: "npm test" }),
    ).toMatchSnapshot();
  });
});

describe("buildCapBanner golden", () => {
  it("under cap no warning", () => {
    const state = {
      tierName: "fast",
      cap: 8 as Cap,
      calls: 3,
      seen: new Map<string, number>(),
    };
    expect(buildCapBanner(state, false, undefined, "read")).toMatchSnapshot();
  });

  it("cap warning 2 remaining", () => {
    const state = {
      tierName: "fast",
      cap: 8 as Cap,
      calls: 6,
      seen: new Map<string, number>(),
    };
    expect(buildCapBanner(state, false, undefined, "grep")).toMatchSnapshot();
  });

  it("cap reached", () => {
    const state = {
      tierName: "medium",
      cap: 5 as Cap,
      calls: 5,
      seen: new Map<string, number>(),
    };
    expect(buildCapBanner(state, false, undefined, "glob")).toMatchSnapshot();
  });

  it("redundant call", () => {
    const state = {
      tierName: "fast",
      cap: 8 as Cap,
      calls: 4,
      seen: new Map<string, number>(),
    };
    expect(buildCapBanner(state, true, 2, "read")).toMatchSnapshot();
  });

  it("cap none unlimited", () => {
    const state = {
      tierName: "custom",
      cap: "none" as Cap,
      calls: 10,
      seen: new Map<string, number>(),
    };
    expect(buildCapBanner(state, false, undefined, "grep")).toMatchSnapshot();
  });
});
