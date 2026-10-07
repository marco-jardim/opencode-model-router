# Read-only tiers and shell-free Git inspection (#77)

## Policy and compatibility

`fast` is read-only by default, including old/custom presets without a `readOnly`
field. Every bundled preset explicitly sets it to `true`. Other tiers retain
their previous definitions unless opted in. This is host permission enforcement,
not a prompt-only request, and is independent of advisory/enforced/off mode.

The ordered baseline is deny `*`, then allow `read`, `glob`, `grep`, the six
`router_git_*` tools below, and `external_directory`. Reads of `*.env`,
`*.env.*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc` ask for approval;
`*.env.example` is allowed. Basename patterns are also applied in subdirectories.
Shell (`bash` on v1, `shell` on v2), edits/write/patch, Code Mode `execute`,
subagent/task/delegate, webfetch/websearch, browser, and unspecified MCP tools
remain denied. Adding a future tool does not implicitly allow it.

Only when an enabled MCP named **`context7`** is configured, the effective MCP
actions `context7_resolve-library-id`, `context7_query-docs`, and the older
`context7_get-library-docs` are allowed. Hosts name actions
`<sanitized server>_<sanitized tool>` (hyphens survive). No `context7_*` wildcard
is granted. Renamed servers need explicit user permission rules. On v2 these
specific docs tools are made directly callable so denying Code Mode does not
strand them in its separate catalog. Configuration is not proof of connectivity.

### Precedence and overrides

V1 publishes both a deny-by-default `permission` object and legacy `tools`
booleans (`"*": false`, explicit allowed tools). The installed v1 SDK supports
`tools: Record<string, boolean>` and a narrower set of named permission fields;
current v1 hosts additionally support arbitrary permission actions/resources.
Existing `agent.<tier>.permission` entries are merged **after** the router
baseline, retaining the order of resource rules; existing `tools` entries win
over the generated booleans. A user wildcard is moved to the end, not silently
left at the baseline's earlier position.

V2's config-agent transform runs before external plugins. The host initializes
agents with `Agent.Info.default`'s permissive rules, then appends configured rules.
The router replaces only the exact leading default-rules sequence with its
baseline; explicit global/agent host rules therefore come **last** and win.
It never removes a matching allow-all later in the list (that is a user override).
This preserves native `agents.<tier>.permissions` and migrated v1
`agent.<tier>.permission` rules. The transform runs against fresh host state on
reload, so it does not stack old router policies. Existing built-in agent rules
also take precedence if you deliberately reuse a built-in name for a tier.

**An explicit user/global `* → allow`, or a session-level allow-all, overrides
this policy.** V2 session rules are evaluated after agent rules and inherited by
children. Do not grant parent session allow-all when you want restricted
children. This is intentional user control, not an immutable security boundary.
For external directories, use `external_directory: "deny"` or scoped `ask`
rules in host agent configuration. Read-only does not mean confined to the
project by default.

To remove the router policy, deep-merge the following in
`opencode-model-router.overrides.jsonc` (global or `.opencode/` project override):

```jsonc
{ "presets": { "anthropic": { "fast": { "readOnly": false } } } }
```

Use your preset name; repeat for other presets as desired. `readOnly: true` on
any other tier enables the same baseline. User restrictions remain applicable.
Use a fresh child after changing host rules. Router overrides reload normally;
the exploration prompt remains exploration-oriented even when opted out.

## Git tools

Six tools, rather than a generic command runner, keep each advertised schema
small and make permissions/audits explicit. They are registered for all agents.

| Tool | Inputs (all optional unless noted) |
|---|---|
| `router_git_status` | `path` |
| `router_git_log` | `path`, `ref`, `limit` (integer 1–50, default 20) |
| `router_git_diff` | `path`, `ref` (including a range), `mode`: `patch`, `stat`, `name-only`, `cached` |
| `router_git_show` | `path`, `ref` (default HEAD) |
| `router_git_blame` | **`path` required**, `ref` |
| `router_git_ls_files` | `path` |

Examples: status `{}`, log `{ "limit": 10 }`, diff
`{ "ref": "HEAD~2..HEAD", "mode": "stat" }`, blame `{ "path": "src/index.ts" }`.
`git-info` dispatches should use these tools, not shell commands; edits including
renames belong to `medium`.

The repository root comes from `git rev-parse --show-toplevel` in the **session's
directory**, not an arbitrary caller-supplied working directory. Paths are
literal, repository-relative (maximum 4096 characters), with absolute paths,
parent segments, option prefixes, control characters, and escaping existing
symlinks/junctions rejected. Git pathspec magic is disabled. Refs allow only
`^[A-Za-z0-9._/@{}~^:-]+$`, maximum 200 characters, never a leading `-`. There is
no free-form argv or `--output`/`-o` option.

Every subprocess uses `spawn` with `shell: false`, fixed argv, an absolute Git
executable resolved from absolute PATH entries (`git.exe`, never cmd/bat, on
Windows), `--no-optional-locks`, and these overrides:

```text
-c core.pager=cat -c core.fsmonitor=false -c diff.external=
-c core.hooksPath=NUL (Windows; /dev/null elsewhere)
-c protocol.allow=never -c maintenance.auto=false -c gc.auto=0 -c color.ui=false
```

Diff/show/log disable external diffs and textconv; blame disables textconv too.
Submodule diff helpers are disabled. Inherited `GIT_*` variables are stripped
before setting `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=NUL` (or `/dev/null`), `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`,
`PAGER=cat`, `GIT_LITERAL_PATHSPECS=1`, and `GIT_NO_LAZY_FETCH=1`.
Output is bounded to 64 KiB with a truncation notice. Discovery and inspection
share one 15-second tool-call deadline; abort, timeout, and output overflow kill the process tree
(taskkill `/T /F` on Windows, a detached process group elsewhere). Remote URL
userinfo is stripped, including scp-like remotes; an incomplete trailing token
is discarded before redacting truncated output.

## Guarantees and limits — not an OS sandbox

No tool exposes a write command, shell expansion, arbitrary option, credential
helper, hooks, fsmonitor, external diff, or textconv execution. Status uses no
optional index refresh/locks; the stale-index regression checks both its mtime
and SHA-256. Tests exercise a malicious repository configuration with marker
scripts that must never execute.

This is **not an OS sandbox**, a confidentiality filter, or protection against
a compromised Git executable/OS, Git vulnerabilities, concurrent filesystem
replacement, or an administrator explicitly loosening permissions. Git output
and grep can expose file contents (including committed secrets); `read`'s
sensitive-path approval rules do not filter Git or grep output. URL redaction
is not a general secret scrubber. Large output is deliberately incomplete;
narrow the path/ref or ask a higher tier for more work. No remote access,
fetching missing objects, arbitrary git configuration, commits, or mutations
are supported.
