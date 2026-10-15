# OpenCode v2 compatibility

Issue [#40](https://github.com/marco-jardim/opencode-model-router/issues/40) is a
real API migration. V1 imports a function and awaits a hooks object. V2 validates
the module's default export as an object with an `id` and `setup` or `effect`.
The old function fails with `Expected object at ["default"]` before any routing
code runs. Merely wrapping it in `{ server }` does not satisfy v2.

The adapter typechecks against `@opencode/plugin` **2.0.22**, supports hosts
**2.0.20 or later**, and was originally based on the official
[`v2` source at 74dbc509](https://github.com/anomalyco/opencode/tree/74dbc509d74df46a2523676dd4068225c4f0c9b0).
The old `@opencode-ai/plugin/v2` types bundled with v1 are a different, obsolete
API; they should not be used to assess current v2 capabilities.

## Loading without breaking v1

The package retains `main: ./src/index.ts` and that module's single callable
default export. Old loaders invoke every exported value, so changing it to an
object or adding runtime helper exports would break those installations.

V2's [host resolver](https://github.com/anomalyco/opencode/blob/74dbc509d74df46a2523676dd4068225c4f0c9b0/packages/plugin/src/host.ts)
tries `/server` first. The published `server.ts` re-exports the v2 definition,
including a `server` factory for modern v1 loaders that explicitly use it. Both
versions share the existing routing engine and configuration.

The package also ships `tui.ts`, a TUI entry that v2 (2.0.24 or later) resolves
as `/tui` and v1 never loads: it shows the model and effort of the main and the
delegated sessions, with the effort the server plugin reports over the plugin rpc
`opencode-model-router.effort` (see [TUI status](./TUI_STATUS.md)).

## What replaces the old hooks

| Existing behavior | V1 surface | V2 implementation |
| --- | --- | --- |
| Register tiers, models, limits and prompts | `config` | `agent.transform` |
| Register `/tiers`, `/preset`, `/budget`, `/router`, `/bypass`, `/annotate-plan` | `config`, `command.execute.before` | `command.transform` and prompt admission |
| Track a tier's dispatch and read budget | `chat.message` | `session.hook("prompt")` |
| Inject the routing protocol; set grader temperature | system transform, `chat.params` | `session.hook("context")`; temperature only for exact `graderTemperatureModels` entries |
| Block disallowed tool calls; repair task instructions | `tool.execute.before` | `tool.hook("execute.before")` with native argument translation |
| Count reads; inspect returned work; attach verification | `tool.execute.after` | `tool.hook("execute.after")` with structured-result translation |
| Expose `delegate` and `router_verify` | `tool` map | `tool.transform`, retaining argument schemas |
| Create a producer or an independent grader | SDK session create/prompt | Native `subagent.execute`, with actual parent/call identity |
| Track lifecycle and clear state | `event`, `dispose` | Event subscription plus setup cleanup |
| Flag narration without work | `experimental.text.complete` | `session.text.ended` plus a synthetic warning |

The [official migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
describes these domains. Their callbacks have different data shapes; returning
v1 hooks from `setup` would register nothing.

Agent `request.settings` is not consumed by the v2 request pipeline. Tier options
are therefore applied through the context hook to `event.options`, filling only
missing keys before the legacy `chat.params` hook runs. The router registers
provider-native `reasoningEffort`, `reasoningSummary`, and
`thinking: { type: "enabled", budgetTokens }` (or Claude `effort`), which the bridge
passes unchanged. For options merged into router-registered agents (only definitions
the router's `config` hook changed), it still normalizes legacy aliases
(`reasoning_effort`, `reasoning_summary`, `budget_tokens`) only when the
corresponding native value is absent/`undefined`; an explicit native value wins.
Unmodified agents are skipped, including their per-turn option merge.
User-facing tier config keys (`reasoning.effort`, `reasoning.summary`,
`thinking.budgetTokens`) are unchanged. The producer-only effort override then
runs through `chat.params` directly on `event.options`, without adding a nested
`options` bag.

## Grader temperature on v2

V2 does not expose a temperature capability flag in `Model.Info`, and the router
must not assume a model accepts temperature. Grader temperature is omitted unless
the exact `providerID/modelID` is listed in
`enforcement.verify.graderTemperatureModels` (absent means an empty list). For
example, `["openai/org/model"]` allows the configured `graderTemperature` for that
model only, including an explicit `0`. There is no prefix matching or static
grader agent temperature setting. Non-grader requests are unaffected.

Override arrays replace rather than concatenate: a later `graderTemperatureModels`
list replaces the earlier list in full, and `[]` clears it. V1 ignores this list
and instead follows the host capability flag: `capabilities.temperature: false`
prevents the router from setting grader temperature.

## Per-turn router state

The system prompt of an orchestrator must not move between turns, or the host's prompt
cache misses on everything after the first part that changed. The router therefore keeps
everything that changes from turn to turn out of the system array and delivers it as the
per-turn router state.

**What it contains.** The late verification notices (see
[VERIFICATION.md](VERIFICATION.md)), the list of still-unverified delegations, and, in
`advise` mode, the route hint. Later phases add more sections. Sections come in a fixed
order, separated by a blank line; a section with nothing to say is left out, and with no
section at all there is no state and the request is left untouched.

**Where it goes.** The state is rendered into a `<router-state>` text wrapped in a last
`user` message that the router appends after the conversation on every request. It is
regenerated for each request and never persisted: it is not in the session history, so
the next request carries the current state, not the previous one. The system parts and
the earlier messages are never copied, reordered or rewritten for it. Only root
orchestrator sessions get it: child sessions, graders and role sessions get no state and
no hint.

**Bound.** The whole message, wrapper included, is at most 6000 characters. When the
sections are longer, whole lines are dropped from the end and the last line says how many
were left out (`… 12 more lines`; a line ends with ` (router_plan action=status)` when a
plan section is active). Lines are never cut in the middle.

**Cache hint.** The router puts one ephemeral cache breakpoint (`{ "type": "ephemeral" }`)
on the last non-blank text part of the last real message or, when that message has no such
part, on its last `tool-result` or `media` part. When it has neither, there is no hint: the
tail is still added, and the host may then mark the tail itself. It never moves to an
earlier message, so during a tool loop it follows the newest message. The state
message itself never carries it, and no system part gets one. It carries no 1-hour TTL:
OpenCode v2.0.26 cannot set the TTL of the tools breakpoint, so a longer TTL on the
message breakpoint alone would not keep the prefix cached (ADR 0007, decision D5,
withdrawn); the router has no setting for the cache hint's lifetime.

**The `R:` line.** In `advise` and `enforce` mode the `R:` line of the protocol is
generated from recorded outcomes. With the state in place it is frozen per session: the
first request of a session fixes it, and it is reused while the agent name, the
orchestrator's model, the agent's and the session's permission rules and the configuration are unchanged. A
change to any of these, or a new session, regenerates it, and that request misses the
cache. A change of the agent catalog alone does not regenerate it: an agent removed from
the host can stay named in the line until one of those changes. Fresh routing evidence still
reaches the model through the route hint, which is in the state; `enforce` decides at
dispatch.

**v1.** OpenCode v1 keeps the old delivery, unchanged: the pending list and the late
notices (once) are system parts there, and there is no route hint (it is a v2 feature).

## Background dispatches

On v2 the orchestrator protocol carries a short `Background dispatches` block with these
rules: after dispatching background work, continue any independent work; when none remains,
end the turn, because the router wakes the orchestrator; never poll or sleep; a held result is
not usable until its verdict; never report a task done while dispatches are listed in flight;
a lease refusal is resolved by waiting for the holder, not by retrying. The whole block, the
lease rule included, is left out when `routing.background.mode` is `off`; the lease rule
alone when `routing.leases.mode` is `off`. Leases are still enforced under `off`; only the
prompt line goes. The v1 protocol is unchanged.

**When a call runs in the background.** `routing.background.mode` selects the policy (v2 only;
v1 ignores it):

- `off` keeps the previous behavior byte for byte: a verified or role-routed `subagent` call
  runs in the foreground and every other call keeps whatever `background` argument the model
  sent.
- `model` backgrounds only what the model asks for with `background: true`; a call that does
  not set it is left as under `off`.
- `auto` also backgrounds, on its own, a call the router expects to be long: one whose
  recorded duration estimate has at least the minimum number of real samples and a median at
  or above `routing.background.minPredictedMs`, or one whose acceptance criteria include
  `testsPass` or `buildPasses`. An estimate that is only the built-in prior never selects a
  call. A call that is not selected keeps the old behavior (a verified call stays in the
  foreground).

`routing.background.mode` defaults to `auto` and `routing.background.minPredictedMs` to
`45000` (an integer from 0 to 3600000). An invalid value warns once and the default applies.
An explicit `background: false` is always honored. A child session never gets the router's
background policy (only a root orchestrator session does), and neither does a call made while
1000 attempts are already in flight; both keep the `off` behavior. When the call needs
required verification but a held result cannot be offered (see below), the router does not
background it: an `auto` selection falls back to the foreground, and an explicit
`background: true` is turned into `background: false`.

**Held results.** When a backgrounded call has `required` verification, its result is held:
the orchestrator does not see the child's output until the verdict exists. While a result is
held, every request (and every compaction) shows the orchestrator this in place of the
completion text, whether the text is a whole message or sits inside a compaction record:

```
<subagent sessionID="<child>" state="held">held — verdict pending (vrf_…)</subagent>
```

Redaction is deterministic, so it does not move the prompt cache between requests. The
placeholder stays in force for the rest of the session, after the verdict arrives too; the
verdict is a separate entry. When the verdict is posted, the router adds a synthetic entry to
the parent session and wakes it (an idle parent resumes; a busy parent receives it as a
steer):

```
<router-verdict handle="vrf_…" sessionID="<child>" verdict="PASS|FAIL|UNVERIFIABLE">
…the same text a foreground verified call returns…
</router-verdict>
```

Resuming a held child with `subagent`, or naming its session id in a Code Mode `execute`, is
refused: `[router] Refused: session <child> is held for verification (<handle>). Its result
arrives with the verdict; resume it after that.` A failed delivery is retried three times
with backoff and then stays pending for the next start. Holds are bounded (256 per parent
session, 10000 in all); beyond that, or when the host cannot hold (no context and compaction
hooks, or no `ctx.session.synthetic`), the call is not backgrounded as above.

The guarantee covers the result text the orchestrator receives. The terminal UI and
`session.export` still show the original to the human, and files the child wrote are readable
as soon as its file leases end (see [ROLES.md](ROLES.md#file-leases)).

**Child text that looks like a router line.** Under `auto` and `model`, every line of a
child's text inside a `<subagent>` element that starts with `[router` (after blanks and
markdown quote, list or emphasis marks; any case) is shown to the orchestrator as `(router`,
so a child cannot pass its own text off as a router line, placeholder or verdict. Role
dispatches get the same rewrite in every mode (see
[ROLES.md](ROLES.md#observability)).

**Calls a child session backgrounds.** The running notice, holds and completion guarantees
apply to a root orchestrator's calls only. When the user backgrounds a call that a child
session made, the router registers nothing and adds no notice: the child sees the host's
running result as it is, and no hold or completion guarantee applies to that call.

**Restarts.** The in-flight dispatches, the pending verification entries and the holds are
written to `pending.jsonl` in a per-user state directory, so a held result is still held and
its verdict is still delivered after the host restarts (see
[VERIFICATION.md](VERIFICATION.md#pending-handles-survive-restarts)). If that file cannot be
read, the router stops holding new results and redacts every `<subagent>` element it has not
seen processed until a retry succeeds.

**`off` and v1.** `routing.background.mode: "off"` reproduces the previous request, system
prompt, running-ack text and results byte for byte, and renders none of the three sections.
It does not turn off file leases (`routing.leases.mode`) or the restart persistence. OpenCode
v1 is unchanged: none of this runs there, its protocol has no background block, and the
`routing.background` and `routing.leases` keys have no effect (see
[OpenCode v1 fallback](ROLES.md#opencode-v1-fallback)).

**What the orchestrator is told.** Three sections join the per-turn router state above, after
the late notices and the pending list and before the route hint: `Completed since your last
turn` (background dispatches that finished, each with the verification annotations or
`router guarantees pending`), `Held for verification — not usable until the verdict` (each
held handle and whether it is verifying or waiting for a file lease), and `In flight
(background)` (the count, each dispatch with its role, description, session and minutes
running, and the line `Do not report the task done while dispatches are listed here.`). A
section with nothing to list is left out, and under `routing.background.mode: "off"` none
of the three is rendered. Like the rest of the state they exist only on a root orchestrator
session and are never written to its history.

## Child sessions, cancellation and verification

The v2 public session creation method cannot set `parentID`. Creating a standalone
session would lose the parent relationship and the native permission/depth checks.
Instead, the adapter invokes the host's registered `subagent` implementation with
the real originating tool context. Its awaited creation notification registers
the child's guards and captures the verification reference before the first model
request. A separate hidden grader agent receives the selected grader model,
grading instructions, with temperature handled by the context hook as above.

Grader working directories are applied to the real child session. Native results
must name that child and report completion before they can be graded. Deadlines,
cancellation and cleanup interrupt running children. Queued verification retains
bounded copies of actual parent tool contexts rather than inventing session or
message IDs.

When verification uses another working directory, the router must also be enabled
at that location (for example through global plugin configuration). V2 resolves
agents and hooks per location; an unavailable grader fails verification instead
of silently using an unrelated agent.

On v2 hosts ≥2.0.21, plugin-created producer and grader children are interrupted
and removed after use through `ctx.session.remove`, which recursively removes
their children. Cleanup is best-effort. On 2.0.20, removal is unavailable and child
history remains attached to its parent. V1 still aborts and deletes its temporary
sessions. V2's immutable completed-text events require anti-narration warnings
to appear as separate synthetic entries rather than mutating completed text.

The adapter awaits native subagent completion when the router verifies that dispatch
and the call is not backgrounded under the background policy (see
[Background dispatches](#background-dispatches)); with `routing.background.mode: "off"`
it overrides `background: true` as it always did. A backgrounded call that is not
verified passes through as before. The router's configured deferred and background
verification operate on completed artifacts as before.

If a user backgrounds an already-running verified native job, the router takes it over
when it completes: it reads the child's final text, runs the same required-verification
gate as a foreground call and, where the result can be held, holds it until the verdict
and posts the verdict as above. Where it cannot hold (a child parent, or no holding
available), the completion is visible, the gate still runs, and the verdict appears in
the `Completed since your last turn` section and as a late notice. Under
`routing.background.mode: "off"` the job is only marked unverified, as before; it is never
sent to the acceptance gate as if it were a completed artifact.

Router-annotated/verified `subagent` results now keep the host's
`<subagent sessionID=…>` envelope part in `content`, preserving the resume handle,
and append router notes as a separate text part. This changes the visible layout
from the old plain-text replacement; it does not change the structured-output or
metadata semantics. Envelope preservation applies when host text exists and the
router output starts with the child's text after trimming trailing whitespace.
Missing host text or a non-suffix rewrite instead uses the full router output as
one text part, retaining non-text attachments without duplicating the child text.
See [CHANGELOG](../CHANGELOG.md).

## Plan executor

The plan executor compiles a written plan into a ledger and runs its tasks in parallel in isolated worktree slots,
integrating them one at a time into an always-green integration branch. It is **v2 only**: OpenCode v1 ignores the
`routing.executor.*` keys (one notice per process). The `router_plan` tool, the `/plan` command and the executor instructions are registered on OpenCode v2 only; OpenCode v1's tool, command and help maps are unchanged.
See [EXECUTOR.md](EXECUTOR.md) for the concepts, the `/plan` commands, the `router_plan` actions, the
`routing.executor.*` configuration and the trust rules.
Start with its [owner checklist](EXECUTOR.md#owner-checklist-for-the-next-real-plan); the guide also covers
[safety invariants](EXECUTOR.md#safety-model), [Windows provisioning](EXECUTOR.md#windows-notes) and
[opt-in observations and G8 metrics](EXECUTOR.md#metrics-and-observations).

## Validation

Focused tests cover the exact module schema failure, preservation of the callable
v1 export, hook/argument/result translation, enforcement errors, independent child
dispatch, model variants, cancellation, queued parent identity and cleanup. The
SDK dependency is for development-time type checking; the v1 runtime entrypoint
does not import the v2 SDK.

The native smoke check loads both a local checkout and an npm-packed package in
OpenCode 2.0.20 or later, then reads plugin, agent and command catalogs without a model call.
This proves loading and registration; it does not substitute for provider-backed
end-to-end testing of model behavior.

Run the committed native loader regression with `OPENCODE_V2_BIN` set to the
absolute path of an OpenCode 2.0.20 or later executable:

```sh
npm run smoke:v2
```

It starts an isolated local server, demonstrates rejection of the old function,
then checks the fixed package's catalogs. It requires no provider credentials.

Run the provider-backed standalone smoke (adapted from ChronosWS / Cliff Hudson)
with `OPENCODE_V2_BIN` pointing to an OpenCode v2 executable:

```sh
npm run smoke:v2:e2e
```

It uses an isolated home and a local deterministic OpenAI-compatible provider,
testing native subagent routing, verified delegation, and grader temperature
omission/allowlisting without provider credentials. It is skipped unless
`RUN_OC_SMOKE_V2_E2E=1` (set by the script).
