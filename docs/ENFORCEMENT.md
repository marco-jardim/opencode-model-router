# Layer 1: Hard-block execution guard

Converts advisory read-only caps into real hard-blocks for subagent sessions. Opt-in; orchestrator sessions and `mode:"off"` are byte-identical to pre-enforcement routing (GA-1).

## Mechanism

A `tool.execute.before` hook. In `enforced` mode, when the guard denies a call it **throws**; opencode aborts the tool call and the thrown message reaches the model as that tool's error text (empirically confirmed).

Applies **only** to subagent sessions — sessions whose agent matches a tier name, plugin-created delegate producer sessions and, in roles mode, role-agent child sessions. Orchestrator sessions and `mode:"off"` are early-return no-ops.

Role agents are guarded too, with their **role profile** instead of the tier policy below: the role's budget for the tier the dispatch runs on (raised by a route-line `budget=`), its own cumulative ceiling, the reader or producer kind of the role, and a stop that asks for `NEED MORE: budget` (`roleGuardProfile`, `src/router/guard-profile.ts`). See [the reader guard profile](./READ_ONLY_TIERS.md#reader-guard-profile-84) and [role budgets](./ROLES.md#budgets).

## Modes (`enforcement.mode`)

| mode | effect |
|------|--------|
| `off` | Hook is a no-op. Zero added tokens. Byte-identical to pre-enforcement (GA-1). |
| `advisory` | Guard is evaluated; a `[⚠ GUARD:<name>] <forcing message>` banner is appended to the tool result via the after-hook. Never throws. |
| `enforced` | Deny ⇒ throw `<observation>\n<forcing message>`. |

## Guard evaluation (`evaluateGuards`)

Pure / non-mutating. First match wins. `test/unit/docs-drift.test.ts` checks that every guard name `evaluateGuards` (`src/guard/guards.ts`) returns has a row here.

<!-- guard-table -->
| # | condition | verdict | guard name |
|---|-----------|---------|------------|
| 1 | call is a finish / return / task_complete signal | ALLOW | — |
| 2 | call matches self-script pattern | DENY | `anti_self_script` |
| 3 | `toolCallCount >= budget` | DENY | `iteration_cap` |
| 3b | `totalToolCallCount >= cumulativeBudget` (calls across every resumed round of the session) | DENY | `cumulative_iteration_cap` |
| 3c | refused calls in this round `>= min(budget, REFUSAL_CAP)` AND executed + refused calls `>= budget` | DENY | `denied_cap` |
| 4 | read whose fingerprint was seen `>= sameOpRetryCap` times | DENY | `redundant_read` |
| 5 | read while `consecutiveNonProducing >= readDraftCap` — **producer profile only**; a reader dispatch never gets it | DENY | `read_budget` |
| 6 | `deliverableFirst` enabled AND deliverable signal exists AND not yet executed AND call is read/other | DENY | `deliverable_first` |
| 7 | — | ALLOW | — |

- **Refused calls are not charged.** A call the guard refuses in `enforced` mode does not count toward `budget` and is not recorded as executed by the repeat check; `denied_cap` bounds a loop of refusals instead (`REFUSAL_CAP` = 10, `src/router/guard-profile.ts`). Calls refused outside the guard — the router's role-authority refusals and structured host permission denials — count toward `denied_cap` too, in `advisory` mode as well as `enforced` (`guardRefusedCall`); in `advisory` the would-stop is only recorded with its banner, nothing is stopped.
- **Stops.** In `enforced` mode a refusal by `iteration_cap`, `cumulative_iteration_cap` or `denied_cap` stops the child's round. `advisory` never stops anything.
- **Reader profile.** Read-only tiers, routed classes `review`/`recon`/`search`, an uncapped `CAP:none` dispatch and the reader roles are guarded as readers: row 5 never applies and the forcing message never asks for a write ([details](./READ_ONLY_TIERS.md#reader-guard-profile-84)).

## Self-script detection (`isSelfScript`)

Writing source files (`.ts`, `.js`, `.py`, `.mjs`, etc.) is the normal coding deliverable and is **not** blocked by default. Extension-based write blocking is opt-in via `blockScriptWrites` (default `false`).

Note the two settings are independent: `blockSelfScript` (default `true`) keeps the self-script guard *active*, but with `blockScriptWrites` left at `false` that guard's default scope is **bash ad-hoc execution only** — it does not touch `write`/`edit` of source files. Setting `blockScriptWrites: true` additionally blocks writes to script extensions; setting `blockSelfScript: false` disables the guard entirely.

The always-on self-script signal catches **bash ad-hoc execution only**:

```
heredocs  ·  node|python|deno|bun -e/-c  ·  cat > file  ·  bash -c  ·  redirect-to-script
```

**Intent exemptions**: if the DoD's declared deliverable is a script (`deliverableIsScript`), or the write target equals the declared deliverable path, the call is allowed.

## Policy defaults (`buildGuardPolicy`)

For tier agents and delegate producer sessions. A role dispatch takes `budget` and `cumulativeBudget` from its role profile instead ([ROLES.md](./ROLES.md#budgets)); the other fields apply to it as listed.

| field | default |
|-------|---------|
| `budget` | `25` (`DEFAULT_GUARD_BUDGET`) |
| `cumulativeBudget` | `budget` × 3 (`CUMULATIVE_BUDGET_MULTIPLIER`) |
| `readDraftCap` | `3` (producer profile only) |
| `sameOpRetryCap` | `1` |
| `blockSelfScript` | `true` |
| `deliverableFirst` | `true` |
| `blockScriptWrites` | `false` |
| `deliverableSignal` | `null` (deliverable-first effectively disabled until wired) |

## Forcing message format

```
[budget N/B | deliverable=n/a|ran|NOT RUN | reads_since_produce=K] NEXT: <instruction>
```

## Proportional enforcement (GA-6)

`trivial` is classified **at dispatch**, not from realized tool counts. `classifyTrivial` is tier-gated to the `fast` tier and requires a fast `taskPattern` keyword match with no medium/heavy signal — conservative, biased toward non-trivial so real work is never mis-classified.

A trivial `fast` dispatch downgrades `enforced` → `advisory` when `enforcement.proportional.trivialBypass !== false` (default `true`). `medium` / `heavy` work is always fully enforced.

## Security

Thrown messages and banners pass through `scrubText` (redacts API keys / bearer tokens / `key=value` secrets). No secrets leak into observations.

## Enabling enforcement

```jsonc
// tiers.json
"enforcement": { "mode": "enforced" }
```

```sh
# environment variable
MODEL_ROUTER_ENFORCE=1
```

```
# slash command
/router enforce <off|advisory|enforced>
```

See [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md) for the full schema and [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md) for per-mode example blocks.
