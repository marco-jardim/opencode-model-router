import { describe, it, expect } from "vitest";
import { fingerprintToolCall } from "../../src/guard/fingerprint";

describe("fingerprintToolCall", () => {
  it("read: uses file_path, falls back to filePath, then empty", () => {
    expect(fingerprintToolCall("read", { file_path: "a.ts" })).toBe("read:a.ts");
    expect(fingerprintToolCall("read", { filePath: "b.ts" })).toBe("read:b.ts");
    expect(fingerprintToolCall("read", {})).toBe("read:");
  });

  it("grep: uses pattern + path, falls back to glob, then empty", () => {
    expect(fingerprintToolCall("grep", { pattern: "x", path: "src" })).toBe("grep:x:src");
    expect(fingerprintToolCall("grep", { pattern: "x", glob: "*.ts" })).toBe("grep:x:*.ts");
    expect(fingerprintToolCall("grep", {})).toBe("grep::");
  });

  it("glob: uses pattern + path", () => {
    expect(fingerprintToolCall("glob", { pattern: "**/*.ts", path: "src" })).toBe("glob:**/*.ts:src");
    expect(fingerprintToolCall("glob", { pattern: "**/*.ts" })).toBe("glob:**/*.ts:");
  });

  it("ls: uses path", () => {
    expect(fingerprintToolCall("ls", { path: "src" })).toBe("ls:src");
    expect(fingerprintToolCall("ls", {})).toBe("ls:");
  });

  it("unknown tool: serializes args (sliced to 120 chars)", () => {
    expect(fingerprintToolCall("bash", { command: "echo hi" })).toBe('bash:{"command":"echo hi"}');
  });

  it("unknown tool: truncates long serialized args at 120 chars", () => {
    const long = "x".repeat(300);
    const fp = fingerprintToolCall("bash", { command: long });
    expect(fp.startsWith("bash:")).toBe(true);
    // "bash:" prefix (5) + 120 chars of JSON
    expect(fp.length).toBe(5 + 120);
  });

  it("handles null/undefined args without throwing", () => {
    expect(fingerprintToolCall("read", undefined)).toBe("read:");
    expect(fingerprintToolCall("ls", null)).toBe("ls:");
  });
});
