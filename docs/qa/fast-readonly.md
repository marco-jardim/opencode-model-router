# Issue #77 — fast read-only QA

## 1. Pre-flight

- Base: **b7094c4**, v2.3.0; branch `feat/fast-readonly`, worktree
  `D:\git\omr-fast-ro`. `gh issue view 77` read before implementation.
- Linear: **not used**. GitHub issue #77 is the work item.
- Target host: **OpenCode 2.0.24**; adapter dependency/types: `@opencode/plugin`
  2.0.22; Windows/pwsh. The v1 SDK's `AgentConfig` supports permission fields and
  `tools: Record<string, boolean>`; the plugin supplies both.
- `opencode --version` returned `opencode v2.0.24`. Host source checks used
  `git show v2.0.22:...` (the host source checkout's current HEAD is newer).
- All edits are in the feature worktree. No live config/store edits, master
  merge, release, or AI commit attribution.
- Permission-review follow-up: branch `fast-ro/perm`, worktree
  `D:\git\omr-fast-perm`, based on `1c977ad`. This round does not modify
  `src/router/git-tools.ts` or its tests; P3/P8/G8 remain separate work.

## 2. Implementation and policy decisions

- Six named tools keep schemas narrow and audit/permission actions explicit.
  Git processes have fixed argv, no shell, strict paths/refs, inert executable
  configuration, bounded output, timeout/tree cancellation, URL redaction.
  Repository discovery and inspection share one monotonic 15-second deadline;
  discovery cannot grant a second 15-second window to the inspection command.
- Optional tier `readOnly`, defaulting to true for fast and false otherwise;
  all eight presets explicitly opt fast in. Override `readOnly: false` is
  layer-mergeable. Other tier definitions/prompts are not changed.
- V1 merges user permission resources after baseline and publishes legacy tool
  booleans. Arbitrary v1 permission actions/resources remain **unverified**;
  hosts honouring only `tools` cannot enforce sensitive `read` asks.
- QA-77-P1/P4 supersede the original v2 prefix-only implementation: reviewed
  hard-coded defaults, conservative inherited-rule filtering and last-match
  canaries fail closed on host drift, including appended grants. Warnings are
  deduplicated. Inherited allow-all is no longer preserved; opt out with
  `readOnly: false`. Agent resource overrides on permitted actions survive.
- QA-77-P2 preserves agent-own denies in the permission-evaluate hook, removes
  child-session allows before prompting/context construction, and filters stale
  denied tools from the catalog. Parent-session grants cannot reopen denies.
  `--auto`/`--yolo` auto-answer prompts, not denied permissions.
- QA-77-P7: global-rule precedence on newly created router agents is unverified;
  the supported restriction guidance is agent-specific configuration.
- Only the explicitly named Context7 documentation actions are allowed, only
  when configured; v2 exposes them directly rather than through denied Code Mode.
  Action naming was checked against `packages/core/src/tool/mcp.ts` at the
  host's `v2.0.22` tag (`name(server, tool)` and the executor's permission assertion).
- External-directory access is allowed but user-configurable. This is not an
  OS sandbox or a content-confidentiality policy; Git/grep can reveal secrets.

## 3. Tests and verification

### Permission-review follow-up (QA-77-P1/P2/P4/P5/P6/P7/P9/P10)

- `npm run typecheck`: passed.
- Explicit read-only, evidence-redaction, v2-hooks, v1-roles-line,
  routing-engine.protocol-line and `test/golden` run: **228 passed / 12 files**.
  Command: `npx vitest run test/unit/read-only.test.ts test/unit/readonly-evidence.test.ts test/unit/v2-hooks.test.ts test/integration/v1-roles-line.test.ts test/unit/routing-engine.protocol-line.test.ts test/golden --maxWorkers=2 --testTimeout=30000`.
- `npx vitest related src/compat/v2-hooks.ts src/router/read-only.ts --run --maxWorkers=2 --testTimeout=30000`:
  **1123 passed, 55 skipped / 41 passed files, 3 skipped** (46.63 s).
  Both runs use the default pool. No snapshot updates in this round.
- Hard-coded host fixtures cover identical, appended allow, inserted-middle,
  respelled and dropped defaults; no SDK-generated drift fixtures. Tests also
  cover wildcard semantics, canary fallback, warning deduplication, inherited
  session grants, multi-resource denies, safe overrides and stale tool catalogs.

### Original implementation verification (historical)

- Initial Git implementation: typecheck passed; 32 focused Git tests passed;
  related tests passed **996 tests / 39 files**, with 55 tests / 3 files skipped.
- Policy-focused pass: **100 tests / 2 files** (`read-only`, `v2-hooks`), including
  v1 opt-out/user merge and v2 default-prefix/user precedence. Prompt tests also
  passed after their deliberate fast-only count update.
- Added rejection cases: `-o`, `--output=x`, traversal, absolute paths, spaces
  and shell punctuation in refs, long inputs, invalid limits/modes; hardened
  argv for all six tools; malicious fsmonitor/diff/textconv/hook marker scripts;
  stale-index hash/mtime; root discovery; redaction/truncation; timeout/abort.
- Additional tests cover escaping symlink/junction paths and aborting a process
  with a live descendant.
- Focused final pass: **191 tests / 5 files** (Git, permissions, v2 adapter,
  D2 protocol hashes, v1 roles); typecheck passed. Four affected golden files
  passed **36 tests**, with **23 snapshots deliberately updated**. The protocol
  and assembled-prompt snapshots were compared against their old versions with
  only the documented rename substitution applied: exact equality.
- Final related run: **9046 passed, 56 skipped; 96 files passed, 3 skipped**,
  142.01 s. Command:

  ```text
  npx vitest related src/index.ts src/router/config.ts src/router/read-only.ts src/router/prompts.ts src/compat/v2-hooks.ts src/routing/classify/types.ts src/router/git-tools.ts --run --maxWorkers=2 --testTimeout=30000
  ```

  Default pool (no `--pool=threads`). An initial invocation hit its 120 s shell
  deadline; the completed runs used no enclosing shell deadline. One initial
  adapter test exceeded Vitest's 5 s default on cold startup; focused and final
  runs used 30 s. Expected protocol/prompt snapshot failures were updated only
  after inspecting their exact text deltas. No unresolved failures remain.
- Final deadline hardening: `npm run typecheck` passed, followed by
  `npx vitest related src/router/git-tools.ts --run --maxWorkers=2 --testTimeout=30000`:
  **1147 passed, 55 skipped; 42 files passed, 3 skipped**, 50.20 s. Includes the
  regression proving discovery cannot reset the 15-second deadline.
- `git diff --check` passed. A comparison against `git show b7094c4:tiers.json`
  verified all eight presets differ only by `fast.readOnly: true`, every
  medium/heavy definition and prompt is identical, and fast's prompt is append-only.

## 4. Real-host smoke and evidence

- Permission-review follow-up smoke passed: **1 passed, 12 unrelated scenarios
  skipped**, 13.87 s, **12 fresh-child probes**. Command:
  `RUN_OC_SMOKE_ROUTING=1 OMR_UPDATE_READONLY_EVIDENCE=1 npx vitest run --config vitest.smoke.config.ts test/smoke/routing-engine.smoke.test.ts -t '77 fast read-only' --maxWorkers=2`
  (environment variables were set with PowerShell syntax).
- Added parent `shell` allow and parent `*` allow probes: shell remains absent
  and host-refused. Added an **advertised** read with an agent-specific resource
  deny and inherited parent read allow: host reports `Permission denied`,
  exercising permission assertion / BlockedError rather than missing-tool
  refusal. All probes assert no published `*:*:allow` and no child-session allow.
- P10: normal smoke runs write only to the isolated harness directory. Updating
  tracked evidence requires `OMR_UPDATE_READONLY_EVIDENCE=1`. The committed JSON
  was regenerated with this flag and scrubbed: absolute path resources, embedded
  Windows user directories and short names are replaced by placeholders. A unit
  test covers long/short Windows paths, embedded user paths and POSIX paths.

The following records the original nine-probe run; its session-inheritance
limitation is superseded by the follow-up above.

- Gated scenario: `77 fast read-only: host refuses shell edit execute subagent
  and permits inspection` in `test/smoke/routing-engine.smoke.test.ts`.
- Uses the existing isolated real-host harness: private HOME/XDG/temp/store,
  keyless scripted provider, fresh fast child for every probe, no parent
  session allow-all. It intentionally emits unavailable tools, so refusal is
  the host's, not model cooperation.
- Negative probes: shell redirection, edit, execute, subagent, and Git ref
  `--output=readonly-probe.txt`; positives: read, grep, glob, git status.
  Every probe checks the original file and absence of nested children.
- `docs/qa/fast-readonly-smoke.json` stores names-only advertised-tool traces,
  permission rules, hook statuses, and refusal booleans (no file contents,
  provider credentials, or complete model requests).
- `npm run smoke:routing -- -t ...` was rejected by this npm CLI with
  `EUNKNOWNCONFIG: Unknown cli flag --t`; the equivalent direct Vitest command
  with `RUN_OC_SMOKE_ROUTING=1` was used instead.
- First host attempt exposed inherited default allow-all; corrected by exact
  prefix replacement and covered in a regression test. The next attempt passed
  all access probes but the Git rejection assertion incorrectly required an
  execute.after error hook. Host context already held `status: error` and
  `Invalid git ref`; the assertion now uses that authoritative host state.
- A subsequent assertion was tightened to the host's exact `No tool named
  "<name>"` refusal instead of a loose regex. Final smoke **passed** on 2.0.24:
  **1 passed, 12 unrelated scenarios skipped**, nine fresh-child probes. Re-run
  after final deadline hardening also passed (12.38 s); verdicts and tool inventories
  were identical, with only isolated temporary-directory paths changing in host rules.

## 5. Exact prompt/snapshot delta

Only two changes to shipped prompt text:

1. Append two newlines and this exact line to fast's prescriptive and built-in
   goal-oriented prompt (all presets use these defaults):

   > Direct tools (read, glob, grep, router_git_*) and the Code Mode catalog are separate; an empty Code Mode search does not mean a direct tool is missing. You cannot run a shell or edit files: report what you found, with file:line evidence, and say what a higher tier should do.

   Fast lengths: prescriptive **2155 → 2432**, goal-oriented **1212 → 1489**.
   Medium/heavy lengths and bytes remain unchanged.

2. Taxonomy substring, identically in raw and v2-adapted protocols:

   ```diff
   -exists-check/rename @medium→impl-feature
   +exists-check @medium→rename/impl-feature
   ```

   `git-info` stays the taxonomy token (the protocol does not name shell Git
   commands); the fast prompt names `router_git_*` and the docs map git-info to
   these tools. No other protocol text changed.

Updated D2 SHA-256 goldens (character counts unchanged):

| Snapshot | Before | After |
|---|---|---|
| R: | `5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452` | `6ace4a35c29f8972a86e67e705830aaff964c78997b654c4b13a139b5b0563fe` |
| anthropic raw, 3249 | `ee7e33eed9ee3068bc8eb9f2a7492abaed6c428bbf10372bba51f2e92d152af2` | `96c9fa385ca8104f72730ab9aff1d6b6d83a98c1be6c8dd857a6ed129fb38b60` |
| anthropic v2, 3249 | `aa24cbbf7e558c4f9bd8130fe378a1cdee12e9e9bafef684f57fa4ba9bc59817` | `85d07a3a46c79abc1b15caa65bfff0757912d5e33a6b8ec0deff6b81fae592b1` |
| hybrid-2 raw, 3288 | `392ff439845c7c96d3f6728111f50c69e4f46315e79db0c4a252507a402a6d33` | `f79fde6484ae5a8f4ca64dc0b1a89910bd55e12f649f39e54e4817d770877211` |
| hybrid-2 v2, 3288 | `10c2437a28b312f6745512fa6ca69867808b1d2efe897e0e6bb3b0235381370b` | `f9fd9f713f80942d01c3d23ca236164d03e72bd1d8730ab55f1d5081a19c19e0` |

The v1 roles inline snapshot uses the same exact substring change. Its historic
6357-character system-prompt hash remains pinned after inverting **only** that
substring, proving every other byte remains identical.

## 6. Limitations and handoff

- V2 agent resource overrides on permitted actions survive; inherited session
  allows cannot override own denies. Broad inherited allow-all is dropped.
- Sensitive-file `ask` rules belong to `read`, not Git or grep content filtering.
- No OS sandbox, network Git operations, arbitrary flags, or writable Git tools.
- V1 permission registration/merge is unit-tested; no claim of a real-v1
  negative-probe smoke unless explicitly recorded later. Arbitrary actions on
  v1 are unverified; tool-boolean-only hosts cannot enforce sensitive-read asks.
- Verification is scoped/related, default Vitest pool, maximum two workers;
  the full suite was not requested or run. No release or master merge.
- Implementation and tests were committed/pushed incrementally:
  `057e472` (Git tools), `7236d5d` (policy/config/protocol), `0c8952d`
  (real-host smoke, names-only evidence, additional Git safety tests), `9d3cda1`
  (one shared Git deadline and its regression test).
  `npm run typecheck` passed before each commit; documentation is the final subtask.
