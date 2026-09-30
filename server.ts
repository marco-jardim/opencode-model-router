// OpenCode v2 resolves the /server entrypoint before the package main.
// Keep main callable for v1 loaders that invoke every module export.
export { default } from "./src/v2";
