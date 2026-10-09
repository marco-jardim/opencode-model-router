# Phase P0.1 — prerequisites and spikes (#90)

## Pre-flight (2026-10-09)

| Check | Result |
|---|---|
| PR #89 (v1 feature freeze) | CI 17/17 green on `4ad121e`; merged with a merge commit, `master` = `f969139` |
| Base checkout `D:\git\opencode-model-router` | fast-forwarded `31c5687` → `f969139` (docs + docs-drift only), clean |
| `D:\git\opencode` | fetched with tags; `dev` already up to date; tags `v2.0.24`, `v2.0.25`, `v2.0.26` present |
| Host log `C:\Users\Marquinho\.local\share\opencode\log\opencode.log` | one `failed to load plugin` line (`2026-10-09T05:02:58Z`, `Export named 'oneLineReason' not found`): a mid-sync load before the 2.4.0 restart; stale, no action |
| Worktree `D:\git\omr-v1-freeze` | already gone after the #89 merge; `git worktree prune` done |
| Leftover `D:\git\omr-rta-p34` | still present (held by the host); delete after the restart |

## T0.1.1

- Owner override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`: added
  `routing.workRoots: ["D:/git/omr-msd-*"]`.
  - Temp-HOME validation: `loadConfig()` of the base checkout (bun, isolated `HOME`/`USERPROFILE`/`XDG_*`/`APPDATA`/
    `LOCALAPPDATA`) returned `workRoots ["D:/git/omr-msd-*"]`, `delegation roles`, `engine enforce`, no notices.
  - Backup `…overrides.jsonc.bak-2026-10-09_07-49-22`, SHA-256 `5F5016CCCE4F61BC06DE35E4F1C7707E112373ACF44326BCECD939EDC3753FEF`.
  - New file SHA-256 `AAA4DB0A1002AD185B0525755835D31F2FD749D09CB07DC7C4D699FDC2E02C54`.
- Integration worktree `D:\git\omr-msd-main`, branch `msd/main` = `origin/master` (`f969139`) + merge of
  `docs/status-display-plan`; `npm ci` done; pushed; draft PR #91 `msd/main → master`.
- Restart stop: role agents need the restart to pick up `routing.workRoots`.
