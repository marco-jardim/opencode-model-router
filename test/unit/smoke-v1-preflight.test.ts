// QA-3.2-R2-2: `npm run smoke:v1` fails clearly when `opencode` on PATH is not OpenCode 1.x. The script is plain ESM in scripts/ (no types), so it is
// loaded dynamically and typed here.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = path.resolve(__dirname, "../../scripts/smoke-v1-preflight.mjs");

interface Verdict { ok: boolean; major: number | null; text: string; message: string }
async function load(): Promise<{ classifyOpencodeVersion(output: unknown): Verdict }> {
  return await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href);
}

describe("smoke:v1 preflight", () => {
  it("accepts what OpenCode 1.x prints", async () => {
    const { classifyOpencodeVersion } = await load();
    expect(classifyOpencodeVersion("1.18.34\n")).toMatchObject({ ok: true, major: 1, text: "1.18.34" });
    expect(classifyOpencodeVersion("opencode v1.2.0")).toMatchObject({ ok: true, major: 1 });
    expect(classifyOpencodeVersion("v1.0")).toMatchObject({ ok: true, major: 1 });
  });

  it("rejects OpenCode 2, other majors and text that is not a version, and says which", async () => {
    const { classifyOpencodeVersion } = await load();
    const v2 = classifyOpencodeVersion("opencode v2.0.22\n");
    expect(v2).toMatchObject({ ok: false, major: 2 });
    expect(v2.message).toContain("needs OpenCode 1.x");
    expect(v2.message).toContain("2.x");
    expect(classifyOpencodeVersion("10.1.0")).toMatchObject({ ok: false, major: 10 }); // not a prefix match on "1"
    for (const text of ["", "command not found", undefined, null]) {
      const verdict = classifyOpencodeVersion(text);
      expect(verdict.ok).toBe(false);
      expect(verdict.major).toBeNull();
      expect(verdict.message).toContain("not a version number");
    }
  });

  it("exits 1 with a message that says what to change when there is no opencode on PATH", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "omr-preflight-"));
    try {
      const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...process.env, PATH: empty, Path: empty }, timeout: 30_000, windowsHide: true });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("smoke:v1 preflight failed");
      expect(run.stderr).toContain("no `opencode` executable was found on PATH");
      expect(run.stderr).toContain("first on PATH");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
