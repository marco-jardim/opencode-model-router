import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readState, writeState, statePath } from "../../src/router/config";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = join(
    tmpdir(),
    `oc-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
});

describe("writeState / readState — atomic file operations", () => {
  it("(i) writeState then readState round-trips activePreset", () => {
    writeState({ activePreset: "openai" });
    expect(readState().activePreset).toBe("openai");
  });

  it("(ii) merge: subsequent writeState preserves earlier keys", () => {
    writeState({ activePreset: "openai" });
    writeState({ enforcementMode: "enforced" });
    const s = readState();
    expect(s.activePreset).toBe("openai");
    expect(s.enforcementMode).toBe("enforced");
  });

  it("(iii) state file is valid JSON ending in newline", () => {
    writeState({ activePreset: "anthropic" });
    const content = readFileSync(statePath(), "utf-8");
    // Throws if invalid JSON
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.activePreset).toBe("anthropic");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("(iv) no leftover .tmp-* files after writeState", () => {
    writeState({ activePreset: "openai" });
    const dir = dirname(statePath());
    const files = readdirSync(dir);
    const tmps = files.filter((f) => f.includes(".tmp-"));
    expect(tmps).toHaveLength(0);
  });

  it("(v) enforcementMode persists round-trip", () => {
    writeState({ enforcementMode: "advisory" });
    expect(readState().enforcementMode).toBe("advisory");
  });

  it("readState returns {} when no state file exists", () => {
    // tmpHome is fresh — no state file written yet
    expect(readState()).toEqual({});
  });
});
