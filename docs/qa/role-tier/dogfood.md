# Dogfood record — Role × Tier × Assurance delegation (#84)

Executor-owned (plan §0.10, §4). Written and committed only in `D:\git\omr-rta-main` on `rta/main`. Holds aggregated
counts and decision-row fields only — never prompt text, tool arguments or file contents from the live store.

## Baseline (P0.1 pre-flight step 5) — 2026-10-08T02:37Z

### Live host and base checkout

| Item | Value |
|---|---|
| Host | `opencode --version` → `opencode v2.0.24` |
| Base checkout | `D:\git\opencode-model-router` on `master` @ `eeab36bce8bcc72f481a6e4fd919b47daebfa051`, `status --porcelain` empty |
| Owner state (read-only) | `activePreset: anthropic`, `activeMode: normal`, `enforcementMode: advisory` |
| Override SHA-256 | `700E25876937EB740748AB4B10EAF1CDDD4C7E29C7FDD8B84F23C609B0BE88F8` (`C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`); copy kept at `C:\Users\Marquinho\AppData\Local\Temp\Claude\rta-override-last.jsonc` |

### §0.7 liveness commands on `master` code

1. **`/router` marker.** Format read from `src\router\build-info.ts` (`formatRouterLine`):
   `router: engine=<mode> build=<version>+<sha7>`. For the live code: version `2.3.0` (`package.json` line 3), sha7
   `eeab36b`, engine `enforce` (owner override) → expected line `router: engine=enforce build=2.3.0+eeab36b`. No human
   round trip at P0.1 (plan §5 P0.1 step 5).
2. **Host log** `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`: plugin-load lines present, e.g.
   `timestamp=2026-10-08T02:35:32.975Z level=INFO … msg="loading plugin" id="D:\\git\\opencode-model-router"
   entrypoint=file:///D:/git/opencode-model-router/server.ts role=server`. Genuine `failed to load plugin` lines: 0.
   Caveat (R5): the host logs every shell command it spawns (`message="spawning process" … args=…`), so a plain
   `Select-String 'failed to load plugin'` also matches the executor's own probe command. The probe must exclude
   `message="spawning process"` lines.
3. **Agent list** `opencode api get '/api/agent?location%5Bdirectory%5D=D%3A%5Cgit%5Copencode-model-router'` works on
   2.0.24. Agents (name | mode | model):

   | Agent | Mode | Model |
   |---|---|---|
   | Build, Compaction, Plan | primary | — |
   | Title, Summary | primary | `anthropic/claude-haiku-5-5` |
   | General | subagent | — |
   | Explore | subagent | `anthropic/claude-haiku-5-5#low` |
   | model-router-grader | subagent | — |
   | fast | subagent | `anthropic/claude-haiku-5-5#low` |
   | medium | subagent | `anthropic/claude-sonnet-5-5#medium` |
   | heavy | subagent | `anthropic/claude-opus-5-5#xhigh` |
   | runner, researcher | subagent | `anthropic/claude-haiku-5-5#low` |
   | reviewer | subagent | `anthropic/claude-opus-5-5#xhigh` |

### DF-1 self-test probes on `master` code (the reference DF-1 compares against)

All three ran from the executor's session with work root `D:\git\omr-rta-main` (read-only work).

**Probe 1 — read-only `fast`, 10 consecutive reads.** The router's default dispatch cap for `fast` is `CAP:8`, so the
first dispatch stopped after 8 reads with `[⚠ CAP REACHED (8/8) …]`; the same session was resumed with `CAP:12` for
reads 9–10 (R5: the DF-1 probe must carry `CAP:12`).
- Reads 1–8: no guard footer; `[cap: N/8]` counters and `[⚠ CAP WARNING …]` on reads 6–7.
- Reads 9–10 (resumed session): `[⚠ GUARD:read_budget] [budget 0/25 | deliverable=n/a | reads_since_produce=8] NEXT:
  take a producing action (write/edit) or emit your final answer` and `… [budget 1/25 | … | reads_since_produce=9] …`.
- Totals: 10 reads, 0 denied, 2 with a `GUARD:read_budget` footer. Note: `reads_since_produce` survived the resume
  while the `budget` counter restarted at 0.

**Probe 2 — `[route class=review risk=high pin]` heavy, `CAP:none` + `reason:`, 20 reads.**
- 20 reads, 0 denied, 9 with `[⚠ GUARD:read_budget] [budget N/25 | deliverable=n/a | reads_since_produce=N] NEXT:
  take a producing action (write/edit) or emit your final answer`; first footer on read 4
  (`budget 3/25 | reads_since_produce=3`), last on read 20 (`budget 18/25 | reads_since_produce=18`).
- `[cap: N/∞]` on every read (`CAP:none` honoured for the read-only counter). The guard `budget` counter ran 1–2 below
  the `cap` counter; reads were issued in parallel batches of five, so footer presence per read was intermittent.

**Probe 3 — delegation with a long acceptance block (verdict criteria whole).**
- 3a: `fast` lookup, `VERIFY:required`, `check: fileExists` + two long `criteria:` lines → `[router ✓ verified:
  deterministic]` (the deterministic check settled it; no grader text).
- 3b: same shape with `criteria:` lines only (≈ 400 characters each) → `[router ✓ verified: checker]`.
- No `NOT ACCEPTED` and no truncated criterion observed on `master` code for these two dispatches; E8 did not
  reproduce here. DF-1 repeats 3b and additionally checks the live decision log's verdict text (read-only copy).

### Test baseline

- Capped full suite on `rta/main` @ `a8b1905` (`npx vitest run --maxWorkers=2`, 353.6 s): `Test Files 1 failed | 152
  passed | 3 skipped (156)`, `Tests 1 failed | 12016 passed | 66 skipped (12083)`. The failure is the known flake
  `test\unit\exec.test.ts` › `lowPriority > runs grandchildren of runArgv below normal priority` (`spawnSync
  powershell.exe ETIMEDOUT`); re-run alone: `42 passed | 2 skipped (44)`.

## DF-1 — §2.9 fixes live (sync 2026-10-08T12:07Z)

| Item | Value |
|---|---|
| Pre-flight | Wave 1 CI 16/16 green on PR #85 head `741a835`; capped suite on `741a835`: 165 files passed / 3 skipped, only `test\unit\exec.test.ts` load flakes (3 tests, ETIMEDOUT / timing) which passed alone (42 passed / 2 skipped); base checkout clean on `master` @ `eeab36b`; override SHA-256 unchanged (`700E2587…88F8`) |
| Rollback tag | `rta/df1-prev` → `eeab36b` |
| Sync | `git -C D:\git\opencode-model-router switch --no-track -C rta/live origin/rta/main` → `741a8359c4532bdefa7a6d2e6f1bd6be175b169f` |
| `npm ci` | not needed (`package-lock.json` identical `eeab36b`..`741a835`) |
| Roles | inert (`routing.delegation` absent → `tiers`) |
| Restart | owner restarted OpenCode v2 at 2026-10-08T12:34Z (service `opencode serve --service` PID 78648 started 12:34:27Z) |

### DF-1 liveness probe (2026-10-08T12:40Z) — PASS

- `/router` line pasted by the owner: `router: engine=enforce build=2.3.0+741a835` → matches the synced commit.
- Host log: plugin-load lines for `D:\git\opencode-model-router` after the restart; 0 genuine `failed to load plugin` lines since 12:00Z (spawn lines excluded, R5).
- `/api/agent` (location `D:\git\opencode-model-router`): fast/medium/heavy, runner, reviewer, researcher, model-router-grader present with the same models as the P0.1 baseline.
- `/router` also printed the pre-existing cost-doctor `variant-effort` warnings for the bundled anthropic tiers (not introduced by this work; owner's choice).

### DF-1 self-test probes (vs P0.1 baseline) — PASS

| Probe | P0.1 (master) | DF-1 (`741a835`) |
|---|---|---|
| 1. read-only `fast`, `CAP:12`, 10 reads | 2 reads with `[⚠ GUARD:read_budget]` (after a resume) | 10 reads, 0 denied, 0 `GUARD` footers (only `[cap: N/12]` and one `CAP WARNING`) |
| 2. heavy `[route class=review risk=high pin]`, `CAP:none` + `reason:`, 20 sequential reads | 9 of 20 with `[⚠ GUARD:read_budget] … take a producing action`, first at read 4 | 20 reads, 0 denied, 0 `GUARD` footers (`[cap: N/∞]` only) |
| 3. long `[acceptance]` criteria, `VERIFY:required` | `[router ✓ verified: checker]` | `[router ✓ verified: checker]`; no `NOT ACCEPTED`, no truncated criterion |

The 25-call tier budget is unchanged in tiers mode (E7 is addressed by role budgets at DF-2).
## DF-2 — roles mode (sync 2026-10-08T19:04Z)

| Item | Value |
|---|---|
| Pre-flight | Wave 2 CI 17/17 green on PR #85 head `ae67429`; capped suite on `ae67429`: 173 files passed / 3 skipped, only the known `test\unit\exec.test.ts` lowPriority flake (passed alone 42/2); DF-1 record complete; base clean on `rta/live` @ `741a835`; override SHA-256 unchanged (`700E2587…88F8`) |
| Rollback tag | `rta/df2-prev` → `741a835` |
| Sync | `git -C D:\git\opencode-model-router merge --ff-only origin/rta/main` → `ae674298942a2a2ca05adc0ba97ef17f654aa865` |
| `npm ci` | not needed (`package-lock.json` identical `741a835`..`ae67429`) |
| Restart 1 of 2 (R8) | owner restarted at 2026-10-08T19:08Z (service `opencode serve --service` PID 65852 started 19:08:11Z) |
### DF-2 liveness probe after restart 1 (2026-10-08T19:15Z) — PASS

- `/router` line pasted by the owner: `router: engine=enforce build=2.3.0+ae67429` → matches the synced commit.
- Host log: plugin-load line for `D:\git\opencode-model-router` at 19:08:16Z; 0 genuine `failed to load plugin` lines since 19:00Z.
- `/api/agent`: Build, General, Explore, Compaction, Title, Summary, Plan, model-router-grader, fast, medium, heavy, runner, reviewer, researcher — tiers mode as expected (the override has no `delegation` yet).
- Next: override migration validated in a temp HOME (candidate and kill switch), then the write and restart 2 of 2.
### DF-2 step 2 — owner override migration (2026-10-08T19:10Z local 16:10)

| Item | Value |
|---|---|
| Validation | temp HOME on code identical to `ae67429` in `src` (report `C:\Users\Marquinho\AppData\Local\Temp\Claude\df2-validate-A.json` / `-B.json`): candidate → delegation `roles`, workRoots `["D:/git/omr-rta-*"]`, engine/profile/margin kept, 0 notices, 7 roles enabled (explorer, researcher, runner fast–medium; implementer, general fast–heavy; reviewer heavy; architect medium–heavy), no `agents`/`subagentTiers`; kill switch (pre-DF-2 file) → tiers mode, `subagentTiers.explore = fast`, agents runner/reviewer/researcher, 0 notices |
| Backup (kill switch) | `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc.bak-2026-10-08_16-10-50` (SHA-256 `700E2587…88F8`) |
| New override SHA-256 | `E73373581618F1193A4E3AF9264FD59E603C1D66B2ECF100C4F3C246A1C50750` (copy at `C:\Users\Marquinho\AppData\Local\Temp\Claude\rta-override-last.jsonc`) |
| Config diff | `routing` += `delegation: "roles"`, `workRoots: ["D:/git/omr-rta-*"]`; removed `subagentTiers.explore`; removed custom `agents` runner, reviewer, researcher (replaced by shipped roles) |
| Restart 2 of 2 (R8) | owner restarted at 2026-10-08T19:11Z (service PID 60388 started 19:11:41Z) |
### DF-2 step 3 — roles mode live (2026-10-08T19:12Z) — PASS

- `/router` (owner paste): `build=2.3.0+ae67429`, a "Roles:" block listing the 7 roles with ranges and authority, advisor info `native-explore-aliased` and `role-usage-share` (0 of 1005 historical dispatches were role dispatches).
- `/api/agent`: explorer, researcher, runner, implementer, reviewer, architect registered (+ host `General` replaced by the role: steps 255); floor-tier fallback models (explorer/researcher/runner/implementer/General haiku#low, architect sonnet#medium, reviewer opus#xhigh); steps 95 (fast–medium roles) / 255 (others); 0 genuine plugin load failures since 19:00Z.
- The orchestrator system prompt carries `## Role Delegation Protocol (MANDATORY)`.

### DF-2 step 4 — self-test probes (role dispatches from this session; decision rows from a read-only copy of the live log)

| Probe | Role → routed model (row) | Result |
|---|---|---|
| explorer lookup in `D:\git\omr-rta-p23` | explorer → haiku#low (fast; grant glob/grep/read/router_git; binding exact) | PASS: answer correct, no guard footers |
| runner scoped test via `router_run` (`test-files`, cwd = worktree) | runner → haiku#low (grant + router_run) | PASS: exit 0, `Test Files 1 passed`, `Tests 2 passed` |
| implementer throwaway file, `d=deterministic` + `fileExists` | implementer → sonnet#medium (floor:authority; classifier risk medium; detection deterministic) | file created (verified, then deleted); **gate UNVERIFIED** — checks ran in the session directory, not the work root (finding DF2-F1) |
| implementer `[route class=implement risk=high tier=heavy pin]` | implementer → opus#xhigh (pinned:heavy) | PASS |
| general without edit vocabulary → expect edit denied → ladder | general → sonnet#medium, grant included `edit` in all 3 attempts (classifier needs `edit` every time) | ladder not exercised live (finding DF2-F2); ladder covered by P2.3 integration tests; P3.1 real-host smoke must prove it end to end |
| reviewer 40 sequential reads | reviewer → opus#xhigh (heavy..heavy) | PASS: 40/40, 0 denied, 0 guard/budget footers (E7 solved by role budgets) |
| researcher web lookup | researcher → haiku#low (grant context7/webfetch/websearch) | PASS: web egress works; tool list WebFetch/websearch only, no local tools |
| negative: read `C:\Windows\win.ini` and the base checkout from the worktree root | explorer | PASS: both denied by the router ("outside this dispatch's work root"); a parallel-call re-probe showed each refusal names its own path (the first probe's child misreported the second message) |

Self-test findings (to fix in Wave 3, P3.3 fix branches; plan §0.10):
- **DF2-F1 (major) — fixed** in `rta/p33-fix-1` (role checks run in the bound work root; resumes keep it) and proven on the real host (P3.1 smoke): a role dispatch's `[acceptance]` checks run in the session directory instead of the dispatch's work root, so deterministic checks on a worktree root are unverifiable while the router still treats detection as deterministic for the floor. Workaround until fixed: every acceptance block carries `cwd: <work root>`.
- **DF2-F2 — fixed** as QA-G-B-3 (rated major) in `rta/p33-fix-4`: the classifier ran with the session directory as cwd (in-root absolute paths became `external_dir`) and a class-implied `edit` (from "a new file" → `implement`) survived `class=other`; dynamic roles now classify in the bound root and `needs=` replaces the text needs. Original note: the rules classifier attributes `edit` to `class=other` prompts that contain no edit vocabulary (3/3 general probes), which makes the authority ladder rarely reachable live; investigate the matched term.
- Observation: classifier noise also gave the explorer `shell` and the researcher `risk=high`; harmless for fixed roles.

## Wave 3 — executed through role agents (2026-10-08T19:12Z → 2026-10-09)

All P3.1, P3.2 and P3.3 work was dispatched as role agents (explorer, researcher, runner, implementer, reviewer, general);
no tier agent was named. Decision rows from a read-only copy of the live log (`decisions.jsonl`, rows with a role since
19:12Z): 390 role rows.

| Role, tier (dispatch rows with a grant) | Count |
|---|---|
| implementer, heavy (mostly `tier=heavy pin`) | 82 |
| implementer, medium | 8 |
| reviewer, heavy | 47 |
| explorer, fast / medium | 26 / 2 |
| researcher, fast | 10 |
| general, medium / heavy | 3 / 1 |
| runner, fast | 2 |

Signal and binding notes: `note:binding:exact` 143, unknown bindings 0; `verdict:pass` 36, `verdict:fail` 16,
`incomplete:fail` 13, `budget:none` 1. These rows predate the P3.3 fixes (the live host still runs `ae67429`), so grader
verdicts appear as `verdict` rows (fixed in `rta/p33-fix-2`) and advisory budget returns as `incomplete` (fixed as QA-G-A3-1).

Observed in use: the router's grader timed out (60 s) on most large fix reports and twice rejected results on truncated
criteria; heavy children died on transport errors and were resumed by session id; resuming a reviewer bound to one root
could not read a sibling worktree (expected: a resume keeps its bound root).