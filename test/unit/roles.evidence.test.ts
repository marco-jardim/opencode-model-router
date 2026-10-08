/**
 * #84 P3.1 (QA-P31-1-1): the committed real-host evidence of the roles smoke (docs/qa/role-tier/evidence/*.json) carries no user
 * path and no credential — also not inside a base64 `CHILD_SCRIPT64=` run (the scripted steps of a child), which a plain grep cannot
 * see: every such run is decoded and checked too. And the smoke's own `save()` decoder turns every script into redacted text.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { decodeScriptsForEvidence } from "../smoke/helpers/routing-host";
import { REAL_HOME, REAL_TMPDIR_ENV } from "../setup/home-guard";
import { SHIPPED_ROLE_SPECS } from "../../src/router/roles";

const DIR = join(process.cwd(), "docs", "qa", "role-tier", "evidence");
const FILES = readdirSync(DIR).filter((name) => name.endsWith(".json")).sort();
const SCRIPT64 = /CHILD_SCRIPT64=([A-Za-z0-9+/=]+)/g;
/** A Windows profile path in any escaping (`C:\Users\x`, `C:\\Users\\x`, `C:/Users/x`) or a POSIX home, unless a placeholder follows. */
const USER_PATH = /[A-Za-z]:(?:\\+|\/+)Users(?:\\+|\/+)(?!<)|(?:^|[^A-Za-z0-9_.-])\/(?:home|Users)\/(?!<)/i;
const CREDENTIAL = /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bBasic\s+[A-Za-z0-9+/=]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}/;
/** A directory in the spellings a JSON file can hold it: raw, forward slashes, escaped once or twice. */
const spellings = (dir: string): string[] => [dir, dir.replaceAll("\\", "/"), dir.replaceAll("\\", "\\\\"), dir.replaceAll("\\", "\\\\\\\\")];
const realpathOr = (dir: string): string => { try { return realpathSync.native(dir); } catch { return dir; } };
/**
 * QA-P31 round 2 N3: the REAL home. Unit tests see a private `os.homedir()` (test/setup/home-guard.ts), so the user's home comes
 * from the guard's capture (`REAL_HOME`), its real path, and the home prefix of the real temp dir (its 8.3 short spelling on
 * Windows, e.g. `C:\Users\ABCDEF~1`); the mocked `homedir()` is kept too (the decoder test writes under it).
 */
const shortHome = /^(.*?[\\/]Users[\\/][^\\/]+)/i.exec(process.env[REAL_TMPDIR_ENV] ?? "")?.[1];
const HOME_FORMS = [...new Set([REAL_HOME, realpathOr(REAL_HOME), ...(shortHome ? [shortHome] : []), homedir()].filter((dir) => dir !== "").flatMap(spellings))]
  .filter((form) => form.length > 3);
/**
 * The user name. A name that is also a word of the evidence's own vocabulary (a role, a tier: CI runs as `runner`) is checked only
 * as a path segment (after `\` or `/`); any other name (3+ characters) anywhere, case-insensitively.
 */
const USER_NAME = userInfo().username;
const VOCABULARY = new Set([...SHIPPED_ROLE_SPECS.map((spec) => spec.agent), "fast", "medium", "heavy", "build", "root", "user", "test", "admin"]);
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const USER_NAME_RE = USER_NAME.length < 3 ? null
  : VOCABULARY.has(USER_NAME.toLowerCase()) ? new RegExp(`[\\\\/]${escapeRe(USER_NAME)}(?=[\\\\/"\\s]|$)`, "i")
    : new RegExp(escapeRe(USER_NAME), "i");

/** The file text plus the decoded text of every base64 script in it. */
function texts(name: string): { raw: string; decoded: string[] } {
  const raw = readFileSync(join(DIR, name), "utf8");
  const decoded = [...raw.matchAll(SCRIPT64)].map((match) => Buffer.from(match[1]!, "base64").toString("utf8"));
  return { raw, decoded };
}

describe("committed roles evidence (docs/qa/role-tier/evidence)", () => {
  it("holds the seven JSON files of the real-host smoke, each valid JSON", () => {
    expect(FILES).toEqual(["I2.json", "I3-I4.json", "I5-I9.json", "budget-signals.json", "exploration.json", "ladder.json", "roots-handoffs.json"]);
    for (const name of FILES) expect(() => JSON.parse(readFileSync(join(DIR, name), "utf8")), name).not.toThrow();
  });

  it.each(FILES)("%s: no user path or credential, neither in the text nor in any decoded CHILD_SCRIPT64 run", (name) => {
    const { raw, decoded } = texts(name);
    for (const [where, text] of [["text", raw], ...decoded.map((d, i) => [`decoded script ${i}`, d] as const)] as const) {
      expect(USER_PATH.exec(text)?.[0], `${name} ${where}: user path`).toBeUndefined();
      expect(CREDENTIAL.exec(text)?.[0], `${name} ${where}: credential`).toBeUndefined();
      for (const form of HOME_FORMS) expect(text.toLowerCase().includes(form.toLowerCase()), `${name} ${where}: home directory`).toBe(false);
      if (USER_NAME_RE !== null) expect(USER_NAME_RE.exec(text)?.[0], `${name} ${where}: user name`).toBeUndefined();
    }
  });

  it("checks the real home and the user name (not the test's private home)", () => {
    expect(REAL_HOME).not.toBe("");
    expect(HOME_FORMS.some((form) => form.toLowerCase() === REAL_HOME.toLowerCase())).toBe(true);
    expect(USER_NAME.length).toBeGreaterThan(0);
  });
});

describe("the smoke's evidence decoder (decodeScriptsForEvidence)", () => {
  it("replaces every CHILD_SCRIPT64 run by its decoded, redacted, JSON-escaped text, at any depth", () => {
    const secret = join(homedir(), "work", "secret.txt");
    const script = Buffer.from(JSON.stringify({ steps: [{ tool: "read", input: { path: secret } }], final: "DONE" }), "utf8").toString("base64");
    const message = JSON.stringify({ text: `TASK: x\nCHILD_SCRIPT64=${script}\nOMR_NONCE=n` });
    const out = decodeScriptsForEvidence({ firstUser: message, nested: [{ text: `CHILD_SCRIPT64=${script}` }] }) as { firstUser: string; nested: Array<{ text: string }> };
    for (const text of [out.firstUser, out.nested[0]!.text]) {
      expect(text).toContain("CHILD_SCRIPT64(decoded)=");
      expect(text).not.toMatch(SCRIPT64);
      expect(text).toContain("<home>");
      for (const form of HOME_FORMS) expect(text.toLowerCase().includes(form.toLowerCase()), text).toBe(false);
    }
    // the JSON-encoded message stays parseable, and the script's steps are readable in it
    const parsed = JSON.parse(out.firstUser) as { text: string };
    expect(parsed.text).toContain('"tool":"read"');
    expect(parsed.text).toContain("OMR_NONCE=n");
  });
});
