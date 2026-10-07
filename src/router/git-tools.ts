import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { tool } from "@opencode-ai/plugin";

export const GIT_OPERATIONS = ["status", "log", "diff", "show", "blame", "ls_files"] as const;
export type GitOperation = typeof GIT_OPERATIONS[number];
export const GIT_TOOL_NAMES = GIT_OPERATIONS.map(name => `router_git_${name}`);
export interface GitInput { path?: string; ref?: string; limit?: number; mode?: "patch" | "stat" | "name-only" | "cached" }
const MAX_BYTES = 64 * 1024;

export function validateRef(ref: string): string {
  if (!ref || ref.length > 200 || ref.startsWith("-") || !/^[A-Za-z0-9._/@{}~^:-]+$/.test(ref)) {
    throw new Error("Invalid git ref: use at most 200 ref characters, never an option");
  }
  return ref;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

/** Literal repo-relative paths only. Check existing ancestors too (symlinks/junctions). */
export function validatePath(root: string, path: string): string {
  if (!path || path.length > 4096 || path.startsWith("-") || /[\x00-\x1f:]/.test(path)
    || isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid git path: expected a relative path inside the repository");
  }
  const normalized = path.replaceAll("\\", "/");
  const absolute = resolve(root, normalized);
  if (!inside(root, absolute)) throw new Error("Git path escapes repository");
  let ancestor = absolute;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!inside(realpathSync(root), realpathSync(ancestor))) throw new Error("Git path symlink escapes repository");
  return normalized;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  // Inherited GIT_CONFIG_COUNT/KEY/VALUE, GIT_DIR, tracing, helpers and alternate
  // object directories must not redirect inspection or re-enable executable config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", GIT_NO_LAZY_FETCH: "1" };
}

export function hardeningArgs(): string[] {
  return ["--no-optional-locks", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.allow=never",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "color.ui=false"];
}

export function gitArgv(operation: GitOperation, input: GitInput, root: string): string[] {
  if (!GIT_OPERATIONS.includes(operation)) throw new Error("Invalid git operation");
  const ref = input.ref === undefined ? undefined : validateRef(input.ref);
  const path = input.path === undefined ? undefined : validatePath(root, input.path);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw new Error("Git log limit must be 1..50");
  if (input.mode !== undefined && !["patch", "stat", "name-only", "cached"].includes(input.mode)) throw new Error("Invalid git diff mode");
  const args = hardeningArgs();
  switch (operation) {
    case "status": args.push("status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"); break;
    case "log": args.push("log", "--no-ext-diff", "--no-textconv", `--max-count=${input.limit ?? 20}`, "--format=medium", ...(ref ? [ref] : [])); break;
    case "diff": args.push("diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short",
      ...(input.mode && input.mode !== "patch" ? [`--${input.mode}`] : []), ...(ref ? [ref] : [])); break;
    case "show": args.push("show", "--no-ext-diff", "--no-textconv", "--format=medium", "--submodule=short", ref ?? "HEAD"); break;
    case "blame":
      if (!path) throw new Error("Git blame requires path");
      args.push("blame", "--no-textconv", ...(ref ? [ref] : [])); break;
    case "ls_files": args.push("ls-files", "--cached"); break;
  }
  return [...args, "--", ...(path ? [path] : [])];
}

/** Resolve an actual executable, never git.cmd/git.bat or a cwd search. */
export function gitExecutable(): string {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, process.platform === "win32" ? "git.exe" : "git");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("Git executable not found on absolute PATH entries");
}

export function stripUrlUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1")
    .replace(/\b[^\s/@:]+@([A-Za-z0-9.-]+:[^\s]+)/g, "$1");
}

async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    return;
  }
  await new Promise<void>((done) => {
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" });
    killer.once("error", () => done());
    killer.once("close", () => done());
  });
}

/** Internal runner; executable/argv/bounds are never exposed as tool input. */
export async function runBoundedProcess(executable: string, args: string[], cwd: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  if (options.signal?.aborted) throw new Error("Git inspection aborted");
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env: gitEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const max = options.maxBytes ?? MAX_BYTES;
    let bytes = 0;
    let truncated = false;
    let failure: string | undefined;
    let killing: Promise<void> | undefined;
    const stop = () => { if (child.pid && !killing) killing = killTree(child.pid); };
    const abort = () => { failure = "Git inspection aborted"; stop(); };
    const timer = setTimeout(() => { failure = "Git inspection timed out"; stop(); }, options.timeoutMs ?? 15_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, max - bytes));
      if (kept.length) chunks.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) { truncated = true; stop(); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", async code => {
      cleanup(); await killing;
      if (failure) { reject(new Error(failure)); return; }
      let text = Buffer.concat(chunks).toString("utf8");
      // A truncated URL might end before its @. Drop the incomplete final token
      // BEFORE redacting, so a byte boundary cannot expose partial credentials.
      if (truncated) text = text.replace(/\S+$/, "");
      text = stripUrlUserinfo(text);
      if (truncated) { resolveResult(`${text}\n[truncated: output exceeds ${max} bytes]`); return; }
      if (code !== 0) { reject(new Error(`Git inspection failed (${code}): ${text}`)); return; }
      resolveResult(text);
    });
  });
}

export async function inspectGit(operation: GitOperation, input: GitInput, directory: string, signal?: AbortSignal): Promise<string> {
  const executable = gitExecutable();
  const root = (await runBoundedProcess(executable, [...hardeningArgs(), "rev-parse", "--show-toplevel"], directory, { signal })).trim();
  if (!root || !isAbsolute(root) || !existsSync(root)) throw new Error("Cannot resolve repository toplevel");
  return runBoundedProcess(executable, gitArgv(operation, input, root), root, { signal });
}

export function gitTools() {
  const inputSchema = tool.schema.object({
    path: tool.schema.string().optional(), ref: tool.schema.string().optional(),
    limit: tool.schema.number().int().min(1).max(50).optional(),
    mode: tool.schema.enum(["patch", "stat", "name-only", "cached"]).optional(),
  }).strict();
  return Object.fromEntries(GIT_OPERATIONS.map(operation => [`router_git_${operation}`, tool({
    description: `Read-only git ${operation.replaceAll("_", "-")} in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.`,
    args: {
      path: tool.schema.string().optional().describe("Literal repository-relative path; required for blame"),
      ...(operation === "log" || operation === "diff" || operation === "show" || operation === "blame"
        ? { ref: tool.schema.string().optional().describe("Ref or diff range, at most 200 characters; never an option") } : {}),
      ...(operation === "log" ? { limit: tool.schema.number().int().min(1).max(50).optional() } : {}),
      ...(operation === "diff" ? { mode: tool.schema.enum(["patch", "stat", "name-only", "cached"]).optional() } : {}),
    },
    async execute(input, context) { return inspectGit(operation, inputSchema.parse(input), context.directory, context.abort); },
  })]));
}
