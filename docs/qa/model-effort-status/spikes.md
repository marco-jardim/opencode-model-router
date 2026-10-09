# P0.1 spikes — evidence and verdicts (#90)

Host source read only at tags `v2.0.24` / `v2.0.25` / `v2.0.26` of `D:\git\opencode` (`git show <tag>:<path>`,
`git grep <pat> <tag>`); `dev` never read. Runtime evidence from a throwaway probe on the real hosts
`C:\Users\Marquinho\scoop\apps\opencode2\2.0.24\opencode.exe` and `…\2.0.26\opencode.exe`, probe and captures kept in
`C:\Users\Marquinho\AppData\Local\Temp\Claude\omr-tui-probe\` (`out\*.screens.txt`, `out\*.raw.txt`, `probe*\*.log`).

## S1 — entry resolution → D1: root `tui.ts`, no `exports` map, no JSX

- `v2.0.24:packages/plugin/src/host.ts:17-43`: `Host.resolve` builds `<pkg>/<subpath>` (package) or
  `path.resolve(dir, subpath || "index")` (local dir) and calls `Bun.resolveSync`; misses with ENOENT, ENOTDIR,
  MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND, ERR_PACKAGE_PATH_NOT_EXPORTED, ERR_UNSUPPORTED_DIR_IMPORT fall through.
  `server: entry(["server",""])`, `tui: entry(["tui"])` (no fallback to the bare package), `rpc: entry(["rpc"])`.
  Without `exports`, `<pkg>/server` finds root `server.ts` by extension probing — why v2 loads `server.ts` today.
- `v2.0.24:packages/tui/src/plugin/context.tsx:670-671`: `Host.resolve(target).tui`; undefined → `unsupported`.
- Bun probe (no `exports`, root `tui.tsx`): `fakepkg/tui` → `…\node_modules\fakepkg\tui.tsx`. With an `exports` map
  lacking `./tui`, `fakepkg/tui` fails: an `exports` map makes every entry explicit.
- v1 risk of an `exports` map: `v1.18.35:packages/opencode/src/plugin/shared.ts:74-113` checks `exports["./server"]`
  before `main`, so `"./server": "./server.ts"` would switch the v1 entry from `src/index.ts` to the v2 module. Rejected.
  Without `exports`, v1 keeps loading `main`; a root `tui.ts` is never looked at by v1.
- Solid JSX transform scope (`@opentui/solid@0.5.14` `scripts/solid-plugin.js`, identical in 0.5.17):
  `/^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?…$/` — files under `node_modules` are NOT transformed, so shipped JSX
  would break npm installs. Runtime probe P2: a root `tui.ts` built with `@opentui/solid` reconciler primitives
  (`createElement`, `insert`, `setProp`, exported by `src/reconciler.d.ts`) renders and updates on 2.0.24 and 2.0.26,
  both as a local path and from inside a `node_modules` folder with no `node_modules` of its own: bare `solid-js`,
  `@opentui/solid`, `@opencode/plugin/tui` imports are served by the host runtime plugin
  (`import.meta.resolve` on disk throws, the module still loads, a `createSignal` tick re-renders inside the host's
  `insert` effect → single Solid instance).
- P3: `v2.0.24:packages/plugin/src/tui/plugin.ts` `define(plugin) { return plugin }`; a plain `{ id, setup }` default
  export works (runs A/B1/D), `Plugin.define` too (run E).
- Verdict D1: root `tui.ts` re-exporting `./src/tui/plugin.ts`; no `exports` map; no JSX in shipped files; `files`
  gains `tui.ts`. v1 and the v2 server entry are unaffected.

## S2 — TUI config

- `v2.0.24:packages/tui/src/config/index.tsx:45-52`: `plugins: Array<string | { package: string; options?: Record<string, any> }>`;
  `-<id>` disables, `*`/`foo.*` patterns, exact id enables a built-in (`context.tsx:318-326`); options only from the
  object form (`context.tsx:332`); options reach `setup` as `context.options` (`plugin/src/tui/context.ts:545`,
  `context.tsx:640`).
- Global file: `<config dir>\tui.json`; config dir `OPENCODE_CONFIG_DIR ?? Path.config`
  (`packages/util/src/global.ts:79`), `XDG_CONFIG_HOME || ~/.config` (`global-roots.ts:7`) → owner file
  `C:\Users\Marquinho\.config\opencode\tui.json` (exists; probe hosts read `<HOME>\.config\opencode\tui.json`).
  Project dirs `.opencode` in each ancestor (`util/config-directories.ts:5-6`). The provider reloads on change.
- Sources merged (`context.tsx:299-305`): local discovery (`<config>/plugins/*`, `.opencode/plugins/*`, directories
  only) → **the server config's plugin list (`serverTuiPlugins()`, no options)** → `tui.json` `plugins` (last wins per
  target). Consequence: every v2 user who lists this package in the server config gets the TUI entry automatically
  with default options; options need an explicit `tui.json` entry; disabling uses `enabled: false` or the `-<id>`
  selector (recorded in A4).
- Listing by bare package name makes the host `npm install` it (probe B2: `NpmInstallFailedError … 404`); the owner and
  the smoke use local paths.
- No difference 2.0.24 → 2.0.26 in config or discovery.

## S3 — effective variant and the footer rule

- TUI selection `v2.0.24:packages/tui/src/context/local.tsx:236-250`: per-model preference → the agent's configured
  variant (same model) → the configured global model's variant → `undefined`; kept only if listed in `info.variants`.
  The prompt sends `{providerID, id, variant}` (`prompt/index.tsx:1208,1284`).
- Core `runner/model.ts:77-90`: `resolveModel(selected, session.model.variant)`; `model-resolver.ts:141-157` treats
  `undefined`/`"default"` as no overlay (model default). `to-llm-message.ts:232-237` maps a variant id to an effort only
  for notices. `session/context.ts:104-105` is title generation only.
- The assistant message `model` (`schema/src/session-message.ts:216`) is the session's ref as sent: `variant` absent when
  none was selected; no default is filled in.
- Footer `metadata.tsx:63-146`: `Agent · model provider · variant`, the variant from `local.model.variant.current()`
  (`prompt/index.tsx:1554`) shown under `<Show when={layout().variant}>` (`:69`). The row is outside every slot
  (`prompt/index.tsx:1833`); `prompt.footer`/`prompt.footer.status` render in the row below (`:1875-1877`).
- Verdict D3 (A3): the D3 chain collapses — the agent's configured variant is already folded into the selection and the
  last assistant message describes a past turn. G1 renders `effort default` when `ui.model.current()?.variant` is unset
  (the host row shows no variant), and nothing when a variant is selected (the host row already shows it).

## S4 — server→TUI effort channel → A1: FEASIBLE (plugin rpc, pull)

- Server: `v2.0.24:packages/core/src/plugin/host.ts:119` `rpc: Object.assign(rpc.client, { register })`;
  `packages/plugin/src/promise/rpc.ts:19-40`; registrations keyed by definition id in-process (`core/src/rpc.ts`),
  released with the plugin scope. The `rpc` package subpath only sets a flag (`core/src/plugin/module.ts:121`) and has no
  consumer — not needed.
- TUI: `context.client.rpc(def).<method>(input)` (`packages/client/src/promise/client.ts:15`,
  `client/src/promise/rpc.ts`), HTTP `rpc.call` (`packages/server/src/handlers/rpc.ts:9-13`). Events are bus-published
  per location directory → pull, not push.
- Runtime probe P4 (2.0.24 and 2.0.26): plain-object definition in a shared relative file with JSON-Schema
  `input`/`output` and `events: {}`, registered from the server plugin's `setup` via `ctx.rpc.register(def, handlers)`
  (returned `{dispose, events}`), called from the TUI → screen `OMR-PROBE-RPC:{"effort":"high:x"}`, server log
  `effortOf called input={"sessionID":"x"}`. Registration preceded the first TUI call by ~1 s: the TUI must retry/lazy-call.
- Router data (repo): route time `src/routing/wire/dispatch.ts:1397-1401` (agent, model, variant); child `chat.params`
  `src/compat/v2-hooks.ts:1375-1380`; effective effort after an escalation `src/index.ts:1986` +
  `src/escalate/effort-override.ts:114-145` (in-memory, keyed by child session id).
- No difference 2.0.24 → 2.0.26 in host/client/schema rpc files (only an unrelated `integration.connection.external`).

## S5 — slots, reactivity, timing

- Placement `v2.0.24:packages/tui/src/plugin/render.tsx:85-144`, `structure.ts:71-145`: `before…`,
  `[prepend…, children, append…]`, `after…`; `replace` swaps the boundary (last claim wins); several claims coexist in
  enable order; each claim in a `PluginBoundary`. `render` is called once, untracked, with reactive props.
- `prompt.footer.status` (`prompt/index.tsx:1877`, props `{sessionID?, mode, showDetails}`); built-ins append there
  (`feature-plugins/.../btw.tsx:29`). Verdict: G1 uses `append`.
- `session.composer.top` (`routes/session/index.tsx:1448`, props `{sessionID}`) is in the shared session route, not
  conditional on `parentID` → renders in root and child views (runtime confirmation in P2.1).
- Reactivity: `packages/client/src/solid/data.ts` `createStore` (`:229`); `status` (`:1378`), `family` (`:1359`),
  `message.list` (`:1620`) read the store → reactive in tracking scopes. A not-yet-synced session returns `[]`: P1.3
  calls `data.session.message.sync(id)` once per child (feature-detected).
- Timing: the assistant message exists only after `Step.Started` (`step.ts:194,243`; later still on 2.0.25+). The child's
  `session.model` is set at creation (`core/src/tool/plugin/subagent.ts:184-193`, `override ?? agent.model ??
  parent.model`) → G2 reads `session.get(id).model` until an assistant message exists. Whether `status(child)` is
  `running` before the first response is UNVERIFIED → P2.1 checks it on the real host.
- Context shape (`plugin/src/tui/context.ts`): `options`, `app`, `client`, `data`, `ui.slot(claim) => dispose`,
  `ui.model.current()`, `storage`, `theme`; no logging API. Cleanup returned from `setup`.

## S6 — build/typecheck → D8

- No JSX shipped (S1), so the root `tsconfig.json` needs no JSX settings.
- Imports at runtime: `@opentui/solid` (reconciler primitives), `solid-js`; `@opencode/plugin/tui` not needed at runtime
  (plain default export). None may enter `dependencies` (2.0.26 `createForeignPackageFilter` rejects bundled `effect`/
  `@opencode/plugin`; a local `solid-js` copy could shadow the host's).
- Types: the TUI code types the host context structurally (local types for the used subset, feature-detected), declares
  the three `@opentui/solid` functions in a local ambient declaration, and adds `solid-js` (`1.9.x`) as a devDependency
  (types + unit tests). `@opencode/plugin@2.0.24` exports `./tui` as raw `.ts` source, which would be type-checked with
  this repo's settings; not imported.
- `@opencode/plugin` published 2.0.24–2.0.26; `@opentui/solid` 0.5.14–0.5.17; host catalog pins `solid-js` 1.9.15.

## S7 — tests

- Unit: the pure core (`status-model.ts`) in vitest; the view layer with a fake context and a mocked `@opentui/solid`
  module (records created nodes, props, inserted accessors) plus `solid-js` reactivity (`createRoot`); under Node,
  `solid-js` resolves to its server build by default, so the test must load the reactive build (browser condition or the
  `dist/solid.js` path) — P1.3 decides per file without changing `vitest.config.ts` for other tests.
- Real host (P1 PASS): Node + `@lydell/node-pty` 1.2.0-beta.15 (win32-x64 prebuild present and working) +
  `@xterm/headless` 6.0.0 capture the 2.0.24/2.0.26 TUI screen text (150×45, replies written back to the pty).
  Mandatory: `--standalone` (otherwise the managed service port collides with the owner's live service: `Managed service
  port 49374 … already in use`); wait for a real PID (the pty reports `pid=0` right after spawn on Windows) and kill only
  processes spawned by the run; local-path plugin entries (a bare name triggers `npm install`); the host checks for
  updates over the network (display only). Gated by an env flag like the other smokes.
- Incident (recorded): the probe's first pty run took `pid=0` as the root and attempted `taskkill /T /F` on Windows
  system PIDs (4, 172, 220, 936, 4276); every attempt was refused (no admin) and all kept running; the owner's
  opencode.exe PIDs were unchanged. The harness was fixed (real PID wait, never kill pre-existing PIDs). P2.1 must
  carry the same guard.
