# TUI status: model and effort in the OpenCode v2 TUI (#90)

The package ships a TUI entry, `tui.ts` (plugin id `opencode-model-router.status`), that shows which model and effort
the main session and its delegated sessions run with. It is **OpenCode v2 only**: it needs OpenCode 2.0.24 or later.
It was verified on 2.0.24, 2.0.25 and 2.0.26 with a scripted provider: the footer, its hand-off to the host's row when
a variant is selected, the running-delegate row, the delegated session's row, and the router's effort. On OpenCode v1
nothing on this page applies: v1 never loads `tui.ts`, and v1 is in feature freeze
([AGENTS.md](../AGENTS.md#host-support-policy)).

> **Every option and default:** [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md#tui-status-options-opencode-v2).
>
> Names and numbers on this page are the code's; `test/unit/docs-drift.test.ts` compares the options table with
> `src/tui/status-model.ts`, and the slot names, ids and timings with `src/tui/plugin.ts` and `src/tui/effort-rpc.ts`.

## Contents

- [What it shows](#what-it-shows)
- [Turning it on](#turning-it-on)
- [Options in `cli.json`](#options-in-clijson)
- [Turning it off](#turning-it-off)
- [Where the effort comes from](#where-the-effort-comes-from)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Where things live](#where-things-live)

## What it shows

Three views, each with its own option. Rows use the theme's muted text colour. The footer and the delegated session
view are on by default; the running-delegates rows are opt-in (off by default), so with the default options the main
session shows only the footer's `effort <value>`.

### Main session footer (`footer`)

In a root session, and on the home prompt before a session exists, the plugin appends `effort <value>` to the prompt
footer (slot `prompt.footer.status`), **only when no variant is selected**. When a variant is selected (for example
with `ctrl+t`, which cycles the model's variants), the host's own footer row shows it and the plugin's text goes away.

`<value>` is the effort the router applied to the session's latest turn, when that turn ran on the prompt's current
model without a variant. Otherwise, and whenever the [effort channel](#where-the-effort-comes-from) has no answer, the
footer shows `effort default`. Root sessions normally show `effort default` (see [Limitations](#limitations)).

### Delegated session view (`childView`)

When you open a delegated (child) session, for example from the host's subagent picker, a row above the composer
(slot `session.composer.top`) shows `<agent> · <model> · <effort>`:

- `<agent>`: the session's agent, else the agent of its latest assistant message; left out when neither is known.
- `<model>`: the model of the latest assistant message; before the first one, the child session's model. It is the
  model's display name from the model list, else its raw id, with ` (<providerID>)` appended when a model of another
  provider has the same name.
- `<effort>`: the effort from the router's [effort channel](#where-the-effort-comes-from) when it was recorded for that
  model; else the variant of the message's (or, before the first message, the session's) model; else `default`. When
  the channel recorded a variant for that turn too, the row shows `<effort> (<variant>)`, for example `high (max)`,
  only when both values are set (not blank), neither is `default`, and they differ ignoring case (`high` and `High`
  do not); otherwise it shows the channel's effort alone.

The row stays empty until the session and a model for it are known.

### Running delegates (`runningRow`)

Opt-in: off by default. Turn it on with `"options": { "runningRow": true }` on the plugin's entry in `cli.json` (see
[Options in `cli.json`](#options-in-clijson)).

In a root session, while delegates run, the same slot directly above the prompt box shows one
`<agent> · <model> · <effort>` row per running delegate, with the same rules as the delegated session view, for example
`fast · Claude Sonnet 5.5 · medium (low)`. A delegate's row appears as soon as its session runs, before its first
token, and goes away when the delegate finishes (its session is no longer running). Delegates of delegates
(grandchildren) are included when the host lists them in the root session's family. Rows are ordered by session
creation, oldest first. At most `maxRows` rows are shown, then `+<k> more` for the rest. Nothing is shown when no
delegate runs.

A running delegate without an agent shows its session title, else `subagent`; one without any model yet shows the
model `unknown` and the effort `default`.

### Width

Rows are fitted to the terminal width minus 4 columns, not to the composer, and never wrap. With the sidebar open, a
row longer than the composer is not shortened to it and runs into the sidebar's columns (short rows were verified on
one line with the sidebar open and closed). A row too long for that width is cut with `…`: the first part (the
agent, else the model) shrinks first, then the part after it, and only then the whole row is cut from the end.

## Turning it on

Nothing to do. OpenCode v2 loads the TUI entry of every package listed in the server config (`opencode.json`
`plugins`), so with the [v2 installation](../README.md#opencode-v2) (`"plugins": ["opencode-model-router"]`) the status
loads with the default options: the footer and the delegated session view. A `cli.json` entry is needed only to change
the options, for example to turn on the running-delegates rows.

The TUI entry is auto-loaded only when the server entry loads. The server entry needs the `@opencode-ai/plugin` peer
dependency installed; npm installs peer dependencies by default.

## Options in `cli.json`

Options go in OpenCode v2's TUI config file, `<config dir>/cli.json` (for example `~/.config/opencode/cli.json`), as
the `options` of an entry in its `plugins` list. For an npm install, `package` is the package name:

<!-- cli.json example -->
```json
{
  "plugins": [
    { "package": "opencode-model-router", "options": { "runningRow": true } }
  ]
}
```

For a local checkout, `package` is the absolute path of the package **directory**. The host ignores a path to `tui.ts`.

<!-- cli.json example -->
```json
{
  "plugins": [
    { "package": "/absolute/path/to/opencode-model-router", "options": { "runningRow": true, "maxRows": 6 } }
  ]
}
```

That entry replaces the auto-loaded registration of the same plugin. Its `package` must be the package name or
directory, never the plugin id: do not write `"package": "opencode-model-router.status"`. An entry whose `package`
equals the id of a plugin that is already loaded is treated as an enable selector, and its `options` are dropped.

`tui.json` is OpenCode v1's TUI config file. OpenCode v2 reads it only to migrate it when `cli.json` does not exist, so
put this entry in `cli.json`.

<!-- tui-status-options -->
| Key | Type | Default | Values / range | Controls |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | `true \| false` | `false` turns every view off |
| `footer` | `boolean` | `true` | `true \| false` | `effort <value>` in the main session's prompt footer (`prompt.footer.status`) |
| `childView` | `boolean` | `true` | `true \| false` | `<agent> · <model> · <effort>` above a delegated session's composer (`session.composer.top`) |
| `runningRow` | `boolean` | `false` | `true \| false` | one row per running delegate above the main session's composer (`session.composer.top`); opt-in |
| `maxRows` | `integer` | `4` | `[1, 20]` | the most running-delegate rows; the rest is `+<k> more` |

With `enabled: false`, or with `footer`, `childView` and `runningRow` all `false`, the plugin claims no slot.

**Invalid options.** A key with an invalid value keeps its default, and an unknown key is ignored. The plugin shows one
warning toast that names every invalid and every unknown key. For `{ "maxRows": "x" }` and for
`{ "maxRows": "x", "compact": true }` the toasts are:

```text
model-router status: invalid TUI options ("maxRows" must be an integer from 1 to 20); using defaults for those keys
model-router status: invalid TUI options ("maxRows" must be an integer from 1 to 20; unknown keys "compact"); using defaults for those keys
```

When `options` is not an object, the whole set falls back to the defaults with
`model-router status: invalid TUI options (not an object); using the defaults`.

## Turning it off

Set `"options": { "enabled": false }` on the entry above, or add the selector `"-opencode-model-router.status"` to the
`plugins` list of `cli.json`. Place the selector **after** any explicit entry for the same plugin:

<!-- cli.json example -->
```json
{
  "plugins": [
    { "package": "opencode-model-router", "options": { "maxRows": 6 } },
    "-opencode-model-router.status"
  ]
}
```

Either way the server plugin keeps running; only the TUI status is off.

## Where the effort comes from

For each session's latest turn, root and delegated sessions alike, the v2 server plugin records the effort the request
carried after its `chat.params` bridge (a tier's effort, or a ladder escalation's effort override), with the turn's
model and variant. It answers the plugin rpc `opencode-model-router.effort`, method `effortOf({ sessionID })`, from that
record (`{}` when it knows nothing about the session). On the verified hosts the reported effort was the one the
provider received.

The TUI calls `effortOf` while a view needs the session: the first call right away, then again, at most every 5 s,
when the session's status or latest message changes, and every 5 s while the session runs. When the rpc is not
available yet, or a call times out, it retries with backoff (1 s, doubling up to 30 s). After any other error it stops
asking about that session for at least 30 s.

While the channel has no answer for a session (an older router version, the rpc not registered, an error, or a turn
without an effort), the footer shows `effort default`, and the delegated session and running-delegate rows show the
message's variant, else `default`.

## Limitations

- **Thinking budgets are not effort levels.** For a tier that sets a thinking budget (`thinking.budgetTokens`) instead
  of an effort, the row shows the variant or `default`. The channel carries the budget as `thinkingBudget`, but the
  views do not display it.
- **Root sessions normally show `effort default`.** The router applies no effort to primary agents (only its own tier
  agents carry request options), so the channel reports no effort for a root session's turn.
- **No console output.** The host swallows a TUI plugin's console output. The notices you must see (invalid options, and
  a render without a Solid owner) are toasts.
- **Auto-load needs the server entry.** The TUI entry is auto-loaded only when the server entry loads, and the server
  entry needs the `@opencode-ai/plugin` peer dependency installed. npm installs peer dependencies by default.
- **Terminal width, not the composer.** Rows are fitted to the terminal width minus 4 columns, not to the composer,
  and never wrap. With the sidebar open, a row longer than the composer is not shortened to it and runs into the
  sidebar's columns (short rows were verified on one line with the sidebar open and closed).
- **The host resolves a package-name entry itself.** For an entry in `cli.json` that names the package, OpenCode
  resolves the package on its own and may install it, so the TUI can run another version of the package than the
  server entry. A local directory path is used as it is and avoids this.

## Troubleshooting

- **Is it loaded?** The `/plugins` dialog shows a `TUI opencode-model-router.status` row
  (`TUI opencode-model-router.status local` for a local-path entry).
- **It failed to load.** Observed on 2.0.24–2.0.26 when the TUI entry failed to load: a toast
  `Plugin failed: <path>` (for example `Plugin failed: C:\Users\…`), the footer marker `⊙ 1 plugin failed /plugins`,
  and, in the `/plugins` dialog under `TUI`, a row `x <path> failed, local` instead of the row above. Check that the
  server entry loads (the peer dependency) and that a local-path entry names the package directory.
- **A `model-router status: render has no Solid owner: …` toast.** The views were then rendered once and do not
  update: the rows show no router effort, and the running-delegates row stays hidden. The toast's named cause (a
  local `node_modules/solid-js`) was not reproduced. Update OpenCode; if the toast persists, report it.
- **Nothing shows.** Check that the package is listed in `opencode.json` `plugins` and that the server entry loads (the
  peer dependency), that `cli.json` has no `"enabled": false` and no `"-opencode-model-router.status"`, and that a
  local-path entry names the package directory, not `tui.ts`. The footer shows nothing while a variant is selected.
  The running-delegates rows show only with `"runningRow": true`, and nothing while no delegate runs.
- **Options are ignored.** Check that the entry is in `cli.json` (not `opencode.json`) and that its `package` is the
  package name or directory, not `opencode-model-router.status`.

## Where things live

- `tui.ts`: the TUI entry; it re-exports `src/tui/plugin.ts`.
- `src/tui/plugin.ts`: slot claims, options, the effort polling and the views.
- `src/tui/status-model.ts`: labels, rows, widths and option parsing; no host imports.
- `src/tui/effort-rpc.ts`: the `opencode-model-router.effort` rpc definition, shared by both entries.
- `src/tui/effort-channel.ts`: the server side: the per-session record and the rpc registration.
