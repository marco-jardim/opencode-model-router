# Offline resilience plan

OpenCode v2 fixture. Use a virtual clock, `maxParallel: 4`, and
`crossPhase: "inferred"`. `resilience.script.json` fixes the durations, provider
turns, recovery actions and host checkpoints before execution. There are exactly
24 initial tasks over two waves and four phases, as in `throughput.md`; generated
fixes, re-reviews and background probes are not initial plan tasks.

<!-- plan-context -->
Work offline inside the assigned slot with pre-provisioned toolchains. Follow the
scripted attempt, including its deliberate injection, through host tools; never
write behind the host's guards. Return DONE after local checks, ESCALATE for the
scripted human decision, and only FINDINGS_FORMAT JSON for QA.
<!-- /plan-context -->

## Ownership

| Phase | Writes | Repository |
| --- | --- | --- |
| 1.1 | `node-pnpm/artifacts/` | `node-pnpm` |
| 1.2 | `node-npm/` | `node-npm` |
| 2.1 | `py-pip/artifacts/` | `py-pip` |
| 2.2 | `node-pnpm/release/` | `node-pnpm` |

## Wave 1

### Phase 1.1 TypeScript artifacts and hidden overlap

Depends on: none.
Phase suite: in `node-pnpm`, `pnpm run typecheck` and `pnpm test`.
The driver holds the second writer's lease while the third writer attempts the
undeclared write in the sidecar. The compiler must leave those tasks concurrent;
only the runtime lease guard catches the hidden overlap. The denied tool call
must not change the leased file. The third writer then writes its own artifact.

**Tasks**
- **1.1.1** `[tier:medium]` Write the first typed artifact. Scripted duration: 12000 ms.
  Writes: `node-pnpm/artifacts/a.json`
- **1.1.2** `[tier:medium]` Write the independent second artifact; hold its lease for the overlap probe. Scripted duration: 8000 ms.
  Writes: `node-pnpm/artifacts/b.json`
- **1.1.3** `[tier:medium]` Attempt the hidden sidecar write, observe its denial, then write the declared artifact. Scripted duration: 10000 ms.
  Writes: `node-pnpm/artifacts/c.json`
- **1.1.4** `[tier:medium]` Derive an artifact from the first one. Scripted duration: 6000 ms.
  Writes: `node-pnpm/artifacts/d.json`
  Reads: `node-pnpm/artifacts/a.json`
- **1.1.5** `[tier:medium]` Join the second and third artifacts. Scripted duration: 4000 ms.
  Writes: `node-pnpm/artifacts/e.json`
  Reads: `node-pnpm/artifacts/b.json`, `node-pnpm/artifacts/c.json`
- **1.1.QA** `[tier:heavy]` QA the integrated phase; return zero findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `node-pnpm/artifacts/`

Order: (1.1.2 ∥ 1.1.3) → 1.1.5.
The 1.1.1 → 1.1.4 edge is implicit from the read/write footprint.

### Phase 1.2 JavaScript artifacts and phase-only regression

Depends on: none.
Local check: in `node-npm`, `node --test test/index.test.js`.
Phase suite: in `node-npm`, `npm test`.
The third task clamps negative totals to zero. Its local check passes, but the
unchanged phase suite fails on negative totals. Reject that integration, preserve
the green integration head, restore the original function on a corrective attempt
and rerun the suite. The second task receives three 429 rate-limit responses;
faults do not consume its queued successful turns.

**Tasks**
- **1.2.1** `[tier:medium]` Write the first JavaScript artifact. Scripted duration: 11000 ms.
  Writes: `node-npm/artifacts/a.json`
- **1.2.2** `[tier:medium]` Write the second artifact through the 429 burst. Scripted duration: 7000 ms.
  Writes: `node-npm/artifacts/b.json`
- **1.2.3** `[tier:medium]` Write the third artifact and inject the phase-only regression. Scripted duration: 9000 ms.
  Writes: `node-npm/artifacts/c.json`, `node-npm/src/index.js`
- **1.2.4** `[tier:medium]` Derive an artifact from the first one. Scripted duration: 5000 ms.
  Writes: `node-npm/artifacts/d.json`
  Reads: `node-npm/artifacts/a.json`
- **1.2.5** `[tier:medium]` Join the second and third artifacts. Scripted duration: 4000 ms.
  Writes: `node-npm/artifacts/e.json`
  Reads: `node-npm/artifacts/b.json`, `node-npm/artifacts/c.json`
- **1.2.QA** `[tier:heavy]` QA the repaired integrated phase; return zero findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `node-npm/`

Order: (1.2.2 ∥ 1.2.3) → 1.2.5.
The 1.2.1 → 1.2.4 edge is implicit from the read/write footprint.

## Wave 2

### Phase 2.1 Python artifacts, human decision and QA fixes

Depends on: 1.1.
Phase suite: in `py-pip`, `python -m pytest tests`.
The third task first returns `ESCALATE: human` without writing. Only that task and
its dependents wait; independent tasks proceed. The scripted human answer permits
another attempt. QA returns exactly two structured findings, generating two fixes
and one clean re-review. The driver restarts the host after the first task's
durable integration while its derived task is running, then resumes the same
ledger. Compare the completed run with an otherwise identical uninterrupted run.

**Tasks**
- **2.1.1** `[tier:medium]` Write the first Python artifact and reach the host restart checkpoint. Scripted duration: 12000 ms.
  Writes: `py-pip/artifacts/a.json`
  Reads: `node-pnpm/artifacts/e.json`
- **2.1.2** `[tier:medium]` Write the second artifact with the scripted review omission. Scripted duration: 8000 ms.
  Writes: `py-pip/artifacts/b.json`
- **2.1.3** `[tier:medium]` ESCALATE: human to confirm the audit marker, then write the third artifact on the approved attempt. Scripted duration: 6000 ms.
  Writes: `py-pip/artifacts/c.json`
- **2.1.4** `[tier:medium]` Derive an artifact from the first one; recover its interrupted attempt. Scripted duration: 5000 ms.
  Writes: `py-pip/artifacts/d.json`
  Reads: `py-pip/artifacts/a.json`
- **2.1.5** `[tier:medium]` Join the second and third artifacts. Scripted duration: 4000 ms.
  Writes: `py-pip/artifacts/e.json`
  Reads: `py-pip/artifacts/b.json`, `py-pip/artifacts/c.json`
- **2.1.QA** `[tier:heavy]` QA the integrated phase; return the two sidecar findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `py-pip/artifacts/`

Order: (2.1.2 ∥ 2.1.3) → 2.1.5.
The 2.1.1 → 2.1.4 edge is implicit from the read/write footprint.

### Phase 2.2 Release artifacts and background probes

Depends on: 1.2, 2.1.
Phase suite: all three repository suites, including the TypeScript typecheck.
While release metadata is running, issue the sidecar's three non-plan dispatches:
an ad hoc background call, a foreground verified call that the user backgrounds
while running, and a required-verification call. The last call is backgrounded
and held until its verdict only when C4 and C15 hold; otherwise assert the
foreground fallback. They must not appear among these 24 tasks.

**Tasks**
- **2.2.1** `[tier:medium]` Assemble the release input. Scripted duration: 10000 ms.
  Writes: `node-pnpm/release/a.json`
  Reads: `node-npm/artifacts/e.json`, `py-pip/artifacts/e.json`
- **2.2.2** `[tier:medium]` Write independent release metadata and reach the background-probe checkpoint. Scripted duration: 8000 ms.
  Writes: `node-pnpm/release/b.json`
- **2.2.3** `[tier:medium]` Write independent release metadata. Scripted duration: 6000 ms.
  Writes: `node-pnpm/release/c.json`
- **2.2.4** `[tier:medium]` Derive the release summary. Scripted duration: 5000 ms.
  Writes: `node-pnpm/release/d.json`
  Reads: `node-pnpm/release/a.json`
- **2.2.5** `[tier:medium]` Join release metadata. Scripted duration: 4000 ms.
  Writes: `node-pnpm/release/e.json`
  Reads: `node-pnpm/release/b.json`, `node-pnpm/release/c.json`
- **2.2.QA** `[tier:heavy]` QA the integrated phase; return zero findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `node-pnpm/release/`

Order: (2.2.2 ∥ 2.2.3) → 2.2.5.
The 2.2.1 → 2.2.4 edge is implicit from the read/write footprint.

## Tail assertions

Assert every `tailAssertions` entry in the sidecar against host observations and
ledger events, not against this prose. Check the lease refusal and unchanged
leased file; a passing local check and failing phase suite with no red integration
head; the human queue item and independent progress; exactly two QA fixes and one
clean re-review; exactly three 429s and eventual completion; restart equivalence
without duplicate integration, completion side effects or abandoned leases.
Check the ad hoc background dispatch's annotation exactly once in the tail, the
user-backgrounded call's verification exactly once at completion, and (C4 AND
C15) a permanent held placeholder through context and compaction, no early output,
then one verdict delivery and one parent wake. Otherwise check foreground
fallback. Final suites and phase gates pass; no lease or background work remains.
