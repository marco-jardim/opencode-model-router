# Recovery restart fixtures (4.2.6)

Fixtures for `test/integration/executor-recovery-restart.test.ts`.

- `restart-child.ts`: the plugin-side executor (real `createExecutorRuntime`, real `LedgerStore`, real slots, real git,
  real integration queue via `realCollaborators`) run as a real Node child process. The host simulator lives in the
  test process and stores child sessions on disk, so they survive a killed child process.
- Children are played by `scriptedLauncher` (a `TaskLauncher`): `normal` writes its file in the slot and answers at
  once (after every scripted child of the run is launched); `alive`, `dead` and `finish-while-down` stay busy and are
  played by the test's host simulator once the process is gone.
- Run 0 compiles an `awaiting-approval` draft (a compiler double) and approves it (approve path: `queue.resume()` once
  before the first tick, §9); the integration branch and the integration slot exist before the approve (5.1 handoff).
  Run 1 is a plain `start()` (recovery of the running ledger).
- The commits the runtime makes in a slot go through the hardened runner (its environment drops the user's git config):
  the temp repo carries `user.name`/`user.email` in its own config, so every worktree has an identity.
- Config: `batchMax` 1, phase suite off, `land: "manual"`, `maxParallel` = tasks + 1 (the capacity controller starts at
  `maxParallel`, so every task launches in the first tick and the hold above cannot deadlock).
- The recovery's `slotMarker(t.slot)` (R2) is answered from the real pool's records: a leased slot whose owner is
  `plan:<planId>:<taskId>` (`leaseHolderID`).
- Each process opens the real pool (`pool.open()`) on the same slots dir and markers dir; the restarted one finds the
  slots the killed one leased.
- The child gets its whole setup from one JSON file (`ChildConfig` in `restart-child.ts`) and talks to the test over
  stdin/stdout lines.
- Host events reach the child as `EVENT <json>` stdin lines (`HostSessionEvent`); an adopted child ends through an
  `execution.completed` event (`runtime.ts` `lateChildEnd`: the handle `restoreHandle` registered is settled, the text
  is the session's last assistant message), a child on probation leaves it on any event (`onHostEvent` →
  `provedAlive`). A repeated `execution.completed` is harmless: ends are processed only for open attempts (D3).
- `host-store.ts`: the disk-backed session store both processes use (one JSON file per session).
- Sessions store the v2 host's real history shape (QA-4.2-1, QA-4.2-2): the first user message is the launch prompt
  after the host's preamble line (`You are a subagent spawned by another session.`); entries are discriminated by
  `type`; an ended answer step carries `finish` and `time.completed`, an interrupted one an abort `error`; a scripted
  child (`alive`, `dead`, `finish-while-down`) is left mid-tool-call (`tool-calls` step plus a running tool turn).
  `HostSessions.context` is the v2 adapter's real mapping (`executorHostContext` in `src/compat/v2-hooks.ts`), so the
  terminal `idle` entry with the end outcome exists only when that history shows the child ended.
- The queue is the real `createIntegrationQueue` over real `GitOps`/`IntegrateGit`/`SlotPool`, the real checks (the
  `node-basic` fixture's `check.js`), the real lander, the phase suite off; it is built per plan by
  `realCollaborators({queue})`.
- Kill points (memo phase-4.2 §10):
  - K1: after the integration entry's start event is fsynced, before the fast-forward (the queue's `fast-forward` step,
    `queue.ts` `fastForward`, moves the branch with `update-ref --no-deref <ref> <new> <old>`, `git.ts` CAS move).
  - K1 is taken at the `merge --ff-only` git call of the `fast-forward` step (its start event is fsynced by then).
  - K2: after `update-ref`, before the entry's end event.
  - K3: after `git commit` in a slot, before row 21.
