# Phase P2.2 — docs (#90)

Branch `msd/p22` (worktree `D:\git\omr-msd-p22`), merged into `msd/main` (`00d07a6`, fixes `8764ce8`).

## Pre-flight

`msd/main` `6fb528f`; `npm ci`; typecheck and docs-drift green at the base.

## Implementation

New `docs\TUI_STATUS.md` (views, enabling via the server config, `cli.json` options, disabling, effort channel,
limitations, troubleshooting with the failure signs observed on the hosts); `docs\CONFIG_REFERENCE.md` "TUI status
options (OpenCode v2)"; `README.md` section and requirements note "(TUI status: 2.0.24+)"; `docs\OPENCODE_V2.md` one
paragraph; `CHANGELOG.md` `[Unreleased]` → `### Added` "OpenCode v2 TUI status (#90)".

Docs-drift pins (`test\unit\docs-drift.test.ts`, 81 tests): options table vs `STATUS_OPTION_KEYS` /
`DEFAULT_STATUS_OPTIONS` / `MAX_ROWS_*`; slots collected from `setup` with a fake `ui.slot` per option set; plugin and rpc
ids from the code; toasts from `parseOptions` and `NO_OWNER_NOTICE`; timings and width margin from exported constants;
row format via `effortWithVariant` / `formatRow` / `runningChildren`; `cli.json` examples parsed (no plugin id or
`tui.ts` path in `package`, selector ordering); `tui.json` only as the v1 file; CHANGELOG entry in `[Unreleased]` or the
first dated release; ≤ 120-column prose; links resolve. No existing pin weakened (diff is additive).

Commits: `bedaae4`, `ce3ec2e` (QA 1), `a555476` (QA 2).

## QA

| Round | Verdict | Findings |
|---|---|---|
| 1 (heavy reviewer) | PASS | 8 minor (fallback wording, unknown keys, auto-load scope, verified scope, grandchildren, unevidenced marker, unreleased failure item, source-text pins) + 10 nits. All fixed in `ce3ec2e` (F4 backed by P2.1). |
| 2 | PASS | R2-1 width caveat (rows fit the terminal, not the composer), R2-2 failure signs replaced by the forms captured in the A9 run on `5c74da5` (toast `Plugin failed: <path>`, footer `⊙ 1 plugin failed /plugins`, dialog row `x <path> failed, local`), R2-3..R2-7. Fixed in `a555476`. |

## Takeovers

None.

## Verdict

DONE. 0 open blocking/critical/major. P3.2 note: the CHANGELOG pin follows the entry into the first dated release.
