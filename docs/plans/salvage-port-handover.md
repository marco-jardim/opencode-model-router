# Handover — Execute the Salvage Port

You are picking up work in progress. This document is self-contained: it assumes you have no memory of the sessions that produced it. Read it fully before your first tool call.

---

## 1. Where you are

| | |
|---|---|
| **Base repository** | `D:\git\opencode-model-router` |
| **Working directory** | `D:\git\opencode-model-router` — *the same directory* |
| **Worktree in use** | None. No separate clone, no worktree. |
| **Platform / shell** | `win32` / `pwsh` |
| **Default branch** | `master` — **not** `main`. `origin/main` does not exist. |
| **Remote** | `github.com/marco-jardim/opencode-model-router` |
| **npm package** | `opencode-model-router`, currently `1.5.0`, published under the `tormentalabs` account |

Base and working directory are identical **on purpose**. Keep it that way unless you have a concrete reason not to. The acceptance verifier runs in the process's current working directory; when work happens somewhere else, it reads the wrong tree and rejects correct work. That cost the previous session about a dozen false rejections before the two were unified.

If you do introduce a worktree or a second clone, say so at the top of your own handover, name both paths, and put the working one in every subagent dispatch. Subagents inherit nothing.

**There is a stale clone at `C:\Users\Marquinho\AppData\Local\Temp\opencode\pr8-check`.** It was the previous session's working clone. It is now redundant. Do not use it; do not trust anything it reports.

---

## 2. State of the repository

```
master            3c8f77b  ci: test across node 20/22/24 on ubuntu and windows
tests             918 passing across 42 files
typecheck         clean
CI                6 matrix jobs (node 20/22/24 × ubuntu/windows), all green
npm               1.5.0, published via OIDC Trusted Publishing with SLSA provenance
working tree      clean except this plan and this handover
```

There is a **local branch `salvage-local-work` at `eec22f9`**. It holds 61 commits that were never pushed — roughly 7,000 lines of feature work discovered during a cleanup. It is the source material for this plan. **Never push it. Never merge it. Never delete it.** Read from it with `git show salvage-local-work:<path>`.

---

## 3. Your mission

Execute `docs/plans/salvage-port.md` from the top.

That plan selects eight features out of the salvage branch and ports them into the current line, in four waves, with a reconnaissance wave first. It also names, explicitly, what it refuses to port and why. Read it end to end before dispatching anything — particularly the Execution Directives, the Parallelism & File Ownership rules, and the Pre-Flight, QA Review and Red-Green protocols. The plan is the specification; this document is the operating manual.

**Start with Wave 0.** Six read-only tasks, dispatched in parallel in a single message. They produce a committed manifest that determines the shape of every wave after it. Do not skip it and do not start Phase 1 before its manifest is committed.

---

## 4. Rules you are held to

These restate the plan's directives. Where this document and the plan disagree, the plan wins.

1. **Iterate continuously.** Finish a phase, review it, fix what the review found, start the next. Do not stop to report progress. Do not ask whether to continue.

2. **Stop only for a blocker or something critical.** A blocker is: CI red for a cause you cannot fix inside the phase; a collision with a third-party PR in flight; a change that would alter a published default; suspected data loss; genuine ambiguity between two defensible readings with materially different outcomes; scope growth the plan did not anticipate. **A failing test you just wrote is not a blocker** — it is the phase not being finished.

3. **Pre-flight before every phase.** Read-only, `[tier:fast]`. Fix everything it finds inside that phase's owned paths, then and there. If a finding belongs to a later phase in the plan, **document it** in the phase's summary commit naming the owning phase — do not fix it, because fixing another phase's file is how parallel work gets corrupted. If it belongs to no phase, file an issue and move on.

4. **Senior QA review after every phase, at `[tier:heavy]`, adversarial.** The reviewer must not be the agent that implemented the phase. **Fix every defect it raises inside the phase's owned paths before the phase closes.** Out-of-scope findings are recorded, not fixed. Two review rounds maximum; whatever the second re-review still raises is filed as an issue with severity, and the phase closes. A *critical* finding on the second round is a blocker — stop and ask.

5. **Commit often.** One commit per task, not per phase. Every commit leaves master green: `npm test` and `npm run typecheck` both pass before you push. Never push red and fix forward.

6. **Every dispatch carries its environment.** Working directory, platform, shell, and the paths that dispatch owns. A dispatch without an environment block is malformed — reissue it.

7. **One writer per file per wave.** Never read a file another agent is currently writing. `src/index.ts` is a mutually exclusive resource: at most one phase per wave touches it, and that phase goes last.

---

## 5. Troubleshooting — read this before you lose an hour to it

Everything here was learned the hard way in the sessions that produced the plan.

### The acceptance gate produces false negatives

**Symptom:** your delegated work is rejected with claims that commits do not exist, files are missing, or `npm test` failed on golden snapshots you never touched.

**Cause:** the verifier runs in the current working directory. If the work happened in another clone, or if the local tree is stale or dirty, it reads the wrong state and reports it confidently.

**What to do:** verify against the remote, not the local checkout.

```powershell
gh api repos/marco-jardim/opencode-model-router/commits/master --jq '.sha'
gh api repos/marco-jardim/opencode-model-router/commits/<sha> --jq '.files[].filename'
gh run list --branch master --limit 3
```

If the remote says the work landed and CI is green, the work landed. The gate's verdict does not overrule `gh api`. Do not redo work on the strength of a rejection you have disproven — but do read the rejection first, because occasionally it is right.

### A resumed subagent reports stale state with total confidence

**Symptom:** a subagent tells you a finding is still open, a file is unchanged, or a PR is unmerged — and it is wrong.

**Cause:** resuming a subagent by `task_id` restores its context frozen at creation. It cannot see anything that happened since, including your own commits and third-party pushes. It will not hedge; it will assert.

**What to do:** never resume across a phase boundary. Within a phase, resuming is fine and preserves cache. When a resumed agent makes a claim about repository state, verify it against the remote before acting. This caused two wrong reports in one session, both stated with certainty.

### The Edit tool can accept a non-matching `oldString`

**Symptom:** an edit reports success; the file is corrupted — typically an orphaned brace or a mangled block.

**Cause:** observed at least once with a parenthesis typo in `oldString`. The tool reported success anyway.

**What to do:** run `npm run typecheck` after any non-trivial edit. It caught this immediately last time (`TS1128: Declaration or statement expected`). Do not batch several edits and typecheck once at the end — you will not know which one broke it.

### Round-tripping text through the GitHub API in PowerShell

**Symptom:** you post a comment, fetch it back to verify, and the comparison fails by exactly the number of lines in the text.

**Cause:** `gh api --jq '.body' | Out-File` splits the output into an array of lines and rejoins it wrong. The mismatch is in your verification, not in what GitHub stored.

**What to do:**

```powershell
gh api repos/OWNER/REPO/issues/comments/<id> > remote.json
$remote = (Get-Content -Raw remote.json | ConvertFrom-Json).body
$local  = [IO.File]::ReadAllText("body.md")
[string]::Equals($remote, $local, [StringComparison]::Ordinal)
```

Never `--jq | Out-File`. Also note `>` appends a trailing newline; if you compare raw bytes, account for it or trim both sides identically.

### Golden snapshots

Nine files conflict between master and the salvage branch; two of them are golden snapshots with 19 and 15 hunks. **Never hand-merge a snapshot and never regenerate one to make a test pass.** If a snapshot moved, the emitted prompt moved — find out why first. When the change is genuinely intended:

```powershell
npx vitest run -u
```

Then read the diff and explain every hunk in the commit message. The previous session shipped a broken snapshot to master exactly once, by merging a `tiers.json` change without regenerating.

### Red-green verification

A test that cannot fail proves nothing, and this repository has shipped at least one vacuous test (an assertion wrapped in `if (spy.mock.calls.length > 0)`, which was a no-op as root and on Windows). The plan mandates the procedure:

```powershell
git stash push -- <source-path>
npx vitest run <test-file>   # MUST fail — capture the output verbatim
git stash pop
npx vitest run <test-file>   # green again
```

Use `git stash`, never a manual edit to revert. See the Edit-tool hazard above.

### CI

Six matrix jobs per run. Windows takes roughly 30 s against Linux's 14 s; the whole matrix finishes under a minute since jobs run in parallel.

Pull requests from first-time fork contributors sit in `action_required` until approved:

```powershell
gh api -X POST repos/marco-jardim/opencode-model-router/actions/runs/<id>/approve
```

Releases publish automatically on a `v*` tag push, via OIDC Trusted Publishing with SLSA provenance. **No npm token is involved** — the one in `~/.npmrc` is expired and irrelevant. Creating a GitHub Release does *not* trigger a second publish, because the workflow fires on tag push.

### Repository conventions

- Commit subjects: `type(scope): lowercase message`. Types in use: `feat`, `fix`, `test`, `docs`, `ci`, `chore`, `perf`.
- Errors: `new Error("<subject>: <lowercase message>")`.
- Tests live in `test/{unit,integration,golden,smoke}`. Vitest 4, TypeScript 7.
- The package publishes raw `src/**/*.ts` — there is no build step. Consumers compile it with their own TypeScript.
- `engines: node >= 20`.
- `package-lock.json` is tracked; `npm ci` must work from it.

---

## 6. Third-party context you must not break

Two pull requests are open and waiting on their authors. **Do not merge, close or push to either.**

- **#13** (`atwright147`) — model naming. The author agreed to rework it as an additive `zen` preset and has not pushed yet.
- **#19** (`Apl0x`) — grader temperature. The submitted fix removes the documented `graderTemperature: 0` default; a narrower approach was requested. **Phase 3B of the plan touches this directly**: shipping the `enforcement` block makes that default explicit in `tiers.json` rather than implicit in code, which may resolve the impasse. Record the finding for the maintainer; do not act on the PR from inside a phase.

**A contributor has work in flight that collides with this plan.** `lucashungaro` split a large PR into buckets; (a) merged as #22, and buckets **(b) catalog/discovery** and **(c) `index.ts` refactor** are still to come. Bucket (c) extracts `dispatchGrader` and `buildGateDeps` into `src/verify/wiring.ts` and will have to carry two existing master commits across that extraction — `40c9b94` (child-session cleanup) and `8710a84` (bounded config search).

**This is why Wave 3 is gated.** Do not start it while (c) is open. If (c) has neither opened nor merged 21 days after Wave 2 closes, stop and ask the maintainer to choose — do not decide alone and do not wait indefinitely.

Three open issues are waiting on other people: #1 (Ollama tier suggestions), #17 (`MetalbolicX`, no reply since 16 Aug — the plan is to wait roughly two weeks, then port their guards with `Co-authored-by`), #18 (`MarCYK`, sending `zai` presets themselves).

---

## 7. What not to do

- Do not merge or push `salvage-local-work`.
- Do not change `activePreset`. It is `anthropic`; the salvage branch sets it to `opus`, and **git automerges that with no conflict marker**. It would silently change the default preset for every existing user. Risk R1 in the plan guards it in three places.
- Do not port the lessons store, the anti-context-anxiety clause, the INTENT section or the workspace-root protocol line. The plan's Deferred/Rejected table explains each; the short version is that they add prompt tokens immediately after PR #21 removed 52% of them.
- Do not edit `docs/plans/salvage-port.md` during execution. It is immutable until Phase 9. Progress lives in commits and your todo list.
- Do not refactor while porting. The `src/index.ts` diff in particular must stay minimal, because bucket (c) has to carry it.
- Do not leave scratch files anywhere in the repository. The previous session found ten stray API dumps in the base clone, written by subagents told not to touch it.
- Do not delete or weaken an existing test to make a phase pass. Test count must end strictly above 918.

---

## 8. Your first move

```powershell
# Confirm you are where you think you are
git -C D:\git\opencode-model-router status --short --branch
git -C D:\git\opencode-model-router log --oneline -3
```

Expect `master` at `3c8f77b` (or later, if someone has pushed since) and a clean tree.

Then read `docs/plans/salvage-port.md` in full, and dispatch Wave 0's six reconnaissance tasks in parallel in a single message. Their output becomes `docs/plans/salvage-port-manifest.md`, committed, before any implementation begins.

Work through the waves without pausing. Stop only for a blocker.
