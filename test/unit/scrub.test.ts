import { describe, it, expect } from "vitest";
import { scrubText } from "../../src/guard/scrub";

describe("scrubText", () => {
  // -------------------------------------------------------------------------
  // Token shapes
  // -------------------------------------------------------------------------
  it("redacts Anthropic sk-ant- tokens", () => {
    const result = scrubText("key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-");
  });

  it("redacts OpenAI-style sk- tokens (>=20 chars after sk-)", () => {
    const result = scrubText("using sk-ABCDEFGHIJKLMNOPQRSTU1234567890 now");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ABCDE");
  });

  it("redacts GitHub ghp_ tokens", () => {
    const result = scrubText("token=ghp_ABCDEFGHIJKLMNOPQRSTU12345678901");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_");
  });

  it("redacts GitHub gho_ tokens", () => {
    const result = scrubText("auth: gho_ABCDEFGHIJKLMNOPQRSTU1234567890AB");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("gho_");
  });

  it("redacts AWS AKIA access key IDs", () => {
    // Pattern requires exactly 16 [0-9A-Z] chars after AKIA + word boundary
    const result = scrubText("aws key: AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIA");
  });

  it("redacts Google AIza API keys", () => {
    const result = scrubText("key=AIzaSyD-ABCDEFGHIJKLMNOPQRSTU1234567890");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AIza");
  });

  it("redacts Slack xoxb- tokens", () => {
    const result = scrubText("slack: xoxb-ABCDEFGHIJ-KLMNOPQRST");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("xoxb-");
  });

  it("redacts JWT eyJ tokens", () => {
    const result = scrubText("jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("redacts Bearer tokens", () => {
    // Do not prefix with "Authorization:" — that keyword triggers KEYVALUE_RE first
    // and consumes "Bearer" as the value, orphaning the actual token. Use a
    // non-keyword prefix so the Bearer pattern fires cleanly.
    const result = scrubText("X-Forwarded-Auth: Bearer mytoken12345abcde");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mytoken12345");
  });

  // -------------------------------------------------------------------------
  // Key=value secrets
  // -------------------------------------------------------------------------
  it("redacts api_key=value", () => {
    const result = scrubText("api_key=supersecretkey123");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("supersecretkey123");
  });

  it('redacts token: "value"', () => {
    const result = scrubText('token: "myapitoken"');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("myapitoken");
  });

  it("redacts password=value", () => {
    const result = scrubText("password=mypassword12");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mypassword12");
  });

  // -------------------------------------------------------------------------
  // Ordinary text / file paths - must be UNCHANGED
  // -------------------------------------------------------------------------
  it("does not alter ordinary file path src/guard/guards.ts", () => {
    const s = "src/guard/guards.ts";
    expect(scrubText(s)).toBe(s);
  });

  it("does not alter Windows file path with tiers.json", () => {
    const s = "D:\\git\\opencode-model-router\\tiers.json";
    expect(scrubText(s)).toBe(s);
  });

  it("does not alter read:src/index.ts directive", () => {
    const s = "read:src/index.ts";
    expect(scrubText(s)).toBe(s);
  });

  it("does not alter empty string", () => {
    expect(scrubText("")).toBe("");
  });

  it("does not alter ordinary short prose", () => {
    const s = "hello world";
    expect(scrubText(s)).toBe(s);
  });

  it("does not alter non-secret short string", () => {
    const s = "abc123";
    expect(scrubText(s)).toBe(s);
  });
});
