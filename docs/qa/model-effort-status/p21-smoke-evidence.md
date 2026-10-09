# Phase P2.1 — real-host proof of the TUI status (G1/G2/G3), #90

Worktree `D:\git\omr-msd-p21` (branch `msd/p21`), not committed (the executor commits).

## Verdict

All scenarios pass on OpenCode **2.0.24, 2.0.25 and 2.0.26**: 30/30 tests, 0 skipped, no `it.skip` needed. Three
consecutive full runs passed (run ids `cd5b8ad6`, `bdbfe44c`, `002415f1`; the last is on the final code). A6 holds on every
version: the G3 row is on screen while the child's first answer is still being held, so `status(child) === "running"` is
set before the first token. Nothing in the P1.3 code needs changing (no `msd/p21-fix`).

## Files

| File | Change |
|---|---|
| `test/smoke/tui-status.smoke.test.ts` | new, gated by `RUN_OC_SMOKE_TUI=1` (otherwise `describe.skip`: 30 skipped) |
| `test/smoke/helpers/tui-pty.ts` | new: isolated env, process table, own-tree kill, `TuiSession` (ConPTY → `@xterm/headless`, replies written back) |
| `test/smoke/helpers/routing-host.ts` | additive: `RoutingProvider.hold` / `holds` / `holdMarked(marker, ms)` (+6 lines in `handle`, inert when unset) |
| `package.json` | script `smoke:tui`; devDependencies `@lydell/node-pty` `1.2.0-beta.15`, `@xterm/headless` `6.0.0` (exact) |
| `package-lock.json` | from `npm install -D --save-exact` |

Run: `npm run smoke:tui`. Options: `OMR_TUI_SMOKE_BINS` (`;`-separated executables; defaults built from `homedir()` and
the real temp dir to the three known installs; a missing one becomes `it.skip("skipped: executable not found (<path>)")`,
verified with a fake `C:\nonexistent\opencode-2.0.99\opencode.exe`: `30 passed | 1 skipped`), `OMR_TUI_SMOKE_OUT`
(evidence directory; default `<real temp>\omr-tui-smoke`). Evidence of the runs below: `C:\Users\Marquinho\AppData\Local\Temp\Claude\omr-p21\out\`
(`<run>-<version>.screens.txt` = every distinct screen, `<run>-<version>.summary.json`, `<run>-pids.json`).

## Method

- One isolated root per version (`mkdtemp` under the smoke temp guard, `realpath`): HOME, USERPROFILE,
  `XDG_CONFIG_HOME=<H>\.config`, XDG_DATA/STATE/CACHE, APPDATA, LOCALAPPDATA, TEMP/TMP/TMPDIR inside it;
  `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_TEST_HOME`, random `OPENCODE_PASSWORD`;
  the caller's credential-shaped names and `OPENCODE_*`/`MODEL_ROUTER_*`/`OMR_*`/provider prefixes are dropped (a
  leak check throws).
- Server config only (`<H>\.config\opencode\opencode.json`): `model: anthropic/claude-opus-4-7`,
  `plugins: [<worktree>, <probe plugin>]`, `providers.anthropic.settings.baseURL` = the scripted provider. No `cli.json`:
  the host auto-loads the router's TUI entry (A4/C4). Router overrides in the same dir: preset `smoke` = `SMOKE_PRESET`
  with **fast = `anthropic/claude-sonnet-5-5`, variant `low`, effort `medium`**, so the expected child effort is
  `medium (low)` (A11d: effort and variant differ).
- `opencode.exe --standalone --auto` in a 150x45 ConPTY; `@xterm/headless` mirrors it and its replies to the host's
  terminal queries are written back. Waits for a real PID (> 4); kills only its own tree (`taskkill /T /F`, process-table
  baseline taken before the spawn); `opencode.exe` PIDs recorded before and after the run.
- Versions run in parallel (3 hosts, spawns staggered 4 s). Each step has its own deadline (≤ 90 s; whole flow 330 s).
- The worktree's own `node_modules/solid-js` (devDependency 1.9.15) did not break the TUI entry: the footer is reactive
  (S1 toggles it both ways) and no `Solid owner` notice appeared (`notices []`), so the host served its own solid-js,
  as in A9 C5.

Host facts (all via `git -C D:\git\opencode show v2.0.24:<path>`; no `git grep`):
`packages/tui/src/config/keybind.ts`: `variant.cycle` = `ctrl+t`, `session.child.first` = `down` ("Toggle subagent
picker"), `composer.subagent.down` = `down`, `composer.subagent.select` = `return`, `session.sidebar.toggle` =
`<leader>b`, `LeaderDefault = "ctrl+x"`. `packages/tui/src/routes/session/index.tsx:1257-1261` (Down opens the composer
on the `subagents` tab) and `composer/subagents-tab.tsx` (running family members, Enter navigates).
`packages/cli/src/commands/commands.ts` (root TUI command): `--standalone`, `--server`, `--auto`, `--session/-s`,
`--continue`, `--prompt`. `git diff v2.0.24 v2.0.26` of `keybind.ts` and `commands.ts` touches none of these.

## Vitest summary (final run `002415f1`, `--reporter=verbose`)

```
 ✓ … > OpenCode 2.0.24 > boots with the plugin's footer on the home screen 70488ms
 ✓ … > OpenCode 2.0.24 > S1 G1: home footer shows `effort default`
 ✓ … > OpenCode 2.0.24 > S1 G1: a selected variant shows in the host row and the plugin shows no effort
 ✓ … > OpenCode 2.0.24 > S1 G1: cycling back to no variant restores `effort default`
 ✓ … > OpenCode 2.0.24 > S2 G3: a running-delegate row above the composer while the child runs, gone after
 ✓ … > OpenCode 2.0.24 > S2 A6: the row is on screen before the child's first token
 ✓ … > OpenCode 2.0.24 > S3 G2: the child session view shows `fast · <model> · <effort>`
 ✓ … > OpenCode 2.0.24 > S4: the child's effort is the fast tier's (medium (low))
 ✓ … > OpenCode 2.0.24 > recorded: sidebar toggled and empty-box gap
 ✓ … > OpenCode 2.0.24 > teardown: every process this run spawned is gone
 (same 10 for OpenCode 2.0.25 and OpenCode 2.0.26)

 Test Files  1 passed (1)
      Tests  30 passed (30)
   Start at  11:54:06
   Duration  81.38s (tests 100%)
```
(The first test carries the wait for the three parallel flows; the others read their recorded results.)

Gate off (`vitest run --config vitest.smoke.config.ts test/smoke/tui-status.smoke.test.ts` without the variable):
`Test Files 1 skipped (1)`, `Tests 30 skipped (30)`.

## Per-scenario evidence

The screens are the same on the three versions (path tails differ). They are quoted from 2.0.24 unless noted.

### S1 G1 — home footer, variant, restore (PASS ×3)
Home, no variant (footer under the prompt box):
```
┃  Ask anything… "Fix a TODO in the codebase"
┃
┃  Build auto · Claude Opus 4.7 Anthropic
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
C:\…\omr-tui-2.…\project  effort default  shift+tab agents  ctrl+p commands
```
After `ctrl+t` (variant.cycle): the host row shows the variant and the plugin shows no `effort`:
```
┃  Build auto · Claude Opus 4.7 Anthropic · low
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
C:\…\om…\omr-tui-2.0.24-cLehcU\project    shift+tab agents  ctrl+p commands
```
Five more presses cycle `medium → high → xhigh → max → (none)`, and `effort default` comes back on the last one, so the
footer reacts both ways.

### S2 G3 — running row (PASS ×3) and A6 (PASS ×3)
The root prompt `SPIKE_CALL={"agent":"fast","description":"tui smoke one","prompt":"TUI_SMOKE_HOLD one","background":false}`
is typed and submitted. The scripted provider holds the child's first answer for 15 s. Root view while the child runs
(sidebar open by default at 150 columns):
```
  fast · Claude Sonnet 5.5 · medium (low)                                                                         use other models, including
  ┃                                                                                                               Claude, GPT, Gemini etc
  ┃
  ┃                                                                                                               Connect provider        /connect
  ┃  Build auto · Claude Opus 4.7 Anthropic
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ⬝■■■■■■⬝ esc interrupt                                    effort default  ↓ 1 subagent  ctrl+p commands    C:\…\project
```
The row sits on line 37, directly above the prompt box (lines 38–41). G1 in the root session stays `effort default` (the
root agent has no effort). Timeline, in seconds after the submit:

| Version | Child request reached the provider | Row first seen | First token released | Row gone (`ROOT_DONE` shown) |
|---|---|---|---|---|
| 2.0.24 | 0.5 | 0.6 | 15.5 | 15.9 |
| 2.0.25 | 0.5 | 0.6 | 15.5 | 15.8 |
| 2.0.26 | 0.6 | 0.7 | 15.6 | 16.0 (run `bdbfe44c`: 15.9) |

**A6:** the row appears about 0.1 s after the child's request is sent and about 15 s before its first token, so
`data.session.status(child)` is `running` before the first response. It never appears before the request (our polling
interval is 100 ms). The row's first value is already `medium (low)`, so the channel answered on the first pull.

### S3 G2 — child view (PASS ×3)
A second delegation (`TUI_SMOKE_HOLD two`, held 30 s). Down opens the subagent picker, Down moves to the child, and Enter
navigates to it. Child view while the child is still held:
```
  fast · Claude Sonnet 5.5 · medium (low)
  ┃                                                                                                               OpenCode includes free models so
  ┃  Subagents  Shell                                                                                esc          you can start immediately.
  ┃
  ┃  Fast: tui smoke two                                                                        Running           Connect from 75+ providers to
```
The same view after the child answered (2.0.26; the sidebar stayed closed after the S2 toggle):
```
     Fast · Claude Sonnet 5.5 · 31.2s · 0.2 tok/s

  fast · Claude Sonnet 5.5 · medium (low)
  ┃
  ┃  Subagents  Shell                                                                                                                          esc
  ┃
  ┃  No active subagents
```

### S4 — effort channel (PASS ×3)
Expected `medium (low)`, from the fast tier's effort `medium` and variant `low` (A11d rule). Observed on every version:
G3 `medium (low)`, G2 while running `medium (low)`, G2 when idle `medium (low)`. On the wire, both child requests carried
`catalogModel anthropic/claude-sonnet-5-5#low`, agent `fast`, effective effort `medium`. So the screen matches what the
provider was actually told, not just the stored variant.

### Recorded (not asserted as product requirements; both checks passed)
- **Sidebar:** at 150 columns the sidebar is open by default. Open: `fast · Claude Sonnet 5.5 · medium (low)` on one line,
  with the sidebar text to its right. After `<leader>b` (closed): `fast · Claude Sonnet 5.5 · medium (low)`, still on one
  line, and the next line is the prompt border `┃`. There was no wrapping in either state. (The row width comes from the
  renderer width − 4, not the composer width. A row longer than about 108 columns with the sidebar open would run under
  the sidebar edge, but `wrapMode: none` prevents it from wrapping. Not reproduced, because the names here are short.)
- **Empty-box gap:** with no delegate running, the prompt box top is on line 38, the same as with the row, and the line
  above it is blank. The transcript is too short to tell an empty-box line apart from the transcript's own free space, so
  this needs the DF-1 check below.

### Teardown (PASS ×3)
Each flow killed only its own tree. For example, 2.0.24 `{"pid":53068,"tree":[53068,80588,30488],"kill":["killed 53068"],"survivors":[]}`.
`opencode.exe` PIDs were `[12164,55072,56236,59416,65616,73448,75048]` before and after the batch, with no new or missing
PIDs, so the owner's live OpenCode was untouched.

## Notes

- **Session titles:** a TUI-created session asks the host's small model for a title. That request quotes the
  `SPIKE_CALL` text and carries no tools, so the scripted fixture refuses it with a 400. This happens 4 times per version;
  the titles fall back and nothing else is affected. The test records these as `notes` (auxiliary), keeps them out of
  `errors`, and still reports any other provider error.
- **Unit-suite flake:** `npm test` (full suite) had one failure: `test/unit/exec.test.ts:466` ("G4 load limit … holder not
  dead 3 s after"). This is the known Windows timing flake (#88), unrelated to this change. The file passes alone
  (42 passed, 2 skipped), and `packaging.test.ts` and `docs-drift.test.ts` pass (81). `npm run typecheck` is green.
- **v1 untouched:** `smoke:keyless`/`smoke:v1` scripts, `vitest.smoke.config.ts` and every other smoke file are
  unchanged. `routing-host.ts` is not in the v1-pinned file list. `npm run smoke:v1` (T2.1.2) was not run: it needs
  OpenCode 1.x first on `PATH`, which this dispatch did not provide.
- **R2-6** (old session from another directory) and the `node_modules` install variant of "server config only" (A9) are
  not covered by this smoke. This smoke loads the local worktree path only, as the dispatch specified.

## DF-1 manual checks (owner)
1. G1: on the home screen and in a root session with no variant, the footer under the prompt reads `effort default` (or
   `effort <applied>`). After `ctrl+t` the host row shows the variant and the plugin text disappears.
2. G3: delegate to a tier. While the delegate runs, a row `<agent> · <model> · <effort>` sits directly above the prompt
   box, and it disappears when the delegate finishes.
3. G2: press Down, select the delegate and press Enter. The child view shows the same row above `Subagents  Shell`.
4. Gap (the only item not provable here): in a long root session whose transcript fills the screen, with no delegate
   running, the last transcript line or the host's `Jump to latest ↓` line sits directly above the prompt box. There
   should be no extra blank line compared with the plugin disabled (`-opencode-model-router.status` in `cli.json`).
5. Sidebar: with the sidebar open (`ctrl+x b`) the row stays on one line.
