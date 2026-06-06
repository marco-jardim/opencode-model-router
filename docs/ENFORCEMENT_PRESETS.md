# Enforcement Presets & Proportional Tuning (PRELIMINARY)

> **Status:** Preliminary (Wave 4, Phase 4.3). The values below are derived from
> design reasoning and the offline fixture/E2E trajectories in `test/integration/`,
> **not** from field telemetry. Treat them as starting points and **re-tune with
> real data** (see *Re-tuning*, below). This mirrors the AgentCity harness caveat
> that reliable tuning needs an adequate sample (N ≥ 20) of live runs.

## What these are

`opencode-model-router` ships with enforcement **OFF by default** — with no
`enforcement` key in `tiers.json`, the plugin behaves exactly as it did before the
enforcement work (byte-for-byte identical routing; see GA-1). The blocks below are
**opt-in, copy-paste examples** you can add under the root of your `tiers.json` to
turn the three enforcement layers on with a posture that suits a given workflow.

> **These presets are not injected into `tiers.json` automatically, and selecting a
> routing mode (`/budget`, `/budget quality`, …) does NOT enable enforcement.** A
> routing mode only changes which tier work is routed to; enforcement is enabled
> *only* by an explicit `enforcement` block, `MODEL_ROUTER_ENFORCE=1`, or
> `/router enforce <advisory|enforced>`. No preset silently forces enforcement on.
>
> They are documented here (rather than written into `tiers.json`) so adopting them
> never disturbs a working copy of `tiers.json` you may already be editing. Copy the
> one that matches your routing mode and adapt.

The three layers each preset configures:

- **Layer 1 — hard-block guard** (`guard`): budget ceiling, anti-redundancy,
  anti-self-script, optional deliverable-first.
- **Layer 2 — acceptance gate** (`verify`): independent producer ≠ grader
  verification (deterministic checks and/or a grader ≥ producer tier).
- **Layer 3 — escalation ladder** (`escalate`): retry → escalate → honest give-up,
  bounded by attempts and a cost ceiling.

## How the cost ceiling interacts with `costRatio` (read this first)

The escalation ladder stops escalating once the **cumulative cost** of the producing
attempts exceeds:

```
ceiling = firstAttemptCostUnits × escalate.costCeiling.multiple
```

`firstAttemptCostUnits` is the `costRatio` of the tier the **first** attempt ran on.
With the default `anthropic` preset the tier cost ratios are:

| tier   | model                       | costRatio |
|--------|-----------------------------|-----------|
| fast   | `claude-haiku-4-5`          | 1         |
| medium | `claude-sonnet-4-6` (max)   | 5         |
| heavy  | `claude-opus-4-8` (max)     | 20        |

Because the cheapest tier has `costRatio = 1`, **a ladder that starts at `fast` with
a small `multiple` is intentionally shallow**. Worked example with the default
`multiple: 4` starting at `fast` (ceiling `= 1 × 4 = 4`):

```
attempt 1  fast    cumulative 1   (≤ 4, continue)
attempt 2  fast    cumulative 2   (≤ 4, continue)   ← retry same tier
attempt 3  medium  cumulative 7   (> 4, STOP)       ← escalates, verifies once, then give_up
```

So the effective shape is **[fast ×2, medium ×1] → give-up**; `heavy` is never
reached from a `fast` start at `multiple: 4`. The two knobs that deepen the ladder:

- **`escalate.costCeiling.multiple`** — raise it to allow more / more expensive
  attempts before give-up.
- **`escalate.floorTier`** — pin the *minimum* starting tier so cheap rungs are
  skipped and `firstAttemptCostUnits` (and therefore the ceiling) is larger. E.g.
  `floorTier: "medium"` makes `firstAttemptCostUnits = 5`, so `multiple: 6` gives a
  ceiling of `30` — enough to escalate `medium → heavy` once.

Tune `multiple` and `floorTier` together to get the ladder depth you want; the
presets below pick sensible pairings per routing mode.

## Per-mode presets

Add **one** of the following as a top-level `"enforcement"` key in `tiers.json`.
All are additive and fully optional; every field has a safe default if omitted.

### `normal` — balanced (routing defaultTier: `medium`)

Advisory for `fast` (surfaces guidance, never hard-blocks cheap exploration),
enforced for `medium`/`heavy` (where real implementation happens). Verifies only
when a DoD is present or auto-inferred.

```jsonc
"enforcement": {
  "mode": "advisory",
  "perTier": { "fast": "advisory", "medium": "enforced", "heavy": "enforced" },
  "guard": { "budget": 25, "readDraftCap": 3, "sameOpRetryCap": 1, "blockSelfScript": true, "deliverableFirst": true },
  "verify": { "require": "whenDoDPresent", "preferDeterministic": true, "graderPolicy": "atLeastProducerTier", "graderTemperature": 0 },
  "escalate": { "ladder": ["fast", "medium", "heavy"], "maxAttemptsPerTier": 1, "maxTotalAttempts": 4, "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 } },
  "proportional": { "trivialBypass": true }
}
```

### `budget` — cost-conscious (routing defaultTier: `fast`)

Lowest spend: smaller budget, tighter read-draft cap, a shallow ladder
(`multiple: 2` → at most a couple of cheap retries, rarely escalates), and
advisory everywhere except `heavy` so grader calls stay rare.

```jsonc
"enforcement": {
  "mode": "advisory",
  "perTier": { "fast": "advisory", "medium": "advisory", "heavy": "enforced" },
  "guard": { "budget": 15, "readDraftCap": 2, "sameOpRetryCap": 1, "blockSelfScript": true, "deliverableFirst": true },
  "verify": { "require": "whenDoDPresent", "preferDeterministic": true, "graderTemperature": 0 },
  "escalate": { "ladder": ["fast", "medium", "heavy"], "maxAttemptsPerTier": 1, "maxTotalAttempts": 3, "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 2 } },
  "proportional": { "trivialBypass": true }
}
```

### `quality` — quality-first (routing defaultTier: `medium`)

Fully enforced; verifies **always** (auto-infers a DoD when none is supplied); the
grader is never weaker than `medium` (`minGraderTier`); deeper ladder
(`multiple: 6`, `maxTotalAttempts: 5`) so a `medium` start can escalate to `heavy`.

```jsonc
"enforcement": {
  "mode": "enforced",
  "perTier": { "fast": "enforced", "medium": "enforced", "heavy": "enforced" },
  "guard": { "budget": 30, "readDraftCap": 4, "sameOpRetryCap": 1, "blockSelfScript": true, "deliverableFirst": true },
  "verify": { "require": "always", "preferDeterministic": true, "graderPolicy": "atLeastProducerTier", "minGraderTier": "medium", "graderTemperature": 0 },
  "escalate": { "ladder": ["fast", "medium", "heavy"], "maxAttemptsPerTier": 1, "maxTotalAttempts": 5, "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 6 } },
  "proportional": { "trivialBypass": true }
}
```

### `deep` — deep analysis (routing defaultTier: `heavy`)

For long, hard tasks. `floorTier: "medium"` skips the cheap rungs (so the ceiling is
large), `multiple: 8` and `maxAttemptsPerTier: 2` allow several strong attempts, and
`trivialBypass: false` means even quick-looking dispatches are verified.

```jsonc
"enforcement": {
  "mode": "enforced",
  "perTier": { "medium": "enforced", "heavy": "enforced" },
  "guard": { "budget": 40, "readDraftCap": 5, "sameOpRetryCap": 1, "blockSelfScript": true, "deliverableFirst": true },
  "verify": { "require": "always", "preferDeterministic": true, "graderPolicy": "atLeastProducerTier", "minGraderTier": "medium", "graderTemperature": 0 },
  "escalate": { "floorTier": "medium", "ladder": ["fast", "medium", "heavy"], "maxAttemptsPerTier": 2, "maxTotalAttempts": 6, "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 8 } },
  "proportional": { "trivialBypass": false }
}
```

## Defaults (used when a field is omitted)

These are the in-code defaults (`buildGuardPolicy`, `buildEscalatePolicy`,
`resolveEnforcementMode`), i.e. the effective `normal`-ish profile when
`enforcement.mode` is on but a sub-field is not specified:

| field | default |
|-------|---------|
| `mode` | `off` |
| `guard.budget` | `25` |
| `guard.readDraftCap` | `3` |
| `guard.sameOpRetryCap` | `1` |
| `guard.blockSelfScript` | `true` |
| `guard.deliverableFirst` | `true` |
| `guard.blockScriptWrites` | `false` (writing source files is normal work, never self-script) |
| `verify.require` | `whenDoDPresent` |
| `verify.preferDeterministic` | `true` |
| `verify.graderPolicy` | `atLeastProducerTier` |
| `verify.graderTemperature` | `0` |
| `escalate.ladder` | `["fast","medium","heavy"]` |
| `escalate.floorTier` | `null` |
| `escalate.maxAttemptsPerTier` | `1` |
| `escalate.maxTotalAttempts` | `4` |
| `escalate.costCeiling.multiple` | `4` |
| `proportional.trivialBypass` | `true` |

## Re-tuning with real data (the honest part)

The presets above are **preliminary**. The offline fixtures exercise the control
flow but cannot tell you the right caps/multiples for *your* models and tasks. To
tune for real:

1. Turn on enforcement in `advisory` first (records verdicts and scorecards without
   blocking) and run a representative workload (aim for N ≥ 20 delegations per
   tier/task-type).
2. Read the per-delegation **scorecards** and **trajectory** records the plugin
   writes under the OS temp dir (`…/opencode-model-router-trajectory/*.scorecard.log`
   and `*.delegate.log`), plus the trajectory metrics (`ttfa`, `read_exec_ratio`,
   `self_script_count`, `attempts`, `escalations`, `final_tier`, `cost_units`,
   `verdict`, `verify_method`, `grader_tier`).
3. Adjust `readDraftCap`/`budget` to where genuine work stops being blocked,
   `costCeiling.multiple`/`floorTier` to the ladder depth your hardest tasks need,
   and `verify.require`/`minGraderTier` to the verification strength that catches
   false-finishes without rubber-stamping.
4. Only then graduate from `advisory` to `enforced` for the tiers you trust.

When in doubt, prefer **`advisory`** — it gives you the data to tune without
interrupting flows.
