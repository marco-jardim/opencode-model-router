# Phase 2.1 QA round 2, part 2: interface contract between the two fix dispatches

Binding for the dispatches "r2 part 2 A" (owner of `src/index.ts`, `src/verify/*`, `src/router/config.ts`, docs) and
"r2 part 2 B" (owner of `src/compat/background.ts`, `src/compat/v2-hooks.ts`, `test/helpers/v2-bg-host.ts`). B adds the
members below to the `FinishApi` interface in `background.ts`; A implements them in the plugin's `finishApi` in
`src/index.ts`. Until both are done, typecheck errors at that boundary are expected; the orchestrator runs the final
typecheck.

```ts
/** What a restart keeps of a dispatch so the gate can run again (QA-2.1-17). Journaled by B with `inflight`. */
export interface RestoredDispatch {
  /** The task tool's call arguments as the plugin recorded them for the live gate (prompt, description, subagent type…). */
  readonly args?: Readonly<Record<string, unknown>>;
  /** The directory the dispatch ran in (work root), when known. */
  readonly cwd?: string;
}

interface FinishApi {
  // existing members unchanged; `finish` gains one optional trailing parameter:
  //   finish(...existing params, restored?: RestoredDispatch)
  // When `restored` is given and the in-memory task args are missing, the gate uses `restored.args` / `restored.cwd`.
  // When `restored` is given without `args`, the held verdict is UNVERIFIABLE "verification data lost in restart"
  // (never the read-only skip). When the restored pending entry already carries a verdict (state record), that verdict
  // is posted instead of re-running the gate.

  /** Resolves when no held gate started through `finish` is still running (QA-2.1-21). */
  idle(): Promise<void>;

  /**
   * Claims `parentSessionID` for this plugin instance (pid + instance token) at the first `inflight`/`hold` record
   * (QA-2.1-19). Returns false when another live owner holds the claim; B then does not write the records' adoption side
   * effects for that session and never adopts it.
   */
  claimSession(parentSessionID: string): boolean;

  /** Settles the pending entry of a held handle whose verdict was posted directly through the held-results sink (QA-2.1-31). */
  markPosted(handle: string): void;
}
```

Rules:
- B writes `hold-text` only when the child status is `succeeded`, passes the real child status to `finish` (never a
  forced `succeeded`), and passes `restored` from the journaled `inflight` record when re-running a restored hold.
- B awaits `api.idle()` inside the settled/dispose seam.
- A keeps dormant records when a claim fails in `adopt` (QA-2.1-19 extended).
