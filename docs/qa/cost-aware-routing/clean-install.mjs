// Run after npm install <tarball> in an otherwise empty temporary project:
// node <repo>/docs/qa/cost-aware-routing/clean-install.mjs <temporary-project>
// No live host, config, store or provider is contacted. All home/temp paths are private.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.argv[2], "Supply the clean temporary project, not the repository");
const project = resolve(process.argv[2]);
const home = join(project, "isolated-home");
const temp = join(project, "isolated-temp");
for (const dir of [home, temp]) mkdirSync(dir, { recursive: true });
for (const key of ["HOME", "USERPROFILE"]) process.env[key] = home;
for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = temp;
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"])
  process.env[key] = join(home, key);
for (const key of Object.keys(process.env))
  if (key.startsWith("MODEL_ROUTER_") || key.startsWith("OPENCODE_")) delete process.env[key];
process.chdir(project);

// Like routing-stats.ts, resolve the package's bundler-style local imports.
// Node does not strip TS inside node_modules by default; explicitly transform the
// installed sources without rewriting them or redirecting imports to the repo.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || /\.[cm]?[jt]s$/.test(specifier)
        || !["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error.code)) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try { return nextResolve(candidate, context); } catch { /* try next */ }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const logs = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
for (const key of Object.keys(original)) console[key] = (...args) => logs.push([key, ...args]);
try {
  const pkg = join(project, "node_modules/opencode-model-router");
  assert.equal(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version, "2.3.0");
  assert.equal(JSON.parse(readFileSync(join(pkg, "tiers.json"), "utf8")).routing, undefined);
  const { default: plugin } = await import(pathToFileURL(join(pkg, "server.ts")).href);
  assert.equal(plugin.id, "opencode-model-router");
  assert.equal(typeof plugin.setup, "function");
  const { loadConfig, resolveRouting } = await import(pathToFileURL(join(pkg, "src/router/config.ts")).href);
  const cfg = loadConfig(project);
  assert.equal(cfg.routing, undefined);
  assert.equal(resolveRouting(cfg, "v2").engine, "static");
  const hooks = await plugin.server({
    directory: project, worktree: project, routerHost: "v2",
    client: { app: { log: async (entry) => { logs.push(entry); return {}; } } },
  });
  assert.equal(typeof hooks["command.execute.before"], "function");
  if (hooks.dispose) await hooks.dispose();
  assert.deepEqual(logs, [], "No plugin startup/disposal log with the shipped no-routing config");
} finally {
  Object.assign(console, original);
}
console.log("PASS: installed 2.3.0 server.ts imports; shipped tiers.json has no routing block; v2 static factory loads/disposes; plugin log lines=0");
