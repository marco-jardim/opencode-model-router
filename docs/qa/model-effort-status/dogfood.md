# DF-1 — owner dogfood (#90)

## Sync (2026-10-09)

- Base checkout `D:\git\opencode-model-router`: clean on `master` `f969139`; rollback tag `msd/df1-prev` (`f969139`,
  pushed); switched to branch `msd/live` = `msd/main` `9a7cd06`; `npm ci` finished before the restart stop; typecheck
  green; `tui.ts` and the `@opencode-ai/plugin` peer present.
- Owner TUI config: **not changed.** The owner's server config `C:\Users\Marquinho\.config\opencode\opencode.json`
  already lists `D:\git\opencode-model-router` (local path), so the v2 TUI auto-loads `tui.ts` with default options
  (A4; proven in P1.3 A9 C4 and P2.1 on 2.0.24–2.0.26). `C:\Users\Marquinho\.config\opencode\cli.json` keeps its own
  `plugins` (`D:\git\opencode-rich-footer`); both plugins append to `prompt.footer.status` and coexist. Deviation from
  the plan text ("add the TUI plugin to the owner's TUI config"): unnecessary write to an owner file avoided.
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

## Result

(recorded on resume)
