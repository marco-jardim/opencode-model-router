// D:\git\opencode-model-router\scripts\routing-stats.ts — `npm run routing:stats -- [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]`
// Plain Node (type stripping on by default: Node >= 22.18 / 23.6). No tsx, no build step.
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

// src/ uses extensionless relative imports (moduleResolution "Bundler"); Node's ESM resolver adds no
// extension, so a relative specifier that fails is retried as "<spec>.ts", then "<spec>/index.ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || /\.[cm]?[jt]s$/.test(specifier) || (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT")) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          continue; // next candidate
        }
      }
      throw error;
    }
  },
});

const outcomes = await import("../src/routing/outcomes/index");
const deps = outcomes.nodePersistDeps({ warn() {} }); // the CLI reports through runStatsCli, not the logger
process.exitCode = await outcomes.runStatsCli(process.argv.slice(2), {
  defaultDir: outcomes.resolveOutcomesDir(null, { tmpdir: tmpdir(), homedir: homedir() }),
  open: (dir) => outcomes.createPersister(resolve(dir), deps),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});

export {};
