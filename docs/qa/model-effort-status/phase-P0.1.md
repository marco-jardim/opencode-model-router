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

## T0.1.2 spikes

Evidence and verdicts: `D:\git\omr-msd-main\docs\qa\model-effort-status\spikes.md`. Dispatches: four `medium` tier
agents for host source (S1+S2, S3+S5, S4, S6+S7; S4 and S1/S2 resumed once for follow-ups), one `heavy` tier agent for a
runtime probe on the real 2.0.24/2.0.26 hosts in a temp dir (P1 pty capture, P2 root `tui.ts` load, P3 `define`,
P4 rpc round-trip, P5 2.0.26). The router grader returned NOT ACCEPTED on the probe because the criterion was truncated
(known, handover §4); the executor re-checked the captures it cites (`out\*.screens.txt`, probe logs) and accepted it.
Incident: the probe's first pty run attempted `taskkill` on Windows system PIDs (all refused, nothing stopped); see
spikes.md S7.

## T0.1.3 amendments

A1–A8 written in `docs\plans\v2-model-effort-status-plan.md` §8 (A1: effort channel feasible → P1.2 runs).

## QA round 1 (heavy tier, adversarial; tier agent instead of role `reviewer` because the role cannot read `D:\git\opencode`)

Verdict FAIL (4 major, 7 minor). All fixed in docs (round-1 rule: fix everything).

| id | sev | finding | fix |
|---|---|---|---|
| QA-1 | major | plugin id = package name makes a `tui.json` `{package, options}` entry an enable selector that drops options | A4: id `opencode-model-router.status`, disable `-opencode-model-router.status` |
| QA-2 | major | A1 had no re-pull rule; push rejection reason wrong | A1: tracked re-pull on status/message change, ≤5 s while running, never in setup; S4 text corrected |
| QA-3 | major | root sessions may run a non-default effort via `agentOptions` while G1 prints `default` | A3: P1.2 records applied effort for every session, `effortOf` answers roots; P1.2 pre-flight checks `agentOptions` |
| QA-4 | major | probe coverage overstated (no 2.0.25, no 2.0.26 `node_modules`, no `<name>/tui`) | S1 corrected; A9: P1.3 tarball check on 3 versions; P2.1 scenarios |
| QA-5 | minor | F1 cites `metadata.tsx:93` | `:69` |
| QA-6 | minor | v1 citation range; root `index.*` fallback of v1 TUI loader | S1 cites `shared.ts:103-114,136-157`; A9 packaging pin "no root `index.*`" |
| QA-7 | minor | rpc registry described as per process | per location, append/last-wins/dispose-restores |
| QA-8 | minor | retry rationale wrong | handler awaits activation; retry only on `rpc.unavailable` |
| QA-9 | minor | `rpc.ts:19-40` overruns; `Bun.resolveSync` unverified; "last wins per target" | `:19-31`; `resolveModule`; per plugin id |
| QA-10 | minor | §3 task text contradicts A2/A3 | A9 supersedes it |
| QA-11 | minor | local-path server entry auto-load uses `path.dirname(source.path)` | UNVERIFIED in S2; P2.1 scenario (A9) |
