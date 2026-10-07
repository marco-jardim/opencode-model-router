# Dogfood — the cost-aware routing plan measures itself (#74)

Final checkpoint and cross-period table: [DF5](#df5), [Summary](#summary). The routing store is host-wide; the final report distinguishes it from the plan orchestrator's session-only cache measurement.

> Workload caveat: the workload is this plan's own execution (implementation-heavy, QA-heavy, pinned heavy dispatches). The numbers are evidence of behaviour, not a benchmark.

## DF5

**Snapshot / window.** Live `decisions.jsonl*` and `outcomes.json` were copied to `C:\Users\Marquinho\AppData\Local\Temp\opencode\p34-1791346419` at the start of Phase 3.4. Every stats invocation uses `--dir <copy>`. The fixed enforce window is **[2026-10-07T00:51:45Z, 2026-10-07T04:13:39.877Z)**. Files copied: one `decisions.jsonl` (SHA-256 `f8ecad2b9d703befe3e07b711fa4a0db159c45fe2dc800d96d402d6a22ceef9e`) and `outcomes.json` (`6e948cb7aeaeb7b47ce5982ffedb2754da71cefe82e0343bfcd61afe2d4f6d80`). The local snapshot and the bounded `.json`/`.md` CLI outputs are retained in that directory; private raw stores are not committed.

**D17 rule and result.** Leave `enforce` if zero switched dispatches ended in a `fail` verdict during the enforce period; otherwise use `advise`. Floor lifts, resumes, pins and shadow/advise would-switches do not count. The copied period has **0 enforced switches, 0 verified enforced switches, 0 failed switched dispatches**. The exact CLI line is:

```text
| D17 mode (use the DF4→DF5 enforce-period window) | n/a (0 enforced switches) |
```

`d17Mode` intentionally reports no switching evidence. Nevertheless, D17's literal **zero switched+fail** condition holds, so the resulting mode is **enforce**. This is a safety-rule result, not evidence that switching saves money or succeeds. **No live override was edited here; the orchestrator applies/retains the resulting mode.** The CLI joins switched decisions to verdicts across the snapshot (including later verdicts), while dispatch windows are half-open. With zero switches, this distinction does not change this result.

**Sync 5 / code boundary (QA-3.4-13 correction).** `master` → `93db126` has a sync-completion record at **2026-10-07T03:40:45Z**, not an exact file-change timestamp. In `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`, router `msg="loading plugin"` entries are already present at **03:40:41.517Z / 03:40:41.546Z**, existing run **`ed92edfe`**. **The new code was live without a restart by 03:41:05.545Z**, the first decision row with the 3.3 audit fields; neither watcher causality nor a 20-second reload duration is established. The bounded split stays at **03:41:05Z**, immediately before that first row. Earlier rows ran pre-3.3 code. The same log directly records the owner restart at **04:11:34.806Z**, `message="cli starting"`, host **2.0.24**, run **`b5f6e377`**. A restart-only boundary would incorrectly label earlier audit-bearing rows. Details are in [run-log.md](run-log.md#df5-liveness-and-timing-correction).

| Enforce slice (UTC, half-open) | Dispatches | Resumes | Pinned | Agreement | Switched / enforced / failed | Savings | False refusals | Variant steps / pass |
|---|---:|---:|---:|---|---|---|---:|---|
| 00:51:45 → 03:41:05, pre-3.3 | 53 | 11 | 11 | 21/21 (100%) | 0 / 0 / 0 | 0.00 ratio over 21 rows | 0 | 0 / n/a |
| 03:41:05 → 04:13:39.877, post-3.3 | 3 | 0 | 0 | 3/3 (100%) | 0 / 0 / 0 | 0.00 ratio over 3 rows | 0 | 0 / n/a |
| Whole DF4 → DF5 window | 56 | 11 | 11 | 24/24 (100%) | 0 / 0 / 0 | 0.00 ratio over 24 rows | 0 | 0 / n/a |

**Post-3.3 never-down audit (expected 0):**

```text
| High-risk d=none rows that ran below the pick's capability rank (D9 never-down, A34; expected 0) | 0 of 2 recorded |
```

Pre-3.3: `n/a (no row records detection and capability)`, not a retroactive safety pass. **`switched` is false on all 247 decision rows**, hence **`pinned && switched` = 0 over ALL 247 decision rows** in the copied log (not just DF5). This pin invariant is vacuous evidence when nothing switched. Whole-window kept-for-evidence: 2 of 45 fresh dispatches. Verdicts on all keys: 2 pass, 1 fail, 2 unverifiable; that fail is **not** a switched-dispatch failure. Dollar measurements remain n/a (unpriced).

### Whole-window DF5 routing:stats output

Verbatim retained `<copy>/df5.md`, produced by `node scripts/routing-stats.ts --dir <copy> --since 2026-10-07T00:51:45Z --until 2026-10-07T04:13:39.877Z`:

```text
## Routing stats

Window: 2026-10-07T00:51:45.000Z → 2026-10-07T04:13:39.877Z

| Metric | Value |
|---|---|
| Dispatches | 56 |
| Routed dispatches | 56 |
| Delegate first attempts | 0 |
| Floor lifts | 0 |
| Pinned | 11 |
| Agreement (best == chosen, non-pinned) | 24/24 (100.0%) |
| Switched | 0 of 24 non-pinned routed (0.0%); enforced 0; failed 0 (verified 0 of 0 enforced) |
| D17 mode (use the DF4→DF5 enforce-period window) | n/a (0 enforced switches) |
| Estimated savings (ratio) | 0.00 over 24 rows |
| Variant steps | 0 taken; pass n/a |
| Orchestrator resumes (task_id / sessionID; not a ladder step, never switched, outside every routing metric) | 11 of 56 routed dispatches |
| Kept for lack of evidence (A27, fresh dispatches) | 2 of 45 fresh routed dispatches |
| High-risk d=none rows that ran below the pick's capability rank (D9 never-down, A34; expected 0) | 0 of 2 recorded |

### By class

| Class | Dispatches |
|---|---|
| debug | 3 |
| design | 12 |
| implement | 11 |
| mechanical | 2 |
| other | 1 |
| recon | 2 |
| review | 12 |
| search | 2 |

### By key

| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/attempt (lifetime) |
|---|---|---|---|---|---|---|---|---|---|
| debug\|host:general\|anthropic/claude-opus-5-5#default | 3 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |
| debug\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 0 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| debug\|router:medium\|openai/gpt-6-astra-fast#high | 0 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| design\|host:general\|anthropic/claude-opus-5-5#default | 11 | 11 | 0 | 0 | 0 | n/a | 0 | 0/11 (0.0%) | n/a |
| design\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| design\|router:medium\|openai/gpt-6-astra-fast#high | 0 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| implement\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 3 | 3 | 0 | 1 | 0 | 0/1 (0.0%) | 0 | 0/3 (0.0%) | n/a |
| implement\|router:medium\|openai/gpt-6-astra-fast#high | 8 | 8 | 0 | 0 | 1 | n/a | 0 | 0/8 (0.0%) | n/a |
| mechanical\|router:medium\|openai/gpt-6-astra-fast#high | 2 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| other\|router:medium\|openai/gpt-6-astra-fast#high | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| recon\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 0 | 1 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/1 (0.0%) | n/a |
| recon\|router:medium\|openai/gpt-6-astra-fast#high | 2 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| review\|host:general\|anthropic/claude-opus-5-5#default | 5 | 7 | 0 | 0 | 1 | n/a | 0 | 0/7 (0.0%) | n/a |
| review\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 6 | 8 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/8 (0.0%) | n/a |
| review\|router:medium\|openai/gpt-6-astra-fast#high | 1 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |
| search\|router:fast\|openai/gpt-6-luna-fast#medium | 2 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |

### Gated by evidence (trace.argmin)

| Cheapest key held back | Rows |
|---|---|
| design\|router:medium\|openai/gpt-6-astra-fast#high | 11 |
| implement\|router:fast\|openai/gpt-6-luna-fast#medium | 3 |
| review\|router:fast\|openai/gpt-6-luna-fast#medium | 2 |
| debug\|router:fast\|openai/gpt-6-luna-fast#medium | 1 |
| implement\|router:medium\|openai/gpt-6-astra-fast#high | 1 |
| other\|router:fast\|openai/gpt-6-luna-fast#medium | 1 |

### Resume vs fresh

| Step | Resume | Fresh |
|---|---|---|
| variant | 0 | 0 |
| retry | 0 | 0 |
| escalate | 0 | 0 |

_Verdict and false-refusal rates cover trusted classes only: dispatches whose class confidence reached `routing.minClassConfidence` and whose class is not `unknown`. Other dispatches have a decision row but no verdict or refusal rows, so Dispatches can exceed Pass + Fail + Unverifiable by design._
```

### Cache-read share — QA-G-A1 / QA-2.2-10

**Read-only discovery:** `opencode session --help` confirms `list` and `export`; current v2 CLI docs also describe `opencode stats --json`. Those data commands connect to the service, so none was run. The initial DB/WAL file copy is **superseded by QA-3.4-8's consistent SQLite online backup**, taken with Node 24 `node:sqlite.backup` from a **read-only** connection to `C:\Users\Marquinho\.local\share\opencode\opencode.db`. A read transaction was established before backup to hold a consistent snapshot. No service/API request, live database write, or credential-file read was made.

Snapshot: **`<copy>/session-backup-r1.db`**, backup started **2026-10-07T04:41:36.289Z**, finished **04:43:30.559Z**, **1,865,172 pages**. SHA-256: **`c42c21c6bc5f86aa53e221e78432d566ca4cac8e96ab4b0a3f58d1b6cfdb517f`**. `PRAGMA quick_check` on this backup returned **`ok`**. All queries below were re-run on this backup with the original fixed cutoff; the original three-window token sums and percentages were unchanged. The backup contains private session data and remains outside the repository.

The plan's root session is `ses_ef09ca71effe2FoiBgxxJuCg6W` (`session_v2.parent_id IS NULL`, directory `D:/git/opencode-model-router`). It was the only root session in that directory updated during the measured period. Children, graders, other projects, synthetic messages and compactions are excluded. Select `session_message.type = 'assistant'` with **`data.time.completed` in the half-open window**; use per-message usage, not lifetime session totals. The host records non-cache input separately, so **total input = `tokens.input + tokens.cache.read + tokens.cache.write`**; the numerator is `tokens.cache.read`. Output and reasoning tokens are not part of the denominator.

| Mode / window (same DF3–DF5 bounds below) | Completed assistant records | Records with usable tokens | Non-cache input | Cache read | Cache write | Total input denominator | Cache-read share (usable records) |
|---|---:|---:|---:|---:|---:|---:|---:|
| shadow | 25 | 25 | 50 | 3,813,758 | 351,895 | 4,165,703 | 91.55% |
| advise | 55 | 52 | 116 | 12,176,648 | 1,072,271 | 13,249,035 | 91.91% |
| enforce | 34 | 33 | 80 | 11,134,968 | 687,870 | 11,822,918 | 94.18% |
| enforce, pre-3.3 (00:51:45 → 03:41:05Z) | 28 | 27 | 66 | 8,796,627 | 682,976 | 9,479,669 | 92.79% |
| enforce, post-3.3 (03:41:05 → 04:13:39.877Z) | 6 | 6 | 14 | 2,338,341 | 4,894 | 2,343,249 | 99.79% |

**Qualification:** the observed-token subset is measurable, but full-window advise/enforce shares are **unverifiable** because records still lack `tokens` in the consistent backup. Recount: **three advise records** (00:16:31.056Z, no finish; 00:16:31.705Z and 00:24:47.382Z, `finish: error`) and **one pre-3.3 enforce record** (02:17:41.570Z, no finish). They are excluded, **not assumed zero**. The snapshot-consistency limitation of the original file copy is resolved, but missing provider usage is not. The advise window used the **old per-turn hint**, not the stable A1 fix. Post-3.3 enforce emits **no hint at all**; the whole enforce window includes the pre-fix period. The post-fix sample has only six completed records. Session growth, compactions, changing work and host versions confound comparisons. These percentages do not establish a causal hint/cache improvement and do not validate the stable advise hint.

Snapshot method (Node 24; save as temporary `.mjs`, choose a **new destination** because `backup` overwrites it; live source is opened read-only):

```js
import { DatabaseSync, backup } from 'node:sqlite';
const source = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  source.exec('BEGIN');
  source.prepare('SELECT count(*) FROM sqlite_schema').get();
  await backup(source, process.argv[3], { rate: 4096 });
  source.exec('ROLLBACK');
} finally { source.close(); }
```

Reproduce the cache table on the **backup only** with Node 24 (save this as a temporary `.mjs`, then `node <script> <copy>/session-backup-r1.db`):

```js
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const windows = [
  ['shadow', '2026-10-06T15:28:34Z', '2026-10-06T20:32:23Z'],
  ['advise', '2026-10-06T20:32:23Z', '2026-10-07T00:51:45Z'],
  ['enforce', '2026-10-07T00:51:45Z', '2026-10-07T04:13:39.877Z'],
  ['enforce-pre', '2026-10-07T00:51:45Z', '2026-10-07T03:41:05Z'],
  ['enforce-post', '2026-10-07T03:41:05Z', '2026-10-07T04:13:39.877Z'],
];
for (const [mode, since, until] of windows) {
  const rows = db.prepare(`SELECT data FROM session_message
    WHERE session_id = ? AND type = 'assistant'
    AND json_extract(data, '$.time.completed') >= ?
    AND json_extract(data, '$.time.completed') < ?`).all(
      'ses_ef09ca71effe2FoiBgxxJuCg6W', Date.parse(since), Date.parse(until));
  let usable = 0, input = 0, read = 0, write = 0;
  for (const row of rows) {
    const t = JSON.parse(row.data).tokens;
    if (!t || ![t.input, t.cache?.read, t.cache?.write].every(Number.isFinite)) continue;
    usable++; input += t.input; read += t.cache.read; write += t.cache.write;
  }
  const totalInput = input + read + write;
  console.log({ mode, since, until, records: rows.length, usable,
    input, read, write, totalInput, share: totalInput ? read / totalInput : null });
}
db.close();
```

## Summary

| Checkpoint / measured mode | Dispatches | Agreement | Switched | Estimated savings per unit | Measured USD | False refusals | Variant steps / pass rate | Restarts / time lost (wall-clock proxy) |
|---|---:|---|---:|---|---|---|---|---|
| DF1 / static | 0 recorded | n/a | 0 | n/a (no rows) | n/a, unpriced | 0 recorded; unmeasured | 0 / n/a | 1 / ≈2h06m54s |
| DF2 / static, before shadow | 0 recorded | n/a | 0 | n/a (no rows) | n/a, unpriced | 0 recorded; unmeasured | 0 / n/a | 1 / 4m55s |
| DF3 / shadow | 79 | 65/65 (100%) | 0 | 0.00 ratio / 65 rows | n/a, unpriced | 0 | 0 / n/a | 1 / 1h50m56s |
| DF4 / advise | 112 | 67/67 (100%) | 0 | 0.00 ratio / 67 rows | n/a, unpriced | 0 | 0 / n/a | 2 starts (1 failed) / 35m38s total |
| DF5 / enforce | 56 | 24/24 (100%) | 0 | 0.00 ratio / 24 rows | n/a, unpriced | 0 | 0 / n/a | 2 / 30m49s sync→owner restart + unmeasured unplanned restart |

**Reading the table:** these are the periods *ending* at each checkpoint, not the mode enabled *after* it. Dispatches are decision rows; agreement excludes pins, orchestrator resumes and decisions without a eligible best/chosen pair. Savings are totals in the indicated unit over eligible rows, not USD or a percentage reduction. False refusals are summed over `byKey` and cover trusted classes only. DF1/DF2 zeros mean no decision instrumentation, not zero actual work/refusals (see DF0 bias). Variant pass rate has no denominator. Restart counts and durations come from [run-log.md](run-log.md#restart-timing-ledger-acceptance-13-qa-g-b10), not `routing:stats`: they include human idle time, and the DF5 code reload was already observed at +20s. Actual restart-only time lost remains unmeasured. The DF5 restart column also includes the unplanned Phase 3.3 restart at 02:17:33Z; the second interruption was not a restart.

**Bounded reproduction commands** (PowerShell; the seven runs generated `<copy>/df*.json` and `.md`; omit/add `--json` for the two renderings):

```powershell
$copy = 'C:\Users\Marquinho\AppData\Local\Temp\opencode\p34-1791346419'
# DF1, DF2: empty instrumentation windows, not estimates of actual dispatch count
node scripts/routing-stats.ts --dir $copy --since 2026-10-06T01:00:00Z --until 2026-10-06T11:41:54Z
node scripts/routing-stats.ts --dir $copy --since 2026-10-06T11:41:54Z --until 2026-10-06T15:28:34Z
node scripts/routing-stats.ts --dir $copy --since 2026-10-06T15:28:34Z --until 2026-10-06T20:32:23Z
node scripts/routing-stats.ts --dir $copy --since 2026-10-06T20:32:23Z --until 2026-10-07T00:51:45Z
node scripts/routing-stats.ts --dir $copy --since 2026-10-07T00:51:45Z --until 2026-10-07T04:13:39.877Z
# DF5 code-boundary split
node scripts/routing-stats.ts --dir $copy --since 2026-10-07T00:51:45Z --until 2026-10-07T03:41:05Z
node scripts/routing-stats.ts --dir $copy --since 2026-10-07T03:41:05Z --until 2026-10-07T04:13:39.877Z
# Raw invariant across ALL copied decision rows, outside windowed stats
$rows = @(Get-ChildItem "$copy/decisions.jsonl*" | ForEach-Object {
  Get-Content $_ | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
} | Where-Object kind -eq decision)
$rows.Count # 247
@($rows | Where-Object { $_.pinned -and $_.switched }).Count # 0
@($rows | Where-Object switched).Count # 0: switched is false on every row
```

All routing numbers in the summary are reproduced by these bounded commands; restart numbers are independently timestamped ledger facts, and cache shares use the separate bounded SQLite query above. The snapshot cutoff excludes later work on this phase.

**Workload caveat (§0.11):** one owner, one machine; the intended workload is this plan itself, implementation- and QA-heavy, with pinned heavy dispatches. The models are unpriced. These are observations, **not a benchmark**. Moreover, the host-wide decision store includes six root sessions: only one belongs to this repository, with the others belonging to concurrent projects. The CLI windows above deliberately preserve that host-wide checkpoint scope; they must not be described as exclusively plan-session dispatches. The cache table, unlike routing stats, is filtered to the plan orchestrator only. Neither measured dollar savings nor switched-dispatch success has been demonstrated.

## DF0 — baseline (Phase 0.P, 2026-10-06)

**Mode after checkpoint:** `static` (no `routing` block).

**Active config.** Plugin loaded from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:189`); bundled `D:\git\opencode-model-router\tiers.json` + `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` `{"activePreset":"hybrid-2","activeMode":"normal","enforcementMode":"advisory"}`; no global or project override file. Preset `hybrid-2`: `@fast=gpt-6-luna-fast/medium(1x) @medium=claude-sonnet-5-5/xhigh(5x) @heavy=claude-opus-5-5/xhigh(20x)`. Checkpoints edit `routing.*` in `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (plan amendment A6).

**Cost unit for every checkpoint.** All tier models of the live `hybrid-2` preset are unpriced in the live catalog (`openai/gpt-6-luna-fast`: `cost []`; `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`: all-zero prices — plan amendment A1). Decisions, estimated savings and D17 inputs in DF1–DF5 are therefore in **`costRatio` units** (fast = 1), never USD.

**Source.** `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory\*.scorecard.log`, files last written in `[2026-10-05T00:00, 2026-10-06T00:58)` local time (the planning window, ending at the plan file's last write). The scorecard carries no parent session id, so the window may include child sessions of other concurrent sessions.

| Metric | Value |
|---|---|
| Child sessions with ≥1 scorecard line | 413 |
| by tier | fast 73 · medium 194 · heavy 74 · no tier 72 |
| of those, `tool_calls=0` on every line | 0 |
| last-line stop reason | none 224 · read_budget 95 · iteration_cap 78 · anti_self_script 13 · redundant_read 2 · cumulative_iteration_cap 1 |
| verdicts | not recorded by the scorecard |

**Bias: the baseline undercounts exactly the false refusals.** A scorecard is written on `session.idle` only when the session has guard state (`D:\git\opencode-model-router\src\index.ts:1710–1713`, `guardStore.get(sid)`), which tool activity creates. A child that returns with zero tool calls therefore most likely writes no scorecard at all — which is why the 5 zero-tool `@fast` hand-backs observed during planning (handover §3.4) do not appear, and why "sessions with ≥1 scorecard line" is not a dispatch count. Verdicts are not stored either. Both signals are first measured from DF2 on, by `decisions.jsonl` and the outcome store (D4, D15). Execution session so far (from 2026-10-06 ≈01:00): 2 `@fast` dispatches in Phase 0.P, the first a "no shell" hand-back (re-dispatched, see `run-log.md`).

**Restarts so far:** 0. Expected: one per code sync (DF1–DF4), per spike S7.

## DF1 — after Wave 1 (2026-10-06T09:35Z)

**Mode after checkpoint:** `static` (no `routing` block anywhere; no override file).

**Sync:** `master` fast-forwarded to `car/main` @ `88847cb` (Phases 1.1, 1.2, 1.3, 1.4, 1.5 merged, each QA PASS with 0 open findings; plan amendments A14–A26). Rollback tag `car/sync-1-prev` = previous `master` (`3b3dba4`). `package-lock.json` unchanged → no `npm ci` in the base checkout. Capped full suite on `car/main` @ `88847cb`: 127 files passed, 3 skipped; 11 036 tests passed, 66 skipped.

**Liveness:** code sync requires a host restart (A8). Probe after restart: `/router` must show `router: engine=static build=2.2.0+88847cb` (first 7 of the synced sha); the live protocol text and `R:` line must be byte-identical to 0.P.3 (v2-adapted SHA-256s pinned in Phase 1.4).

**`routing:stats` (DF0 → DF1):** `node scripts/routing-stats.ts` → `routing-stats: no outcome data in C:\Users\MARQUI~1\AppData\Local\Temp\opencode-model-router-trajectory`; table all zeros (`Dispatches 0`, agreement `n/a`). Expected: the outcome store and decision log start writing at DF2 (`shadow`).

**Incident in the period:** a Phase 1.1 test run with `--pool=threads` wrote the user's real `opencode-model-router.overrides.jsonc` (`{"routing":{"engine":"enforce"}}`); the orchestrator deleted it at ≈03:25, before any engine code was live (A14; global home guard added). Restart time lost: recorded at resume.
**Liveness result (resume, 2026-10-06T11:41:54Z):** `/router` shows `router: engine=static build=2.2.0+8ce54f2` — the DF1 code is live. Restart wall-clock: sync at 2026-10-06T09:35Z, probe at 2026-10-06T11:41:54Z (includes the human's idle time; not attributable to the restart alone). Live protocol text: not re-captured from the restarted session; byte-identity is enforced by the Phase 1.4 D2 snapshot tests (raw and v2 forms) on the synced commit.

## DF2 — after Phases 2.1, 2.2 and 2.3 (2026-10-06)

**Status:** DF2 complete. Shadow period started at 2026-10-06T15:28:34Z.

**Mode after checkpoint:** `shadow` (override file `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` = `{"routing":{"engine":"shadow"}}`, created at 2026-10-06T15:28:34Z, after the liveness check below).

**Sync:** `master` in the base checkout fast-forwarded to `car/main` @ `2878319` (Phase 2.1 `a08229c`, Phases 2.2 and 2.3 `2878319`; QA PASS on each, plan amendments A27–A29). Rollback tag `car/sync-2-prev` = previous `master` (`8ce54f2`). The sync was done at 2026-10-06T15:22:43Z. Capped full suite on `car/main` @ `2878319`: 137 files passed, 3 skipped; 11 387 tests passed, 66 skipped; 255 s.

**Liveness (inferred, not observed):** code sync requires a host restart (A8). The host restarted at 2026-10-06T15:27:38Z (`opencode.log`, run `998fe258`, `cli starting version=2.0.22`, cwd `D:\git\opencode-model-router`), after the sync at 15:22:43Z, so the synced code (`2.2.0+2878319`) was the code that loaded. The `/router` marker line itself was not captured: liveness was inferred from the restart timing, not read from the `engine=… build=…` line. The restart cost about 4 min 55 s between sync and restart (includes the human's idle time; not attributable to the restart alone).

**`routing:stats` before shadow:** `no outcome data`, every metric 0 (`Dispatches 0`, agreement `n/a`, no store, no decision log).

**Override file:** created at 2026-10-06T15:28:34Z with `{"routing":{"engine":"shadow"}}` (hot reload, no restart).

**First live shadow row:** at 2026-10-06T15:28:41Z, 7 s after the override, in `decisions.jsonl` of the D15 directory: `mode: "shadow"`, `switched: false`, `chosen` = `best` = `router:fast`. The row reached disk in ≈7 s.

**Observation for DF3:** the rules classifier labelled a file-listing task as `review` with confidence 0.5. That is below `routing.minClassConfidence` (0.7), so the dispatch has a decision row but no verdict or refusal rows and nothing is recorded in the outcome store (QA-2.1-10: statistics cover trusted classes only). A listing task should read as `search`/`recon`: DF3 should check how many of the shadow period's rows are below the threshold (`Dispatches` against `Pass + Fail + Unverifiable` in `routing:stats`, and `/router stats`) before judging agreement or savings, and whether the rules need a listing keyword.

**Open owner decision (QA-2.3-13), not blocking:** on `hybrid-2` and `anthropic` the medium/heavy tiers carry `effort`, so ladder escalations never resume and variant steps exist only on the fast tier. Phase 2.4's cost doctor now reports it as the `variant-effort` finding in `/router` (suggesting `candidates` and dropping `effort`).
## DF3

**Sync:** `master` to `71815eb` at 2026-10-06T18:41:27Z; rollback tag `car/sync-3-prev` = `2878319`.

**Mode after checkpoint:** `advise`. The switch occurred after the host restart at 2026-10-06T20:32:23Z and no later than the first advise row at 2026-10-06T20:32:57.803Z (exact override write time was not captured).

**Shadow period:** 2026-10-06T15:28:34Z (DF2 override) to 2026-10-06T20:32:23Z. Reproduced with `node scripts/routing-stats.ts --since 2026-10-06T15:28:34Z --until 2026-10-06T20:32:23Z --dir <copy>` (resumes and lifts excluded, A30). For both DF3 and DF4 below, `decisions.jsonl` and `outcomes.json` were copied from the live trajectory directory to `C:\Users\MARQUI~1\AppData\Local\Temp\opencode\p33-stats-1791339553946`; commands read only that copy. These bounded outputs supersede the earlier open-ended readings and include the 16 previously omitted shadow rows.

**Reading:**
- 79 decision rows, of which 13 are orchestrator resumes (outside every routing metric) and 3 pinned. Agreement 65/65 (100%); would-switch 0 (0%); estimated savings 0.00 ratio units (every live hybrid-2 model is unpriced, so ratio units only).
- A27 evidence gate: 1 of 66 fresh dispatches kept for lack of evidence. The `trace.argmin` table (21 rows) counts every row in which a cheaper candidate without evidence existed, including rows where the chosen dispatch was best anyway; it is not the same quantity as the `kept:evidence` line.
- Verdicts: 1 pass on `recon|router:medium`; no fails, no false refusals. Most dispatches carry no verdict because they were deferred (router_verify wiring is a 3.x handoff) or below `minClassConfidence`.
- Classifier (rules): `design` 33 of 66 fresh — the QA/review dispatches with long briefs lean to `design`; DF2 already noted a file listing classified `review` at 0.5. Input for 3.x classifier tuning, not a blocker.
- Conclusion: in shadow the engine would not have changed any orchestrator choice; with no priced models and almost no verdicts there is no evidence yet to justify a switch. Moving to `advise` per plan.

```
## Routing stats

Window: 2026-10-06T15:28:34.000Z → 2026-10-06T20:32:23.000Z

| Metric | Value |
|---|---|
| Dispatches | 79 |
| Routed dispatches | 79 |
| Delegate first attempts | 0 |
| Floor lifts | 0 |
| Pinned | 3 |
| Agreement (best == chosen, non-pinned) | 65/65 (100.0%) |
| Switched | 0 of 65 non-pinned routed (0.0%); enforced 0; failed 0 (verified 0 of 0 enforced) |
| Estimated savings (ratio) | 0.00 over 65 rows |
| Variant steps | 0 taken; pass n/a |
| Orchestrator resumes (task_id / sessionID; not a ladder step, never switched, outside every routing metric) | 13 of 79 routed dispatches |
| Kept for lack of evidence (A27, fresh dispatches) | 1 of 66 fresh routed dispatches |

### By class

| Class | Dispatches |
|---|---|
| debug | 4 |
| design | 33 |
| implement | 8 |
| recon | 9 |
| review | 11 |
| search | 1 |

### By key

| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/attempt (lifetime) |
|---|---|---|---|---|---|---|---|---|---|
| debug\|router:fast\|openai/gpt-6-luna-fast#medium | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| debug\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |
| debug\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 2 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |
| design\|router:fast\|openai/gpt-6-luna-fast#medium | 9 | 9 | 0 | 0 | 0 | n/a | 0 | 0/9 (0.0%) | n/a |
| design\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 16 | 16 | 0 | 0 | 0 | n/a | 0 | 0/16 (0.0%) | n/a |
| design\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 8 | 9 | 0 | 0 | 0 | n/a | 0 | 0/9 (0.0%) | n/a |
| implement\|router:fast\|openai/gpt-6-luna-fast#medium | 5 | 5 | 0 | 0 | 0 | n/a | 0 | 0/5 (0.0%) | n/a |
| implement\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| implement\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 2 | 6 | 0 | 0 | 0 | n/a | 0 | 0/6 (0.0%) | n/a |
| recon\|router:fast\|openai/gpt-6-luna-fast#medium | 8 | 8 | 0 | 0 | 0 | n/a | 0 | 0/8 (0.0%) | n/a |
| recon\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| recon\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 0 | 2 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/2 (0.0%) | n/a |
| review\|router:fast\|openai/gpt-6-luna-fast#medium | 2 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| review\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 9 | 9 | 0 | 0 | 0 | n/a | 0 | 0/9 (0.0%) | n/a |
| review\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 0 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |
| search\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |

### Gated by evidence (trace.argmin)

| Cheapest key held back | Rows |
|---|---|
| review\|router:fast\|openai/gpt-6-luna-fast#medium | 6 |
| design\|router:fast\|openai/gpt-6-luna-fast#medium | 5 |
| design\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 4 |
| debug\|router:fast\|openai/gpt-6-luna-fast#medium | 2 |
| implement\|router:fast\|openai/gpt-6-luna-fast#medium | 2 |
| implement\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 1 |
| search\|router:fast\|openai/gpt-6-luna-fast#medium | 1 |

### Resume vs fresh

| Step | Resume | Fresh |
|---|---|---|
| variant | 0 | 0 |
| retry | 0 | 0 |
| escalate | 0 | 0 |

_Verdict and false-refusal rates cover trusted classes only: dispatches whose class confidence reached `routing.minClassConfidence` and whose class is not `unknown`. Other dispatches have a decision row but no verdict or refusal rows, so Dispatches can exceed Pass + Fail + Unverifiable by design._

```

### Classifier credential check (A4/A13)

**Override used (2026-10-06, set by the orchestrator, global file):** `{"routing":{"engine":"advise","classifier":{"backend":"host","model":"opencode-go/deepseek-v4.1-flash","timeoutMs":10000}}}` (the model the owner named, A13). **Restored to `{"routing":{"engine":"advise"}}` at ≈20:35Z** (read back afterwards: the file holds exactly that; last written 2026-10-06T20:34:58Z).

**Probe:** a dispatch to `fast` from session `ses_ef09ca71effe2FoiBgxxJuCg6W`, description `DF3 classifier probe 2`, prompt `Which word is longer, "alpha" or "omega"? Reply with one word only, no tools.` The rows of that session in `decisions.jsonl`:

| Time (UTC) | Row |
|---|---|
| 20:32:57.803Z (probe 1) | `mode=advise`, `search`, confidence 0.8, `source=rules`, `trace.backend=null`, no `backendSkipped`. At or above `minClassConfidence` (0.7): no backend is consulted by design. |
| **20:34:08.917Z (probe 2)** | `mode=advise`, `other` / `medium` / `single` / no needs, confidence 0.2, `source=rules`, **`trace.backend={"id":"host","status":"ok","latencyMs":1688,"label":"other"}`**, no `backendSkipped`. Below 0.7, so the backend was consulted, and it answered. |

**Correction to the first reading.** The first reading took the rows at 20:34:26.940Z and 20:34:35.001Z as the probe's (`class` `design` / `implement`, confidence 0.5, `trace.backend=null`, `trace.backendSkipped="credentials"`) and concluded a credential-gate false positive. They are not the probe's. They belong to session `ses_ef099b1e0ffe7BcoD9Trb0TpTm`, which wrote three consecutive rows at 20:34:13Z, 20:34:26Z and 20:34:35Z (`design`/`heavy`, `design`/`heavy`, `implement`/`medium`; `risk=high`, `scope=multi`, needs `shell`/`edit`…): long task briefs, not a one-line probe. `decisions.jsonl` is one file for every host session (D15), so reading its tail mixes sessions. The probe's own facts (`other`/`medium`/`single`/no needs/0.2) are reproduced exactly by the rules on the probe inputs in a unit test; a one-line prompt cannot produce `design`/`high`/`multi`.

**Result:** the credential gate did **not** block the probe and there is **no false positive on it**. The gate skipped the other session's briefs because it found a credential signal in their text (D14, working as designed); the rows store no prompt text, so which word fired cannot be re-read. The host backend **was consulted live once** with `opencode-go/deepseek-v4.1-flash` through `ctx.generate.text` (A4): `status=ok` in 1688 ms, label `other`. It was **not** verified in the form the plan's pass criterion asks for: `facts.source` stays `rules` because a backend answer of `other` never changes the rules facts (`mergeBackend`), and `/annotate-plan` on a two-step sample (the batched `classifyMany` path, F3) was not run. **`source: "host"` for both steps was not observed, so `host` stays documented as *experimental* (A4) until that run is done; the single-call path is live-verified, the batched path is not.**

**Root cause and fix:** no defect in the gate. The patterns and the scrubber do not match the probe, the adapter passes `args.prompt` unchanged (`route()` runs before the legacy hook; `taskArgs` spreads the input), and the earlier `search` probe was simply above the threshold. Fix commit: `e99330c` `test(routing): pin the credential gate on the DF3 probe, ordinary prompts and real secrets` (regression tests, plus a comment in `scrub.ts` stating the rule). Details and the ten-prompt judgement: `docs/qa/cost-aware-routing/phase-df3-credential-gate.md`.

**Liveness after the DF3 restart (inferred, not observed):** the host logged `cli starting` at 2026-10-06T20:32:23Z, after the sync at 18:41:27Z, so the synced code is what loaded; the first row with `mode=advise` is at 20:32:57Z (confirmed in `decisions.jsonl`). The `/router` marker line (`engine=… build=…`) was not read, so liveness rests on the restart timing and on that first `advise` row. The `cli starting` time is as recorded by the orchestrator; `opencode.log` was not re-read here.
The 20:34:08.917Z probe is the only backend row in the observed log; the override was restored afterwards. See [the credential-gate report](phase-df3-credential-gate.md). **Host remains EXPERIMENTAL**: the plan's `source: host` for both steps was not observed.

## DF4

**Sync:** `master` 71815eb → 64e523a at 2026-10-07T00:15:38Z (rollback tag `car/sync-4-prev` = 71815eb). A restart during `npm ci` left the plugin unloaded (incident in `run-log.md`); the owner restarted again.
**Liveness (inferred):** host `cli starting` at 2026-10-07T00:51:16Z with no `failed to load plugin` line for the router afterwards; the router's `fast` agent resolved again. **Host version changed: 2.0.24** (it was 2.0.22 for DF1–DF3 and the Phase 3.2 smoke).
**Restart time lost:** 00:15:38Z → 00:51:16Z, **35m38s**, including the incident and human idle time, not just restart execution.
**Advise period** (`node scripts/routing-stats.ts --since 2026-10-06T20:32:23Z --until 2026-10-07T00:51:45Z --dir <copy>`): 112 decision rows, 28 orchestrator resumes, 20 pinned; agreement 67/67 (100%); switched 0; estimated savings 0.00 ratio units; kept for lack of evidence 23 of 84 fresh routed dispatches. `pinned && switched` = 0 over the original 191 decision rows.
**Mode after checkpoint:** override `{"routing":{"engine":"enforce","profile":"balanced","margin":0.2}}` written just before 2026-10-07T00:51:45Z (not ≈00:52Z).
**First enforce row:** 2026-10-07T00:51:45Z, `mode=enforce`, class `search` (0.8), chosen = best = `router:fast` (gpt-6-luna-fast#medium), `switched=false`, reason `kept:best-is-chosen`. No switch, so no child-model check was needed; the next switched row will be verified during 3.3/3.4.
**Status:** DF4 complete; enforce period started by 2026-10-07T00:51:45Z.

```
## Routing stats

Window: 2026-10-06T20:32:23.000Z → 2026-10-07T00:51:45.000Z

| Metric | Value |
|---|---|
| Dispatches | 112 |
| Routed dispatches | 112 |
| Delegate first attempts | 0 |
| Floor lifts | 0 |
| Pinned | 20 |
| Agreement (best == chosen, non-pinned) | 67/67 (100.0%) |
| Switched | 0 of 67 non-pinned routed (0.0%); enforced 0; failed 0 (verified 0 of 0 enforced) |
| Estimated savings (ratio) | 0.00 over 67 rows |
| Variant steps | 0 taken; pass n/a |
| Orchestrator resumes (task_id / sessionID; not a ladder step, never switched, outside every routing metric) | 28 of 112 routed dispatches |
| Kept for lack of evidence (A27, fresh dispatches) | 23 of 84 fresh routed dispatches |

### By class

| Class | Dispatches |
|---|---|
| debug | 2 |
| design | 10 |
| implement | 21 |
| mechanical | 12 |
| other | 1 |
| recon | 19 |
| review | 18 |
| search | 1 |

### By key

| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/attempt (lifetime) |
|---|---|---|---|---|---|---|---|---|---|
| debug\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| debug\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 1 | 7 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/7 (0.0%) | n/a |
| design\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 10 | 11 | 0 | 0 | 0 | n/a | 0 | 0/11 (0.0%) | n/a |
| design\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 0 | 2 | 0 | 0 | 0 | n/a | 0 | 0/2 (0.0%) | n/a |
| implement\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 1 | 1 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/1 (0.0%) | n/a |
| implement\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 20 | 20 | 7 | 1 | 4 | 7/8 (87.5%) | 0 | 0/20 (0.0%) | n/a |
| mechanical\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 12 | 12 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/12 (0.0%) | n/a |
| other\|router:fast\|openai/gpt-6-luna-fast#medium | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |
| recon\|router:fast\|openai/gpt-6-luna-fast#medium | 5 | 5 | 0 | 0 | 0 | n/a | 0 | 0/5 (0.0%) | n/a |
| recon\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 14 | 17 | 0 | 1 | 0 | 0/1 (0.0%) | 0 | 0/17 (0.0%) | n/a |
| review\|router:heavy\|anthropic/claude-opus-5-5#xhigh | 17 | 19 | 0 | 0 | 0 | n/a | 0 | 0/19 (0.0%) | n/a |
| review\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 1 | 14 | 1 | 0 | 0 | 1/1 (100.0%) | 0 | 0/14 (0.0%) | n/a |
| search\|router:fast\|openai/gpt-6-luna-fast#medium | 1 | 1 | 0 | 0 | 0 | n/a | 0 | 0/1 (0.0%) | n/a |

### Gated by evidence (trace.argmin)

| Cheapest key held back | Rows |
|---|---|
| implement\|router:fast\|openai/gpt-6-luna-fast#medium | 14 |
| design\|router:medium\|anthropic/claude-sonnet-5-5#xhigh | 8 |
| recon\|router:fast\|openai/gpt-6-luna-fast#medium | 6 |
| mechanical\|router:fast\|openai/gpt-6-luna-fast#medium | 4 |
| review\|router:fast\|openai/gpt-6-luna-fast#medium | 4 |
| implement\|host:general\|anthropic/claude-opus-5-5#default | 2 |

### Resume vs fresh

| Step | Resume | Fresh |
|---|---|---|
| variant | 0 | 0 |
| retry | 0 | 0 |
| escalate | 0 | 0 |

_Verdict and false-refusal rates cover trusted classes only: dispatches whose class confidence reached `routing.minClassConfidence` and whose class is not `unknown`. Other dispatches have a decision row but no verdict or refusal rows, so Dispatches can exceed Pass + Fail + Unverifiable by design._
```
