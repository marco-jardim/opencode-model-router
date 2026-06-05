# ADR 0001 — Layer 1: Hard-block execution guard

> **Status:** Accepted (Wave 1, Phase 1.0)
> **Depends on:** ADR 0000 (spike) — capability **A** confirmed: throwing inside `tool.execute.before` aborts *that tool call* (not the session) and the thrown message reaches the model verbatim as the tool's error result.
> **Scope:** Define the pure guard engine (`src/guard/guards.ts`) and the throw-contract that Phase 1.2 wires into `tool.execute.before`. Behaviour-preserving: with `enforcement.mode:"off"` the guard path is never reached (GA-1).

---

## 1. Context

The proven reference (`D:\git\agent-city-frontend\scripts\agent-city\agent-test\guards.mjs` + `opencode-plugin.mjs`) hard-blocks a weak model at the tool loop. But the reference is **domain-specific**: every test had exactly one known deliverable (`agent_city { op }`), so its guard clauses (`given_first`, `single_execution`, `wrong_flow`, `given_other`) all key off that single GIVEN op.

General coding has **no single known deliverable**. Per the plan's honest M5 framing, the *generalisable* value of Layer 1 is therefore:

1. **Budget ceiling** — cap total tool calls so a weak model cannot thrash to the context wall.
2. **Anti-redundancy** — block identical repeated reads (the weak-model "re-read the same file" loop).
3. **Anti-self-script** — block authoring/running a throwaway script *instead of* doing the task.
4. **Deliverable-first** — *only when a deliverable signal exists*, block exploration until the deliverable has been attempted. **Disabled (no-op) when no signal exists** (the common case).

## 2. Decision

### 2.1 Clause order (authoritative — `evaluateGuards(state, call, policy)`)

Evaluated top-to-bottom; first match wins. This is the order fixed by the plan (T1.1.1):

| # | Clause | Decision | Guard id | Fires when |
|---|--------|----------|----------|------------|
| 1 | **finish / return** | **allow** | — | `classify === "finish"`. A subagent's terminal/answer call is never blocked (mirrors reference `call.tool !== "finish"`). |
| 2 | **self-script** | **deny** | `anti_self_script` | `classify === "self_script"` AND not exempt (see §2.4 intent-awareness). |
| 3 | **budget ceiling** | **deny** | `iteration_cap` | `toolCallCount >= policy.budget` (and not a finish call). |
| 4 | **redundancy** | **deny** | `redundant_read` | read-only call whose fingerprint already occurred `>= policy.sameOpRetryCap` times. |
| 5 | **read-draft budget** | **deny** | `read_budget` | read-only call AND `consecutiveNonProducing >= policy.readDraftCap`. |
| 6 | **deliverable-first** | **deny** | `deliverable_first` | `policy.deliverableSignal != null` AND `!state.deliverableExecuted` AND call is not itself the deliverable (read/other). **Skipped entirely when `deliverableSignal == null`.** |
| 7 | **else** | **allow** | — | default. |

Rationale for placing **self-script before budget**: a self-script attempt is a *flow* violation we always want to name explicitly, even on the call that also happens to hit the budget; the forcing message is more useful than a bare `iteration_cap`. Budget is clause 3 so it still fires before any read/redundancy accounting.

Dropped reference clauses (AgentCity-specific, intentionally **not** ported): `single_execution` (re-running the deliverable is legitimate in coding), `wrong_flow`/`given_other` (no notion of a "wrong" deliverable), and the always-allow `health` category (folded into ordinary read classification).

### 2.2 Classification (`classify(call, policy) -> kind`)

`kind ∈ { finish, read, mutation, self_script, other }`.

- **finish** — `call.tool` ∈ `{ "finish", "return", "task_complete" }` (defensive; OpenCode subagents usually finish by emitting text with no further tool call, so this rarely fires — but never block it if it does).
- **self_script** — `isSelfScript(call, policy)` is true (see §2.4).
- **read** — `READ_ONLY_TOOLS.has(tool)` i.e. `{ grep, read, glob, ls }`.
- **mutation** — producing tools: `{ write, edit, patch, bash, multiedit }` (when not classified self_script).
- **other** — anything else (`todowrite`, `task`, custom tools, unknown). Counts as non-producing but is never itself denied except by budget.

### 2.3 Deliverable signal (M5 — the honest part)

`policy.deliverableSignal` is set by the wiring layer, NOT by the guard:

- **Mode B (plan-annotated):** the plan task's declared primary action / deliverable string.
- **Mode A (on-the-fly):** the dispatch's declared `first_action` hint, if the orchestrator supplied one.
- **None ⇒ `deliverableSignal = null` ⇒ clause 6 is a no-op.** This is the default for ordinary delegations and is the *expected* common case. We do **not** invent a deliverable; deliverable-first is a bonus that fires only when a real signal exists.

`state.deliverableExecuted` flips to `true` in `updateState` the first time a **mutation** call resolves `ok` (this also sets `ttfa`). Once executed, clause 6 never fires again.

### 2.4 Anti-self-script — intent-aware (§5.5)

Ported regex bank from the reference (verbatim semantics):

```
WRITE_TOOLS          = { write, edit, patch }            // multiedit also treated as write
SCRIPT_EXT_RE        = /\.(mjs|sh|py|js|ts|cjs|bash)\b/i
HEREDOC_RE           = /<<-?\s*['"]?[A-Za-z_]/
REDIRECT_SCRIPT_RE   = />\s*\S+\.(mjs|sh|py|js|ts|cjs|bash)\b/i
INLINE_SCRIPT_RE     = /\b(node|python3?|deno|bun)\s+-(e|c)\b/i
CAT_WRITE_RE         = /\bcat\s+>\s*\S/i
BASH_C_RE            = /\bbash\s+-c\b/i
```

`isSelfScript(call, policy)`:
1. If a WRITE tool targets a path matching `SCRIPT_EXT_RE` → candidate.
2. If `bash`/`shell` command matches any of HEREDOC/REDIRECT/INLINE/CAT_WRITE/BASH_C → candidate.
3. **Intent exemption (NEW, generalises §5.5):** a candidate is **allowed** (returns `false`) when the policy says the declared deliverable *is* a script — i.e. `policy.deliverableIsScript === true`, or the written path equals/*matches* `policy.deliverablePath`. A task whose job is to write `build.sh` or a codegen `*.mjs` must not be blocked.

So self-script detection keys off **intent from the DoD/task**, not just the file extension.

### 2.5 Throw-message contract (Phase 1.2 consumes this)

On a denied call in **enforced** mode the wiring throws:

```
throw new Error(`${decision.observation}\n${forcingMessage(state)}`)
```

- `decision.observation` — the per-clause `DENIED: …` sentence (model-actionable, secret-free).
- `forcingMessage(state)` — generalised from the reference:

```
[budget <n>/<B> | deliverable=<ran|NOT RUN|n/a> | reads_since_produce=<k>] NEXT: <action>
```

`deliverable=n/a` when `deliverableSignal == null`. `NEXT` tells the model exactly what to do: run the deliverable (signal + not run), else "take a producing action (write/edit) or emit your final answer".

Spike-confirmed: this string reaches the model as the aborted tool's error result, verbatim. **Security:** observation + forcing message are built only from tool *names*, counters, and the (already model-authored) deliverable hint — never from tool *output* or args values, so no secret can leak. A `scrubText` pass (Phase 1.2) is applied defensively anyway.

### 2.6 Advisory vs enforced switch

Resolved per session/tier by `resolveEnforcementMode` (already built, Phase 0.3):

- **off** → `tool.execute.before` returns immediately; `evaluateGuards` never called; zero added tokens, byte-identical behaviour (GA-1).
- **advisory** → `evaluateGuards` runs for telemetry and a banner is surfaced (reuse the existing `tool.execute.after` banner channel), but the decision is forced to `allow:true`; **never throws**.
- **enforced** → `evaluateGuards` authoritative; `!allow` ⇒ throw per §2.5.

The guard engine itself is pure and mode-agnostic; the mode only governs whether the wiring throws. This keeps `guards.ts` 100%-testable without the SDK.

### 2.7 State & counting

`newGuardState(policy)` →
```
{ toolCallCount, readCount, execCount, selfScriptCount, redundantCount, blockedCount,
  consecutiveNonProducing, deliverableExecuted:false, ttfa:null,
  seen: Map<fingerprint, count>, lastBlock: null }
```

`updateState(state, call, { ok })` (ported + generalised):
- `finish` → no-op (never counts).
- always `toolCallCount += 1`.
- `self_script` → `selfScriptCount++`, `consecutiveNonProducing++`.
- `mutation` → `execCount++`, `consecutiveNonProducing = 0`, and if `ok && !deliverableExecuted` → `deliverableExecuted = true; ttfa = toolCallCount`.
- `read` → `readCount++`, `consecutiveNonProducing++`, bump `seen[fingerprint]`.
- `other` → `consecutiveNonProducing++`.

**Blocked calls still count** (mirrors reference: the wiring calls `updateState(…, {ok:false})` before throwing) so a blocked model cannot spin the budget for free. `blockedCount` and `redundantCount` are bumped by the wiring on a deny.

`trajectoryMetrics(state)` returns the snake_case subset already defined in `src/telemetry/trajectory.ts` (`ttfa`, `read_exec_ratio`, `self_script_count`, `tool_call_count`, …) so guard state feeds the existing scorecard rather than duplicating it.

## 3. Consequences

- **Generalises honestly:** with no deliverable signal (the norm), Layer 1 = budget + anti-redundancy + anti-self-script. Deliverable-first is opt-in via a signal.
- **False-positive surface** is concentrated in two places, both covered by adversarial tests in Phase 1.1/1.2: (a) self-script on a legitimate script-authoring task → exempted by §2.4 intent; (b) redundant-read on a legitimate re-read after a write → mitigated because `consecutiveNonProducing` resets on mutation and the redundancy clause only counts *identical* fingerprints (a re-read after an edit is usually a different intent but identical fingerprint — see Open Question O1).
- **GA-1 preserved:** off-mode never enters the guard.
- **Pure & deterministic:** enables ≥95% branch coverage + property-based termination tests (no input sequence can loop forever because every call increments `toolCallCount`, and clause 3 denies once `>= budget`; `finish` is always allowed and terminal).

## 4. Open questions (resolved-with-default; revisit in Phase 1.1 QA)

- **O1 — redundant re-read after a write.** A model that writes `foo.ts` then re-reads `foo.ts` to verify produces an identical `read:foo.ts` fingerprint. With `sameOpRetryCap=1` the 2nd read is blocked. **Default decision:** acceptable — the forcing message tells it to proceed to a producing action or finish; verification belongs to Layer 2, not the subagent re-reading. If field data shows this is too aggressive, raise `sameOpRetryCap` or reset `seen[fp]` on an intervening mutation. Documented, not pre-optimised.
- **O2 — `bash` that is a legit build/test command** (`npm test`, `tsc`) must classify as **mutation/other-allowed**, not self_script. The regex bank only flags inline-script / heredoc / `bash -c` / cat-write / redirect-to-script patterns, so `npm test` is safe. Covered by a Phase 1.1 edge test.
- **O3 — `multiedit`/`patch` extensions.** Treat `multiedit` as a write tool for self-script purposes. Covered in §2.2/§2.4.

## 5. Test obligations handed to Phase 1.1

Exhaustive unit + property-based: clause-order table; budget at cap vs cap+1; identical read twice (deny) vs different file (allow); read→read→produce resets `consecutiveNonProducing`; self-script blocked **but** script-authoring DoD allowed; deliverable-first with no signal never blocks; advisory never denies; unknown tool ⇒ `other`; obfuscated shell self-script (case/whitespace) still caught; property: counters monotonic, `finish` always allowed, no infinite block loop (termination).
