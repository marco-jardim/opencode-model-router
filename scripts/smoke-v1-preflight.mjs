#!/usr/bin/env node
/**
 * Preflight of `npm run smoke:v1` (QA-3.2-R2-2).
 *
 * The v1 smoke suite (`smoke:keyless`) spawns plain `opencode` from PATH and expects OpenCode 1.x there. On a machine where the OpenCode 2
 * shim comes first on PATH the suite does not fail clearly: it runs the v1 tests against a v2 host. This script fails FIRST, with a message
 * that says what to change. It runs `opencode --version` exactly like the suite resolves the binary (no shell, PATH lookup) and touches no
 * smoke file.
 *
 * Exit codes: 0 = OpenCode 1.x is first on PATH, 1 = anything else (not found, not 1.x, unreadable version).
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Classifies the text `opencode --version` printed: v1 prints `1.18.34`, v2 prints `opencode v2.0.22`.
 * @param {unknown} output
 * @returns {{ ok: boolean, major: number | null, text: string, message: string }}
 */
export function classifyOpencodeVersion(output) {
  const text = String(output ?? "").trim();
  const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text);
  if (match === null) {
    return { ok: false, major: null, text, message: `\`opencode --version\` printed ${JSON.stringify(text)}, which is not a version number` };
  }
  const major = Number(match[1]);
  if (major !== 1) {
    return { ok: false, major, text, message: `\`opencode --version\` printed ${JSON.stringify(text)}: the v1 suite needs OpenCode 1.x, and this is ${major}.x` };
  }
  return { ok: true, major, text, message: `OpenCode ${text} is first on PATH` };
}

const HINT = "smoke:v1 runs the existing v1 suite (smoke:keyless) against the `opencode` that comes FIRST on PATH. Put the directory of an OpenCode 1.x executable first on PATH for this command (not the OpenCode 2 shim), then run it again. The v2 smoke is `npm run smoke:v2`.";

/** Runs the check against `opencode` on PATH. */
export function preflight() {
  const run = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (run.error !== undefined) {
    const reason = run.error.code === "ENOENT" ? "no `opencode` executable was found on PATH" : `\`opencode --version\` could not run (${run.error.message})`;
    return { ok: false, message: `smoke:v1 preflight failed: ${reason}. ${HINT}` };
  }
  const verdict = classifyOpencodeVersion(run.stdout);
  if (!verdict.ok) return { ok: false, message: `smoke:v1 preflight failed: ${verdict.message}. ${HINT}` };
  return { ok: true, message: `smoke:v1 preflight: ${verdict.message}` };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = preflight();
  (result.ok ? console.log : console.error)(result.message);
  process.exit(result.ok ? 0 : 1);
}
