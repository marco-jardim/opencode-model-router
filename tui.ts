// OpenCode v2 resolves the /tui entrypoint (`<package>/tui`) by extension probing; v1 never loads this file.
// The explicit `.ts` is required: from `node_modules`, an extensionless specifier makes the host resolve the plugin's
// bare imports (`solid-js`) outside its runtime and the load fails (A9 run, OpenCode 2.0.24–2.0.26).
export { default } from "./src/tui/plugin.ts";
