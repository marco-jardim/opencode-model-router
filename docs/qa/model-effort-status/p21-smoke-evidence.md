# Phase P2.1 — real-host proof of the TUI status (G1/G2/G3), #90

Branch `msd/p21`: the smoke is committed as `f0b6f7c` and the QA round 1 fixes as `b8a8766`. QA round 2 passed; its code
minors (below) are in the working tree, for the executor to commit.

## Verdict

Every scenario passes on OpenCode **2.0.24, 2.0.25 and 2.0.26**, for both plugin sources:
- the local path of this checkout;
- a `node_modules` install of the `npm pack` tarball.

Results: 49/49 tests in each of two consecutive full runs after round 1 (`b61ffa82`, `549b8690`), and 49/49 in the
confirming run after round 2 (`72d7caea`), with no skipped scenario.
- **A6 holds on every version and flow.** The G3 row is on screen while the child's first answer is still held, so
  `status(child) === "running"` is set before the first token.
- **No P1.3 code change is needed.**

## QA round 1 fixes

| Id | Fix |
|---|---|
| P21-1 (major) | **No `taskkill /T` any more.**<br>- The process query reads `CreationDate` (epoch ms).<br>- A child is accepted only if it was created at or after its parent and after the spawn (250 ms clock slack), and it is not in the pre-spawn baseline (pid + creation time).<br>- Children are killed first, then the root, each with `taskkill /F /PID <pid>`. Before each kill the process is re-read with `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` and skipped if gone or if its name or creation time changed.<br>- `pty.kill()` comes after the root.<br>- Collect → kill repeats up to 3 times, and every taskkill output is kept.<br>- The test asserts every kill record is a tree member, the root is killed exactly once and last in its round, there is no overlap with the start-of-run list, and there are no survivors.<br>- `RoutingHost.doStop` is unchanged; see Follow-ups. |
| P21-2 (major) | **`node_modules` install flow per version.**<br>- `npm pack` runs once into the temp dir. Then `npm install --no-save --no-audit --no-fund --ignore-scripts --no-package-lock --prefix <root>/install <tgz>`, with a minimal `package.json`. The peer `@opencode-ai/plugin` is installed and checked.<br>- Server config `plugins: ["<root>/install/node_modules/opencode-model-router", probe]`, no `cli.json`.<br>- Asserts boot, S1 default, the S2 G3 row (and A6) and S4 (screen and wire).<br>- At most 3 hosts at once, through a FIFO slot pool; installs run outside the slots. |
| P21-3 | **Child view check corrected.**<br>- Round 1 had matched the root view with the picker open: the picker replaces the prompt row, so the "no root row" test passed on the wrong screen.<br>- Now the child view needs a line with `TUI_SMOKE_HOLD two` that has no `SPIKE_CALL`, no `SPIKE_CALL` anywhere on screen, and a screen different from the picker snapshot.<br>- The picker must list exactly one running entry, `Fast: tui smoke two`.<br>- G2 is asserted while the child is still held (`running: true`). |
| P21-4 | - Throws if `pty.pid <= 4` after the wait (after `pty.kill()`).<br>- The root's identity (name, created after the spawn, not in the baseline) is checked at spawn.<br>- Teardown asserts `pid > 4`, `tree[0]` is the root, and the kill order described above.<br>- A last batch test asserts `newAfter` is empty and no own PID or identity is in the start-of-run lists.<br>- The suite is skipped off Windows, with the reason in its title. |
| P21-5 | **Host environment is an allowlist.**<br>- Inherited: `PATH`, `PATHEXT`, `SystemRoot`, `windir`, `ComSpec`, `NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`, `OS`, `USERNAME`, `COMPUTERNAME`.<br>- Set: the isolated dirs, `HOMEDRIVE`/`HOMEPATH` from the temp home, the OpenCode settings and the harness's own variables.<br>- Any other name throws, and so does a credential-shaped name.<br>- Round 1's deny-list let `OPENCODE` (no underscore) through. |
| P21-6 | **Every key waits for its expected screen change.** Typed prompt complete, root request seen, host row changed per `ctrl+t`, picker open, child view.<br>- The sidebar is toggled and toggled back, each waiting for the sidebar state, and the restored state is asserted.<br>- `<leader>b` retries at most 3 times; a stray `b` is erased. Both final runs needed 1 attempt each.<br>- The first draft failed because the second `ctrl+x` came right after the first chord. A 1 s pause before toggling back fixed it. |
| P21-7 | - S1: the host row's last segment is one of `low\|medium\|high\|xhigh\|max` and was not one before.<br>- G3: the row is on `composerTop - 1`.<br>- S4: every request of agent `fast` has effort `medium` and a catalog model ending `#low`, at least 2 in the local flow and 1 in the npm flow. |
| P21-8 | - `Promise.allSettled` over the flows.<br>- Each `finally` step has its own try.<br>- The hard stop has `.catch(() => {})`.<br>- Every process call has a 15 s timeout.<br>- An empty start-of-run process list throws.<br>- Flows are keyed by index, and binaries are de-duplicated by resolved path. |
| P21-9 | `npm run smoke:v1` was **not run**: it is not isolated from the owner's environment (see below). |
| P21-10 | This header is corrected, and paths are written as `<home>\AppData\Local\Temp\…`. |
| P21-11 | Process-table, re-read and taskkill calls use async `execFile`, as does npm. |

## QA round 2 fixes (code minors)

| Id | Fix |
|---|---|
| R2-1 | `npmEnv()` now sets `npm_config_cache=<run temp>/npm-cache` (one cache shared by the run's installs), `npm_config_logs_max=0` and `npm_config_userconfig=<empty temp file>`. The registry stays npm's default (public). The install is still `--ignore-scripts` from the local tarball, plus the peer from the public registry. |
| R2-2 | The batch check counts as left behind only processes whose parent is the vitest worker (`process.pid`) and whose pid + `CreationDate` is absent from the start-of-run list. Overlap is checked by pid + `CreationDate` only. The process query excludes its own `pwsh` (`$PID`), which would otherwise always be a fresh child of the worker. The `opencode.exe` pid lists are kept as info. |
| R2-3 | After the kill rounds the harness reads the process list once and reports, without killing, any process created after `spawnAt` whose parent pid is a member's and that was created after that member, but is not a member. The teardown test fails on any (`strays`). |
| R2-5 | `setRoot` also requires the root's `CreationDate` to be no later than `Date.now() + 5_000`. |
| R2-6 | This header names `b8a8766` and this round. |
| R2-4, R2-7 | Recorded under Follow-ups only. |

## Files

| File | Change |
|---|---|
| `test/smoke/tui-status.smoke.test.ts` | gated smoke (`RUN_OC_SMOKE_TUI=1`, Windows only): local and npm flows per version, checks, teardown and batch assertions |
| `test/smoke/helpers/tui-pty.ts` | allowlisted env, async process table with `CreationDate`, `ProcessTree` (identity-checked collect and kill), `TuiSession` |
| `test/smoke/helpers/routing-host.ts` | unchanged since `f0b6f7c` (additive `RoutingProvider.hold` / `holds` / `holdMarked`) |
| `package.json`, `package-lock.json` | unchanged since `f0b6f7c` (`smoke:tui`, `@lydell/node-pty` 1.2.0-beta.15, `@xterm/headless` 6.0.0) |

Run with `npm run smoke:tui`. Options:
- `OMR_TUI_SMOKE_BINS`: `;`-separated executables. A missing one is skipped with its path.
- `OMR_TUI_SMOKE_OUT`: evidence directory.

The evidence of the runs below is in `<home>\AppData\Local\Temp\Claude\omr-p21\out2\`:
- `<run>-<version>-<flow>.screens.txt`
- `<run>-<version>-<flow>.summary.json`
- `<run>-pids.json`

## Method

- **Isolation and process handling:** as in the P21-1 and P21-5 rows above.
- **Host config, per flow:**
  - Server config only (`<H>\.config\opencode\opencode.json`): `model: anthropic/claude-opus-4-7`, the router plugin (local path or installed package) plus a probe plugin, and the scripted Anthropic provider.
  - The host auto-loads the router's TUI entry (A4/A9).
  - Router preset `smoke` has **fast = `anthropic/claude-sonnet-5-5`, variant `low`, effort `medium`**, so the expected child label is `medium (low)` (A11d).
- **Host run:** `opencode.exe --standalone --auto` in a 150x45 ConPTY, mirrored by `@xterm/headless`; the mirror's replies to the host's terminal queries are written back.
- **Host facts used** (`git -C D:\git\opencode show v2.0.24:<path>`, no `git grep`):
  - `variant.cycle` = `ctrl+t`
  - `session.child.first` = `down` (subagent picker)
  - `composer.subagent.select` = `return`
  - `session.sidebar.toggle` = `<leader>b`, with `LeaderDefault = "ctrl+x"`
  - Root CLI flags: `--standalone`, `--auto`, `--session/-s`
  - `git diff v2.0.24 v2.0.26` of `keybind.ts` and `commands.ts` touches none of these.

## Vitest summaries

After round 1: run 1 (`b61ffa82`) and run 2 (`549b8690`), consecutive, `--reporter=verbose`:
```
 Test Files  1 passed (1)
      Tests  49 passed (49)
   Start at  12:22:50
   Duration  125.99s (tests 100%)

 Test Files  1 passed (1)
      Tests  49 passed (49)
   Start at  12:25:04
   Duration  118.87s (tests 100%)
```

After round 2: the confirming run (`72d7caea`) on the final code, `--reporter=verbose`:
```
 ✓ batch teardown: no new child of the test worker left behind, no own process (pid + creation time) present at the start 2401ms
 Test Files  1 passed (1)
      Tests  49 passed (49)
   Start at  12:37:06
   Duration  126.00s (tests 100%)
```
In that run the batch record shows `worker 26016`, `leftovers []`, `ownOverlapStartIdentities []` and 18 own processes.
The `opencode.exe` pids were `[12164,55072,56236,59416,65616,73448,75048]` before and after (info only). Every flow
reported `survivors []` and `strays []`.

Test names, per version (×3):
```
✓ OpenCode <v> > local path (this checkout) > boots with the plugin's footer on the home screen
✓ … > local path … > S1 G1: home footer shows `effort default`
✓ … > local path … > S1 G1: a selected variant shows in the host row and the plugin shows no effort
✓ … > local path … > S1 G1: cycling back to no variant restores `effort default`
✓ … > local path … > S2 G3: a running-delegate row directly above the prompt box while the child runs, gone after
✓ … > local path … > S2 A6: the row is on screen before the child's first token
✓ … > local path … > S3 G2: the child's own view shows `fast · <model> · <effort>` while it runs
✓ … > local path … > S4: the child's effort is the fast tier's (medium (low)) on screen and on the wire
✓ … > local path … > recorded: sidebar toggled and back, empty-box gap
✓ … > local path … > teardown: only this flow's processes were killed, children first, and none survive
✓ … > node_modules install (npm pack) > boots / S1 default / S2 G3 / S2 A6 / S4 / teardown   (6 tests)
✓ batch teardown: no opencode.exe left behind and no own PID among the processes present at the start
```
16 × 3 + 1 = 49.

Other checks:
- `npm run typecheck`: green.
- `vitest run test/unit/smoke-redact.test.ts test/unit/roles.evidence.test.ts test/unit/packaging.test.ts`: 3 files, 25 tests passed.

## Per-version / per-flow results

Times are seconds after the submit. "Request" is when the child's first request reached the provider; "row" is when the
G3 row was first seen; "release" is when the held first token was released.

| Run | Version | Flow | Checks | A6 (request / row / release) | G3 / G2 run / G2 idle | Wire (fast) | Teardown (kills, order) |
|---|---|---|---|---|---|---|---|
| b61ffa82 | 2.0.24 | local | 10/10 PASS | 1.0 / 1.1 / 16.0 | `medium (low)` ×3 | 2× `sonnet-5-5#low` effort `medium` | conhost, opencode, root opencode; 0 survivors |
| b61ffa82 | 2.0.24 | npm | 5/5 PASS | 0.7 / 0.8 / 15.7 | `medium (low)` | 1× same | same order; 0 survivors |
| b61ffa82 | 2.0.25 | local | 10/10 PASS | 0.5 / 0.6 / 15.5 | `medium (low)` ×3 | 2× same | same order; 0 survivors |
| b61ffa82 | 2.0.25 | npm | 5/5 PASS | 0.7 / 0.9 / 15.7 | `medium (low)` | 1× same | same order; 0 survivors |
| b61ffa82 | 2.0.26 | local | 10/10 PASS | 0.8 / 0.8 / 15.8 | `medium (low)` ×3 | 2× same | same order; 0 survivors |
| b61ffa82 | 2.0.26 | npm | 5/5 PASS | 0.5 / 0.6 / 15.5 | `medium (low)` | 1× same | same order; 0 survivors |
| 549b8690 | 2.0.24 | local | 10/10 PASS | 0.9 / 1.0 / 15.9 | `medium (low)` ×3 | 2× same | same order; 0 survivors |
| 549b8690 | 2.0.24 | npm | 5/5 PASS | 0.5 / 0.5 / 15.5 | `medium (low)` | 1× same | same order; 0 survivors |
| 549b8690 | 2.0.25 | local | 10/10 PASS | 0.6 / 0.7 / 15.6 | `medium (low)` ×3 | 2× same | same order; 0 survivors |
| 549b8690 | 2.0.25 | npm | 5/5 PASS | 0.5 / 0.7 / 15.5 | `medium (low)` | 1× same | same order; 0 survivors |
| 549b8690 | 2.0.26 | local | 10/10 PASS | 0.8 / 1.0 / 15.8 | `medium (low)` ×3 | 2× same | same order; 0 survivors |
| 549b8690 | 2.0.26 | npm | 5/5 PASS | 0.4 / 0.5 / 15.4 | `medium (low)` | 1× same | same order; 0 survivors |
| 72d7caea | 2.0.24 | local | 10/10 PASS | 1.0 / 1.2 / 16.0 | `medium (low)` ×3 | 2× same | same order; 0 survivors, 0 strays |
| 72d7caea | 2.0.24 | npm | 5/5 PASS | 0.5 / 0.6 / 15.5 | `medium (low)` | 1× same | same order; 0 survivors, 0 strays |
| 72d7caea | 2.0.25 | local | 10/10 PASS | 0.5 / 0.6 / 15.5 | `medium (low)` ×3 | 2× same | same order; 0 survivors, 0 strays |
| 72d7caea | 2.0.25 | npm | 5/5 PASS | 0.6 / 0.6 / 15.6 | `medium (low)` | 1× same | same order; 0 survivors, 0 strays |
| 72d7caea | 2.0.26 | local | 10/10 PASS | 0.7 / 0.8 / 15.7 | `medium (low)` ×3 | 2× same | same order; 0 survivors, 0 strays |
| 72d7caea | 2.0.26 | npm | 5/5 PASS | 0.7 / 0.9 / 15.7 | `medium (low)` | 1× same | same order; 0 survivors, 0 strays |

Notes on the table:
- **Local-flow checks:** boot, S1 default/variant/restore, S2 G3, A6, S3 G2, S4, sidebar, gap.
- **npm-flow checks:** boot, S1 default, S2 G3, A6, S4.
- **Process trees:** every tree has 3 members: the root `opencode.exe`, a child `opencode.exe` and a `conhost.exe`. All were killed in round 1, children first.
- **Batch, both runs:** `opencode.exe` PIDs `[12164,55072,56236,59416,65616,73448,75048]` before and after; `newAfter` and `gone` empty. 18 own processes per run, none in the start-of-run lists.

## Screen evidence (2.0.24, run `549b8690`; the other versions are identical apart from path tails)

**S1:** variant cycle.
- Host row: `┃  Build auto · Claude Opus 4.7 Anthropic` → `┃  Build auto · Claude Opus 4.7 Anthropic · low`. There was no variant before, and the plugin footer is absent.
- Restore: `medium → high → xhigh → max → (none)`, then `effort default` is back.

**S2 G3**, npm flow (the plugin loaded from `…\install\node_modules\opencode-model-router`). The row is on line 37 and the
prompt box starts on line 38:
```
  fast · Claude Sonnet 5.5 · medium (low)                                                                         use other models, including
  ┃                                                                                                               Claude, GPT, Gemini etc
  ┃
  ┃                                                                                                               Connect provider        /connect
  ┃  Build auto · Claude Opus 4.7 Anthropic
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ■■■■■⬝⬝⬝ esc interrupt                                    effort default  ↓ 1 subagent  ctrl+p commands    C:\…\omr-tui-2.0.24-npm-oZBjRh\project
```

**S3 G2:** the child's own view while the child is still held (`running: true`). It shows the child's prompt (the
router's dispatch preamble, then `TUI_SMOKE_HOLD two`), no `SPIKE_CALL`, and the picker entry `Fast: tui smoke two  Running`:
```
  ┃  ---
  ┃
  ┃  TUI_SMOKE_HOLD two
  ┃

  fast · Claude Sonnet 5.5 · medium (low)
  ┃
  ┃  Subagents  Shell                                                                                                                          esc
  ┃
  ┃  Fast: tui smoke two                                                                                                                  Running
```

**Sidebar (recorded and asserted):**
- Open by default: `fast · Claude Sonnet 5.5 · medium (low)` on one line, with the sidebar text to its right.
- After `<leader>b`: closed, same row, and the next line is the prompt border `┃`.
- After `<leader>b` again: open again, restored. One attempt each time.

**Gap (recorded):** the prompt box top is on line 38 with and without the row, and the row uses line 37. The transcript is
too short to tell an empty-box line apart from free space; this stays a DF-1 check.

**Teardown record** (taskkill output as the Portuguese system prints it, decoded as UTF-8):
`r1/child/64096 conhost.exe killed`, `r1/child/73348 opencode.exe killed`, `r1/root/30164 opencode.exe killed`. Each one's
output is `ÊXITO: o processo com PID <pid> foi finalizado.`, with no survivors.

## P21-9 — `npm run smoke:v1` not run (not isolated from the owner's environment)

`smoke:v1` runs `scripts/smoke-v1-preflight.mjs` and then `smoke:keyless`: `registration`, `subagent-tiers`,
`deferred-catalog`, `depth-effort` and the scripted-provider test. These are the reasons it was not run:

- **`deferred-catalog.smoke.test.ts:197`** spawns `opencode serve` with `env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }`.
  - `APPDATA`, `LOCALAPPDATA` and `XDG_*` are not repointed. The file's own comment (`:271-273`) says opencode then uses the owner's `AppData\Roaming` provider metadata ("the isolation was weaker than it looked").
  - The whole parent environment is passed. In this shell that includes provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and others) and the live session's `OPENCODE_*` variables (`OPENCODE_SESSION_ID`, `OPENCODE_BINARY`, …). Only the names were checked; no values were printed.
- **`registration.smoke.test.ts:64-81` and `subagent-tiers.smoke.test.ts:73-90`** repoint the dirs and delete `OPENCODE_*`, but pass every other parent variable, credentials included, and the bare `OPENCODE`.
- **`depth-effort`'s v1 host** is isolated (it strips the prefixes and repoints every dir).

v1 is not touched by this change in any case: the `smoke:keyless`/`smoke:v1` scripts, `vitest.smoke.config.ts` and the
v1-pinned smoke files are unchanged, and `routing-host.ts` is not v1-pinned.

## Follow-ups (not in P2.1 scope)

1. **`RoutingHost.doStop`** (`test/smoke/helpers/routing-host.ts`, used by the other v2 smokes) still runs
   `taskkill /PID <pid> /T /F`. It should get the same identity-checked, children-first kill as `tui-pty.ts`.
2. **v1 keyless smokes:** isolate `deferred-catalog` (repoint `APPDATA`/`LOCALAPPDATA`/`XDG_*`, allowlist the env), and
   allowlist the env of `registration`/`subagent-tiers`. After that, `smoke:v1` can run on this machine.
3. **Session titles:** in a TUI-created session, the host's title request quotes `SPIKE_CALL` and has no tools, so the
   fixture refuses it with a 400 (4 per local flow, 2 per npm flow). The test records these as notes, not errors.
4. **R2-4** (QA round 2, upstream residual, accepted): on `pty.kill()` node-pty lists the processes attached to the
   pty's console and kills them; if that helper does not answer within 5 s it kills the root's bare PID after its handle
   is closed (`@lydell/node-pty` `windowsPtyAgent.js:220-230`). Needs a > 5 s helper stall plus PID reuse. Option for
   later: spawn with `useConptyDll: true` when the DLL ships (skips the helper).
5. **R2-7** (QA round 2, outside P2.1): the v1 keyless smoke `test/smoke/deferred-catalog.smoke.test.ts:197` passes
   `{...process.env}` to `opencode serve`, so a local run hands the owner's provider keys and live `OPENCODE_*`
   variables to the child. Track as its own issue together with the `RoutingHost.doStop` `taskkill /T` follow-up.

## DF-1 manual checks (owner)

1. **G1:** with no variant, the footer under the prompt reads `effort default`. After `ctrl+t` the host row shows the variant and the plugin text disappears.
2. **G3:** while a delegate runs, `<agent> · <model> · <effort>` sits directly above the prompt box. It disappears when the delegate finishes.
3. **G2:** press Down, then Enter on the delegate. The child view shows the same row above `Subagents  Shell`.
4. **Gap** (not provable here): in a long root session with no delegate running, there is no extra blank line above the prompt box compared with the plugin disabled (`-opencode-model-router.status` in `cli.json`).
5. **Sidebar:** with the sidebar open or closed (`ctrl+x b`), the row stays on one line.
