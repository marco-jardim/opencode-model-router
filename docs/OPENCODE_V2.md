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

The adapter awaits native subagent completion only when the router verifies that
dispatch, overriding `background: true` in that case. Otherwise background is
preserved and its running result passes through unverified by design (not graded).
The router's configured deferred and background verification operate on completed
artifacts as before.

If a user backgrounds an already-running verified native job, its pending response is
explicitly marked unverified. It is never sent to the acceptance gate as if it
were a completed artifact.

Router-annotated/verified `subagent` results now keep the host's
`<subagent sessionID=…>` envelope part in `content`, preserving the resume handle,
and append router notes as a separate text part. This changes the visible layout
from the old plain-text replacement; it does not change the structured-output or
metadata semantics. Envelope preservation applies when host text exists and the
router output starts with the child's text after trimming trailing whitespace.
Missing host text or a non-suffix rewrite instead uses the full router output as
one text part, retaining non-text attachments without duplicating the child text.
See [CHANGELOG](../CHANGELOG.md).

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
