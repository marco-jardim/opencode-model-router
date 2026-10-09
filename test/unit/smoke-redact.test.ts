// QA-G-C-11: the smoke evidence redactor (test/smoke/helpers/routing-host.ts) derives the user's 8.3 short home from the REAL temp
// directory (`<home>\AppData\Local\Temp`). The smoke temp guard (test/setup/smoke-tmp-guard.ts) points TEMP one folder deeper and
// records the real one in OMR_SMOKE_REAL_TMPDIR, so three folders above os.tmpdir() is `<home>\AppData`, not the home. The helper
// only builds strings, so it is importable here without a host.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactText } from "../smoke/helpers/routing-host";

const saved = process.env.OMR_SMOKE_REAL_TMPDIR;

afterEach(() => {
  if (saved === undefined) delete process.env.OMR_SMOKE_REAL_TMPDIR;
  else process.env.OMR_SMOKE_REAL_TMPDIR = saved;
});

describe("smoke evidence redaction (QA-G-C-11)", () => {
  it("takes the short home from the real temp directory the smoke temp guard records, never from the guard's deeper one", () => {
    const shortHome = path.join(path.parse(process.cwd()).root, "Users", "QAUSER~1");
    process.env.OMR_SMOKE_REAL_TMPDIR = path.join(shortHome, "AppData", "Local", "Temp");
    const file = path.join(shortHome, "AppData", "Local", "Temp", "omr-smoke-tmp-1-2", "x.json");
    const out = redactText(`wrote ${file} as QAUSER~1`);
    expect(out).toBe(`wrote ${path.join("<home>", "AppData", "Local", "Temp", "omr-smoke-tmp-1-2", "x.json")} as <user>`);
    expect(out).not.toContain("QAUSER~1");
    // `AppData` (three folders above the guard's temp dir) is a folder name, never taken for the user's name.
    expect(redactText("AppData\\Local")).toBe("AppData\\Local");
  });
});
