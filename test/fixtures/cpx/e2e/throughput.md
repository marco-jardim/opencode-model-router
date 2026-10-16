# Offline throughput plan

OpenCode v2 fixture. Use a virtual clock, `maxParallel: 4`, and scripted child
durations fixed before execution. All child checks and phase suites pass on the
first attempt. Every implementation writes its declared artifact containing
`{"complete":true}` and returns `DONE:`. Every QA returns `{"findings":[]}`.
Artifacts are relative to the aggregate run root containing the three offline
repositories. `throughput.script.json` is the machine-readable script. Configure
`crossPhase: "inferred"`: waves group phases, not synchronization barriers.

<!-- plan-context -->
Work offline inside the assigned slot. Write only the declared paths. Use the
pre-provisioned toolchains. Return DONE after local checks; QA returns only JSON.
The fixture harness advances the clock by the task's scripted duration.
<!-- /plan-context -->

## Ownership

| Phase | Writes | Repository |
| --- | --- | --- |
| 1.1 | `node-pnpm/artifacts/` | `node-pnpm` |
| 1.2 | `node-npm/artifacts/` | `node-npm` |
| 2.1 | `py-pip/artifacts/` | `py-pip` |
| 2.2 | `node-pnpm/release/` | `node-pnpm` |

## Wave 1

### Phase 1.1 TypeScript artifacts

Depends on: none.
Phase suite: in `node-pnpm`, `pnpm run typecheck` and `pnpm test`.

**Tasks**
- **1.1.1** `[tier:medium]` Write the first typed artifact. Scripted duration: 12000 ms.
  Writes: `node-pnpm/artifacts/a.json`
- **1.1.2** `[tier:medium]` Write the independent second artifact. Scripted duration: 8000 ms.
  Writes: `node-pnpm/artifacts/b.json`
- **1.1.3** `[tier:medium]` Write the independent third artifact. Scripted duration: 10000 ms.
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

### Phase 1.2 JavaScript artifacts

Depends on: none.
Local check: in `node-npm`, `node --test test/index.test.js`.
Phase suite: in `node-npm`, `npm test`.

**Tasks**
- **1.2.1** `[tier:medium]` Write the first JavaScript artifact. Scripted duration: 11000 ms.
  Writes: `node-npm/artifacts/a.json`
- **1.2.2** `[tier:medium]` Write the independent second artifact. Scripted duration: 7000 ms.
  Writes: `node-npm/artifacts/b.json`
- **1.2.3** `[tier:medium]` Write the independent third artifact. Scripted duration: 9000 ms.
  Writes: `node-npm/artifacts/c.json`
- **1.2.4** `[tier:medium]` Derive an artifact from the first one. Scripted duration: 5000 ms.
  Writes: `node-npm/artifacts/d.json`
  Reads: `node-npm/artifacts/a.json`
- **1.2.5** `[tier:medium]` Join the second and third artifacts. Scripted duration: 4000 ms.
  Writes: `node-npm/artifacts/e.json`
  Reads: `node-npm/artifacts/b.json`, `node-npm/artifacts/c.json`
- **1.2.QA** `[tier:heavy]` QA the integrated phase; return zero findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `node-npm/artifacts/`

Order: (1.2.2 ∥ 1.2.3) → 1.2.5.
The 1.2.1 → 1.2.4 edge is implicit from the read/write footprint.

## Wave 2

### Phase 2.1 Python artifacts

Depends on: 1.1.
Phase suite: in `py-pip`, `python -m pytest tests`.

**Tasks**
- **2.1.1** `[tier:medium]` Write the first Python artifact. Scripted duration: 12000 ms.
  Writes: `py-pip/artifacts/a.json`
  Reads: `node-pnpm/artifacts/e.json`
- **2.1.2** `[tier:medium]` Write the independent second artifact. Scripted duration: 8000 ms.
  Writes: `py-pip/artifacts/b.json`
- **2.1.3** `[tier:medium]` Write the independent third artifact. Scripted duration: 6000 ms.
  Writes: `py-pip/artifacts/c.json`
- **2.1.4** `[tier:medium]` Derive an artifact from the first one. Scripted duration: 5000 ms.
  Writes: `py-pip/artifacts/d.json`
  Reads: `py-pip/artifacts/a.json`
- **2.1.5** `[tier:medium]` Join the second and third artifacts. Scripted duration: 4000 ms.
  Writes: `py-pip/artifacts/e.json`
  Reads: `py-pip/artifacts/b.json`, `py-pip/artifacts/c.json`
- **2.1.QA** `[tier:heavy]` QA the integrated phase; return zero findings. Scripted duration: 3000 ms.
  Writes: none.
  Reads: `py-pip/artifacts/`

Order: (2.1.2 ∥ 2.1.3) → 2.1.5.
The 2.1.1 → 2.1.4 edge is implicit from the read/write footprint.

### Phase 2.2 Release artifacts

Depends on: 1.2, 2.1.
Phase suite: all three repository suites, including the TypeScript typecheck.

**Tasks**
- **2.2.1** `[tier:medium]` Assemble the release input. Scripted duration: 10000 ms.
  Writes: `node-pnpm/release/a.json`
  Reads: `node-npm/artifacts/e.json`, `py-pip/artifacts/e.json`
- **2.2.2** `[tier:medium]` Write independent release metadata. Scripted duration: 8000 ms.
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

Exactly 24 initial tasks complete once, with four clean QA responses and four
passed phase gates. No writer or reader overlaps another writer's lease. No
ready task with free capacity waits more than 10000 ms. Evaluate G8 with scripted
work W and critical path CP, configured p = 4, and measured serial integration
time sum(I): makespan <= 1.3 * max(CP, W / p, sum(I)).
