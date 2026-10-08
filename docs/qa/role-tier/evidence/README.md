# Roles mode real-host evidence (#84, P3.1)

Redacted observations of the real-host smoke `test/smoke/roles.smoke.test.ts`, run 4 (branch `rta/p31` @ `20d4d2d`, which
includes `rta/main` with the DF2-F1 and grader-signal fixes) on an isolated OpenCode **v2.0.24** host: 7 of 7 tests passed.
The phase report is [`../phase-p31.md`](../phase-p31.md).

Each file is the JSON one test writes: `{ "test", "recordedAt", "observed" }`. The assertions live in the test; the files keep
what the host did so a reviewer can check the claims without rerunning. Placeholders: `<home>` and `<user>` stand for the
redacted home directory and user-name segments of temp paths. `ses_…` are session ids of the isolated host, which is gone after
the run.

## How the evidence is produced

Every test starts its own isolated OpenCode v2 host (`test/smoke/helpers/routing-host.ts`):
- an allow-listed environment and a private HOME;
- a keyless scripted Anthropic provider;
- this checkout loaded as the router plugin, next to a probe plugin that records tool hooks, session events and permission
  evaluations.

The host runs in roles mode (`routing.delegation: "roles"`, `routing.engine: "enforce"`). Before the host starts, its project
becomes a git repository (the main checkout) with a sibling worktree `wt-1`. `routing.workRoots` covers worktrees named
`wt-late-*`, which are created after start.

The scripted root dispatches role agents with route lines. A role child follows a base64 script (`CHILD_SCRIPT64`): it really
attempts every scripted call, forbidden ones included. Assertions are on host state only:
- what the provider received (model, variant, advertised tools);
- the host's session, agent and context API;
- files on disk;
- the decision rows the router wrote into the isolated outcomes store.

## Files

| File | Test | What it proves |
|---|---|---|
| `I2.json` | I2: models inside `[floor, ceiling]`, pins, resumes, raise after FAIL | For 11 role × class dispatches the model the provider received is a preset tier inside the role range and at or above the authority floor (§2.3). The decision row's `tier` equals the tier that reached the provider, every binding is `exact`, and every grant passes the separation rule. A `tier=heavy pin` reaches the heavy model; a resume asking for `tier=fast` stays on the running rung (heavy). A deterministic `fileExists` FAIL at fast tells the parent "the router raises it to medium", and the resume of the same session runs on medium. Zero unknown bindings. |
| `I3-I4.json` | I3 + I4: forbidden calls refused, under a parent without grants and under an allow-all parent | An explorer attempts edit, Code Mode `execute`, `subagent`, `shell`, a read outside the repository, a read of the main checkout and `router_run`; each is refused or absent (`toolNames`, the per-call `states`), and its in-root read runs. On disk the edited file is unchanged, the shell file is absent, there is no nested child, no rename, and the outside file's content never reached the provider. `router_run`: a foreign `cwd` is refused, its own work root exits 0 and writes the marker. Researcher: no local/exec/write tool; implementer: no egress tool. A non-role control agent runs the same `shell` / `execute` inputs, so the refusals are not input errors. `records`: the host's own agent records of all seven roles, with no separation problem. |
| `I5-I9.json` | I5 + I9: binding by nonce, unknown binding, context-hook error | Two identical dispatches of one parent turn are in flight together (`barrier`); each child carries its own nonce in title and first message, and both bind `exact`. A child whose first-message nonce was swapped by the probe (`mixDecision`) binds `unknown`: catalog = local tools + `router_request_authority`, edit and the worktree read refused, the session-directory read allowed. Its exact sibling edits and reads `wt-1` but is refused the main checkout. An error injected into the router's context hook (`preprobe`) gives that step an empty catalog, and the parent's result says "had no tools for at least one step". |
| `ladder.json` | The authority ladder end to end | `general` with no edit need: the fresh row's needs and grant hold no `edit`; the catalog is local + `router_request_authority`. The edit is refused, `router_request_authority` records the request, the child returns `ESCALATE: authority`, and the parent is told to resume. The resume of the same session advertises `edit`, runs on medium or above (floor recomputed), and the edit lands. The resume row's grant holds `edit` and its reason is "authority widened on resume: edit"; an `authority` signal row exists. |
| `roots-handoffs.json` | Work roots and the host handoffs of P2.3 | Resource formats (`formats`): `external_directory` is `<canonical dir>/*`; a read outside the session directory is canonical absolute, inside it Location-relative; an edit in the worktree is canonical absolute. Search roots (`search`): `glob` inside the root runs, outside it and with the default root (the main checkout) it is refused; a `grep` `include` that leaves the root is refused by the router's `execute.before` and the child sees that error. `router_git_status` reports the bound worktree. A worktree created after start is covered by the `workRoots` glob, one outside the glob is not; `router_run` runs in the later worktree and refuses `wt-1`. DF2-F1 fixed (`df2NoCwd`, `df2WithCwd`, `df2Live`, `df2Outside`): checks run in the work root, including on a file the child wrote, and a `cwd:` outside the work root is refused (unverifiable, detection not deterministic). Host 2.0.24 observation (`outputView`, `savedPath`, `ownRead`, `foreignRead`): a truncated output is saved, but `session.tool.success` carries no `outputPaths`, so the owning child's read of it is refused (fail closed, R9(5)), as is another child's. |
| `budget-signals.json` | Role budget and outcome signals | Enforced mode: explorer with a 3-call budget reads 3 files, the next 2 calls are refused with `NEED MORE: budget`, the parent gets the `[router budget]` note, and the resume of the same session reads the rest. Signal rows (`signals`, `found`, `kinds`) of all seven kinds: `verdict` pass/fail (deterministic `fileExists`), `run:pass` (an edit, then `router_run` of the acceptance script after it), `grader:pass` (an independent heavy grader on another model; no `verdict` row for that dispatch), `incomplete:fail`, `budget`, `authority`, `redispatch:fail` (the same TASK again on a higher tier, charged to the earlier attempt). |
| `exploration.json` | Exploration | With `routing.exploration.rate: 0.2`, eligible deterministic dispatches (explorer, class implement: static default medium, floor fast) are drawn: an exploration row (`explore: true`, propensity 0.2, reason "exploration draw") went to fast, inside `[floor, ceiling]`; exploit rows carry propensity 0.8 on medium. Zero unknown bindings. |

## Regenerating

From the repository root, with an OpenCode 2.x executable on PATH (or `OPENCODE_V2_BIN=<absolute path>`):

```
RUN_OC_SMOKE_ROLES=1 npx vitest run --config vitest.smoke.config.ts test/smoke/roles.smoke.test.ts
```

On Windows PowerShell: `$env:RUN_OC_SMOKE_ROLES = "1"; npx vitest run --config vitest.smoke.config.ts test/smoke/roles.smoke.test.ts`.

The test writes the files to `<OMR_SMOKE_REAL_TMPDIR>\omr-roles-smoke\`: the real temp directory that the smoke temp guard
(`test/setup/smoke-tmp-guard.ts`) records, or the OS temp directory without it. Never into the repository. Copy them here only
after checking them:
- no user name or home path (grep for the user name, its 8.3 short form and `C:\Users`);
- no credential (grep `sk-`, `key`, `token`, `Bearer`, `Basic`).

The smoke uses no real provider key and never touches the live host, the user's OpenCode config or the live outcomes store.
