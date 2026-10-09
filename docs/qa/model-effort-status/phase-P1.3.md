# Phase P1.3 — TUI plugin entry and packaging (#90)

Branch `msd/p13` (worktree `D:\git\omr-msd-p13`, from `msd/main` `374d3f1` with P1.1 and P1.2 merged), merged into
`msd/main` after `3a76eef`.

## Pre-flight

P1.1 (`ce11159`) and P1.2 (`b74e726`) merged; `npm ci`; typecheck green. `solid-js` 1.9.15 (host catalog pin) added as
an exact devDependency by the executor (`fbe183b`).

## Implementation

- `tui.ts` (root) → `./src/tui/plugin.ts`; no `exports` map, `main` unchanged, `files` gains `tui.ts`.
- `src/tui/plugin.ts`: plain `{ id: "opencode-model-router.status", setup }`; imports only `solid-js`,
  `@opentui/solid` (`createElement`, `insert`, `setProp`) and `.ts` relative files. G1 `append` on
  `prompt.footer.status` (root or no session, A3); G2/G3 one `append` claim on `session.composer.top` (child → one row,
  root → running delegates + `+k more`). Per-session effort pollers (A1: immediate first pull off the setup path, 5 s
  debounce and poll while running, `rpc.unavailable` backoff 1→30 s by the host's `{type}` error shape, 30 s cooldown on
  other errors, 10 s abortable calls, bounded pull state across close/reopen, session `location` passed), message and
  location-model sync once (bounded), `wrapMode: "none"`, `getOwner()` guard with a static fallback, toasts for
  user-facing notices, every host access feature-detected and isolated.
- `src/tui/host-types.ts` (structural host subset), `src/tui/opentui-solid.d.ts` (ambient, three functions).
- `tsconfig.json`: includes `server.ts` and `tui.ts`; `allowImportingTsExtensions` (with `noEmit`).

Commits: `fbe183b`, `7b6c9c3`, `9f487bb` (QA 1), `5c74da5` (QA 2), `3a76eef` (real-host critical fix).

## Tests

- `test/unit/tui.plugin.test.ts` 113 tests over a real `solid-js/universal` renderer and the reactive Solid build.
- `test/unit/packaging.test.ts` +pins: `tui.ts` exact re-export, `.ts` relative specifiers in the TUI closure, allowed
  bare imports, no Solid outside the TUI closure, no `.tsx`, no root `index.*`, no `exports`, `main` unchanged, no host
  packages in `dependencies`/`peerDependencies`.
- Reviewer round 3: 4 TUI/packaging files 351 passed; goldens 8 files / 88 passed; typecheck green. On `msd/main` after
  the merge: 14 files (TUI, packaging, v2-hooks, docs-drift, goldens) 610 passed.

## A9 real-host evidence (heavy tier agent, temp dir `C:\Users\Marquinho\AppData\Local\Temp\Claude\omr-a9\`)

Isolated HOMEs, `--standalone`, pty + `@xterm/headless`, ≤ 3 concurrent hosts, only own PIDs killed (owner PIDs
unchanged). 2.0.25 binary from npm `@opencode/cli-windows-x64@2.0.25` (sha512 matches the registry integrity).

| Check | 2.0.24 | 2.0.25 | 2.0.26 |
|---|---|---|---|
| C1 `npm pack` contents (`tui.ts`, `server.ts`, `src/tui/*`, no root `index.*`) | PASS | | |
| C2 `Bun.resolveSync("opencode-model-router/tui", dir)` from the install root and the package dir | PASS | | |
| C3a `cli.json` local path → footer `effort default`, `/plugins` `TUI opencode-model-router.status local` | PASS | PASS | PASS |
| C3b `cli.json` options `maxRows:"x"` → toast `model-router status: invalid TUI options …` | PASS | PASS | PASS |
| C4 server config only → TUI auto-loads (`effort default`); server `loading plugin … entrypoint=…/server.ts` | PASS | PASS | PASS |
| C5 copy with its own `node_modules/solid-js` → renders; the host serves its own solid-js (marker never written) | PASS | PASS | PASS |

The first matrix on `5c74da5` failed C3–C5 everywhere (`Cannot find package 'solid-js' imported from …\src\tui\plugin.ts`)
because of the extensionless re-export in `tui.ts`; fixed in `3a76eef` (A11b) and re-run above. Other observations:
the v2 TUI config is `cli.json` (A10); the host swallows plugin console output (A11c); the server entry needs the
`@opencode-ai/plugin` peer at runtime, and when the server entry fails the TUI entry is not auto-loaded (pre-existing;
documented in P2.2). Probe incidents: an earlier `git grep` on the blobless `D:\git\opencode` clone may have fetched
blobs into `.git/objects` (working tree unchanged); three un-isolated `opencode.exe --version` runs. Not repeated.

## QA

| Round | Verdict | Findings |
|---|---|---|
| 1 (heavy reviewer) | FAIL | P13-1 major (rpc errors are `{type}` objects), P13-2 major (shadowing solid-js risk), 7 minor, 5 nits. All fixed in `9f487bb` (P13-8: G2 keeps the agent, A11a). |
| 2 | PASS | R2-1..R2-6 minors/nits (location model list fallback, static mode without G3, explicit `type`, strict eval, pin scope, R2-6 for P2.1). Fixed in `5c74da5`. |
| 3 | PASS | Review of `3a76eef` (critical real-host fix). Minors accepted — QA round limit: owner toast fires synchronously in render; owner notice names a cause the shadow run disproved; options notice invisible on a host without `ui.toast`. |

## Takeovers

None. Coverage, merges and host-source lookups for A10 by the executor.

## Verdict

DONE. 0 open blocking/critical/major. Hand-offs to P2.1: G2/G3 with a scripted provider (status of a child before its
first response, A6), rpc `effortOf` after real turns, sidebar-open width and empty-box gap, R2-6 (old session from
another directory).
