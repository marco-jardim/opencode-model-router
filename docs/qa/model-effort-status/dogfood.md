# DF-1 — owner dogfood (#90)

## Sync (2026-10-09)

- Base checkout `D:\git\opencode-model-router`: clean on `master` `f969139`; rollback tag `msd/df1-prev` (`f969139`,
  pushed); switched to branch `msd/live` = `msd/main` `9a7cd06`; `npm ci` finished before the restart stop; typecheck
  green; `tui.ts` and the `@opencode-ai/plugin` peer present.
- Owner TUI config: **not changed.** The owner's server config `C:\Users\Marquinho\.config\opencode\opencode.json`
  already lists `D:\git\opencode-model-router` (local path), so the v2 TUI auto-loads `tui.ts` with default options
  (A4; proven in P1.3 A9 C4 and P2.1 on 2.0.24–2.0.26). `C:\Users\Marquinho\.config\opencode\cli.json` keeps its own
  `plugins` (`D:\git\opencode-rich-footer`). Deviation from the plan text ("add the TUI plugin to the owner's TUI
  config"): unnecessary write to an owner file avoided (A13d).
- Rollback: `git -C D:\git\opencode-model-router switch master` (tag `msd/df1-prev`), `npm ci`, restart.

## Owner checks after the restart (pending)

1. `/router` line shows `build=2.4.0+9a7cd06`.
2. G1: main session prompt footer shows `effort default` with no variant selected; `ctrl+t` selects a variant → the
   host row shows it and `effort …` disappears.
3. G3: while a delegation runs, a row `<agent> · <model> · <effort>` above the composer; it disappears when the
   delegate finishes.
4. G2: open the delegate's view (Down in an empty composer opens the subagent picker, then Enter) → the same row above
   the composer.
5. `/plugins` lists `TUI opencode-model-router.status`.

## Result (owner, after the restart on `9a7cd06`)

- `/router`: `router: engine=enforce build=2.4.0+9a7cd06` — the synced code is live.
- G1: the main-session footer shows `effort default` next to the host's own footer items (screenshot from the owner);
  it coexists with `opencode-rich-footer` on the same row. Owner: keep it.
- G3: the running-delegate rows appeared above the composer (`runner · Claude Haiku 5.5 (anthropic) · low`,
  `reviewer · Claude Opus 5.5 (anthropic) · xhigh` ×2). Owner: too cluttered in the main session; the delegate's own
  view is enough → **A12: G3 opt-in** (`runningRow` default `false`), implemented on `msd/p31-fix-1` (`38d8f42`,
  smoke `af96cd8`).
- G2 and the `-<id>` selector / `cli.json` options were not checked by the owner; covered by the real-host smoke (G2,
  options toast, `cli.json` replacing the auto-loaded entry). The selector is cited from host source only (residual,
  recorded in `global.md`).
- Whether the empty composer box in the main session (G3 off) adds a blank line above the prompt box is not yet seen
  by the owner: checked after the release restart.
