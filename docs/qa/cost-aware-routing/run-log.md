# Run log — cost-aware routing engine (#74)

Delegation incidents, take-overs (§0.10.2), restarts and sync incidents, in time order.

| When (local) | Phase / task | Event | Action |
|---|---|---|---|
| 2026-10-06 ≈01:03 | 0.P.2 / 0.P.6 | `@fast` made the three preamble calls, then returned `NEED MORE` claiming it had no filesystem or shell tool | Re-dispatched once with a read/glob/grep-only task (§0.10.2). The second dispatch answered A–C; it reported 0 scorecard files (a glob miss: the directory holds 12 631) and missed the state file. The orchestrator ran the remaining shell checks itself (`opencode --version`, config dir listing, state file, scorecard counts). |
| 2026-10-06 ≈01:20 | 0.P.1 | `@medium` spike dispatch ended mid-task ("I'll finish the remaining step…") with files written but nothing committed | Resumed the same session; it finished, committed `2171400` and pushed. |
| 2026-10-06 ≈01:30 | 0.P.1 (S2) | First S2 report claimed the wire effort is "sticky" after a resume; the harness had only inspected the top-level `output_config.effort` | Follow-up spike S2b; the host delivers the new effort in-band. S2 evidence corrected (`ed873a4`). |
| 2026-10-06 | 0.P.4 | Heavy verdicts issued by the orchestrator (Opus) per router rule 9 ("if self is opus: skip-@heavy") | Logged as a take-over of a `[tier:heavy]` task; QA stays a separate `@heavy` dispatch. |
