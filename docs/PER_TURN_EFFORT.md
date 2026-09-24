# Per-turn effort and timing (Claude Code 2.1.280)

What upstream Claude Code 2.1.280 does with per-turn effort and timing, which models declare
those capabilities, and what that means for the `anthropic` preset this router ships. Each
section says whether it states a **fact** (with its source) or a **recommendation**.

**Cross-references:** [CONFIG_REFERENCE.md — Per-tier `effort`](./CONFIG_REFERENCE.md#per-tier-effort) · [CONFIG_REFERENCE.md — Provider gate for explicit `thinking` and `reasoning` fields](./CONFIG_REFERENCE.md#provider-gate-for-explicit-thinking-and-reasoning-fields)

**Evidence:** the npm package `@tormentalabs/claude-code-wire-compat`, file
`docs/protocol/versions/claude-code-2.1.280-analysis.md` (search it for `per-turn-control-2026-07-01`; the message shape is in §11.2, "Per-turn effort
and timing on `api_system` messages").

---

## The upstream mechanism (fact)

Everything in this section comes from the 2.1.280 analysis above. None of it was observed
from this repository. One statement is sourced by the analysis itself to Anthropic's
release notes rather than to the extracted bundle; it is tagged where it appears.

### Effort travels on the message, not the request

Upstream `api_system` messages carry their own `outputConfig` object holding `effort` and
`timing`. The analysis derives this from two downgrade transforms in the bundle: one strips
the whole `outputConfig` from an `api_system` message when per-message effort is
unavailable, the other strips only `timing` when `per_turn_timing` is unavailable.

A plausible **reading** of that placement — ours, not something the analysis states — is
that effort can change mid-conversation without touching the request-level configuration,
because the change is appended as a message rather than written into that configuration.
If so, it might leave a cached prompt prefix intact. The analysis's section on this
mechanism says nothing about caching, and its nearest cache statement, about a
neighbouring mechanism, is explicitly unresolved: whether it preserves a server-side
prompt cache is **not evidenced by the bundle**. Treat any cache benefit here as
unverified.

### Which models declare the capabilities

| Capability | Declared by |
|---|---|
| `per_turn_effort` | `claude-opus-5-5`, `claude-fable-5-1` |
| `per_turn_timing` | `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` |

`claude-mythos-5-1` declares `per_turn_timing` but not `per_turn_effort`.

### Which beta identifiers are emitted

| Beta identifier | Emitted by default? |
|---|---|
| `per-turn-control-2026-07-01` | Yes — on the default request path, for a model whose catalogue entry declares `per_turn_effort`. |
| `timing-2026-09-09` | No — environment-gated off; it requires `CLAUDE_CODE_PER_TURN_TIMING`. |

### What the analysis records about `claude-opus-5-5`

- Its catalogue entry is marked `adaptive_thinking` and `rejects_disabled_thinking`.
- The client's own emission site chooses between an adaptive thinking object and a
  budgeted one through a helper that the analysis leaves explicitly unresolved.
- It rejects `tool_choice` values `any` and `tool`. **Provenance:** the analysis sources
  this statement to Anthropic's Opus 5.5 release notes, not to the extracted bundle — it is
  the one claim in this section that does not come from bundle extraction.

---

## The HTTP 400 budget claim (unsourced)

This section is **not** covered by the upstream-mechanism section above.

- `claude-opus-5-5` rejecting a manually supplied thinking budget with **HTTP 400** is
  stated in [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md#provider-gate-for-explicit-thinking-and-reasoning-fields),
  which calls it "a newer upstream constraint" and **cites no source** for it.
- The 2.1.280 analysis document does **not** contain this claim. Its mentions of HTTP 400
  concern a rejection ladder for `thinking.(adaptive|enabled).display` and `block_binding`,
  and a version gate — none of them about thinking budgets.
- What the analysis does support is narrower, and is listed above: the
  `adaptive_thinking` / `rejects_disabled_thinking` catalogue flags, and an emission site
  that picks between adaptive and budgeted thinking through an unresolved helper.

---

## What this means for this router

### Facts read from this repository

The bundled `anthropic` preset points `@medium` at `claude-opus-5-5`. From `tiers.json`:

```jsonc
"medium": {
  "model": "anthropic/claude-opus-5-5",
  "variant": "high",
  "effort": "high",
```

`buildAgentOptions` in `src/router/agent-options.ts` gates the explicit fields for Claude
models: it never registers `reasoning_effort` / `reasoning_summary` on a Claude model, and
never registers `budget_tokens` on an adaptive-only Claude model (`isAdaptiveOnlyClaudeModel`
in `src/router/protocol.ts`, which lists the 2.1.280 catalogue entries carrying
`rejects_disabled_thinking`: `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1` and
`claude-mythos-5-1`).
Each drop warns once per tier. Non-Claude tiers are still passed through unchecked. See
[CONFIG_REFERENCE.md — Provider gate for explicit `thinking` and `reasoning` fields](./CONFIG_REFERENCE.md#provider-gate-for-explicit-thinking-and-reasoning-fields).

Nothing in `buildAgentOptions` emits a per-turn `outputConfig` or either beta identifier
above. A tier's `effort` is a registration-time value on the agent's `options`, fixed for
the life of that agent.

### The consequence (rests on the unsourced HTTP 400 claim, not observed here)

With the tier exactly as shipped, `@medium` sets `effort: "high"` and no `thinking` block, so
`buildAgentOptions` registers `effort: "high"` and **no** `budget_tokens`. The shipped
default does not, by itself, send a manual thinking budget.

When a `claude-opus-5-5` tier also sets `thinking.budgetTokens` — in an overrides file or
an edited preset — `buildAgentOptions` drops the budget with a one-time warning and
registers the tier's `effort` as if no budget were set. Before that gate, the budget was
registered and outranked `effort`, so the request carried a manual thinking budget to that
model. [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md#provider-gate-for-explicit-thinking-and-reasoning-fields)
reports that such a request is answered with HTTP 400; that report cites no source and is **not**
in the 2.1.280 analysis (see [The HTTP 400 budget claim](#the-http-400-budget-claim-unsourced)).
The gate is a precaution keyed to the `rejects_disabled_thinking` catalogue flag, not a
response to an observed failure.

No test and no live request in this repository has produced that 400, and the upstream
analysis does not state it. It rests solely on the unsourced statement in
`CONFIG_REFERENCE.md`.

Not verified here: whether opencode turns the tier's `variant: "high"` into a thinking
budget further down the stack. That mapping lives outside this repository.

---

## Recommendations

1. **Configuration, now:** on a `claude-opus-5-5` tier (and on the other adaptive-only
   Anthropic models listed in the provider gate) set `effort`, never
   `thinking.budgetTokens`. The router now ignores the budget there with a warning, but
   the tier reads more honestly without it.
2. **Code — implemented:** the `budget_tokens` and `reasoning_*` branches of
   `buildAgentOptions` are gated for Claude models and warn instead of registering (see
   [the provider gate](./CONFIG_REFERENCE.md#provider-gate-for-explicit-thinking-and-reasoning-fields)).
   The budget half rests on the `rejects_disabled_thinking` catalogue flag; the HTTP 400
   it guards against remains the unsourced claim above. Non-Claude tiers are not gated.
   The `tool_choice` `any` / `tool` restriction is out of the router's reach: the router
   never emits `tool_choice`, so that restriction is a wire-layer concern
   (claude-code-wire-compat, 2.1.280 analysis §6.6).
