// Offline script loader: extensionless TS resolution mirrors routing-stats.ts:9-27.
// Use Node's own type stripper, also before type stripping became enabled by default
// in Node 22.18. TypeScript 7's package root exports version data, not transpileModule.
// Strip mode only (#195): Node 26 removed mode "transform", so every product module this
// analyzer imports must use erasable syntax (no parameter properties, enums or namespaces).
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (!(specifier.startsWith("./") || specifier.startsWith("../")) || /\.[cm]?[jt]s$/.test(specifier)
      || !["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error.code)) throw error;
    for (const suffix of [".ts", "/index.ts"]) {
      try { return await nextResolve(specifier + suffix, context); } catch { /* next candidate */ }
    }
    throw error;
  }
}
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const text = await readFile(new URL(url), "utf8");
  return { format: "module", shortCircuit: true,
    source: stripTypeScriptTypes(text, { mode: "strip", sourceUrl: url }) };
}
