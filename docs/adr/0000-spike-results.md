# ADR 0000 — Enforcement-Primitives Spike Results (Phase 0.0)

> **Status:** Accepted
> **Date:** 2026-06-05
> **Phase:** WAVE 0 / Phase 0.0 (GATES the whole plan — Directive E)
> **Decision owner:** Marco Jardim (router owner)
> **Related:** `docs/plans/model-router-enforcement-and-verification-plan.md` §3, §3.2, §3.3, §13 (Open Q1), GA-8.

## Context

The enforcement plan is explicitly **conditional** on what the OpenCode plugin SDK can actually do
(Directive E). Before building any of the three layers we had to empirically answer three capability
questions and pin the artefact contract:

- **Capability A** — Can throwing inside `tool.execute.before` **abort** a tool call, and does the
  thrown text reach the model? (Linchpin of Layer 1 hard-block.)
- **Capability B** — Can a plugin register a **custom tool** the orchestrator can call and whose
  return it receives? (Required for Option (ii) `delegate` tool.)
- **Capability C** — Can a plugin **observe a subagent's tool calls and final return**? (Required for
  Layer 2 artefact assembly.)

## Method

1. **Typings recon** of the installed SDK (read-only).
2. **A throwaway probe plugin** (`test/smoke/probe/probe-plugin.js`, non-shipping) that registers two
   custom tools (`probe_echo`, `probe_block_me`), a `tool.execute.before` that throws on
   `probe_block_me`, a `tool.execute.after`, and an `event` logger. All events are appended as JSON to
   `tmp/probe/probe-events.log` (gitignored).
3. **One live run** against a real cheap model, non-interactively:
   ```
   opencode run "...call probe_echo then probe_block_me, report each result/error..." \
     --model anthropic/claude-haiku-4-5 --format json --dangerously-skip-permissions
   ```
   Loaded via a **temporary** repo-root `opencode.json` (deleted after; the user's global config was
   never modified). Exit code 0, ~19 s.

### SDK / runtime version landscape (record for R10 — version drift)

| Location | `@opencode-ai/plugin` | Notes |
|----------|----------------------|-------|
| repo `node_modules/` | **1.2.6** | what `tsc`/tests resolve against |
| repo `.opencode/package.json` | **1.4.1** | project-local plugin dep |
| `opencode` CLI | **1.15.13** | bundles the **runtime** that actually invokes the hooks |

The probe ran under the **CLI 1.15.13 runtime** — i.e. the production execution path. Hook *typings*
were read from 1.2.6. The before-hook abort semantics are a **runtime** property and were confirmed
against the runtime that ships to users. **Each Wave's real-OpenCode smoke (M1) must re-confirm** the
primitive it relies on, and Phase 1.2 pre-flight must re-spike if the CLI/SDK drifts (Directive E).

## Findings (evidence)

### Capability A — throw-to-abort: **CONFIRMED (empirical)**

- `probe_block_me`'s `execute` **never ran** — `block_execute_REACHED` is absent from the log; only
  `before` then `before_throw` were logged.
- The tool-call record in the JSON event stream was:
  ```json
  { "tool": "probe_block_me",
    "state": { "status": "error", "input": { "reason": "test" },
               "error": "PROBE_BLOCKED: before-hook aborted this call (capability A)." } }
  ```
- The model **received the thrown text verbatim** and reported it back.
- The session **continued and exited cleanly (code 0)** after the block — the throw aborts *the tool
  call*, it does not crash the session.

**Implication:** Layer 1 can hard-block by throwing in `tool.execute.before`, and the throw message is
the perfect carrier for the **forcing message**. This is exactly the reference
(`agent-test/opencode-plugin.mjs`) pattern, now re-confirmed on CLI 1.15.13.

### Capability B — custom tool: **CONFIRMED (empirical)**

- `probe_echo` was registered via the plugin `tool` map, **called by the model**, executed
  (`echo_execute` logged), returned `PROBE_ECHO_OK:hello` (`status:"completed"`), and the model quoted
  the return verbatim.
- Registration shape that works: `import { tool } from "@opencode-ai/plugin"`, build args with the
  zod re-export `const z = tool.schema`, then put the built tool under
  `return { tool: { <name>: <builtTool> } }`. **This is the construction the real `delegate` tool will
  reuse in Wave 2.**

### Capability C — subagent interception: **CONFIRMED for the event stream; child-correlation deferred**

- The `event` hook fired for **12 distinct event types** in a single simple run, including the ones the
  artefact contract needs:
  - `message.updated` (carries the assistant `Message` → final return text),
  - `message.part.updated` / `message.part.delta` (carry `ToolPart` with `state.output` → a session's
    tool calls + outputs; `message.part.delta` is the only event exposing a non-null `messageID`),
  - `session.created`, `session.idle`, `session.status`, `session.diff`.
- `event.properties.sessionID` is populated on all session/message events (null only on global
  `tui.toast.show` / `server.instance.disposed`).
- **`parentID` was `null` on every event** — but this run **did not spawn a subagent**, so there was no
  child session to carry one. The field exists in the typings
  (`EventSessionCreated.parentID?`, `AssistantMessage.parentID`). **Parent/child correlation for a real
  `Task()` child is therefore typed-but-not-yet-exercised.**
- Independently, `tool.execute.before` / `after` fired with the session's `sessionID`, so the
  **enforcement point fires per-session** — which is what Layer 1 needs (it keys off the existing
  `subagentSessionIDs` detection, not off `parentID`).

## The artefact contract (§3.3) — what is achievable

`Artefact = { changedFiles, finalReturnText, declaredOutputs }`, assembled as:

- **changedFiles** — attributed to a delegation by observing that session's **edit/write tool calls in
  `tool.execute.after`** (keyed by `sessionID`), *not* a global `git diff` (concurrency-safe, §5.6).
  `event` `session.diff` / `file.edited` are a secondary signal.
- **finalReturnText** — the subagent's final assistant text via `message.updated` → `Message`, and/or,
  under Option (ii), the **string returned by the `delegate` tool's own `execute`** (cleanest).
- **declaredOutputs** — paths/commands named explicitly by the DoD; always verifiable regardless of A/B/C.

**Residual limit (record):** a *free-form, text-only* deliverable with no declared output and no changed
files can only be **checker-graded on the returned text**. Acceptable and documented (matches §3.3).

## Decision

1. **Architecture = Option (ii) (plugin-provided `delegate` tool) is the buildable robust end-state**,
   because **Capability B is confirmed**. Raw `Task()` keeps working via **Option (i)**
   (protocol-enforced verify-dispatch) for back-compat.
2. **All three layers are buildable as designed:**
   - Layer 1 (hard-block) — **buildable** (Cap A ✅). `[needs Spike cap. A]` → **RESOLVED: buildable.**
   - Layer 2 (acceptance gate) — **buildable** via Option (ii) (`delegate` tool returns only an
     accepted result) with deterministic + checker verifiers. `[needs Spike cap. B or C]` →
     **RESOLVED: buildable (B ✅).**
   - Layer 3 (escalation) — **buildable** (pure policy; composes on top of the gate).
3. **Open Q1 is NOT triggered.** Q1 only fires if **both** B and C are absent; B is confirmed, so we do
   **not** stop to escalate. We proceed building Option (ii).
4. **GA-8** is satisfied for A and B now; the C **child-session** facet is satisfied at the typings
   level and **must be re-confirmed empirically in the Wave-2 smoke** (see below).

## Consequences / follow-ups (carried into later phases)

- **W2 smoke (must spawn a real subagent):** confirm (a) `parentID` populates for a `Task()` child so
  orchestrator-vs-subagent sessions are distinguishable via events, and (b) whether the plugin factory's
  injected **`client`** (the OpenCode SDK client) can `session.create` + `prompt` + await a child result
  so the `delegate` tool can **produce → gate → return accepted-only** internally. If `client` cannot
  spawn/await, Option (ii) degrades to "delegate tool wraps the *gate* around an
  orchestrator-driven `Task()`" (still owns verify/accept, just not the spawn). Either way the gate is
  plugin-owned. **Not blocking.**
- **Throw-message contract (Layer 1):** the thrown `Error.message` IS the model-visible observation;
  keep it secret-free (§5.5) and end it with the forcing message.
- **Re-spike trigger (R10):** if `opencode --version` or the bundled plugin SDK changes before Wave 1
  wiring, re-run this probe (Phase 1.2 pre-flight).

## Probe artifact

Kept at `test/smoke/probe/probe-plugin.js`, **non-shipping** (`package.json` `files` is restricted to
`src/`, `tiers.json`, `LICENSE`, `README.md`; `tmp/` is gitignored). Reusable as the seed for the
Wave-1/Wave-2 real-OpenCode smokes.
