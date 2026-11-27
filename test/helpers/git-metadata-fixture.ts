/**
 * Repositories on disk for the delegated-agent git metadata guard tests (src/router/git-metadata-guard.ts): a repository with a
 * nested one, a linked worktree of it (`.git` file → `<repo>/.git/worktrees/wt`, common dir `<repo>/.git`), and a linked worktree
 * of a bare repository (common dir `bare.git`, not named `.git`), and a bare repository `proj.git` whose linked worktree lies
 * inside it (`proj.git/main`). Canonical (long-name) paths, so an 8.3 temp directory never
 * reaches the code under test.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitMetadataFixture {
  readonly root: string;
  /** A repository: `.git/` (HEAD, objects, refs, config, hooks), `src/a.ts`, `.gitattributes`, and a nested repository `sub/`. */
  readonly repo: string;
  /** A linked worktree of `repo` (its `.git` is a file). */
  readonly wt: string;
  /** The git directory of `wt`: `<repo>/.git/worktrees/wt`. */
  readonly admin: string;
  /** A bare repository. */
  readonly bare: string;
  /** The git directory of `bwt`: `<bare>/worktrees/bwt`. */
  readonly bareAdmin: string;
  /** A linked worktree of `bare`. */
  readonly bwt: string;
  /** A bare repository whose linked worktree `projMain` lies inside it (`proj.git/main`). */
  readonly proj: string;
  /** The git directory of `projMain`: `<proj>/worktrees/main`. */
  readonly projAdmin: string;
  /** The linked worktree inside `proj`. */
  readonly projMain: string;
  /** Creates a directory link (a junction on win32) at `path` to `target`; false when the platform refuses it. */
  link(target: string, path: string): boolean;
  cleanup(): void;
}

function gitDirectory(dir: string): void {
  mkdirSync(join(dir, "objects"), { recursive: true });
  mkdirSync(join(dir, "refs", "heads"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "config"), "[core]\n");
}

function linkedWorktree(admin: string, worktree: string): void {
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(admin, "commondir"), "../..\n");
  writeFileSync(join(admin, "gitdir"), `${join(worktree, ".git")}\n`);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
  writeFileSync(join(worktree, "a.ts"), "export {};\n");
}

export function gitMetadataFixture(): GitMetadataFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-gitmeta-")));
  const repo = join(root, "repo");
  gitDirectory(join(repo, ".git"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
  writeFileSync(join(repo, ".gitattributes"), "* text=auto\n");
  gitDirectory(join(repo, "sub", ".git"));
  const wt = join(root, "wt");
  const admin = join(repo, ".git", "worktrees", "wt");
  linkedWorktree(admin, wt);
  const bare = join(root, "bare.git");
  gitDirectory(bare);
  const bwt = join(root, "bwt");
  const bareAdmin = join(bare, "worktrees", "bwt");
  linkedWorktree(bareAdmin, bwt);
  const proj = join(root, "proj.git");
  gitDirectory(proj);
  const projAdmin = join(proj, "worktrees", "main");
  const projMain = join(proj, "main");
  linkedWorktree(projAdmin, projMain);
  return {
    root, repo, wt, admin, bare, bareAdmin, bwt, proj, projAdmin, projMain,
    link(target, path) {
      try {
        symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
        return true;
      } catch {
        return false;
      }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** The arguments of a write-class call `tool` that writes `path`, in the legacy (v1) argument shape. */
export function writeCall(tool: string, path: string, other: string): Record<string, unknown> {
  switch (tool) {
    case "patch":
    case "apply_patch":
      return { patchText: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` };
    case "multiedit":
      return { filePath: other, edits: [{ filePath: path, oldString: "a", newString: "b" }] };
    case "write":
      return { filePath: path, content: "x" };
    default:
      return { filePath: path, oldString: "a", newString: "b" };
  }
}

/** The write-class tools of both hosts. */
export const WRITE_TOOLS = ["edit", "write", "patch", "apply_patch", "multiedit"] as const;

/** Paths below a repository that name its git metadata (relative to the repository). */
export const GIT_METADATA_PATHS = [
  ".git/config", ".git/hooks/x", ".GIT/Config", ".git./config", ".git::$DATA", ".git::$INDEX_ALLOCATION/config", ".git:stream",
  ".git", ".git /hooks/post-checkout", "sub/.git/config", "sub/.git/hooks/pre-commit", "src/../.git/config",
] as const;

/** Paths below a repository that are ordinary files (relative to the repository). */
export const ORDINARY_PATHS = [
  "src/a.ts", ".gitattributes", ".gitignore", ".gitmodules", ".github/workflows/ci.yml", "src/new/dir/b.ts", "docs/git/notes.md", "x.git/y",
] as const;
