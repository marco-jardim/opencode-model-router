# ADR 0006 — Role × Tier × Assurance Delegation

> **Status:** Accepted (roles mode live in the owner's dogfood since checkpoint DF-2, 2026-10-08) **Date:** 2026-10-08 **Wave/Phase:** Role × Tier × Assurance delegation, Phase P3.2
> **Supersedes:** none **Depends on:** ADR 0002 (acceptance gate: the deterministic verdicts that make detection effective), ADR 0005 (cost-aware routing engine: the kernel, ladders and outcome store roles mode extends)
> **Deciders:** owner (Marco Jardim); amendments R0–R10 and adversarial QA recorded in the plan and phase reports
> **Plan:** [`../plans/role-tier-assurance-delegation-plan.md`](../plans/role-tier-assurance-delegation-plan.md) **User guide:** [`../ROLES.md`](../ROLES.md) **Spikes:** [`../qa/role-tier/spikes.md`](../qa/role-tier/spikes.md)
> **Issue:** [#84](https://github.com/marco-jardim/opencode-model-router/issues/84)

## Context

Up to `2.3.0` the orchestrator named a **tier** for every dispatch, and the tier carried both a model and a
permission set. The cost-aware engine of ADR 0005 could re-price that choice, but the runs of 2026-10-06/07 showed that
the tier was the wrong unit of decision, and that the evidence the engine needed did not arrive. Evidence (line numbers
refer to the base commit `eeab36b`):

| Id | Evidence | Source |
|---|---|---|
| E1 | The cost-aware engine never switched a dispatch: DF3 79 rows (65/65 agreement), DF4 112 (67/67), DF5 56 (24/24); since DF4 220 dispatches, 101 eligible, 0 switches | [`../qa/cost-aware-routing/dogfood.md`](../qa/cost-aware-routing/dogfood.md) |
| E2 | Outcome signal is starved: 23 verdict rows over 247 decision rows; "kept for lack of evidence" 23 of 84 fresh | DF5 record, QA-3.4 reproduction |
| E3 | The rules classifier skews: `design` 24 of 51 fresh; a file listing classified `review` @0.5 | DF2/DF3 records |
| E4 | Producers reported DONE while heavy QA then found serious defects (2.4 R1: 1 critical + 4 major; global QA R1: 1 critical + 8 major; #77 git tools R1: 3 blocking + 1 critical; #81 R1: 1 blocking + 2 critical) | `docs/qa/` reports |
| E5 | `gpt-6-luna-fast` searched the Code Mode catalog for "shell", found nothing and returned NEED MORE although direct tools existed; denying `execute` removed the confusion | session `ses_ee9cf7d50ffeq270hLk5fBJMwY`, #77 |
| E6 | Read-only agents were denied by the producer-oriented guard ("read/draft budget exhausted (3 consecutive non-producing actions)"), the read-only `fast` tier and a heavy review alike, even with `CAP:none` + `reason:`; denied calls were charged to the budget and later counted as repeats | `src/guard/guards.ts:223-227`, sessions `ses_ee6f0ba89ffenfzGLa5sDIrf6R`, `ses_ee6e6dee9ffef2QQoPWOt1Pn6G` |
| E7 | Many dispatches were cut at 25 tool calls (`DEFAULT_GUARD_BUDGET`, cumulative × 3); resuming the same session id preserved all work every time | `src/guard/enforce.ts:20,27,43-56` |
| E8 | ≥ 10 false "NOT ACCEPTED" verdicts citing a criterion cut mid-sentence; the criterion was a router instruction, not an outcome | `src/router/dispatch-header.ts:20`; candidate cut site `src/verify/dod.ts:62` (confirmed by spike S5) |
| E9 | Shell allow-patterns were bypassable (newline, `&`, `\|`, backtick, `$(`); the v1 action name `bash` silently failed on v2 (`shell`) until a real-host smoke caught it | QA-81-R2-7, #81 smoke |
| E10 | Host facts: the per-call `model` overrides the agent model; `session.created` carries parentID/agent/title; tool hooks reach only the session location's instance; `execute.before` does not fire for the runner's internal `native.execute`; same-model variant steps travel in-band | [`../qa/cost-aware-routing/phase-3.2.md`](../qa/cost-aware-routing/phase-3.2.md) |
| E11 | GitHub CI runs only on PRs/master; Windows jobs flake on temp-dir cleanup and tight timing | PR #76/#78/#82/#83 runs |
| E12 | A subagent's relative-path .NET write landed an empty file in the base checkout | #81 step 6 |
| E13 | The owner's custom `researcher` combined local reads with web egress; its `brave_*` tools need Code Mode `execute`, which also exposes the whole Code Mode catalog | owner override, #81 review, PLAN-3 |

Spikes S1–S12 against OpenCode 2.0.24 ([`../qa/role-tier/spikes.md`](../qa/role-tier/spikes.md)) settled the host
behaviour the design depends on; their proposals P-1…P-19 are amendment R6 of the plan.

## Decision

### D1 — Three axes; roles mode is opt-in, OpenCode v2 only, decided at plugin start

A dispatch is **role × tier × assurance**. The orchestrator picks the role (intent); the router picks the tier and
always sets the per-call `model` (E10); the effective detection of the dispatch bounds how cheap the tier may be.
`routing.delegation: "roles"` turns it on; the default `"tiers"` leaves v2 (and v1) byte-identical to the base except
the mode-independent fixes of D12, the dispatch header naming a route line's `root=`, and the I7 budget-incomplete rule
(a `NEED MORE: budget` return backed by the guard's state is `incomplete`, not a failure). R10 adds one more exemption,
in every mode: verification reasons are rendered one per line, with line breaks joined, at most 20 items plus a count,
and grader text cut at 500 characters. Role agents and role tools are registered only when the plugin **starts** in roles
mode; a runtime switch logs a restart notice (R8).

### D2 — A small, explicit role set, defined in code

Seven roles — `explorer`, `researcher`, `runner`, `implementer`, `reviewer`, `architect`, `general` — with written
contracts (authority, tier range, default assurance, guard profile, budget per tier, prompt with the return contract)
in `SHIPPED_ROLE_SPECS` (`src/router/roles.ts`), not in `tiers.json`, so a deep-merged user layer can never widen
authority (R7). `roleAgents.<name>` only narrows. The tier agents stay callable. `general` replaces the host's native
`general` in roles mode; the host's `explore` is aliased to `explorer` (S9).

### D3 — Least privilege with capability separation

Actions fall in four classes: local, exec (`router_run`), write (`edit`), egress (web, MCP, `execute`, shell,
delegation, unknown names). **No grant holds local, exec or write together with egress** (I4), checked for every
shipped role, every narrowing and every same-named #81 agent. `execute` is denied to every role, because Code Mode
inner calls are never permission-checked and its catalog cannot be filtered (S8); `researcher` is egress-only
(`webfetch`, `websearch`, `context7_*`), which closes E13. Raw shell is outside roles mode. Enforcement is layered: the
host applies the role's deny-by-default max policy, the router's permission hook narrows each session to its grant and
work root, and its context hook strips the session's catalog (S3, S11, P-19).

### D4 — The tier floor is authority × effective detection

`authorityFloor(grant, detection, risk, scope)`: no write → `fast`; write without exec → `fast` only with
deterministic detection, low risk and a single-file scope, else `medium` (`heavy` with no detection on high risk);
write + exec → `medium` with deterministic detection, else `heavy`. The window floor is the max of the role floor, this
floor, `escalate.floorTier`, the running rung on a resume and a raise recorded after a verification FAIL; risk and
scope are raise-only from the route line. Write authority reaches the cheapest tier only behind checks the router runs
itself in the dispatch's work root; edit + execution never runs on `fast`.

### D5 — Detection is effective, never claimed

Detection has three inputs only: whether the router's own gate will run the acceptance checks for the dispatch in its
work root (`deterministic`), the route-line `d=` claim and the prompt's `[acceptance]` block. Without the gate it is
the weaker of the claim and the block, capped at `grader` (A34, `effectiveDetection`); with neither it is `none`, for
every role. Unlike a tier dispatch, a role dispatch without a `d=` claim is `none` even when its prompt has an
`[acceptance]` block (unless the gate runs its checks): the orchestrator writes `d=grader` or `d=deterministic` to claim
it. A role dispatch's checks run in its routed work root by default, a `cwd:` outside that root is refused, and
a dispatch whose checks cannot run in the root is not `deterministic` (dogfood finding DF2-F1, fixed). The roles'
default assurance (`deterministic` for `runner`, `none` for the others) is descriptive and never enters the routing.

### D6 — Dynamic authority with exact binding and a resume-based ladder

Dynamic roles (`implementer`, `general`) get role max ∩ (base ∪ needs ∪ widened). A child is bound to its dispatch at
its first context build, **exactly only through a router-inserted nonce** (description suffix and last prompt line,
S2, R7); anything else is an unknown binding = role max ∩ local actions, no `router_run`, no `external_directory`, a
visible row and advisor finding. Never a union. `router_request_authority` records a request inside the role max and
tells the child to stop with `ESCALATE: authority`; the parent's result is annotated (S6); on the resume of the same
session the grant widens — only for an exact binding (R8), and only when the resuming session is the one the request
was escalated to — and the floor is recomputed, so the model may rise (S7).
Outside the max the request is refused, naming the role to use.

### D7 — One work root per dispatch

The session directory, or a git worktree of the same repository named by `root=` and validated against
`git worktree list --porcelain` before any filesystem call; anything else withholds write and run. Max policies allow
`external_directory` for the worktrees listed at registration plus `routing.workRoots` globs in canonical long form;
the permission hook narrows each session to its own root (S11, P-11, P-13). `router_run` and `router_git_*` take the
bound root, never the session location (P-10, P-18). Role `edit` needs a validated work root (on the ladder too) and
never writes `.git` or anything below it (R10).

### D8 — A structured, fixed-argv run tool

`router_run` runs one allowlisted `package.json` script or configured command with a fixed argv and no shell of its
own; caller arguments only where an entry declares patterns, each matching an allowlist regex and confined to the work
root; npm resolved from the Node install with its script shell, node options, workspaces and config files pinned;
`.npmrc` keys that would move them refused; credential-like environment variables dropped. Script bodies stay trusted
repository content run by npm's script shell (E9).

### D9 — Budgets belong to the role and tier; exhaustion is not failure

A role dispatch's call budget is the role's budget for the routed tier (`budget=` raises it up to 2×; a resume without
`budget=` keeps the previous one); the cumulative ceiling is 3 × the largest round budget the child had; refused calls
are not charged. On exhaustion the child returns `NEED MORE: budget` with a summary, the parent's result gets a
`[router budget]` note, and the same session is resumed (E7). The host `steps` limit is 2 × max(the top role budget,
25) + `REFUSAL_CAP` + 5, so the router's stop always comes first (S4, R7, R8). Tier agents keep 25 / × 3; a role
dispatch that a floor lifts above its role's ceiling, when the role has no budget for that tier, gets max(the role's
budget for its ceiling tier, 25). A role dispatch has a read-only call cap only when it carries `CAP:N` or `CAP:none`.

### D10 — Outcome evidence only from external verification

Deterministic pass/fail weighs 1. A router-observed run weighs 1 (success only) when the child's own `router_run` of
every npm-script-form acceptance check (`npm test`, `npm run <name>`) exited 0 after its last edit; only checks of that
form are matched to runs, so a dispatch without one gets no `run` signal and a check of any other form is covered only
by the deterministic verdict. An LLM grader's verdict of a role dispatch is never a weight-1 `verdict`: an independent
grader (tier ≥ producer, another model) moves the outcome store by 0.5 and writes a `grader` signal row, and a grader
that is not independent (or not known to be) records nothing — no store change, no verdict row, no signal row; a false
refusal after an independent grader's pass takes back only its 0.5. An explicit `NEED MORE`/`ESCALATE` without a budget
stop or authority request weighs 0.5 against; a re-dispatch of the same task to a higher tier within 30 minutes 0.5 against the earlier
attempt; `DONE` alone 0; budget and authority events are recorded with no penalty (I6, I7). Only verdicts move the
outcome store the kernel reads — deterministic verdicts at 1 and independent grader verdicts at 0.5; `run`,
`incomplete` and `redispatch` signals are routing statistics only, decision-log rows read by `routing:stats` (R10).

### D11 — Exploration is experimental and off by default

`routing.exploration.rate` (global only, default 0, at most 0.2) lets `enforce` send a share of role dispatches to a
cheaper rung, only with deterministic effective detection, never on pinned, resumed or high-risk dispatches, never
below the floor; seeded by the decision id, logged with `explore` and `propensity`.

### D12 — Mode-independent fixes ship with it (v1, tiers mode and roles mode)

E6: a reader guard profile (no consecutive-non-producing denial) for the read-only `fast` tier, `class=review|recon|search`
dispatches (v2 with a non-`static` routing engine only: the class comes from the engine's dispatch record),
`CAP:none` + `reason:` dispatches and reader roles; refused calls are neither charged nor recorded as
executed. E8: verification never cuts a criterion (whole criteria within 4000 code points, the rest omitted and not
graded), the router header is stripped before criteria are inferred, router directives are not gradable, and a
progress-note return is `incomplete`, not `fail`. The dispatch header's `Working directory:` names a route line's
`root=`. Each change ships a before/after golden.

### D13 — OpenCode v1 keeps the tier model

On v1 the roles keys are validated but inert, with one notice (`roles delegation requires OpenCode v2; using tiers`);
no role agent, tool, hook or prompt change is registered (I8).

## Alternatives rejected

- **`DONE` as a weak positive signal.** Self-reported success preceded serious QA findings (E4), and verbalized
  confidence is overconfident (L7); 0 is a deliberate conservative setting, since self-evaluation does carry some
  signal (L3, L8).
- **The orchestrator picks the tier.** It named tiers by prose and the engine never found evidence to override it
  (E1, E2); the tier is now the router's decision inside a floor.
- **`general` auto-granted full tools on a cheap model.** Write + exec on `fast` without the router's own checks
  contradicts D4.
- **Raw shell for `general`, or shell allow-patterns.** Allow-patterns were bypassable (E9); fixed argv with an
  argument allowlist is the safer shape (L14).
- **A Code Mode allowlist (`codeModeAllow`) for `researcher`.** Inner Code Mode calls are never permission-checked and
  the catalog cannot be filtered (S8); dropped by R6.
- **Binding by intersection or union of candidate dispatches.** Siblings of one parent turn are indistinguishable
  without a nonce (S2); an ambiguous binding is unknown and narrowed, never widened (R7).
- **Role specs in `tiers.json`.** A deep-merged user layer could widen authority and every config would look like a
  roles config (R7).
- **Learned routers, OS-level sandboxing, changing the host, removing the tier agents** — out of scope (plan §3).

## Consequences

- Savings come first from structural defaults (reading roles on cheap tiers); learned switching adds savings only once
  outcome signal exists. The `run` signal is narrow (npm-script-form checks only), so most positive evidence still
  comes from the deterministic gate.
- Acceptance checks run in the dispatch's work root; a role dispatch whose checks cannot run there is not
  `deterministic`, so its write authority stays on `medium`/`heavy` instead of reaching `fast`.
- Separation costs utility: a task needing both the web and the repository becomes two dispatches composed by the
  orchestrator. The cost was not measured here; L13 reports 77% task success with its defence vs 84% undefended on
  AgentDojo.
- Residual risks stay documented, not solved: repository scripts may reach the network; untrusted repository content
  is an injection vector; flows routed through the orchestrator are not covered; the host's own search may follow
  links inside the work root; reading roles keep the host's tool-output folder, narrowed per session. Roles mode is not
  an OS sandbox.
- Switching delegation mode needs an OpenCode restart; the kill switch is the previous override plus a restart.
- I1/I8 hold except the D12 fixes, the header naming `root=`, the budget-incomplete rule and the verification-reason
  rendering (R10); those are behaviour changes in every mode, listed in the changelog.
- Signal rows are annotation rows of the decision log; readers older than this release drop them only through their
  decision-id dedupe, so downgrading past this release is unsupported.
- The tier agents and tiers mode remain fully supported; a role defect has a recorded fallback.

## Literature

Only these sources are cited, with the qualifier that applies to each hypothesis.

- [L1] Chen, Zaharia, Zou. *FrugalGPT.* [arXiv:2305.05176](https://arxiv.org/abs/2305.05176) (2023) — cascades match the best single model with large cost reductions on their benchmarks.
- [L2] Ong et al. *RouteLLM.* [arXiv:2406.18665](https://arxiv.org/abs/2406.18665) (2024) — learned strong/weak routers cut cost >2× in some settings without quality loss.
- [L3] Aggarwal, Madaan et al. *AutoMix.* [arXiv:2310.12963](https://arxiv.org/abs/2310.12963) (NeurIPS 2024) — routes on few-shot self-verification, a signal the authors call noisy, and still saves cost.
- [L4] Dekoninck, Baader, Vechev. *A Unified Approach to Routing and Cascading for LLMs.* [arXiv:2410.10347](https://arxiv.org/abs/2410.10347) (2024) — quality estimators are the critical factor.
- [L5] Huang et al. *Large Language Models Cannot Self-Correct Reasoning Yet.* [arXiv:2310.01798](https://arxiv.org/abs/2310.01798) (ICLR 2024).
- [L6] Kamoi et al. *When Can LLMs Actually Correct Their Own Mistakes?* [arXiv:2406.01297](https://arxiv.org/abs/2406.01297) (TACL 2024) — self-correction works with reliable external feedback.
- [L7] Xiong et al. *Can LLMs Express Their Uncertainty?* [arXiv:2306.13063](https://arxiv.org/abs/2306.13063) (ICLR 2024) — verbalized confidence is overconfident.
- [L8] Kadavath et al. *Language Models (Mostly) Know What They Know.* [arXiv:2207.05221](https://arxiv.org/abs/2207.05221) (2022) — self-evaluation can be calibrated (format/scale dependent).
- [L9] Zheng et al. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* [arXiv:2306.05685](https://arxiv.org/abs/2306.05685) (2023) — judges agree >80% with humans but show position, verbosity and self-enhancement bias.
- [L10] Cemri et al. *Why Do Multi-Agent LLM Systems Fail?* [arXiv:2503.13657](https://arxiv.org/abs/2503.13657) (2025) — MAST: 14 failure modes in system design, inter-agent misalignment, task verification.
- [L11] Hong et al. *MetaGPT.* [arXiv:2308.00352](https://arxiv.org/abs/2308.00352) (2023) — SOP-encoded roles on the authors' benchmarks.
- [L12] Beurer-Kellner et al. *Design Patterns for Securing LLM Agents against Prompt Injections.* [arXiv:2506.08837](https://arxiv.org/abs/2506.08837) (2025) — capability separation patterns with an explicit utility trade-off.
- [L13] Debenedetti et al. *Defeating Prompt Injections by Design (CaMeL).* [arXiv:2503.18813](https://arxiv.org/abs/2503.18813) (2025) — capability tracking blocks exfiltration; 77% vs 84% task success undefended on AgentDojo.
- [L14] MITRE [CWE-78](https://cwe.mitre.org/data/definitions/78.html), OS command injection (non-academic, authoritative) — fixed-argv calls over command strings; denylists are weak.

How they bear on the decisions (plan §1.3):

| # | Hypothesis | Status | Basis |
|---|---|---|---|
| RH1 | Savings come first from structural defaults (role → class → tier; cheap models on read-only work); learned switching adds savings only once outcome signal exists | revised (was: the engine learns the savings) | L1–L4 (estimator quality is critical); E1, E2 |
| RH2 | Positive evidence only from external verification: deterministic checks and router-observed runs (weight 1); an independent grader (tier ≥ producer, different model) 0.5; self-reported `DONE` 0 — a conservative local choice | revised (was: `DONE` as a weak positive) | E4, E8; L6, L7, L9 support discounting self-assessment; L3, L8 show it carries *some* signal, so 0 is a deliberate conservative setting |
| RH3 | A small, explicit role set with written contracts, plus role-aware infrastructure; every handoff has a cost | motivated, not proven | L10 (failure categories), L11; E5, E6 |
| RH4 | Least privilege with capability separation: no grant holds local reads/code execution together with an egress channel | partially supported: it blocks a role's own read → egress path, not flows routed through the orchestrator | L12, L13; E13 |
| RH5 | Authority × effective detection floor: write authority on a cheap model only behind checks the router itself runs; edit + execution never on the cheapest tier | derived | L6; plan history (D9/A34, PLAN-5) |
| RH6 | Structured fixed-argv tools for routine commands; npm script bodies still run through npm's script shell, which is pinned | supported | L14; E9 |
| RH7 | Budget exhaustion is not model failure; budgets belong to the role/tier; a cut-off resumes the same session | evidence-only | E6, E7 |
| RH8 | Fewer advertised tools per role reduce tool-selection confusion and per-turn tokens | evidence-only | E5 |
| RH9 | Learning cheaper tiers needs safe exploration (only behind effective deterministic detection) | evidence-only, experimental, off by default | E1, E2 |
| RH10 | Verification text is never truncated mid-criterion; router instructions are not gradable outcomes | evidence-only | E8 |

L5 belongs to the plan's verified list; no hypothesis above names it as its basis. Sources the plan could not verify
are not used as support.
