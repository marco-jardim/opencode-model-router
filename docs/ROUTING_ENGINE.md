# Cost-aware routing engine (#74)

The routing engine decides, for every dispatch, which **agent**, **model and variant**, and which **retry path** is expected to cost the least for a given kind of work, and it learns that from verified outcomes instead of from prose. It sits on top of the tiered router: with no `routing` block in your configuration the plugin behaves exactly as `2.2.0` did.

> **Requires OpenCode v2.** The engine, the ladder's variant and session steps, telemetry ingestion and the cost doctor run on OpenCode v2 only. On v1 the `routing` block is parsed and validated, `routing.engine` is forced to `static`, and the only effect of the feature is an opt-in text line (see [OpenCode v1](#opencode-v1)).
>
> **Decision record:** [`adr/0005-cost-aware-routing-engine.md`](./adr/0005-cost-aware-routing-engine.md). **Every key and default:** [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md#routing--cost-aware-routing-engine-74). **Plan and QA reports:** [`plans/cost-aware-routing-engine-plan.md`](./plans/cost-aware-routing-engine-plan.md), [`qa/cost-aware-routing/`](./qa/cost-aware-routing/).
>
> Decision ids (`D1`…`D18`) and amendment ids (`A1`…`A30`) in this page refer to the plan, §1.5; the ADR lists them all.

## Contents

- [Concepts](#concepts)
- [The four modes](#the-four-modes)
- [Turning it on](#turning-it-on)
- [How one dispatch is routed](#how-one-dispatch-is-routed)
- [The expected-cost formula](#the-expected-cost-formula)
- [Cost units and zero-cost models](#cost-units-and-zero-cost-models)
- [When `enforce` switches a dispatch](#when-enforce-switches-a-dispatch)
- [The classifier and its backends](#the-classifier-and-its-backends)
- [Privacy](#privacy)
- [Roles and native agents](#roles-and-native-agents)
- [The session-aware ladder](#the-session-aware-ladder)
- [Outcomes, the decision log and statistics](#outcomes-the-decision-log-and-statistics)
- [The cost doctor](#the-cost-doctor)
- [OpenCode v1](#opencode-v1)
- [Known limits and experimental parts](#known-limits-and-experimental-parts)

## Concepts

| Term | Meaning |
|---|---|
| **Task facts** | What the engine knows about one dispatch, decided in code: `class` (`search`, `recon`, `mechanical`, `implement`, `debug`, `design`, `review`, `other`), `risk` (`low`, `medium`, `high`), `scope` (`single`, `multi`, `repo`), `needs` (any of `shell`, `web`, `edit`, `network`, `external_dir`), a `confidence` in `[0, 1]` and a `source` (`rules`, a route line, a plan, a backend). |
| **Candidate** | One thing a dispatch could be sent to: a router tier (`@fast`, `@medium`, `@heavy`) at one of its rungs, or a native/user agent listed under [`routing.roles`](#roles-and-native-agents). |
| **Rung** | One `(model, variant, costRatio)` of a tier's ladder. Without `candidates` a tier has one rung, its own. See [Tier `candidates`](./CONFIG_REFERENCE.md#tier-candidates). |
| **Key** | `(class × agent × model#variant)`: the unit the scoreboard keeps. |
| **Outcome** | A verification verdict (`pass`, `fail`, `unverifiable`) or a false refusal (a child that handed back with zero tool calls) for a key. |
| **Posterior** | A Beta distribution over "this key passes verification for this class", built from a prior (below) and the key's outcomes. Only verified outcomes feed it (D4). `unverifiable` verdicts change nothing; a false refusal counts as a failure. |
| **Decision** | The engine's answer for one dispatch: `chosen` (what the orchestrator picked), `best` (the cheapest eligible candidate by expected cost), whether it would switch, why. |
| **Pin** | `[route … pin]`: the tier is mandated by a plan or by policy; the engine never switches a pinned dispatch. |

**Priors (D7).** A candidate that ranks the same as the class's static tier starts at `Beta(4, 1)` (mean 0.80); each rank above adds 0.05 (cap 0.95), each rank below subtracts 0.25 (floor 0.30); the strength is always 5 pseudo-observations. The static tier of a class comes from the shipped taxonomy: `search`, `recon`, `mechanical` → `fast`; `implement`, `review`, `debug` → `medium`; `design` → `heavy`; `other` has none (the orchestrator's choice stands). Old outcomes decay with a half-life (`routing.outcomes.halfLifeDays`, 14) and one posterior holds at most `routing.outcomes.maxEffectiveSamples` (50) effective samples.

## The four modes

`routing.engine` is the one switch. The modes are product features, not stages: all four are complete. Raise them one step at a time. A change is config-only and is picked up by the normal hot reload (no restart).

| Mode | Decides | Records | Orchestrator sees | Changes a dispatch |
|---|---|---|---|---|
| `static` (default) | nothing | nothing | the shipped protocol and `R:` line, byte for byte | never |
| `shadow` | every dispatch | a decision row per dispatch, verdicts and refusals into the store | unchanged (a `[route …]` line is parsed and stripped) | never |
| `advise` | every dispatch | as `shadow` | the generated `R:` line, a paragraph about the route line, and a one-or-two-line `Route hint` when the engine would move a dispatch | never: the orchestrator decides |
| `enforce` | every dispatch | as `shadow` | as `advise` | yes, under [the rules below](#when-enforce-switches-a-dispatch) |

Facts worth knowing:

- **`static` is not "no `routing` block".** Any `routing` block, even `{ "engine": "static" }` or `{}`, turns variant steps on for v2 (`enforcement.escalate.variantSteps` then defaults to `auto`). Write `"variantSteps": "none"` to keep the `2.2.0` ladder under a `routing` block.
- **`switched` in a `shadow` or `advise` row means "would switch".** The row is written with `switched: true` when the kernel would have switched in `enforce`; nothing was changed. Only `enforce` rows with `switched: true` changed a dispatch.
- **Only root sessions are routed.** A dispatch made by a child is neither parsed, stripped nor logged.
- **The protocol never asks the orchestrator to set `model`.** The engine sets `model` itself in the tool hook, as `subagentTiers` already does.
- **Cost of routing.** A non-static dispatch costs one `ctx.session.get`, a cached agent list (5 s) and a cached model catalog, about 0.5 ms on top of `loadConfig`. The first dispatch of a process may wait up to 2 s for the catalog and 500 ms for the on-disk store, once; after that the engine runs on whatever it has (unpriced models fall back to ratio units, an empty store to priors).

## Turning it on

Put the block in the **global** override file, `~/.config/opencode/opencode-model-router.overrides.jsonc` (the one place a classifier or an outcomes path may be set, see [Privacy](#privacy)):

<!-- engine-example: shadow -->
```jsonc
{ "routing": { "engine": "shadow" } }
```

Let it collect a period of data, read it with [`/router stats`](#outcomes-the-decision-log-and-statistics), then move to `advise`, then to `enforce`:

<!-- engine-example: enforce -->
```jsonc
{
  "routing": {
    "engine": "enforce",
    "profile": "balanced",
    "margin": 0.2,
    "minClassConfidence": 0.7
  }
}
```

`/router` (the bare status view) prints the **applied** engine and the build of the running code, `router: engine=<mode> build=<version>+<sha7>`, then one `router: config notice: …` line per finding of the last config load, then the [cost doctor](#the-cost-doctor) section. After changing the mode, run `/router` to confirm the new one is live. A code update needs a host restart; a config change does not.

**Kill switch.** Set `routing.engine` back to `static`. It takes effect on the next hot reload and stops all decisions, recording and `R:`-line changes. The outcome files stay where they are.

## How one dispatch is routed

For a `subagent` call on v2 with `engine != static`, the tool hook does this before the host runs the call:

1. **Parse and strip** the optional first-line `[route …]` directive (also `CAP:` and `VERIFY:` are handled as before).
2. **Classify** into task facts: rules first, then the route line's typed fields, then, only when the class confidence is below `routing.minClassConfidence` and a backend is configured, the model backend, then `unknown`.
3. **Build the candidates**: the ladder of the tier the orchestrator picked, plus the agents of `routing.roles[class]`, minus candidates the parent may not start, whose permissions do not cover `needs`, or that are below `enforcement.escalate.floorTier`.
4. **Price every candidate** with the [expected-cost formula](#the-expected-cost-formula) from the store's posteriors and measured costs.
5. **Decide**: `best` is the cheapest eligible candidate; the decision is `kept` or `switched`.
6. **Act by mode**: `shadow` and `advise` only log; `enforce` rewrites `event.input.agent` and `event.input.model` when the rules below allow it. The row is written either way.

A dispatch that **resumes** an existing child (`task_id`/`sessionID`) is never switched by the engine in any mode (A30). Its decision is still logged with `switched: false` and a reason starting `kept:resume`. In `enforce`, a resume never moves a child away from where it runs because of the router: if the resume names the orchestrator's original pick of a child the router moved (a floor lift or an evidence switch) and the child runs another agent, the arguments are rewritten to the running agent and model (reason `kept:resume:running`), because the host would otherwise switch the child back. If the orchestrator names a different agent on purpose, that is honoured, with the floor lift applied (never below the floor). A child the registry does not know (swept, or a restart) or one that belongs to another orchestrator is left as the orchestrator named it, and a pinned resume is never rewritten. `shadow` and `advise` leave the arguments alone and say in the row what `enforce` would do.

### The route line

The orchestrator (or `/annotate-plan`) may describe the work in one line:

```text
[route class=implement risk=medium scope=multi needs=edit,shell d=deterministic pin]
```

- It is recognised **only as the first non-empty line** of the dispatch prompt (A22). A `[route …]` anywhere else is plain text. On a conflict the first line's `pin` is kept. A line longer than 500 characters is not recognised as a route line.
- Keys: `class`, `risk`, `scope`, `needs` (comma list), `d` (`deterministic`, `grader` or `none`: how deeply the result will be verified) and the bare flag `pin`. Every key is optional; an unknown value is ignored field by field.
- The line is **stripped** before the subagent sees it (also in `shadow`; in `static` it passes through untouched).
- `pin` means "do not switch this one" (D13). The plan convention is a pin on every `[tier:heavy]` step and on every QA review.
- Inside constraint sections ("MUST NOT DO"), negated prohibitions ("never force-push") do not raise `risk` (A22).

### The generated `R:` line and the hint

In `advise` and `enforce` the taxonomy line of the delegation protocol is replaced by a generated one: the shipped line (`buildTaskTaxonomy`), plus an optional ` | by class: c→@agent` suffix. **A class moves only when the winning agent has at least 5 recorded outcomes**, so with no evidence the line is the shipped one byte for byte (D2, a tested property). The line is memoized for 60 s per config, agent and permission set, so evidence that arrives inside the window shows up at most a minute later. The per-turn hint classifies the latest user message with the rules classifier only (a hint never costs a model call), is at most two lines (`Route hint: for <class> work like this turn, prefer @<agent> (<description>) over @<chosen>.` and `Why: …`) and appears only when the kernel would switch, so it never contradicts the `R:` line. It is a separate system part, so the protocol prefix stays cacheable, but the hint part changes with each user turn.

## The expected-cost formula

For candidate `k`, whose successor on its ladder is `next(k)` (the next variant of the same model, then the next model; after the last rung the successor is "give up"):

```text
C(k) = c_k + tax_k + (1 − p_k) · [ d · C(next(k)) + (1 − d) · U ]
```

| Symbol | Meaning |
|---|---|
| `c_k` | Cost of one attempt on `k`, in the decision's [unit](#cost-units-and-zero-cost-models). |
| `tax_k` | What the orchestrator pays to re-read the child's final message: the mean final-message tokens of this class on `k` × 4 remaining turns × the orchestrator's cache-read price. **0 until measured**; never invented. |
| `p_k` | Posterior probability that an attempt on `k` passes verification (see [Concepts](#concepts)). |
| `d` | Probability that a wrong result is **caught** (so the cascade continues): `routing.detection.deterministic` (0.95) when a deterministic `[acceptance]` check is present, `grader` (0.7) when an LLM grader is scheduled, `none` (0.3) otherwise. |
| `U` | Cost of giving up or shipping a wrong result, by `routing.profile` and the task's risk, in units where `fast = 1`: `frugal` {low 3, medium 8, high 20}, `balanced` {5, 15, 40}, `safe` {10, 30, 100}. |

The kernel does not use a fixed `next(k)` chain for the router tiers: it prices them by **simulating the runner** (`buildEscalatePolicy` and the ladder functions, including retries, `maxTotalAttempts`, the cost ceiling and skipped covered tiers), so the figures below are the plain cascade, which is what the simulation reduces to when each tier has one rung and one attempt.

### Worked example

A `medium`-owned task (`implement`, risk `medium`), `balanced` profile (`U = 15`), a grader-checked dispatch (`d = 0.7`), tiers priced by `costRatio` (1, 5, 20), no measured tax. The orchestrator picked `@medium`.

With **priors only** (fast one rank below: `p = 0.55`; medium `p = 0.80`; heavy one rank above: `p = 0.85`):

```text
C(heavy)  = 20 + (1 − 0.85) · 15                                   = 22.25
C(medium) =  5 + (1 − 0.80) · [0.7 · 22.25 + 0.3 · 15]             =  9.015
C(fast)   =  1 + (1 − 0.55) · [0.7 ·  9.015 + 0.3 · 15]            =  5.865
```

`@fast` is cheaper than the pick by far more than the margin (`5.865 < 0.8 · 9.015 = 7.212`), but **priors alone never move a dispatch down** (A24, A27): `@fast` has no outcomes yet, so it is not eligible as `best`. The decision is `kept` with reason `evidence`, and the cheapest unevidenced option is written to the row's `trace.argmin`.

After `@fast` has been tried on this class and 10 of 12 attempts passed verification, its posterior is `Beta(2.75 + 10, 2.25 + 2)` = `Beta(12.75, 4.25)`, `p = 0.75`:

```text
C(fast) = 1 + (1 − 0.75) · [0.7 · 9.015 + 0.3 · 15] = 3.703
```

`3.703 < 7.212`, the candidate has at least 5 outcomes, and, if the class confidence, permissions and floor allow it, `enforce` sends this dispatch to `@fast`. In `advise` the orchestrator is told so in a `Route hint`; in `shadow` the row records `switched: true` and nothing else happens.

## Cost units and zero-cost models

**One unit per decision (D5).** All candidates of one decision are compared in the same unit: **USD** only if every candidate is USD-comparable, that is, has at least 3 measured attempts, or is priced in the catalog and has a token profile (its own or its class's) to price; otherwise **`costRatio` units for all of them**. The two are never mixed. `U` in USD is scaled by the USD price of one `costRatio` unit (the cheapest candidate's); if that cannot be computed, the decision falls back to ratio units. `tax` is 0 in ratio units, since there is no exchange rate between the two.

**Unpriced is not free (D6, A1).** A model is *unpriced* when its catalog `cost` is empty or every field of every price entry (all tiers) is 0. A step whose reported cost is `0` for an unpriced model is stored as **unknown** (`null`), not as zero; its tokens are still stored. A positive reported cost for an unpriced model is kept (a host measurement), and a priced model's `0` stays `0`. An unpriced candidate without 3 measured attempts has no USD estimate, so a decision containing one runs in ratio units. On the owner's `anthropic` and `hybrid-2` presets every tier model is unpriced in the live catalog, so decisions and estimated savings are in `costRatio` units.

**Context-tiered prices (A10).** A catalog price list may hold entries keyed by context size; the entry is picked by the request's input size.

**Subscription providers (D6).** `opencode`, `opencode-go` and `github-copilot` report catalog prices that are relative weights, not what is billed (the Copilot billed amount is not used by the host). The engine uses them as weights only, and the cost doctor says so (`subscription-pricing`).

## When `enforce` switches a dispatch

`enforce` replaces the orchestrator's choice only if **all** of these hold (D9, A16, A23, A24, A27):

1. `C(best) < (1 − margin) · C(chosen)`: **strictly** less. Exactly at the boundary the choice is kept, and `best == chosen` is never a switch. `margin` is `0.2` by default (`[0, 0.9]`).
2. The task facts' confidence is at least `routing.minClassConfidence` (0.7). Below it, the engine does not read the store for that dispatch at all.
3. The candidate agent's **evaluated** permissions cover `needs` (never inferred from the agent id; `grants` count unconditional allows only, so an agent with `bash: ask` never covers `shell`), and the parent is allowed to start it.
4. The candidate is not below `enforcement.escalate.floorTier`.
5. **Evidence gate.** A candidate is eligible as `best` only if it has at least 5 recorded outcomes for the class, or ranks strictly above the orchestrator's pick. The gate filters the candidate set *before* the argmin (A27). The unfiltered argmin is logged in the row's `trace.argmin` when it differs from `best`. Priors alone never move a dispatch down or sideways.
6. **Never down on high risk without detection:** a dispatch with `risk == high` and `d == none` is never moved to a lower rank.
7. The prompt does not carry `pin`, and the dispatch is not a resume.

Otherwise the orchestrator's choice stands and the row records `kept` with the reason.

**Floor lifts.** Independently of the engine, in `enforce` a native `subagent` dispatch below `enforcement.escalate.floorTier` is lifted to the floor tier's base rung (today only the `delegate` tool honoured the floor). The lift happens only if the parent may start that agent and its evaluated permissions cover the task's needs; otherwise it is skipped. A lifted row has `switched: true` and a reason starting `lift:floor`. That is **policy, not an engine decision on evidence**: `routing:stats` counts lifts on their own `Floor lifts` line and leaves them out of the enforced-switch, failed and verified counts, and the dogfood rule that picks the final mode (D17: "no switched dispatch ended in a `fail` verdict") does not count them.

## The classifier and its backends

The classifier is never an agent (D3): it never registers with the host, never appears in the protocol and never creates a session. It runs in this order, and a later stage only runs when the earlier one is unsure:

1. **Rules (always).** A local, deterministic classifier: the `taskPatterns` keywords of your configuration, shape gates (length, multi-step and enumeration markers, path counts), high-risk terms (security, credentials, destructive operations, migrations, releases, money), the class's implied needs (`mechanical`/`implement` → `edit`; `debug` → `edit`, `shell`), and a `cwd` check for `external_dir`. It is free and measured in microseconds.
2. **The route line**, when present, overrides the fields it names.
3. **A model backend**, only if `routing.classifier.backend` is not `rules` **and** the class confidence is still below `routing.minClassConfidence`. A backend's label replaces the rules' class only if it is one of the classes the rules matched (or the rules matched none); otherwise the rules class stands, and a backend's confidence is capped below `minClassConfidence` unless it agrees with the rules (A19).
4. **`unknown`.** The engine then keeps the orchestrator's choice and records nothing for learning.

The classifier's confidence only decides whether the *class* is trusted (D4). It never enters `p_k`, which comes from verified outcomes only. Every backend call is bounded by `timeoutMs`, never retried, and a failure or timeout yields `unknown`; a backend can never block or fail a dispatch. `backend != rules` without `model` is a validation error: the classifier model is never picked for you.

| Backend | Where the state goes | `model` | Also required | Notes |
|---|---|---|---|---|
| `rules` (default) | nowhere | not used | nothing | |
| `host` | the provider of the model you name, through the host's `generate` call with **your** credentials | `provider/model[#variant]` | nothing | **Experimental**, see [Known limits](#known-limits-and-experimental-parts). |
| `openai-compatible` | `<baseUrl>/chat/completions` | the model id on that server (the part after `provider/`) | `baseUrl` (the `/v1` root) | `apiKeyEnv` optional: no key, no `Authorization` header (local servers). `samples: 3` takes a majority vote and uses the agreement as confidence. A `json_schema` `response_format` is tried first and dropped for later calls if the server rejects it. |
| `typesafe` | `<baseUrl>/v1/systemone` (TypeSafe "choice" questions) | sent as the request's `model` | `baseUrl` and `apiKeyEnv` | There is no built-in URL: a missing `baseUrl` disables the backend with a logged reason. TypeSafe returns a calibrated confidence, so `samples` is ignored. |

`apiKeyEnv` names an environment variable; the key itself is never stored in the config, and it is read at each call, so setting the variable later enables the backend without a reload.

### Examples

**Ollama on this machine** (nothing leaves it):

<!-- engine-example: ollama -->
```jsonc
{
  "routing": {
    "engine": "advise",
    "classifier": {
      "backend": "openai-compatible",
      "model": "ollama/qwen3:4b",
      "baseUrl": "http://localhost:11434/v1",
      "timeoutMs": 3000
    }
  }
}
```

**OpenCode Go.** Two ways. Through the host, with the credentials OpenCode already holds for that provider (the `host` backend, experimental):

<!-- engine-example: opencode-go-host -->
```jsonc
{
  "routing": {
    "engine": "advise",
    "classifier": { "backend": "host", "model": "opencode-go/deepseek-v4.1-flash", "timeoutMs": 10000 }
  }
}
```

Or directly, since OpenCode Go serves an OpenAI-compatible API (the endpoint is the one in OpenCode's Go documentation; confirm the model id for your subscription; not exercised live in this release's QA):

<!-- engine-example: opencode-go-http -->
```jsonc
{
  "routing": {
    "engine": "advise",
    "classifier": {
      "backend": "openai-compatible",
      "model": "opencode-go/deepseek-v4.1-flash",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "apiKeyEnv": "OPENCODE_API_KEY"
    }
  }
}
```

**TypeSafe.** The vendor's documented host is `https://api.typesafe.ai`; the plugin never assumes it, you set it:

<!-- engine-example: typesafe -->
```jsonc
{
  "routing": {
    "engine": "advise",
    "classifier": {
      "backend": "typesafe",
      "model": "typesafe/default",
      "baseUrl": "https://api.typesafe.ai",
      "apiKeyEnv": "TYPESAFE_API_KEY"
    }
  }
}
```

The TypeSafe model name above is a placeholder for whatever model your TypeSafe account exposes. The idea of letting an external classifier see the agents and the work and decide came from issue #73; here it is an optional, bounded, off-the-critical-path backend, and the rules result is always computed first.

**Per preset.** `routing.classifier.presets.<name>` overrides `backend` and `model` while that preset is active (matched like `/preset`: exact, then case-insensitive). A key that matches no preset is accepted but noticed.

## Privacy

What a classifier backend may send off your machine is bounded by D14, and by trust rules about who may configure it.

- **The state.** A model backend receives: the dispatch `description`, the first `[acceptance]` block (whole or omitted, never cut), and the head of the prompt, at most `routing.classifier.maxStateChars` characters in total (default 2000, range 200–20000). `[route …]`, `CAP:` and `VERIFY:` lines are removed. **Never** file contents, the orchestrator's system prompt or session history. Fenced code blocks, and indented code blocks, are replaced by a placeholder rather than sent.
- **Secrets are scrubbed first** (environment-style names, quoted JSON keys, "password is …", URL credentials, PEM blocks, common token shapes, long high-entropy runs), before anything is bounded. A raw answer and any logged reason pass through the same scrubber.
- **Credential policy gate (by design, D14).** A dispatch **never reaches a backend** when its text, the description plus the first 20 000 characters of the prompt, matches any of these:
  - a **credential word**, as a whole word and case-insensitively: `password(s)`, `passwd`, `passphrase(s)`, `secret(s)`, `credential(s)`, `api key(s)`, `access key(s)`, `private key(s)`, `ssh key(s)`, `signing key(s)` (the space, `_` or `-` may separate the two words), **`token(s)`**, `bearer`, `authorization`, `oauth`. `tokenizer` is not a hit; "the token budget" is;
  - an **env-style name**: `…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_PASSWD`, `…_API_KEY`, `…_ACCESS_KEY`, `…_PRIVATE_KEY`, `…_CREDENTIAL(S)`, or any upper-case name ending in `_KEY` (`OPENAI_KEY`), with or without a value;
  - a reference to a **`.env` file**;
  - a **PEM header** (`-----BEGIN … PRIVATE KEY`, `-----BEGIN … CERTIFICATE`);
  - anything the **scrubber would redact** by shape (a named assignment, "password is …", URL credentials, `Authorization:` headers, `curl -u`, provider token shapes, a long hex run). The scrubber's entropy-only guess (a commit hash, a long identifier) does **not** skip the backend: the redacted state is sent.

  The dispatch is then classified by rules only, no backend call is made, and the row's `trace.backendSkipped` is `"credentials"`. This is a policy, not a defect: it errs on the side of not sending, so a task that merely **mentions** a token or a key is not sent to a model backend either. If many of your dispatches mention these words, expect `trace.backendSkipped` on their rows and rules-only classes for them.
- **Known limits of the scrubber** (accepted, QA-1.2-34/35/36): lowercase and camelCase key names are not redacted by shape (a credential *word* around them still trips the gate); the redaction of guessed secrets does not skip the backend; a 32+ character secret made only of letters is not redacted by the entropy rule (a credential word near it is). Do not send task text that holds secrets to a backend you do not control, and prefer a local backend (Ollama) for `enforce`.
- **Option order is shuffled** per call, options always include `other`/`unknown`, and a disagreement between two orders lowers the confidence to 0. Instructions and option descriptions are English.
- **Transport.** An API key is never sent over plain `http:` to a non-loopback host; `baseUrl` must be `http(s)` without embedded credentials; the effective host is logged once at creation.
- **Who may configure it (A18).** `routing.classifier.{backend, model, baseUrl, apiKeyEnv, presets}` and `routing.outcomes.path` are honoured only from the bundled `tiers.json` and the **global** override file. In a project-local override (`<repo>/.opencode/opencode-model-router.overrides.jsonc`) they are dropped with a one-time warning, so cloning a repository cannot point your task text at someone else's server.
- **What `host` adds.** The `host` backend calls the host's `generate` with an explicit model, under your credentials, with the prompt the plugin renders. Whether the host prepends anything of its own to that request was not verified (QA-1.2-17); the D14 bound above covers what the plugin sends, not what the host might add.
- **The files the engine writes** (below) hold typed facts, keys, reason codes and counts, not the task text.

## Roles and native agents

`routing.roles` maps a class to an ordered list of agent ids that become candidates **in addition to** the router tiers (which are always in every ladder). On OpenCode v2 the default is:

```jsonc
{ "search": ["explore"], "implement": ["general"], "debug": ["general"], "review": ["general"] }
```

- `roles: {}` disables native candidates. A `roles` you write replaces the default as a whole (no per-class merge, also across override layers).
- A native or user agent is a candidate with, as rungs, **its own configured model first** (from the host's agent list; for example the owner's `agent.explore.model = anthropic/claude-haiku-4-5`), then the rungs of the router tier that owns the class in the static taxonomy, applied by a per-call `model` override. An agent without a configured model gets an own-model rung on the parent's model.
- A candidate must be `mode != primary`, not `hidden`, and permitted for the parent. The permission filter reads the agent's **evaluated** permissions against the task's `needs`: with the host's native permissions `explore` is read-only (`glob`, `grep`, `read`, `webfetch`, `websearch`) and is excluded when `needs` contains `shell` or `edit`; `general` has the full set. The host re-checks permissions after the hook rewrites `agent` (`Subagent denied: …`), so the filter runs before any swap.
- The built-in agents `build`, `plan`, `title`, `summary` and `compaction` cannot be subagents; naming one is accepted and noticed, and the engine skips it.
- **No nested delegation, ever.** The plugin never raises the host's `subagent_depth`; the delegation depth guard stays as it is.
- Priors for a native agent come from the rank it inherits: the role it is listed under, or the matching rung's rank when its own model equals a preset rung (the lower of the two).

## The session-aware ladder

The ladder is what happens **after** a failed verification of a `delegate` dispatch. It runs on OpenCode v2 when a `routing` block exists (A15) and `enforcement.escalate.variantSteps` is not `none`.

**Order of decisions** (the `2.2.0` code order, which the golden tests pin): accept → give up on `unverifiable` → max total attempts → cost ceiling → **variant step** → retry within the tier → escalate.

- **Variant steps before model steps (D10).** A failed attempt first retries on the **same model's next variant** (catalog order, validated against the model's `variants`), on the same child session, with the ladder's forcing message, before the ladder pays for a bigger model. A variant step does **not** consume `maxAttemptsPerTier` but **does** count toward `maxTotalAttempts` and the cost ceiling. A child without a variant counts as `default` and sends no effort; the ladder never emits a variant the model lacks (A9).
- **Where the ladder comes from.** Explicit `candidates` of the tier, else the catalog's variants of the tier's model. A catalog ladder is capped at `enforcement.escalate.effortBumpMax` (default `xhigh`) **independently of `effortBump`**, so with the default the live `claude-haiku-4-5` ladder loses `max`; explicit `candidates` are not capped. Set `effortBumpMax: "max"` or list `max` in `candidates` to use it.
- **Budget reserve (A17, A17a).** When variant steps are on, a variant step or a plain retry is taken only if `maxTotalAttempts − totalAttempts − 1 ≥ H`, `H` being the number of ladder tiers above the current one; otherwise the ladder escalates. The reserve applies only when variant steps are enabled for the session. Every action carries the `costRatio` of the rung it runs and the runner charges that, not the tier's base ratio.
- **No repeats.** The ladder records the highest rung run per model and never re-runs a `(model, variant)` that already failed in the same ladder. An escalation into a tier whose base is already covered enters at the first rung above the one reached, or skips the tier when none exists. A same-model tier is skipped only when it has no variant above the reached one.
- **A tier with both `variant` and `effort`/`thinking`/`reasoning` (A20)** stays on the effort-bump path only (an empty variant ladder), so effort is never delivered twice. The cost doctor reports it (`variant-effort`) and suggests dropping `effort` and listing `candidates`. On the bundled `anthropic` and `hybrid-2` presets the medium and heavy tiers carry `effort`, so variant steps and cross-tier resume exist only on tiers without it.
- **`variantSteps: "none"`** disables variant steps **and** session resume: every attempt is a fresh child, exactly as in `2.2.0`.

**Resume or start fresh (D11, A5, A29).** A retry or escalation **resumes** the child session (`sessionID`, plus `model`, plus `agent` when the role changes; history is kept) when

```text
lastStepTokens + estimatedTokens(next prompt) < routing.sessionReuse.maxContextFraction × inputBudget(next model)
```

with `inputBudget(m) = limit.input ?? (limit.context − limit.output)` of the **next** model, the estimate being characters / 4 of the forcing message plus the dispatch prompt, and `lastStepTokens` the **largest** step token count seen in the current execution (conservative: it only causes more fresh starts). Otherwise a fresh session starts exactly as before. Both numbers are logged. Host auto-compaction runs but does not guarantee the next prompt fits.

A resume is also refused, and a fresh child started, for these reasons:

| Reason | Meaning |
|---|---|
| `unknown-tokens` | The child's last-step context is not known (no step event, or the child's execution end was not seen within the 1 s the runner waits for it). |
| `invalid-variant` | The target variant is not in the live catalog (checked before the call). The attempt runs on a fresh child, charged at the tier's ratio, with the effort override when the variant names an effort level. |
| `bare-model-after-variant` | An escalation would send a bare `provider/model` to a child whose stored variant was set by an earlier step; whether the host keeps the old variant was not verified. |
| `effort-path` | An escalation across a tier that configures `effort`/`thinking`/`reasoning`; whether a resumed child keeps the previous agent's effort options was not verified. |
| a refused resume | The host rejected the resume (for example a permission re-check on an agent switch); the attempt fails and the ladder continues. |

A resume needs a `routing` block (A15), a model catalog, and the child's execution end (waited for at most 1 s). The routine resume/fresh decisions are logged only with `MODEL_ROUTER_TRAJECTORY_DEBUG=1`; the unusual ones (a refusal, an invalid variant) always are. The catalog is cached; a hung catalog call is not repeated.

**Effort delivery depends on the provider route (A7).** On the Anthropic Messages route, a variant change within `claude-sonnet-5-5` or `claude-opus-5-5` travels **in-band** as `{"role":"system","output_config":{"effort": …}}` with the top-level effort unchanged (the host's stated intent is cache preservation; not measured); a step from `default` to a variant changes the top-level `thinking` object; `claude-haiku-4-5` variants map to `thinking.budget_tokens` at the top level. **The OpenAI Responses route was not exercised, and a provider's acceptance of the in-band effort is unverified.** Tests assert the effective effort the plugin requests, not what a provider honoured. Treat "the variant step really raised the effort" as unproven on non-Anthropic routes.

## Outcomes, the decision log and statistics

Everything is written under one directory, `routing.outcomes.path` (global override only), by default the directory that already holds the `*.scorecard.log` files, `<os tmpdir>/opencode-model-router-trajectory`.

| File | Content |
|---|---|
| `outcomes.json` | The scoreboard: per key, the Beta counts, measured USD/tokens, false refusals, variant-step successes. Written atomically (temp file and rename), at most every 30 s, flushed on `session.idle` and `session.deleted`, never on a dispatch's hot path. An unparseable file is moved aside as `outcomes.corrupt.<time>-<pid>.json` (the newest 3 are kept) and the store starts clean. |
| `decisions.jsonl` | Append-only, one JSON row per line; rotated before it would exceed 5 MiB (3 generations kept, `decisions.<time>-<pid>.jsonl`). |
| `advisor-notice.<hash>.json` and `.lock` | The cost doctor's notice state, one pair per project. See [The cost doctor](#the-cost-doctor). |

**Decision rows** (`kind: "decision"`): `v`, `ts`, `sessionID` (the orchestrator), `decisionID`, `mode`, `childSessionID` (null for a fresh dispatch decided before the child exists), `facts` (`class`, `risk`, `scope`, `needs`, `confidence`, `source`), `chosen` and `best` (each `{ key, agent, origin, model, variant }`), `switched`, `pinned`, `unit` (`usd` or `ratio`), `costs` (`C(k)` per candidate key), `confidence` (the class confidence × n/(n+5) of the winner: reported, not decisive), `reason`, `step` (`dispatch`, `variant`, `retry`, `escalate`), `resume`, and `trace`: how many route lines the prompt carried (`routeLines`: `count`, `conflict`, `edgeOnly`), what the backend did (`backend`: `status`, `latencyMs`, `label`, `rejected`, `disagrees`), `backendSkipped` (`"credentials"`), and the A27 `argmin` (the cheapest option the evidence gate held back). A ladder attempt's row carries the delegation's class confidence.

**Verdict rows** (`kind: "verdict"`) and **refusal rows** (`kind: "refusal"`) reference the decision and the key. A refusal that follows a `pass` of the same attempt turns it into a failure in both the store and the statistics; the refusal row then carries `overrides: "pass"`.

**What the store covers: trusted classes only (QA-2.1-10).** Verdict rows, refusal rows and the store itself are written only for dispatches whose class confidence reached `routing.minClassConfidence` and whose class is not `unknown`. A below-threshold dispatch still has its decision row. So `routing:stats` shows **more dispatches than verdicts by design**, and the verdict and false-refusal rates describe trusted classes only (the output says so in a footnote). Read `Dispatches` against `Pass + Fail + Unverifiable` before judging agreement or savings: with the rules classifier a share of dispatches (long briefs, ambiguous wording) sits below the threshold.

**Deferred verification is invisible to the rates.** The verdicts of deferred verification (`VERIFY:deferred`, `finishDeferred`) and of `router_verify` replays are not recorded, so a deferred dispatch has a decision row and no verdict row. Only synchronous verifications feed the scoreboard.

### `/router stats` and `npm run routing:stats`

Both print the same table for a time window and produce the same text for the same store and window. `/router stats [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]` flushes the live store first, then renders; `npm run routing:stats -- --since <ISO>` (PowerShell swallows a bare `--`: write `npm run routing:stats '--' --since <ISO>`) reads the files. The script is plain Node with type stripping (**Node 22.18 / 23.6 or newer**; the plugin itself still runs on Node 20), is a repository tool and is **not part of the npm package**; `/router stats` is the in-session equivalent. `--dir` means what `routing.outcomes.path` means.

| Line | Meaning |
|---|---|
| `Dispatches` | Decision rows of the `dispatch` step in the window: routed `subagent` dispatches (resumes and floor lifts included) plus the `delegate` runner's first attempts. Ladder retries and escalations are in the resume-vs-fresh table instead. |
| `Routed dispatches` | `Dispatches` minus `Delegate first attempts`: the denominator of the resume line. |
| `Delegate first attempts` | First attempts of the `delegate` tool's runner, recorded without an engine pick (`best` is null). Counted on their own line, outside agreement. |
| `Floor lifts` | `lift:floor` rows: policy, not engine decisions. |
| `Pinned` | Rows with `pinned: true` (their `best` is still computed). |
| `Agreement` | `best == chosen` over non-pinned routed rows that have a `best`. |
| `Switched` | Rows with `switched: true` over non-pinned routed rows, how many of them were `enforce` rows, and how many of those ended in a `fail` verdict or a false refusal. Floor lifts excluded. In `shadow`/`advise` this is the would-switch count. |
| `Estimated savings` | `Σ C(chosen) − C(best)` over non-pinned routed rows, in the decision unit (`ratio` or USD). Not a measurement. |
| `Variant steps` | Variant steps taken and their pass rate. |
| `Orchestrator resumes` | `task_id`/`sessionID` dispatches. A resume is never switched, so it is **outside every routing metric** (agreement, switched, savings, per-class and per-key dispatch counts, the evidence gate) and reported only here; its verdict still counts for the key the child ran on. |
| `Kept for lack of evidence` | Fresh routed dispatches whose decision was `kept` for reason `evidence` (A27). |

Below the table: **By class**, **By key** (dispatches, attempts, pass/fail/unverifiable, pass rate, false refusals and refusal rate, USD per attempt over the key's lifetime), **Gated by evidence (`trace.argmin`)** and **Resume vs fresh** (`variant`, `retry`, `escalate` rows). The `trace.argmin` table counts every row in which a cheaper candidate without evidence existed, **including rows where the chosen dispatch was best anyway**, so it is not the same quantity as `Kept for lack of evidence`. The script prints notes (no outcome data, skipped lines, a rotated log) on stderr; `/router stats` appends them after the table.

## The cost doctor

The cost doctor looks for money and reliability problems **outside** the routing decision that you can fix. It is part of the bare `/router` view (the `Cost doctor` section; on v2 with a `routing` block `/router` asks the host for its agent list and model catalog, waiting up to 3 s each) and sends at most one short notice.

**Findings.** Each carries a severity (`warning`: costs reliability or silently disables something; `saving`: a concrete way to spend less; `info`: explains a number), the file the fix belongs to and, where safe, a JSON snippet: `fix (opencode.json)` for the host's own configuration, `fix (opencode-model-router.overrides.jsonc)` for this plugin's.

| Id | Severity | Fires when |
|---|---|---|
| `title-model-unset` | saving | `agents.title.model` is unset **and** the host finds no small model of the session's provider (the host picks the title model as `agents.title.model`, else a small model of the session's provider, else the session's own model). The suggestion is the cheapest priced model the host would accept, from your catalog. There is no `summary` finding: no consumer of a `summary` model was found in the host. |
| `model-not-in-catalog` | warning | A rung's model, or a tier's, is not in the live catalog. |
| `no-tool-support` | warning | A rung's model does not support tool calls. |
| `variant-not-offered` | warning | A configured variant is not offered by the model. |
| `effort-not-offered` | info | A tier's `effort` is not among the catalog's variant ids. |
| `variant-effort` | warning | A tier has `variant` together with `effort`/`thinking`/`reasoning` (A20): its variant ladder is empty. |
| `rejected-candidates` | warning | Candidate variants are ignored: not offered by the catalog, unranked, or not above the previous rung. |
| `foreign-candidates` | info | Candidate rungs on other models, which variant steps never walk (the engine prices them as dispatch options only). |
| `covered-tier` | info | A tier is skipped on escalation because an earlier tier on the same model already covers its base. |
| `variant-ladder-budget` | info | A tier has at least `maxTotalAttempts − 1` variant steps: a failing delegation can spend its whole budget on that tier's variants (the reserve still keeps an escalation reachable). |
| `attempts-without-variants` | info | `maxAttemptsPerTier` is 1 (its default) and variant steps resolve to `none`: every failure escalates straight to a bigger model. Needs an `enforcement.escalate` block. |
| `unpriced-model` | info | A model in a ladder is unpriced (D6). |
| `subscription-pricing` | info | A model's provider is a subscription provider; catalog prices are relative weights. |
| `native-role-unmatched-rung` | info | A role agent's own model matches no preset rung, so it is priced at the owning tier's first rung (live engine only). |
| `tier-agent-unavailable` | warning | A router tier's agent is absent, hidden or primary; the engine is then inert for it. |
| `classifier-model-missing` | warning | `classifier.model` of a `host` backend is not in the catalog. |

Suggestions come from the live catalog only and never from hard-coded model ids ("cheapest" means lowest `input + output` price among priced models). A check that cannot know (no catalog, no agent list) says nothing.

**The notice.**

- **Inert without a `routing` block**; a block as small as `routing: {}` activates it. `routing.advisor.enabled: false` turns the doctor off; `routing.advisor.notify: false` keeps the `/router` section and never notifies.
- Only `warning` and `saving` findings can notify, and the six configuration-shape findings (`variant-effort`, `rejected-candidates`, `foreign-candidates`, `covered-tier`, `variant-ladder-budget`, `effort-not-offered`) are quiet on an **unmodified bundled tier**, which is the shipped preset, not yours. Findings about your environment (`model-not-in-catalog`, `no-tool-support`, `variant-not-offered`, `tier-agent-unavailable`) always notify.
- A notice is sent when a finding the user was not told about appears, or as a reminder after 7 days; a set that only shrank is not news. The check runs at most once per `routing.advisor.noticeIntervalHours` (default 24; never more often than hourly).
- **Delivery.** The notice is a **synthetic transcript entry** (`ctx.session.synthetic`, description `Model router cost doctor`, `resume: false`, so it does not start a turn), handed over from the `chat.message` hook for the root session. It is **not** part of the user's message. It arrives one user turn late: the check runs in the background after the first orchestrator turn. A failure to deliver is logged and the notice is lost (the state already says "delivered"). Where the host has no such call (v1, which has no doctor anyway) a notice is a log line.
- **State and throttle, per project.** In `advise` and `enforce` the state is persisted with a lock in the outcomes directory: `advisor-notice.<sha256(project dir)[0:12]>.json` and `advisor-notice.<…>.lock`, so a pending notice for one project is never delivered into another. A notice left by a previous process is delivered at the message after **this** process's own check confirmed the same findings (else it is dropped). A lock is stale after 30 s of file time and is taken over by one process only. In `static` and `shadow` the notice is logged with a **memory-only** throttle and **no file is written**. The older single-file names `advisor-notice.json` and `advisor-notice.lock` are obsolete, are never read and may be deleted by hand.

## OpenCode v1

OpenCode v1 is unchanged in every mode (D1). With no `routing` block nothing differs from `2.2.0`, byte for byte (the v1 goldens pin it). With a `routing` block on v1:

- the block is parsed and validated; `routing.engine` is coerced to `static` with one log line per process, `[model-router] routing.engine ignored on OpenCode v1`; `variantSteps` is ignored; nothing is recorded; there is no cost doctor and no `/router stats`.
- **One opt-in effect (A28): the roles line.** When you set `routing.roles` explicitly on v1 and name at least one agent that is a subagent, not hidden and available, the static `R:` line gets a ` | by class: c→@agent` suffix listing those agents as destinations for their classes. It is prose only: no model override, no engine. The agent list comes from the host's `client.app.agents()`, cached for 60 s and fetched only when `roles` is set; on a failure the line stays the shipped one. The first turn after start has no roles line (the list is fetched in the background); it appears from the second turn. `roles: {}` means "no roles": nothing is fetched and nothing changes.
- `/annotate-plan` adds nothing for the engine on v1 (and none under `static`): `[route …]` lines are emitted only where the engine will strip and honour them.

## Known limits and experimental parts

- **The `host` classifier backend is EXPERIMENTAL.** The plan's live check at checkpoint DF3 asked for `source: "host"` on **both** steps of a batched `/annotate-plan` sample. That was not observed. What was observed live is that the backend **was consulted**: the probe's decision row shows backend status `ok`, a latency of 1688 ms and the label `other`, with no `backendSkipped`, so the host's `generate` call, the model resolution and the credentials worked end to end for that call. A backend answer that only confirms `other` does not change the rules' facts (a backend label replaces the rules' class only when it is one of the classes the rules matched, A19), so the run proves the transport, not that the backend improves a classification. Until a live run shows `source: "host"` where the backend changed or confirmed a rules class, treat the backend as experimental and prefer `rules` or a local `openai-compatible` backend. Unknowns recorded by the QA review that no live run has settled: whether the host prepends instructions to the request, whether the one-label answer always comes back as plain text, and whether an abandoned call is cancelled by the abort signal. The HTTP backends have not been run against a real service; they are covered by unit tests against fake transports.
- **Effort delivery on non-Anthropic routes is unverified** (A7, see [the ladder](#the-session-aware-ladder)). The OpenAI Responses route was not exercised.
- **The rules classifier is conservative, not clever.** In the dogfood run, long QA and review briefs leaned to `design`, and a file-listing task was labelled `review` at confidence 0.5, below the 0.7 threshold, so no outcome was recorded for it. Check the share of below-threshold dispatches before trusting agreement numbers.
- **Not recorded:** deferred verification and `router_verify` verdicts (see above).
- **Fresh-child registration is a heuristic** on the host's `session.created` event (parent, agent, title, then the oldest waiting dispatch); `execute.after` corrects a wrong claim, but steps already recorded keep their key. Waiting dispatches are claimable for 120 s.
- **No exploration.** The engine only learns from what gets dispatched. It does not try cheaper rungs on purpose; an unevidenced cheaper candidate gets its first outcomes only when the orchestrator (or a floor, or an upward switch) puts work there. Exploration is future work.
- **The numbers of a run are evidence of behaviour, not a benchmark.** The release's own dogfood measured the plan's workload (implementation- and QA-heavy, with pinned heavy dispatches).
