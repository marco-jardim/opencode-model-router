# Offline critical-path fixtures

`throughput.md` and `resilience.md` use the same three repository roots, task IDs,
ownership, two waves and four phases. Copy each repository into an isolated run
root before compiling a plan; resolve plan paths relative to that run root.
The harness supplies scripted child responses and a virtual clock, not remote
models or real sleeps. These fixtures exercise OpenCode v2 only.

| Repository | Provisioning | Phase suite |
| --- | --- | --- |
| `node-pnpm` | `pnpm install --offline --frozen-lockfile` | `pnpm run typecheck` then `pnpm test` |
| `node-npm` | `npm ci --offline --ignore-scripts --no-audit --no-fund` | `npm test` |
| `py-pip` | Create the interpreter environment with the offline harness; `requirements.txt` has no installs. | `python -m pytest tests` |

Both Node repositories have dependency-free lockfiles. Supply Node 22.6+,
pnpm and TypeScript on the harness PATH before starting; no registry access is
needed. Supply pytest from the harness's pre-provisioned Python environment,
as in `../repos/py-pip`; do not download packages or add a Python project or lock
file. The TypeScript repository's `typecheck` script uses that provisioned `tsc`.

The npm task-level check runs only `node --test test/index.test.js`; the phase
suite also runs `test/phase.test.js`. This distinction is deliberate: resilience
can introduce a negative-total regression which the local check does not cover,
without modifying or weakening either test.

## Script sidecars (schemaVersion 1)

`throughput.script.json` and `resilience.script.json` are the driver's source of
truth for deterministic work and injections. `scripts.ts` exports `loadScript`,
the typed schema and `scriptedTurns`; `fixtures.test.ts` checks both JSON files
against the compiled plans and the provider's reply/findings grammar.

- `tasks` has exactly the 24 initial plan IDs. `durationMs` agrees with the plan's
  `Scripted duration`. A `writePath` expands to a real v2 `write` tool turn using
  `content` (or `defaults.content`), then `defaults.completion`. A QA entry expands
  to canonical FINDINGS_FORMAT JSON from `findings` or `defaults.qa`. An
  `escalation` expands to `ESCALATE: <reason>`; the reason itself begins `human:`.
  Explicit `turns` replace that expansion and use the provider's `CpxReply` shape.
- `scriptedTurns` returns `{delayMs, reply}` frames suitable for `front.replyNext`.
  Equivalently queue writes with `front.writeNext(path, content)`, escalations with
  `front.escalateNext(reason)` and QA with `front.findingsNext(report)`. All paths
  are aggregate-run-root-relative; rebase write paths to the assigned slot (or
  the shared run root for a non-plan call). Never write directly from the provider.
- Match requests to a child/attempt, not global request arrival order. Plan child
  prompts carry executor task IDs; non-plan prompts carry `CPX_E2E_CALL=<id>`.
  A queue entry's `when` predicate must keep unrelated children from consuming it.
  Queue one scripted attempt per launch and preserve its turn cursor across HTTP
  retries. The entire work duration is charged on its first successful scripted
  request only, with zero delay on subsequent turns. Map frames to `delayMs`,
  `sleep` and `now` on `CpxFront`; record `requests[].durationMs`. Advance a
  controlled monotonic clock, including concurrent waits, rather than summing
  all concurrent delays or using wall-clock sleeps. Fault requests have their
  own `faultDelayMs`, do not consume replies and must not repeat the work delay.
- `executor` sets `maxParallel: 4` and `crossPhase: "inferred"`; use those options
  for compilation too. The compiler calls `Order:` edges `structural`, even
  though the order is explicitly authored. The unlisted first-to-fourth pair in
  each phase is deliberately inferred as a `conflict` read/write edge. Do not
  add a serialization edge for the hidden overlap.
- `localChecks` and `phaseSuites` are argv arrays and repository-relative working
  directories. Run real checks with the offline toolchains. Phase checks run on
  the tentative integration; a failed check must leave the integration head
  green. In a single-repository smoke iteration the driver must still seed all
  three directories in the aggregate root so every declared path resolves.

## Resilience checkpoints and recovery

`injections` are driver instructions, not extra plan tasks or magical provider
features. Reach checkpoints from observed host/ledger events, not fixed sleeps:

| Injection | Required driver action |
| --- | --- |
| `hidden-overlap` | Hold 1.1.2's acquired lease/completion until 1.1.3's first tool write is refused. Use slots of the same git repository, so identical logical paths share a lease key. Check the refusal names the lease holder and leaves the file unchanged; do not accept a generic tool/scope error as proof. |
| `phase-only-regression` | 1.2.3 writes the clamp via host tools. Observe local exit 0 and phase exit 1, reject integration, then run `recovery` in a corrective attempt and rerun the real suites. The original tests stay unchanged. |
| `human-escalation` | Observe the human queue item, allow `independentTask` to progress while it waits, then submit `answer` and use `recovery` for the approved attempt. |
| `qa-findings` | Use the report on 2.1.QA. The executor creates the two `fixTasks` and `reviewTask`; service them from `generatedTasks`. Do not pre-add these IDs to the plan. |
| `rate-limit` | Before 1.2.2's first request, queue `front.failWhen(childMatcher, fault, options)`. Exactly three matching requests receive 429; retries leave successful turns queued. |
| `host-restart` | After durable integration of 2.1.1, wait for 2.1.4 to be running, stop the host, retain git/ledger state, restart and issue `resumeCommand` for that plan. Serve `recovery` if the orphan is retried. Compare normalized final state, integration commits and exactly-once effects with a separate uninterrupted baseline (timestamps/attempt IDs may differ). |
| Background injections | Launch the entries in `backgroundDispatches` while 2.2.2 is running. They are NOT plan tasks. Explicitly foreground the `user-backgrounded` entry first, then invoke the host's user-background action while it is running and check completion-time verification. |
| `required-verification` | Only if C4 AND C15 hold, background `required-held`, gate its verdict until context AND compaction show the permanent placeholder, then release a PASS verdict. Assert no early output, one verdict delivery and one wake. Otherwise override `background` to false and assert foreground verification; do not claim a held-result pass. |

`generatedTasks` and each injection's `recovery` carry their own durations; they
are excluded from throughput W/CP. Background dispatches include acceptance
blocks for completion verification and write disjoint paths. The driver must
await all of them before checking the tail. Every named `tailAssertions` entry
is an assertion obligation for 6.1.3, not an expected result to fabricate, except
`G8-makespan-bound`: owner amendment A-6.1-2 makes it measured/disclosed only
(bound, ratio and met status), not a pass/fail bound assertion. In particular
check the ad hoc dispatch's annotation exactly once in the tail and
that none of its IDs appears among the 24 compiled tasks. Throughput has empty
injections, four empty QA reports and only clean first-attempt completions (G8).
