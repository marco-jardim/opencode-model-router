import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic fixture access for the plan-compiler tests (memo 2.3.1 section 10): every read goes through
// `readFixture`, which only resolves names inside this directory.

export const FIXTURES_DIR: string = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  const full = resolve(FIXTURES_DIR, name);
  const rel = relative(FIXTURES_DIR, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`fixture path escapes the fixtures directory: ${name}`);
  }
  return full;
}

/** Exact text of a fixture (no newline translation). */
export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

export function readFixtureBytes(name: string): Buffer {
  return readFileSync(fixturePath(name));
}

export function sha256Of(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface ManifestEntry { name: string; source: string; commit: string; sha256: string; bytes: number }

export function readManifest(): ManifestEntry[] {
  return JSON.parse(readFixture("MANIFEST.json")) as ManifestEntry[];
}

export interface RepoViewFixture {
  toplevel: string;
  worktrees: string[];
  files: string[];
  caseInsensitive: boolean;
  commonDir: string;
  head: string;
  branch: string;
}

export function readRepoViewFixture(): RepoViewFixture {
  return JSON.parse(readFixture("repo-view.json")) as RepoViewFixture;
}

/** Git stub answering the commands `loadRepoView` and the compiler issue, from `repo-view.json`. */
export function stubGit(v: RepoViewFixture): { run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> } {
  return {
    async run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
      const a = args.join(" ");
      if (a === "rev-parse --show-toplevel") return { code: 0, stdout: `${v.toplevel}\n` };
      if (a === "worktree list --porcelain") {
        return { code: 0, stdout: `${v.worktrees.map((w) => `worktree ${w}\nHEAD ${v.head}\nbranch refs/heads/${v.branch}\n`).join("\n")}` };
      }
      if (a === "ls-files -z") return { code: 0, stdout: `${v.files.join("\0")}\0` };
      if (a === "config core.ignorecase") return { code: 0, stdout: v.caseInsensitive ? "true\n" : "false\n" };
      if (a === "rev-parse --path-format=absolute --git-common-dir") return { code: 0, stdout: `${v.commonDir}\n` };
      if (a === "rev-parse HEAD") return { code: 0, stdout: `${v.head}\n` };
      if (a === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: `${v.branch}\n` };
      return { code: 1, stdout: "" };
    },
  };
}
