# DF3 — classifier credential gate (QA-1.2-1): suspected false positive

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` D3, D14, amendments A4 and A13, checkpoint DF3 (§0.11, line ≈596). Rationale of the gate: `phase-1.2.md` (QA-1.2-1, QA-1.2-26).
> Worktree `D:\git\omr-car-pcred`, branch `car/pcred`, from `car/main` @ `71815eb`. Issue #74.
> Implemented by `@medium` in one dispatch. **Heavy QA has not run on this change.**

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-pcred`, branch `car/pcred`, HEAD `71815eb` at the start; `git status --short` empty; `node_modules` present |
| Question | Did the credential policy gate (`mentionsCredentials` → `hasCredentialSignal`, `src/routing/classify/index.ts` ≈299 / `scrub.ts` ≈203) block the host backend on a benign prompt during the DF3 live probe? |
| Evidence handed over | Override `{"routing":{"engine":"advise","classifier":{"backend":"host","model":"opencode-go/deepseek-v4.1-flash","timeoutMs":10000}}}`; probe to `fast`, description `DF3 classifier probe 2`, prompt `Which word is longer, "alpha" or "omega"? Reply with one word only, no tools.`; rows at 20:34:26Z and 20:34:35Z with `source=rules`, `design` / `implement`, 0.5, `trace.backend=null`, `trace.backendSkipped="credentials"` |
| Live store | Read-only: `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory\decisions.jsonl` (148 rows at first read, 160 at the last). Override file read once, read-only. Nothing in `~/.config/opencode` or the store was written; no other worktree touched |
| Read-only budget | `CAP:none` with a `reason:` line |
| **Linear** | **Linear: not used** |

## Implementation

**There is no defect in the gate, so there is no fix to the gate.** The suspicion came from a misread of the shared decision log. The change is regression tests plus a comment.

### Diagnosis (the three hypotheses)

1. **A pattern or the scrubber matching ordinary words — no.** On the exact inputs (`description` `DF3 classifier probe 2` + the probe prompt, joined with `\n` as `mentionsCredentials` joins them) `hasCredentialSignal` is `false`, `scrubState(text, {entropy:false}) === text`, and `classify()` with a fake backend **calls the backend once**, `trace.backendSkipped` undefined, facts `{class:"other", risk:"medium", scope:"single", needs:[], confidence:0.2, source:"rules"}`.
2. **The host passing a different prompt — no.** `route()` (`src/routing/wire/dispatch.ts` `decideAndRecord`) classifies `args.prompt` as given. In the v2 adapter (`src/compat/v2-hooks.ts`) `route()` (line 376) runs **before** the legacy `tool.execute.before` (line 389), so nothing the legacy hook adds is seen; `taskArgs` for `subagent` only spreads the input and adds `subagent_type` / `task_id`. Tier prompts (the `config` hook) are agent system prompts, never part of `args.prompt`.
3. **Which rows were the probe's — this is the cause.** The live log, filtered by session:

| Time (UTC) | Session | Class / conf | `trace.backend` | `backendSkipped` |
|---|---|---|---|---|
| 20:32:57.803 | `ses_ef09ca71…` (probe) | `search` 0.8 | null | — (above threshold) |
| **20:34:08.917** | `ses_ef09ca71…` (**probe 2**) | `other` 0.2, `medium`/`single`/no needs | **`{id:host, status:ok, latencyMs:1688, label:other}`** | — |
| 20:34:13.442 | `ses_ef099b1e…` | `design` 0.5 `high`/`multi` | null | `credentials` |
| 20:34:26.940 | `ses_ef099b1e…` | `design` 0.5 | null | `credentials` |
| 20:34:35.001 | `ses_ef099b1e…` | `implement` 0.5 | null | `credentials` |

The rows read as the probe's (20:34:26Z and 20:34:35Z) are **another session's** (`ses_ef099b1e…`, three long design/implement briefs to `heavy`, `heavy`, `medium`). `decisions.jsonl` is one file for every host session (D15); the tail mixes them. The probe's own row (20:34:08.917Z) carries exactly the facts the unit test reproduces. `backendSkipped="credentials"` on those rows means the gate found a credential signal in their text. The rows hold no prompt text, so **which word fired cannot be re-read from the store** (finding 4); briefs of this project often discuss tokens, passwords and API keys (this dispatch's own brief does), which is a plausible but unverified reason. That the rows are not the probe's follows from their facts (`design`/`high`/`multi` cannot come from a one-line prompt) and their session id.

### Commits (`git log --oneline 71815eb..HEAD`, `Refs #74`, no AI attribution)

| Commit | Subject |
|---|---|
| `e99330c` | `test(routing): pin the credential gate on the DF3 probe, ordinary prompts and real secrets` (tests, and a comment-only change in `scrub.ts`) |
| (this commit) | `docs(routing): record the DF3 classifier credential check and the gate rule` (`dogfood.md`, this report) |

The prefix is `test(routing)`, not `fix(routing)`: nothing was fixed in code. The dispatch named `fix(routing)` for a gate fix that turned out not to exist.

### The rule, as the gate implements it (D14, QA-1.2-1, QA-1.2-26) and as now documented in `scrub.ts`

A backend is **skipped** (`trace.backendSkipped="credentials"`, rules facts stand, nothing leaves the machine) for a task whose description or prompt:

- (a) contains a credential word as a whole word: `password(s)`, `passwd`, `passphrase(s)`, `secret(s)`, `credential(s)`, `api/access/private/ssh/signing key(s)`, `token(s)`, `bearer`, `authorization`, `oauth`;
- (b) names an env-style secret: `X_TOKEN`, `X_SECRET`, `X_PASSWORD`, `X_PASSWD`, `X_API_KEY`, `X_ACCESS_KEY`, `X_PRIVATE_KEY`, `X_CREDENTIALS`, a capitalised `*_KEY`, or `.env`;
- (c) carries a PEM header;
- (d) contains anything the scrubber redacts **by name or shape** (assignment, spoken `the key is …`, URL credentials, provider token shapes).

An entropy-only redaction (a commit hash, a long identifier) does **not** skip: the redacted state is sent. The gate is only reached when the rules are unsure (`confidence < minClassConfidence`); a confident rules class never consults a backend, so it never shows a skip marker.

**`token` gates in its LLM sense too.** The text cannot tell "fix the token counter" from "rotate the token"; a false skip costs only the rules facts (the engine then keeps the orchestrator's pick, `kept:class-confidence`), a false pass sends a credential off the machine. The existing test `credential words skip the backend: tokens, …` (`count the tokens in the prompt` → gates) asserts this on purpose, and "Do not weaken the D14 privacy bound" binds it.

## Tests

Added to `test/unit/routing-classify.index.test.ts` (describe `credential policy gate: DF3 probe, ordinary prompts, real secrets (QA-1.2-1, DF3)`; +6 tests, file 87 → 93):

| Test | What it pins |
|---|---|
| the DF3 probe is not a credential signal and reaches the backend | exact probe inputs: `hasCredentialSignal` false, scrubber a no-op, backend called once, no skip marker, `trace.backend` host/ok/`other`, facts equal the live row |
| the probe in a batch | two probe items through `classifyMany` (the `/annotate-plan` path): one batched backend call, neither skipped |
| a long brief that names the credential gate | skipped as designed: what the other session's rows were |
| ten ordinary engineering prompts | the D14 judgement below, via `hasCredentialSignal` |
| through classify | a gated prompt never reaches the backend; an ungated unsure one does (the rules confidence is read from the result, not hard-coded) |
| real secrets gate, alone and inside an ordinary prompt | seven shapes, built at run time: OpenAI project key `sk-proj-…`, Anthropic `sk-ant-api03-…`, GitHub `ghp_…`, AWS `AKIA…`, `password=hunter2`, PEM `-----BEGIN OPENSSH PRIVATE KEY-----`, Stripe |

### The ten ordinary prompts and the judgement

| # | Prompt | Gates? | Why |
|---|---|---|---|
| 1 | `fix the token counter in stats.ts` | **yes** | the word `token`; LLM token indistinguishable from a credential (conservative on purpose) |
| 2 | `rename the password field label in the login form` | **yes** | names a credential |
| 3 | `review the API key rotation doc` | **yes** | names a credential |
| 4 | `refactor the Authorization middleware` | **yes** | names the Authorization header |
| 5 | `add a unit test for the pricing table in src/routing/engine/ladders.ts` | no | nothing credential-shaped |
| 6 | `add a composite primary key to the users table migration` | no | a lone `key` is prose |
| 7 | `change the cache key to include the model id` | no | a lone `key` is prose |
| 8 | `explain why the build fails on Windows with ENOENT in scripts/build.mjs` | no | — |
| 9 | `bump vitest to the latest minor and fix the type errors` | no | — |
| 10 | `write a short summary of the retry logic` | no | — |

Measured with a scratch run (deleted): #1 `other` 0.2, #2 `mechanical` 0.5, #3 `review` 0.5 are unsure, so the gate is what stops the backend; #4 is `implement` 0.8, so no backend would be consulted anyway; #5–7 and #10 are `other` 0.2 and reach the backend; #8, #9 are `debug` 0.8, confident.

### Verification run (all default pool, never `--pool=threads`)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/routing-classify.index.test.ts test/unit/routing-classify.backends.test.ts test/unit/routing-classify.rules.test.ts test/unit/routing-classify.route-line.test.ts` | 4 files, **544 tests passed** (every existing QA-1.2-1 / QA-1.2-26 test green) |
| Mutation check on `hasCredentialSignal` (temporary, restored from a backup copy, `git diff` shows only the comment) | forced always-`true`: 58 tests of the index file fail; forced always-`false`: 7 fail, including the new secret, ordinary-prompt and long-brief tests |
| `npx vitest related src/routing/classify/scrub.ts --run --maxWorkers=2` (run four times; 49 files, 3 skipped) | Run 1: 1 failed / 1389 passed; run 3: 4 failed / 1386 passed; run 2: output not captured, no claim; **run 4 (captured): 46 files passed, 1390 tests passed, 0 failed (64 s)**. Every failure in runs 1 and 3 is in `test/integration/ladder-effort-wiring.test.ts` (v1 ladder effort wiring; the file took 37 s in the pool). The same file run alone: **26/26 pass in 8 s with my changes, and 26/26 on the unmodified tree** (stashed). A load-dependent flake of an unrelated file (the machine runs other worktrees' tests), not caused by this change (comment-only in `src`) |

## Findings

1. **No false positive on the probe; the rows were misattributed (not a defect).** Evidence above. The orchestrator's conclusion "host backend NOT verified live" is **withdrawn**: the probe's own row shows the host backend consulted live, `status=ok`, 1688 ms, label `other`.
2. **The host backend is verified for one single call, not in the form the plan requires.** `facts.source` stayed `rules` because a backend label of `other` never changes the facts (`mergeBackend`: only an agreement on a non-`other` class raises confidence and sets `source`), and `/annotate-plan` (the batched `classifyMany` path, F3) was not run. The plan's criterion — `source: "host"` for both steps — is unmet, so `host` stays documented as **experimental** (A4) until it is.
3. **The gate skips most of this project's own briefs (observed, design-accepted).** All three rows of the other session at 20:34 were skipped. In a cost-routing project the words `token`, `credential`, `password`, `API key` plausibly appear in the orchestrator's briefs often (pricing per token, the credential gate itself); this is an inference from the three skipped rows, not something the store can confirm. The consequence is small and bounded (rules facts stand, the pick is kept), and the safe direction. It means the backend will rarely run on this project's own dispatches; it says nothing about other projects.
4. **A skip marker does not say which signal fired.** `backendSkipped: "credentials"` is the same for a PEM block and for the word `token`; with the shared log this made the misread easy. Left as is: a finer value changes the row schema (`DecisionTrace`, persistence tests), outside this dispatch.
5. **Reading `decisions.jsonl` needs a session filter.** The file is shared by every host session (D15); a tail read mixes sessions. (The rows are `sessionID`-tagged; `routing:stats` already aggregates over all of them.)

## Handoffs

- **DF3 live check, second attempt (owner decision, if `host` is to leave *experimental*):** run `/annotate-plan` on a two-step sample whose steps are **benign and unsure but matched**, so the backend is consulted and an agreement promotes `source: "host"`. A measured candidate: `review the changes in the last commit` (`review` 0.5, not gated). A second step of the same kind has not been measured. Steps like `analyze the shadow period decisions` (`other` 0.2) are consulted but cannot promote (a backend `other` never changes the facts), and steps with a credential word are skipped. The override is global: restore it immediately after, as at DF3.
- **Owner decision, not taken here:** whether to narrow `token` to credential contexts (`API/auth/access/bearer/refresh/session/OAuth token`, `X_TOKEN`, `token=…`) so `fix the token counter` is not skipped. It would change the expected value in `test/unit/routing-classify.backends.test.ts` (`count the tokens in the prompt` → gates) and widens what can leave the machine; it was not done under "do not weaken D14".
- **Optional (3.x):** give `backendSkipped` a reason kind (word / env-name / PEM / shaped secret) without ever logging the matched text.
- **Phase 3.1 docs:** write `host` as *experimental*; describe the gate with the rule above, including that `token` gates in the LLM sense.
- **Orchestrator:** `dogfood.md` `## DF3` now holds the corrected result in place of "skipped: … false positive → NOT verified live".

## Verdict

**The gate is correct on the DF3 probe: no false positive, no gate fix.** The suspicion rested on another session's rows read from the shared decision log; the probe's own row shows the host backend consulted live and answering. The regression tests now pin the probe, ten ordinary prompts with a written judgement, and seven real-secret shapes; every existing QA-1.2-1 test is green, and the D14 bound is untouched (one comment added to `scrub.ts`, no logic change). `host` stays *experimental* because the plan's `source: "host"` criterion was not observed, not because of the gate. Heavy QA has not run; the one open item is the optional second live check above.
