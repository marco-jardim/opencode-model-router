# Run log — cost-aware routing engine (#74)

Delegation incidents, take-overs (§0.10.2), restarts and sync incidents, in time order.

| When (local) | Phase / task | Event | Action |
|---|---|---|---|
| 2026-10-06 ≈01:03 | 0.P.2 / 0.P.6 | `@fast` made the three preamble calls, then returned `NEED MORE` claiming it had no filesystem or shell tool | Re-dispatched once with a read/glob/grep-only task (§0.10.2). The second dispatch answered A–C; it reported 0 scorecard files (a glob miss: the directory holds 12 631) and missed the state file. The orchestrator ran the remaining shell checks itself (`opencode --version`, config dir listing, state file, scorecard counts). |
| 2026-10-06 ≈01:20 | 0.P.1 | `@medium` spike dispatch ended mid-task ("I'll finish the remaining step…") with files written but nothing committed | Resumed the same session; it finished, committed `2171400` and pushed. |
| 2026-10-06 ≈01:30 | 0.P.1 (S2) | First S2 report claimed the wire effort is "sticky" after a resume; the harness had only inspected the top-level `output_config.effort` | Follow-up spike S2b; the host delivers the new effort in-band. S2 evidence corrected (`ed873a4`). |
| 2026-10-06 ≈01:25 | 0.P.1 (S6) | An intermediate, unrecorded harness run failed S6 with `Compaction summary did not match the required template` (the scripted compaction summary did not follow the host template) and the tool returned an error | Scripted summary fixed in the harness; the recorded run compacts successfully. Kept here because it shows a failed compaction surfaces as a tool error. |
| 2026-10-06 ≈01:45 | 0.P QA round 1 | `@heavy` QA: 1 critical, 8 major, 11 minor, 5 nit | All fixed in round 1 (harness `5113977`, docs and plan amendments); see `phase-0P.md` Findings. |
| 2026-10-06 | 0.P.4 | Heavy verdicts issued by the orchestrator (Opus) per router rule 9 ("if self is opus: skip-@heavy") | Logged as a take-over of a `[tier:heavy]` task; QA stays a separate `@heavy` dispatch. |
