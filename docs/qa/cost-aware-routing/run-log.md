# Run log — cost-aware routing engine (#74)

Delegation incidents, take-overs (§0.10.2), restarts and sync incidents, in time order (local time, 2026-10-06).

| When | Phase / task | Event | Action |
|---|---|---|---|
| ≈01:03 | 0.P.2 / 0.P.6 | `@fast` made the three preamble calls, then returned `NEED MORE` claiming it had no filesystem or shell tool | Re-dispatched once with a read/glob/grep-only task (§0.10.2). The second dispatch answered A–C; it reported 0 scorecard files (a glob miss: the directory holds 12 631) and missed the state file. The orchestrator ran the remaining shell checks itself (`opencode --version`, config dir listing, state file, scorecard counts). |
| ≈01:20 | 0.P.1 | `@medium` spike dispatch ended mid-task ("I'll finish the remaining step…") with files written but nothing committed | Resumed the same session; it finished, committed `2171400` and pushed. |
| ≈01:25 | 0.P.1 (S6) | An intermediate, unrecorded harness run failed S6 with `Compaction summary did not match the required template` (the scripted compaction summary did not follow the host template) and the tool returned an error | Scripted summary fixed in the harness; recorded runs compact successfully. Kept because it shows a failed compaction surfaces as a tool error. |
| ≈01:30 | 0.P.1 (S2) | First S2 report claimed the wire effort is "sticky" after a resume; the harness had only inspected the top-level `output_config.effort` | Follow-up spike S2b; the host delivers the new effort in-band. S2 evidence corrected (`ed873a4`). |
| ≈01:35 | 0.P.4 | Heavy verdicts issued by the orchestrator (Opus) per router rule 9 ("if self is opus: skip-@heavy") | Logged as a take-over of a `[tier:heavy]` task; QA stays a separate `@heavy` dispatch. |
| ≈01:45 | 0.P QA round 1 | `@heavy` QA: 1 critical, 8 major, 11 minor, 5 nit | All addressed (harness `5113977`, docs `1409f3a`). |
| ≈02:10 | 0.P QA round 2 | `@heavy` re-review: 20 resolved, 5 partial; new: 3 major, 7 minor, 2 nit | All addressed (harness `d9e2358`, docs/plan/handover in the following commit). |
| 2026-10-06T11:41:54Z | DF1 | Host restart for the DF1 code sync (A8) | Liveness probe `/router` → `engine=static build=2.2.0+8ce54f2`; resumed with Phase 2.1. |
| 2026-10-06 | 2.1 merge | Phase 2.1 (telemetry ingestion) QA PASS at round 3 | Merged into `car/main` as `a08229c`; report `phase-2.1.md`. |
| 2026-10-06 | Wave 2 | Two subagent sessions hit a socket disconnect | Resumed the same sessions; no work lost. |
| 2026-10-06 | Wave 2 | Router-grader returned spurious NOT ACCEPTED verdicts on in-progress notes | Not escalated; they were not verdicts on a deliverable (same pattern as the Wave 1 verdicts, handover §6). |
| 2026-10-06 | 2.2 / 2.3 merge | Phases 2.2 and 2.3 integrated on `car/p22`; QA: 2.2 round 2 PASS, integration round 1 PASS (all fixes applied), 2.3 round 3 PASS | Merged into `car/main` as `2878319`. Capped suite on `car/main` @ `2878319`: 137 files passed, 3 skipped; 11387 tests passed, 66 skipped; 255 s. |
| 2026-10-06 | DF2 | Code sync: `master` in the base checkout fast-forwarded to `2878319`; rollback tag `car/sync-2-prev` = `8ce54f2` | Awaiting the owner's restart (A8). After it: liveness probe (`/router` → `engine=static`, build `2.2.0+2878319`), `routing-stats`, create the global override file with `{"routing":{"engine":"shadow"}}`, then `[route pin]` on QA/heavy dispatches. |

## DF4 sync incident (2026-10-07)

- 00:15:38Z: base checkout `master` fast-forwarded 71815eb → 64e523a (rollback tag `car/sync-4-prev` = 71815eb), then `npm ci` started. A stale `.git/index.lock` (0 bytes, 2026-10-06 20:42) had blocked the first fast-forward attempt; it was removed after confirming no git process was running.
- 00:16:07Z: the OpenCode service restarted while `npm ci` was rebuilding `node_modules`. The plugin failed to load: `failed to load plugin … Cannot find package '@opencode-ai/plugin' imported from …\src\index.ts` (90 retries until 00:25:38Z). The host caches the failed resolve, so the package being present again since 00:16:07Z does not heal it; a further restart is required.
- Effect: the router plugin (tier agents, routing engine) was not loaded in the live host; `Task` with agent `fast` returned `Unknown agent: fast`. The `enforce` override written at ≈00:26Z was reverted to `{"routing":{"engine":"advise"}}` immediately; no dispatch ran under it.
- Root cause: process, not code. `npm ci` deletes `node_modules` first, and this sync ran it although `package-lock.json` did not change (only two `package.json` scripts were added: `smoke:routing`, `smoke:v1`).
- Mitigation (sync procedure from now on): run `npm ci` only when `package-lock.json` differs between the rollback tag and the new head, and finish it BEFORE asking for a restart; never sync while a restart may be pending.
- Advise-period stats (`--since 2026-10-06T20:32:23Z`, recorded before the incident): 112 decision rows, 28 resumes, 20 pinned, agreement 67/67, switched 0, kept for lack of evidence 23 of 84 fresh; `pinned && switched` = 0 over all 191 decision rows.

## Restart timing ledger (acceptance #13, QA-G-B10)

All times below are **UTC**, unlike the early local-time incident rows above. Duration is wall time from sync to the probe (or host-start proxy); it is **not** measured service downtime. DF2–DF4 liveness is inferred, not a read of the `/router` build marker. This ledger supersedes the DF2 row's historical "awaiting restart" status.

| Restart | Code sync | Probe / host-start proxy | Sync → probe duration | Evidence / qualification |
|---|---|---|---|---|
| DF1 | ≈2026-10-06T09:35:00Z | 2026-10-06T11:41:54Z | ≈2h 06m 54s | `/router` read: `engine=static build=2.2.0+8ce54f2`. Includes human idle time before the probe, not just restart time. Host start: 11:41:18.199Z. |
| DF2 | 2026-10-06T15:22:43Z | 2026-10-06T15:27:38Z | 4m 55s | Host-start proxy (log: 15:27:38.029Z); liveness inferred, `/router` marker not read. |
| DF3 | 2026-10-06T18:41:27Z | 2026-10-06T20:32:23Z | 1h 50m 56s | Host-start proxy (log: 20:32:23.782Z); liveness inferred, `/router` marker not read. |
| DF4 — failed start | 2026-10-07T00:15:38Z | 2026-10-07T00:16:07Z | 29s (to failed start) | Plugin failed to load during `npm ci`; not a successful liveness probe. Host 2.0.22; multiple concurrent `serve` startup lines at 00:16:06.884Z–00:16:07.028Z belong to this incident. |
| DF4 — good start | 2026-10-07T00:15:38Z | 2026-10-07T00:51:16Z | **35m 38s total**, including the incident | Host-start proxy (log: 00:51:16.123Z); liveness inferred from successful agent resolution/no router load failure, marker not read. **Host is now 2.0.24.** |
| Phase 3.3 — unplanned restart 1 | n/a (no code sync) | 2026-10-07T02:17:33.326Z | Not measured | `cli starting`, `serve --service`, host 2.0.24. Subagent runs interrupted, resumed by session id, no merged work redone. |
| Phase 3.3 — unplanned restart 2 (reported) | n/a (no code sync) | Later start time **unverified** | Not measured | Subagent runs interrupted, resumed by session id, no merged work redone (dispatch report). The read-only scan below contained no later matching host-start line; do not invent a timestamp. |

Startup evidence was read, not modified, from `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`, filtering actual `message="cli starting"` lines containing `serve` (not `spawning process` lines that merely quote a search command). The latest matching start available during this fix was `2026-10-07T02:17:33.326Z`. The orchestrator must supply/confirm the second unplanned restart's timestamp before acceptance #13 is fully evidenced.

**DF5 handoff (QA-G-A1 / QA-2.2-10):** measure the orchestrator's cache-read share with the stable `advise` hint enabled against the `shadow` baseline; include token totals, the denominator and sample windows. The dropped DF3 measurement is still outstanding. `enforce` now emits no per-turn hint.
