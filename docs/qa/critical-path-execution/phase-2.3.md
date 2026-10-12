# Phase 2.3 — Plan compiler

Worktree `D:\git\omr-cpx-p23`, branch `cpx/p23`, base tag `cpx/p23-base` = `558e5b8`. Started 2026-10-11 06:17.

## Pre-flight

- [x] Depends on: merged into `cpx/main` (Wave 1 merges `12d42b7`, `6d310eb`, `d4d731b`, `a9e32c1`; 0.1 final `915b96a`).
- [x] Worktree from `cpx/main` at `558e5b8` (tag `cpx/p23-base`, pushed), `npm ci`, clean; typecheck green; `smoke:cpx` 52/52 and `smoke:keyless`/`smoke:v1` = baseline at `915b96a`.
- [x] Anchors and task list (explorer `ses_ed5b8fcf1ffekca1nfk7hM00V2`): no write-set overlap between Wave-2 phases; within 2.1, `src\index.ts` (2.1.4 then 2.1.6) and `docs-drift.test.ts` (2.1.2 then 2.1.7) are sequential.
- [x] Anchors hold: `splitPlan` annotate-plan.ts:267, `annotateSteps` plan.ts:293, `parseRouteLine` route-line.ts:280, `parseAcceptanceBlock` dod.ts:224 (drifted from ≈230), `toolTargets` tool-paths.ts:300.

## Implementation notes

### 2.3.1 design memo (architect, heavy pin, `ses_ed5b67c1effeVgdPqD87z4ImZw`)

Orchestrator decisions (binding):
- D2, D3, D11 approved; D3 is confirmed against 3.2 at 3.2's pre-flight (handoff).
- O1: `integration.worktree` is computed at compile through the `integrationWorktree` seam = `<defaultSlotsDir(toplevel, planId)>\integration` (2.4 exports `defaultSlotsDir`); the integration slot always uses `ledger.integration.worktree`, task slots use `config.slotsDir`.
- O2: the 1.3 registry keys files, not directories: `dir: true` writes expand to matching tracked files (≤ 50), else ⊤.
- O3: `roleOf` is checked against `docs\ROLES.md` by 2.3.6 and stubbed in tests. O6: the freezer reports `NEED MORE` if a source plan is missing.

# 2.3.1 Design memo: plan compiler

## 0. Framing and binding decisions

**Goal.** `PlanCompiler` (T:1359-1371) turns plan text into a draft that meets three conditions:
- it is a `LedgerV1` with `seq: 1` that passes `isLedgerV1` (T:1303-1305, QA14:955);
- it satisfies the concurrency closure;
- it comes with an estimate and, when needed, one architect residue dispatch (plan:2295-2300).

Every heuristic has to be either conservative (it adds edges or writes) or reported (`summary.warnings`). The adversarial focus is plan:2502-2510.

**Decisions.** Each one gives the rule, then the evidence or reason.

- **D1. FIX templates stay out of the ledger.** `X.Y.FIX` never becomes a TaskNode (plan:2373). `parse.ts` exports the template (`ParsedPhase.fixTemplate`) and 4.2 QaLoop re-derives it with `parsePlan(read(planPath))`. If the plan's sha256 differs from `ledger.planDigest`, QaLoop uses its defaults and warns. A fake `done` node would show on boards and in counts. A new ledger field would not survive `draft-replaced` (T:608). This is a handoff to 4.2.
- **D2. Shared context.** The `<!-- plan-context -->…<!-- /plan-context -->` block wins (plan:78-93, plan:2362).
  - **Deviation:** worktree-root absolute paths are replaced with `<worktree>\<rel>` in **both** cases (explicit block and fallback). Otherwise a slot child is told to write into `D:\git\omr-cpx-main`.
  - Lines that look like launch headers are replaced with `[header-shaped line removed]` and a warning is emitted. `validate` still reports `shared-context-header` (T:955, T:1126-1129, QA14:1101).
  - Truncation is at the last `\n` at or before `config.sharedContextChars` (T:951).
- **D3. Tasks that an `Order:` line puts after `QA`** (plan:4089: `6.2.0 → 6.2.QA → 6.2.FIX (loop) → 6.2.4 …`).
  - They move to a synthetic phase `<P>.post`: same wave, `dependsOn: [P]`, edges `gate:P → its sources`, warning `post-qa-phase`.
  - Leaving them in P would deadlock: QA waits for P to be integrated, and they wait for QA.
  - **Owner check needed:** 3.2's §3.3 "phase-integrated" precondition decides whether this is required.
- **D4. Unknown write sets.** For closure and conflict edges, an editing task with an unknown write set writes **⊤** (everything). The draft is therefore always safe, possibly over-serialized.
  - `kind:"conflict"` edges are derived data. `mergeResidue` recomputes them; everything else is monotone (§6).
- **D5. A task's `Writes:` line is closed.** Write verbs and mentions do not add writes, and ownership rows do not apply. The same holds for `Reads:` and reads. This is what 2.3.3's criterion "footprints … equal their Writes:/Reads: lines" (plan:2402) requires.
- **D6. Which edge cycles are fatal.**
  - Cycles among structural or graph edges → `E_CYCLE`.
  - An explicit edge from prose that closes a cycle is dropped with warning `explicit-edge-cycle-dropped`. The tasks are still ordered (the other way), so no race results.
  - Contract and conflict edges are only added between pairs that are concurrent, so they cannot create cycles.
  - A cycle from `llm` edges → `E_RESIDUE`.
- **D7. Phase dependencies are gate edges.** "Depends on P", "after Phase P is merged" and "P merged first" become `gate:P → <sources of the dependent>`. `GateRef` is satisfied when the gate is `passed` (T:18-19, T:1505-1507).
  - For reachability, every task t of phase P also gets an implicit node edge `t → gate:P`.
- **D8. Footprint path semantics follow `toolTargets`.** Resolution is lexical, with no realpath (TP:98-102, TP:122). Device-prefixed and drive-less rooted win32 paths are rejected; TP returns them unchanged and the registry fails closed (TP:87-99). Move and delete count as writes of every path named (TP:39).
  - Drive or backslash inputs always use `path.win32`, so tests give the same result on any OS.
  - A parity test on win32 checks that resolution equals `toolTargets("write", {filePath}, root).paths[0]` (TP:300).
- **D9. Interfaces for the parallel tasks.** 2.3.2 and 2.3.3 run in parallel (plan:2318), so `footprint.ts` declares its own input types structurally and does not import `parse.ts`.
- **D10. The 2.3.7 inconsistency** (plan:2491 says tests read `p23\docs\plans`; plan:2496 forbids it; plan:2311-2316 names the sources) is resolved like this:
  - one freeze, done by the 2.3.7 implementer, copies `D:\git\omr-cpx-p23\docs\plans\<name>.md` at the 2.3 base commit to `test\fixtures\cpx\plans\<name>.md`, byte for byte;
  - tests read **only** `test\fixtures\cpx\plans\**` (§10).
- **D11. Fallback context cut.** The fallback shared context is cut at the first wave **or phase** heading. In dd, `### Phase 0.P` (dd:779) comes before `### Wave 1` (dd:862) and would otherwise leak into the context. This is a deviation from plan:2363; it is needed.

## 1. Module map and data flow

```
index.ts compile():
  fs.readText → sha256
  loadRepoView(git)                              footprint.ts
  parsePlan(text)                                parse.ts, sync, pure
  annotateUnrouted(plan, annotate)               parse.ts, exactly one annotateSteps call
  selectPhases(opts)                             index.ts
  extractFootprint per task, in plan order       footprint.ts
  buildEdges                                     edges.ts
  projectDoneBefore                              index.ts
  estimate                                       estimate.ts
  residueRequestOf                               residue.ts
  assembleDraft                                  index.ts
  validate(draft) and ledgerViolations(draft) must both be []    validate.ts
```

Seams, all injected and stubbed in tests:

```ts
export interface CompilerDeps {
  fs: { readText(absPath: string): Promise<string> };
  git: { run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> }; // or the §9 GitRunner seam of T
  durations: DurationModel;                                  // DUR:82-89, already created
  annotate: (steps: readonly PlanStep[]) => Promise<AnnotatedPlan>;  // bound to annotateSteps (PL:293)
  roleOf: (route: RouteLine | null, tier: Tier | null) => string;     // roles policy class→role; stub in tests
  integrationWorktree: (planId: PlanId, repo: LedgerV1["repo"]) => string; // see open item O1
}
export function createPlanCompiler(deps: CompilerDeps): PlanCompiler;
```

## 2. `parse.ts` (2.3.2)

```ts
export interface Span { line: number; endLine: number }               // 1-based, inclusive
export interface CompileIssue { code: string; line: number; message: string }
export interface LabeledList { line: number; text: string; none: boolean }   // a Writes:/Reads: segment
export type IdSource = "explicit" | "dogfood" | "preflight" | "block" | "hash";
export interface ParsedTask {
  id: string; idSource: IdSource; phase: string | null; kind: TaskKind;
  title: string;                 // ≤120 chars; id, tags, VERIFY/CAP, ** removed
  text: string;                  // verbatim plan slice (splitPlan from..to)
  body: string;                  // dedented to the item's content column, pure-tag code spans unwrapped, fenced lines blanked
  span: Span; subtasks: string[]; // subtask ids ("2.3.2.a"), else the normalized first line
  tierTag: Tier | null;
  route: { line: string; fields: RouteLine | null; conflict: boolean } | null;
  verify: "required" | "deferred" | "none" | null; cap: number | "none" | null;
  acceptance: string | null;     // raw first [acceptance]…[/acceptance] (or [dod]) block
  writesLine: LabeledList | null; readsLine: LabeledList | null;
  manual: boolean;
}
export interface OrderChain { groups: string[][]; line: number; raw: string }
export interface ParsedPhase {
  id: string; title: string; wave: string; span: Span; dogfood: boolean; synthetic: boolean;
  dependsOn: Array<{ id: string; external: boolean; line: number }>;
  order: OrderChain | null; fixTemplate: ParsedTask | null;
  intro: string;                 // text between the heading and the first block, used for phrases
  newTests: string | null;       // gate metadata
}
export interface ParsedWave { id: string; title: string; line: number; phases: string[] }
export interface GraphBlock { line: number; edges: Array<{ from: string; to: string; line: number; raw: string }> }
export interface OwnershipRow { path: string; owners: string[]; format: "file-major" | "phase-major"; line: number }
export interface ExplicitPhrase { subject: { kind: "task" | "phase" | "wave"; id: string };
  verb: string; refs: string[]; line: number; excerpt: string }
export interface ParsedPlan {
  waves: ParsedWave[]; phases: ParsedPhase[]; tasks: ParsedTask[];   // tasks in plan order
  graphs: GraphBlock[]; ownership: OwnershipRow[]; phrases: ExplicitPhrase[];
  sharedContextRaw: string; sharedContextSource: "block" | "preamble";
  warnings: CompileIssue[];
}
export function parsePlan(text: string): ParsedPlan;  // throws ExecutorError("E_COMPILE", msg, {code, line})
export function normalizeFirstLine(line: string): string;
export function fallbackTaskId(firstLine: string, seen: Map<string, number>): string;
export function unwrapPureTagSpans(line: string): string;
export async function annotateUnrouted(p: ParsedPlan,
  annotate: (s: readonly PlanStep[]) => Promise<AnnotatedPlan>): Promise<ParsedPlan>;
```

### Algorithm

The whole pass is O(L + Σ|step|). Every scanner is linear, and no regex can backtrack catastrophically: phrase windows are bounded to 160 chars.

**Step 1 — lines and masks.**
- Lines are split on `/(\r\n|\n|\r)/`, as AP:44 does.
- `mask = structureMask(lines)` (AP:84) hides fences and HTML comments; the comment rule is AP:131-137. A second fence-only mask comes from the shared `fenceMask`, as RL:291 uses it, so the plan-context markers can still be found.
- An unclosed top-level fence at EOF → `E_COMPILE fence-unclosed`. Without this check, the mask runs to the end of the file (AP:82) and silently drops the tasks after it.
- An unclosed `[acceptance]` → `E_COMPILE acceptance-unclosed`. `listRuns` would otherwise swallow the rest of the plan (AP:192-198).

**Step 2 — headings** (unmasked lines only). Heading level decides containment.
- **Wave:** `^ {0,3}#{2,3}\s+Wave\s+(\d+[A-Za-z]?)\b` → wave id `$1` (plan:1034, plan:3927, dd:862).
  - Arrows inside the heading's parenthesis (`(6.1 → 6.2)`) become phase-level graph edges.
  - `merged first` inside it (rt:570) becomes a phrase whose subject is the wave.
- **Phase:** any of
  - `#{2,4}\s+Phase\s+(<pid>)`,
  - `#{2,4}\s+(P\d+(?:\.\d+)+)\b` (rt:510, rt:572),
  - `#{2,4}\s+Dogfood switch DF-(\d+)` → id `DF<n>`, `dogfood: true` (plan:2038, plan:3783),
  - a heading whose first token is an id-shaped `<pid>` that is a prefix of at least one explicit task id below it. This "confirmed by children" rule covers `0.P` headings without the word "Phase" and avoids false phases from numbered prose sections.
  - `<pid>` = `[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*`. It must match `PHASE_ID_PATTERN` (T:44), else `E_COMPILE phase-id-invalid`. A duplicate → `E_COMPILE phase-duplicate`.
- A phase **outside any wave heading** becomes its own synthetic wave with id = phase id (dd:779 `0.P`).
- **No phase headings at all:** one synthetic phase `main` in wave `main`, so qa tasks still have a phase (T:850). Exception: when `splitPlan` fell back to heading runs (AP:281), `## Phase N` headings are the tasks (AP:50).

**Step 3 — block labels** inside a phase.
- Regex: `^ {0,3}(?:#{1,6}\s+|\*\*|__)?(Pre-flight|Tasks|New tests|Acceptance criteria|Definition of Done|QA review|Order)\b`.
- A block runs to the next label, phase heading or wave heading.
- `Pre-flight (in addition to §0.9)` matches (plan:2302).

**Step 4 — lines read with dedicated parsers.**
- **`Depends on:`** (`\*\*Depends on:\*\*` or plain), on the `Worktree` line or alone (plan:2293, plan:3933, dd:1135).
  - Every token that equals a known phase id, or `DF-<n>` (external, → `DF<n>`), counts, inside or outside parentheses. `DF-2 (and 5.1)` gives both; `0.1 (C5, C6)` gives only 0.1 (plan:1243).
  - Id-shaped tokens that are not known phases → warning `depends-unknown`.
- **`Order:`** (plan:716, plan:2318, plan:3945, plan:4089). Grammar:
  - `chain := group (ARROW group)*`, `ARROW := → | -> | -->`,
  - `group := item | "(" item ((∥ | "||" | ",") item)* ")"`,
  - `item := taskId | "QA" | "FIX" ["(" word ")"]`.
  - The chain stops at the first token outside the grammar; trailing prose such as plan:716 is ignored.
  - `QA` → `<P>.QA` and `FIX` → the template. An unknown id → `E_COMPILE order-unknown-id`.
- **Ownership tables**, both formats:
  - **file-major:** header cell 1 matches `/^(File|Path)s?$/i` and the other cells are owner columns (dd:710). Each cell's phase ids own the path in cell 1.
  - **phase-major:** cell 1 is a phase id and cell 2 holds backticked paths with parenthetical notes. Phrases inside a cell, e.g. `**starts after 2.1 merges**` (docs\plans\cost-aware-routing-engine-plan.md:363), become phrases whose subject is that phase.
- **Graph blocks:** fenced blocks (any info string, including `mermaid`) with at least one line matching `\S\s*(->|→|-->)\s*\S`.
  - Node token = `[A-Za-z0-9][A-Za-z0-9._-]*` after removing mermaid labels `[…]`, `(…)`, `{…}` and `|…|`. Chains `A -> B -> C` and lists `A, B -> C` are supported.
  - Unknown nodes → warning `graph-node-unknown` and a residue candidate.

**Step 5 — steps.**
- `splitPlan(text)` (AP:267-289) gives top-level items with `line`/`from`/`to`. Its `L<n>` ids are **not** used (AP:287).
- Each step is assigned to (phase, block) by line.
- The leading token after the marker and optional checkbox (AP:348) is tested against the id regex (§3).

**Step 6 — classification, by block.**
- **Tasks block or no block:** explicit id → task. An item without an id in a phase that has ids → still a task, with a hash id and warning `id-less-item`. Work is never dropped.
- **Pre-flight block:** `kind: "preflight"` with id `<P>.PF<k>` (plan:2370).
- **New tests / Acceptance criteria / Definition of Done:**
  - If the phase has explicit ids, these are metadata, never tasks (plan:2371-2372).
  - Without ids, `New tests` becomes one `kind: "tests"` task `<P>.TESTS`; AC and DoD are never tasks.
- **QA review block:** merged into `<P>.QA` when that exists, else creates `<P>.QA` (kind qa).
- **Dogfood sections:** every item is `manual`. Ids are taken from a leading `DF-?<n>.(\d+|QA)` token, else `DF<n>.<k>` by ordinal, and `DF<n>.QA` for the QA item (`isQaLine`, PL:125).
- **Kind rules, in order:**
  1. id ends `.FIX` → template (`phase.fixTemplate`), not a task;
  2. id ends `.QA` → `qa`;
  3. a dogfood section, or no route line and the title starts with `Orchestrator` or `Planned human action` → `manual` (plan:2359-2360);
  4. title starts with `New tests` or `Tests`, or every write is a test path (`^test/`, `\.test\.`, `\.spec\.`) → `tests`;
  5. otherwise `task`.

**Step 7 — annotations per step.** These run on `body`; dedenting first keeps nested route lines under RL's 4-column rule (RL:191).
- **Pure-tag code spans are unwrapped first.** A code span whose whole content is `[tier:X]` or `[route …]` (dd:1067: ``- **1.3.4** `[tier:medium]` ``) becomes plain text. PL ignores tags inside inline code (PL:115-123, PL:220), so without this, backticked and plain forms would differ (2.3.2 criterion, plan:2378).
- **tier:** first `[tier:(fast|medium|heavy)]` outside code (PL:90), else the route line's `tier=`.
- **route:** `parseRouteLine(body, {positions:"any"})` (RL:280, RL:287). If the step has more than one route line → `conflict` plus warning (RL:220).
- **VERIFY:** inline `\bVERIFY:(required|deferred|none)\b` on the first line. DOD's regex is whole-line only (DOD:65), and plan:2334 puts the directive inline. Unknown word → warning.
- **CAP:** inline `\bCAP:(\d+|none)\b` on the first line (plan:2321). It is used for validation only and stays in `text`.
- **acceptance:** the first open/close pair in `body` with fenced lines blanked, so `parseAcceptanceBlock` (DOD:224-247), which does not know about fences, cannot match inside a fence. Store the raw block, tags included.
- **Writes:/Reads:** label regex `\b(Writes|Reads)(?:\s*\([^)]*\))?:` (plan:2324 `Reads (pasted):`).
  - The segment runs to the other label, a blank line, the next item at the task's indent, `[acceptance]`, or a subtask item.
  - A label with nothing after it takes the following nested list items (plan:2478-2485).
  - `none`/`none.` → `none: true`.
- **Subtasks:** nested items `^<parentId>\.[a-z]\b`. They are never tasks; their Writes/Reads segments belong to the parent.

**Step 8 — `annotateUnrouted`.**
- One `annotate(steps)` call over every task with `route === null` and kind not manual or preflight. Each `PlanStep` is `{id, text: body}`.
- The result supplies tier (PL:336, PL:360), route line (PL:380) and pin (PL:377).
- Existing tags are kept (PL:320-322). Role comes from `deps.roleOf`.

**Step 9 — shared context** (D2, D11): block → else the preamble before the first wave or phase heading → replace worktree paths → handle header-shaped lines → cap.

## 3. Id grammar and stability

**Explicit task id.** The leading token of a top-level item, after the marker and optional `[ ]`, matches

`^(?:\*\*)?((?:T|P)?\d+(?:\.(?:\d+|[A-Z]{1,4}))+[a-z]?)(?:\*\*)?(?=\s|:|$)` (plan:2347).

- The lookahead stops `2.3.2.a` (subtask form) from matching.
- Accepted: `1.1.1`, `**1.1.1**`, `T1.1.1`, `0.P.1`, `1.1.QA`, `1.1.FIX`, `6.2.0`.

**Other ids.**

| Form | Rule |
|---|---|
| `DF<n>.<k>`, `DF<n>.QA` | dogfood sections (§2 step 6) |
| `<P>.PF<k>` | k = 1-based ordinal in the phase's Pre-flight block |
| `<P>.QA`, `<P>.TESTS` | synthesized from blocks |
| `S<8 hex>-<n>` | fallback (plan:2350) |

**Fallback.** `S` + the first 8 hex of `sha1(normalizeFirstLine(line))` + `-<ordinal among equal hashes in plan order>`. `normalizeFirstLine` does, in order:
1. remove the list marker, checkbox and heading hashes;
2. remove `[tier:X]`, VERIFY and CAP tokens and pure-tag spans;
3. remove `**`/`__`;
4. NFC, collapse whitespace, trim, lowercase.

**Stability rule.** An id depends only on the step's own id token, its normalized first line, or its ordinal inside its own Pre-flight/DF block. It never depends on a line number or on text outside the step. Consequences:
- inserting or editing lines anywhere else leaves every id unchanged (plan:2550);
- annotating with `/annotate-plan` changes no id, because tags are normalized away.

**Validity** (`E_COMPILE`):
- `id-invalid`: not `isTaskId` (T:26, T:38) or in `RESERVED_TASK_IDS` (T:33-36).
- `id-reserved`: an authored id matches `^<P>\.QA\d+$` or `^<P>\.FIX\d+-\d+$`. These belong to QaLoop (T:1206-1219).
- `id-duplicate`: an exact duplicate, or two ids equal after case folding (branch refs are case-insensitive on win32).

**Phase of a task.** The enclosing phase heading. If none exists, the id prefix (id minus its last segment, with `T`/`P` normalized) becomes an implicit phase. A mismatch → warning `id-phase-mismatch`; the heading wins.

**`tasks` record order.** Insertion order = plan order (T:92). Ids are never integer-like, so JS key ordering cannot reorder them.

## 4. `footprint.ts` (2.3.3)

```ts
export interface RepoView { toplevel: string; worktrees: readonly string[]; files: ReadonlySet<string>;
  dirs: ReadonlySet<string>; byBasename: ReadonlyMap<string, readonly string[]>; caseInsensitive: boolean }
export async function loadRepoView(git: CompilerDeps["git"], cwd: string): Promise<RepoView>;
  // `rev-parse --show-toplevel`, `worktree list --porcelain`, `ls-files -z`, `config core.ignorecase`
export function repoViewFrom(i: { toplevel: string; worktrees: string[]; files: string[]; caseInsensitive: boolean }): RepoView;
export type PathOutcome =
  | { ok: true; path: string; via: "worktree" | "relative" | "basename" | "suffix" | "new"; dir: boolean }
  | { ok: false; reason: "url" | "outside" | "other-drive" | "unc" | "device" | "escape" | "ambiguous" | "not-found"; raw: string };
export function normalizeRepoPath(raw: string, repo: RepoView, o: { allowNew: boolean; createdEarlier: ReadonlySet<string> }): PathOutcome;
export interface FootprintInput { id: string; kind: TaskKind; body: string; manual: boolean;
  route: { fields: { needs?: readonly string[]; class?: string } | null } | null;
  writesLine: { line: number; text: string; none: boolean } | null;
  readsLine: { line: number; text: string; none: boolean } | null }
export interface OwnershipInput { path: string; owners: string[]; line: number }
export interface TaskFootprint { footprint: Footprint; editing: boolean; lowConfidence: boolean;
  evidence: Array<{ path: string; access: "write" | "read"; source: Footprint["sources"][number]; line: number; rule: string }>;
  ignored: Array<{ raw: string; reason: string; line: number }>; foreignRoots: string[] }
export function extractFootprint(t: FootprintInput, phaseOwnership: readonly OwnershipInput[],
  repo: RepoView, createdEarlier: Set<string>): TaskFootprint;   // adds new files it creates to createdEarlier
export function touchKey(p: string, ci: boolean): string;          // ci ? lower : p
export function overlaps(a: string, b: string, ci: boolean): boolean;   // equal, or one is a "/"-prefix of the other
export const UNKNOWN_WRITES: unique symbol;                        // ⊤ marker used by edges/validate
```

### Candidate extraction from `body`

Inline code is the main carrier of paths; fenced lines are already blanked.
- backticked tokens;
- bare absolute paths `[A-Za-z]:[\\/]…`, `\\…`, `/…`;
- bare repo-relative tokens containing `/` or `\` and a file-ish last segment.

Rejected: tokens containing a space or with no separator and no extension (e.g. `## Implementation notes`, plan:2337).

### `normalizeRepoPath`, in order

| # | Input | Result |
|---|---|---|
| 1 | URL (`^[a-z][a-z0-9+.-]*://`), `file:` | `url` |
| 2 | `\\?\`, `\\.\`, `\??\` | `device` |
| 3 | UNC `\\host\share` | `unc` |
| 4 | drive-less rooted `\x` | `device` (TP:87-99) |
| 5 | absolute under a worktree root (segment boundary, case-folded if `caseInsensitive`, `path.win32` for drive paths) | `worktree`, rel = suffix (plan:2386) |
| 6 | absolute, other root | the longest suffix (fewest dropped leading segments) that is in `files` or `dirs` → `suffix` plus `foreignRoots` warning (dd:1251 `D:\git\opencode-model-router\src\index.ts` → `src/index.ts`); else `other-drive` or `outside` |
| 7 | relative with a separator | lexical resolve against the root; a `..` that escapes → `escape`; else `relative` |
| 8 | bare file name | `byBasename` with exactly one match → `basename`; more than one → `ambiguous` (plan:2389) |
| 9 | not in `files` or `dirs` | accepted only with `allowNew` and the parent dir in `dirs` or `createdEarlier` → `new`, else `not-found` |

- `allowNew` is true for Writes-line paths, `*(new)*` markers and create verbs (plan:2390).
- Glob tokens (`*?[]{}`) reduce to their static prefix, as `globPrefixes` does (TP:180-195), and are marked `dir: true`.
- Output: `/`-separated, no `.`/`..`, no trailing `/`, no `:` segment, no NUL. This is stricter than `isRepoPath` (T:730-733).
- Every `ok:false` result goes to `ignored` and then into `summary.warnings` as `path-ignored`.

### Write/read classification

D5 applies: a present `Writes:`/`Reads:` line is closed.

| Evidence | Access | Source | Confidence contribution |
|---|---|---|---|
| `Writes:` line paths | write | `writes-line` | explicit |
| `Writes: none` | — (writes `[]`) | `writes-line` | explicit |
| write verbs (only when there is no Writes line): `In \`X\`:`, implement, create, add (to), modify, update, replace, tests in, move, delete, within one clause before the path (≤6 tokens) | write | `path` | explicit |
| ownership row of the task's phase whose path the task mentions (only when there is no Writes line) | write | `ownership` | ownership |
| `Reads:` line paths | read | `writes-line` | — |
| other mentions (only when there is no Reads line) | read | `path` | — |

- A path that is both written and read is kept in `writes` only. Paths keep first-seen order and are deduplicated by `touchKey`.
- A read of the repository root (plan:2501 `Reads: D:\git\omr-cpx-p23\`) is dropped with an info warning. A read of the whole repo would serialize everything.
- **Editing** = `needs` contains `edit`; or `needs` is absent and the class is not review, design or search-like (confirm against `TASK_CLASSES`); or the task has any write evidence. Manual, preflight and qa tasks are never editing.

**Footprint confidence:**
- `explicit` if any writes-line or verb evidence;
- else `ownership` if any ownership write;
- else `unknown` if editing;
- else `inferred`.

**`lowConfidence`** = editing and (confidence ∈ {unknown, inferred}, or any write via `suffix`/`basename`). These tasks go into the residue request.

**Ownership rows that no task of the owner phase mentions** → residue candidate `ownership-unmatched`.

**Complexity:** O(|body|) per task plus O(1) set lookups. The suffix walk is O(depth).

## 5. `edges.ts` (2.3.4)

```ts
export class Reach {   // bitset transitive closure over tasks ∪ {gate:P}
  constructor(taskIds: readonly string[], phaseOf: (id: string) => string | null, phaseIds: readonly string[]);
  add(from: string, to: string): void;            // O(n²/32) worst case per edge
  reaches(a: string, b: string): boolean;          // O(1)
  concurrent(a: string, b: string): boolean;       // !reaches(a,b) && !reaches(b,a)
}
export interface EdgeTask { id: string; phase: string | null; kind: TaskKind; planIndex: number;
  writes: readonly string[] | typeof UNKNOWN_WRITES; reads: readonly string[];
  confidence: Footprint["confidence"]; isContract: boolean }
export function structuralEdges(p: ParsedPlan, tasks: readonly EdgeTask[], crossPhase: "gate" | "inferred"): Edge[];
export function graphEdges(p: ParsedPlan, tasks: readonly EdgeTask[]): { edges: Edge[]; warnings: CompileIssue[] };
export function explicitEdges(p: ParsedPlan, tasks: readonly EdgeTask[]): { edges: Edge[]; warnings: CompileIssue[] };
export function contractEdges(tasks: readonly EdgeTask[], reach: Reach, ci: boolean): Edge[];
export function conflictEdges(tasks: readonly EdgeTask[], reach: Reach, ci: boolean): Edge[];
export function minimalCycle(nodes: readonly string[], edges: readonly Pick<Edge, "from" | "to">[]): string[] | null;
export function buildEdges(p: ParsedPlan, tasks: readonly EdgeTask[], o: { crossPhase: "gate" | "inferred"; ci: boolean }):
  { edges: Edge[]; warnings: CompileIssue[] };   // throws E_CYCLE {cycle, evidence}
```

### Pass order (= precedence) and derivation

Edges are deduplicated by `${from}>${to}`; the first pass to produce a pair wins. Evidence format: `"<rule> L<line>: <excerpt ≤120>"`.

1. **structural** (confidence high, 2.3.4.a, plan:2410-2415)
   - `Depends on: P` → `gate:P → each source of the dependent phase`. Sources are its preflight items, else its tasks with no in-phase predecessor. `PhaseRecord.dependsOn` gets P.
   - **`Order:`** → complete bipartite edges between consecutive groups.
     - Preflight items → first group.
     - Last group → `<P>.QA` when QA is not in the chain.
     - Tasks not listed → stage edges plus warning `order-unlisted`.
     - A FIX item is contracted: preds(FIX) → succs(FIX). After-QA items → D3.
   - **No `Order:` line** → stages: preflight → every `task` source; `task` sinks → `tests` sources; sinks → QA.
   - **`crossPhase: "gate"`:** for each wave k > 0, `gate:P → sources(Q)` for every non-dogfood P in wave k-1 and every Q in wave k.
   - **`"inferred"`:** no wave edges.
2. **graph** (high, plan:2419). Task→task gives a task edge. Phase→phase gives a `dependsOn` entry plus gate edges as in Depends on. Wave-heading arrows are included.
3. **explicit** (plan:2416-2418)
   - **Phrases** (case-insensitive): `after`, `starts after`, `depends on`, `requires`, `blocked by`, `once … is merged`, `merged first`, `merges`, `builds on`, `codes against`, `uses the API from`.
   - They must be followed within the same clause (up to `;`, `. `, or 160 chars) by **full** ids. Bare `QA`/`FIX` never count, so plan:2414 "FIX steps come after QA" in 2.3.4's own text yields nothing.
   - Phrases inside quotes ("…", “…”) or inline code are skipped. A task's own id is ignored.
   - **Subject:** the task (task text), the phase's sources (phase intro or ownership cell), or every phase of the wave (wave heading).
   - **Refs:**
     - a task id → `ref → subject` (high);
     - a phase id or `Phase X.Y` → `gate:X.Y → subject` (high when "merged" appears, else medium) — dd:1067 "starts after Phase 1.1 is merged" → `gate:1.1 → 1.3.4`;
     - `merged first` in a wave heading (rt:570) → the contract tasks (pass 4 rule) of the named phases → every task of other phases in the wave that touches their writes (medium). With no detectable contract task, it becomes a residue candidate instead.
   - An unknown ref → warning `explicit-ref-unknown`. A cycle → D6.
4. **contract** (medium, 2.3.4.c, plan:2420-2421)
   - `isContract` = title matches `\b(contract|interface|types?|schema)\b` plus a write verb, or the task writes `types.ts`, `*.d.ts`, `schema*` or `contract*`.
   - For c and t in the same phase with `reach.concurrent(c, t)` and `writes(c) ∩ (reads(t) ∪ writes(t)) ≠ ∅` → `c → t`, regardless of plan order.
5. **conflict** (2.3.4.d, plan:2422-2423)
   - For v in plan order, then u < v, both launchable (task, tests, fix, qa), `reach.concurrent(u, v)` and an overlap (W∩W, W∩R, R∩W, using `overlaps()`, with ⊤ overlapping everything) → `u → v`.
   - Confidence: high when both sides are explicit or ownership, medium when inferred, low when ⊤.
   - Evidence example: `conflict: write/write src/index.ts`.
   - qa reads do not take part, because a review runs on a fixed commit (anti false-serialization).
   - Candidate pairs come from a path index: each path keyed under itself and its ancestor dirs, plus the ⊤ list. Cost is O(Σpaths·depth + candidate pairs) instead of O(n²·P).
6. **llm** (residue, §6) and **learned** (runtime, T:1514) are never produced by `compile`.

`reach.add` runs after each accepted edge. Passes 4-5 add only concurrent pairs in plan order, so they cannot create cycles.

**Cycle check** after passes 1-3: Tarjan SCC in O(V+E). For each non-trivial SCC, BFS from every member inside the SCC, keeping the shortest cycle, in O(k·(k+e_k)). The result is `E_CYCLE {cycle:[ids], evidence:[…]}`; gate nodes are shown as `gate:P`.

**Overall:** O(V·E/32 + candidate pairs). 300 tasks is well under 2 s.

## 6. `residue.ts` (2.3.5)

```ts
export const RESIDUE_SCHEMA: JsonValue;
export function residueTaskIds(draft: LedgerV1): TaskId[];   // pure from the draft (route.line → editing; confidence)
export function residueRequestOf(draft: LedgerV1, candidates: readonly ResidueCandidate[]):
  { prompt: string; schema: JsonValue; taskIds: TaskId[] } | undefined;
export interface ResidueCandidate { from: string; to: string; why: string }
export function parseResidue(text: string): unknown;                 // last ```json block, else the whole text (as T:1150-1151)
export function validateResidue(draft: LedgerV1, v: unknown):
  { ok: true; value: ResidueResponse } | { ok: false; code: string; at: string; detail: JsonValue };
export function mergeResidueInto(draft: LedgerV1, r: ResidueResponse): LedgerV1; // monotone; conflicts recomputed by caller
```

**Request** (2.3.5.a).
- **Task set:** `residueTaskIds` = editing tasks with confidence ∈ {unknown, inferred}, or with suffix/basename-mapped writes.
- **Candidate edges:**
  - consecutive hash-id steps in the same phase (unannotated plans);
  - unresolved phrase or graph refs;
  - `merged first` with no contract task;
  - `ownership-unmatched`;
  - concurrent same-phase pairs where v mentions u's id or a path u creates without a Reads line.
- Capped at 60 tasks and 120 candidates. Anything over the cap stays ⊤ (warning `residue-capped`).
- **Prompt:**
  - Line 1 is a route line: `[route class=design risk=medium scope=multi d=none root=<toplevel> tier=heavy pin]`. Use `root="…"` when the path contains spaces (RL:40); it must pass `isWorkRootPath` (RL:60).
  - Then `Writes: none.`
  - Then the request JSON `{requestDigest, tasks:[{id,title,kind,phase,routeLine,footprint,excerpt≤1500}], candidates}`.
  - Then the schema and the rules: repo-relative `/` paths only; restate the full footprint; return `DONE:` and one ```json block.
- `requestDigest` = first 16 hex of `sha256(planDigest + "\n" + taskIds.join(","))`, recomputable from the draft.

**`RESIDUE_SCHEMA`** (`additionalProperties: false` at every level):

```json
{"type":"object","required":["requestDigest","footprints","edges"],
 "properties":{
  "requestDigest":{"type":"string","pattern":"^[0-9a-f]{16}$"},
  "footprints":{"type":"array","items":{"type":"object","required":["taskId","writes","reads","evidence"],
     "properties":{"taskId":{"type":"string"},"writes":{"type":"array","items":{"type":"string","minLength":1}},
       "reads":{"type":"array","items":{"type":"string","minLength":1}},"evidence":{"type":"string","minLength":1,"maxLength":300}}}},
  "edges":{"type":"array","items":{"type":"object","required":["from","to","confidence","evidence"],
     "properties":{"from":{"type":"string"},"to":{"type":"string"},"confidence":{"enum":["medium","low"]},
       "evidence":{"type":"string","minLength":1,"maxLength":300}}}},
  "noChange":{"type":"array","items":{"type":"string"}}}}
```

**Validation** (2.3.5.b). Each failure → `E_RESIDUE` with detail `{code, at, …}`, and the first failure wins.

| Code | Trigger |
|---|---|
| `residue-json` | no parseable JSON (including `ESCALATE:`/`NEED MORE:` answers) |
| `residue-delete` | any key `/^(remove|delete|drop)/i` or an `op` field anywhere — checked before the schema so the error is precise |
| `residue-schema` | `at` = JSON path |
| `residue-digest` | `requestDigest` mismatch |
| `residue-unknown-task` | `taskId`/`from`/`to` not in the draft; `from` may be `gate:<existing phase>` |
| `residue-weaken` | (a) a footprint entry for an `explicit`/`ownership` task that differs in any way ("changes a write set"); (b) an entry whose `writes`/`reads` omits any existing path; detail lists the missing ones |
| `residue-path` | a path that is not repo-relative after lexical normalization against `repo.toplevel`/`integration.worktree` (`..`, another drive, UNC, device, URL, `:`), checked synchronously with no git |
| `residue-cycle` | the merged edges contain a cycle; detail = minimal cycle |

**Merge** (2.3.5.c). For each entry:
- `writes = old ∪ new` and `reads = old ∪ new`;
- `sources += "llm"`;
- confidence `unknown → inferred` (never any other change);
- `noChange` ids: `unknown → inferred` with no paths, i.e. confirmed non-writing.

Edges are added as `{kind:"llm", confidence: min(given, "medium"), evidence:"residue: …"}`. A pair that already exists is skipped.

`index.mergeResidue` then:
1. drops the old `conflict` edges and recomputes them with `conflictEdges` on the merged footprints (D4);
2. runs `validate`; any error → `E_RESIDUE {code:"residue-invalid", violations}`;
3. sets status to `awaiting-approval`.

The returned `seq` is ignored (QA14:955).

## 7. `validate.ts` (2.3.6.a)

```ts
export const VALIDATION_CODES: readonly string[];
export function validateLedger(l: LedgerV1): Array<{ code: string; message: string; taskIds: TaskId[] }>;
```

`validateLedger` returns errors only; warnings stay in `summary.warnings`.

| Code | Rule |
|---|---|
| `ledger:<c>` | every `ledgerViolations(l)` entry (T:909), `taskIds` from `at` |
| `cycle` | minimal cycle (§5) over tasks ∪ gate nodes, including the implicit `t → gate:phase(t)` |
| `id-unknown` | an edge endpoint is not a task or `gate:<phase>` (pre-empts `edge-endpoint`) |
| `id-duplicate` | task ids equal after case folding |
| `id-invalid` / `id-reserved` | §3 |
| `path-outside` | a footprint path fails §4's output rules (stricter than `isRepoPath`; e.g. `D:/x` passes T:730-733) |
| `closure` | two tasks not in {done, cancelled, integrated}, with no path either way, whose W∩W or W∩R is non-empty (⊤ overlaps everything; qa reads excluded) |
| `qa-multiple` (A1-12) | a phase with more than one live (not done/cancelled) `kind:"qa"` task; at compile, more than one plan-authored qa task per phase |
| `shared-context-header` (A1-12) | `LAUNCH_HEADER_PATTERN` matches a line of `sharedContext` (T:1069-1070, T:1093) |

**Complexity:** reach O(V·E/32). Closure uses the §5 path index.

## 8. `estimate.ts` (2.3.6.b)

```ts
export const INTEGRATION_ESTIMATE_MS = 60_000;  // prior until 3.2 records integration timings
export function taskEstimate(m: DurationModel, t: { kind: TaskKind; state: TaskState; role: string;
  tier: Tier | null; route: RouteLine | null }): TaskNode["estimate"];
export function planEstimate(l: Pick<LedgerV1, "tasks" | "edges" | "phases">, maxParallel: number):
  Pick<CompileSummary, "workMs" | "criticalPathMs" | "width" | "expectedMakespanMs">;
export function formatSummary(s: CompileSummary): string;
```

**Per task.**
- Query `{role: role || tier || "unknown", class: route?.class ?? "other", scope: route?.scope ?? "single"}`.
- Use `m.estimate` (DUR:183-207), whose fallback chain is exact → role-class → role → prior 480 000 ms (DUR:11-13, DUR:33).
- `estimate = {p50, p90, source: p90Source === source ? source : `${source}/p90:${p90Source}`}`. DUR guarantees p90 ≥ p50 (DUR:201).
- manual/preflight → `{0, 0, "manual"}`, listed in `summary.manual`.
- `done` → `{0, 0, "done: merged before the run"}`.

**Plan level.**
- **W** = Σ p50 over pending launchable tasks.
- **CP** = max bottom level, `bl(t) = p50(t) + max(0, bl(succ))`, in reverse topological order over tasks ∪ gate nodes. Gate nodes cost 0. O(V+E).
- **width** = peak concurrency of the ASAP schedule with unbounded workers (sweep over [es, es+p50)). O(V log V).
- **p_eff** = `min(maxParallel, max(1, width))`.
- **ΣI_est** = `INTEGRATION_ESTIMATE_MS × #launchable`.
- **makespan** = `max(CP, W / p_eff, ΣI_est)` (plan:2464).

`DurationModel.load()` is awaited once in `compile`. If more than half the tasks use `prior`, warning `estimate-prior`.

`formatSummary` example: `plan <id>: 57 tasks · 9 phases · 140 edges · W 7.6h · CP 3.1h · width 6 · ≈3.1h (p=4) · manual 5 · 3 warnings`.

## 9. `index.ts` (2.3.6.c)

### compile(planPath, opts)

1. **Input checks.**
   - `planPath` is not absolute → `E_INVALID_INPUT`.
   - `opts.config` must pass the shape check and `EXECUTOR_LIMITS` (T:292-300); `opts.now` must be ISO with milliseconds. Otherwise `E_INVALID_INPUT`.
   - The config is deep-copied.
2. **Read and parse:** read, `planDigest = sha256(text)`, `loadRepoView`, `parsePlan`, `annotateUnrouted`.
3. **Selection.**
   - Every id in `opts.phases` must exist and must not be a DF phase; `doneBefore` must exist. Otherwise `E_INVALID_INPUT`.
   - **Earlier** = phases before `doneBefore` in plan order.
   - **Materialized tasks** = the selected phases (all non-DF phases plus DF phases when `phases` is absent; post phases follow their parent).
   - A `dependsOn` entry (including a DF external gate) that is neither selected nor earlier → `E_INVALID_INPUT`.
4. **Footprints** in plan order (with `createdEarlier`), then **edges**.
5. **doneBefore projection** (plan:2466-2469).
   - Materialized tasks of earlier phases → `state: "done"` with the done estimate.
   - An edge whose source is a non-materialized task of earlier phase E becomes `gate:E → to`, keeping kind and confidence, evidence prefixed `via gate:E;`. Edges between non-materialized tasks are dropped.
   - `phases` = selected ∪ earlier. Earlier gates are `passed`; the others are `pending`. `qaRound: 1`, `paused: false`, `tag: null`.
   - `waves` = only waves that contain included phases.
6. **Estimates**, then the **residue** request. Status is `awaiting-residue` iff there is a request, else `awaiting-approval` (T:1360).
7. **Assemble the draft:**

```ts
{ schema: 1, planId, planPath, planDigest,
  repo: { key: realpath(git-common-dir), toplevel, baseBranch, baseCommit },
  integration: { branch: `omr/${planId}/integration`, worktree: deps.integrationWorktree(planId, repo), head: baseCommit },
  launcher: "A", status, orchestrator: { sessionID: opts.orchestratorSessionID, boundAt: opts.now },
  config, sharedContext, waves, phases, tasks, edges, inbox: [], seq: 1 }
```

   - **TaskNode** (T:108-128):
     - `route = {line: route?.line ?? "", role, tier, pin}`; manual/preflight get `{"", "", null, false}`;
     - `verify`: an explicit directive wins; else `required` if there is an acceptance block or `d ≠ none`; else `none` plus warning `unverified-task`; manual/preflight/qa → `none`;
     - `attempts: []`, `slot`/`branch`/`integrated` null;
     - `text` verbatim. 3.1.4 must rewrite worktree paths to the slot path; that is a handoff.
   - **planId** = slug of the basename (lowercase, `[^a-z0-9]+` → `-`, trimmed), plus `-<slug(phases)>` when `phases` is given. If it exceeds 41 chars, cut it to 34 and add `-` and 6 hex of its sha1. It must match T:24.
8. **Self-check:** `validateLedger(draft)` and `ledgerViolations(draft)` must both be `[]` and `seq === 1`. Otherwise `E_COMPILE draft-invalid` with the violations; this is a bug guard.
9. **Errors:** `E_COMPILE` with `{code, line}`, `E_CYCLE`, `E_INVALID_INPUT` (T:1361).

### addTasks(ledger, text)

- `parsePlan` in fragment mode: no waves; the phase comes from the heading or the id prefix and must exist.
- New ids must be absent from the ledger → else `E_INVALID_INPUT`.
- Footprints use the lexical-only normalizer (no RepoView: sync).
- Edges: structural, explicit and graph among the new tasks and their references; then conflict edges with existing non-terminal tasks first in plan order.
- `reopened` = `ready` tasks that are now the target of an unsatisfied new edge.
- Errors: `E_CYCLE`, `E_INVALID_INPUT`.

`validate` = `validateLedger`.

## 10. Tests and frozen fixtures (2.3.7)

**Freeze (once, by the implementer; never done by a test).** Copy byte for byte from `D:\git\omr-cpx-p23\docs\plans\` to `test\fixtures\cpx\plans\`:
- `critical-path-execution-plan.md`
- `delegation-depth-and-effort-bump-plan.md`
- `role-tier-assurance-delegation-plan.md`
- `verification-resource-budget-plan.md`

Next to them:

| File | Content |
|---|---|
| `MANIFEST.json` | `{name, source:"docs/plans/<name>", commit, sha256, bytes}` |
| `counts.json` | hand counts per plan and phase: tasks incl. PF/DF/synth QA/TESTS, excl. FIX templates; preflight; qa; manual; phases; waves; plus the expected explicit edges and, for the cpx plan, the §3.1 phase graph and every Order edge |
| `repo-view.json` | frozen `toplevel`, `worktrees`, `files` (`git ls-files` at freeze time), `caseInsensitive` |
| `synthetic\` | `unannotated-flat.md`, `headings-only.md`, `nested-subtasks.md`, `fences-with-items.md`, `inline-code-paths.md`, `separators.md`, `other-worktrees.md`, `other-drive.md`, `cycle.md`, `duplicate-ids.md`, `post-qa-order.md`, `ownership-file-major.md`, `ownership-phase-major.md`, `graph-arrows.md` (`->`, `→`, `-->`, mermaid), `contract-first.md`, `df-switch.md`, `unclosed-fence.md`; `residue-{valid,delete,weaken-writeset,weaken-omit,escape-dotdot,other-drive,unc,cycle,unknown-id,stale-digest}.json` |
| `.gitattributes` | `test/fixtures/cpx/plans/** -text`, so autocrlf does not change sha256 values or line numbers |

**Hermeticity.**
- One loader resolves names from `import.meta.url` into the fixtures dir and rejects any other path.
- A pin test checks that every fixture's sha256 equals `MANIFEST`.
- A pin test checks that no `test\unit\executor-compile-*.test.ts` contains `docs/plans` or `docs\\plans`.
- Git and FS are stubbed from `repo-view.json`. `annotate`, `roleOf` and `durations` are stubbed.

**Mapping of the New tests (plan:2521-2551) to files.**
- **`executor-compile-parse.test.ts`:**
  - every id form (plan:2347) and that every cpx id is recognized;
  - backticked and plain tags give equal results;
  - fences and inline code;
  - nested subtasks; headings only; unannotated flat list;
  - inserting lines above a task, and re-annotating, leaves ids unchanged;
  - `unclosed-fence` → `E_COMPILE`;
  - D11 cut; plan-context block;
  - header-line removal.
- **`executor-compile-footprint.test.ts`:**
  - cpx footprints equal the Writes/Reads lines;
  - `omr-cpx-main` and `omr-cpx-p23` paths → repo-relative;
  - both separators;
  - another drive / UNC / device / URL / `..` → ignored and reported;
  - unique and ambiguous basenames; `(new)` files;
  - ≥80% of editing tasks in the real plans have writes;
  - win32 parity with `toolTargets` (`skipIf` not win32).
- **`executor-compile-edges.test.ts`:**
  - cpx Depends on and Order give exactly `counts.json`;
  - dd:1067 → `gate:1.1 → 1.3.4`;
  - the verification plan's graph block;
  - FIX contraction and the post-QA phase;
  - contract-first;
  - conflict in plan order; no false edge for disjoint footprints;
  - cycle → `E_CYCLE` with the minimal cycle;
  - an explicit-phrase cycle is dropped and reported.
- **`executor-compile-residue.test.ts`:** every residue fixture → its exact `E_RESIDUE` code; a valid residue merges monotonically and turns ⊤ into concrete writes; re-validation passes.
- **`executor-compile-real-plans.test.ts`:**
  - counts equal the hand counts;
  - `isLedgerV1(draft)` and `draft.seq === 1` on every fixture;
  - the closure holds on every fixture;
  - `phases:["6.1"]`, `doneBefore:"6.1"` → exactly 6.1.1–6.1.5 and 6.1.QA plus the `6.1.PF<k>` preflight tasks; 6.1.4 is `manual`; every incoming edge of a PF is satisfied (the source is done or its gate passed, mirroring T:1505-1507); 6.1.1's unsatisfied incoming edges are exactly its PFs;
  - a 300-task synthetic plan, generated in the test with a fixed seed, compiles in under 2 s;
  - estimate and summary.

These files also cover `validate`, `estimate` and `index`, so the `src/executor` coverage gate is met without adding files beyond 2.3.7's Writes list.

## 11. Options weighed (recommendation first)

- **Unknown footprints:** ⊤ plus recomputed conflicts *(recommended)* vs. skipping the closure until the residue arrives. The latter leaves drafts that are not closure-safe, and the residue cap could leak ⊤ tasks through.
- **FIX template:** re-derive from the plan *(recommended)* vs. a fake `done` node (pollutes counts and boards) vs. a new ledger field (lost on `draft-replaced`).
- **Post-QA tasks:** a synthetic `.post` phase *(recommended)* vs. leaving them in P (deadlock) vs. rejecting the plan (the cpx plan itself fails at plan:4089).
- **Explicit prose cycles:** drop and warn *(recommended)*; failing would break real plans on prose false positives, and dropping leaves an order, not a race.
- **Phase dependency encoding:** gate edges *(recommended; minimal edge count, matches "is merged")* vs. edges from every task of P (O(|P|·|Q|) edges, and they ignore QA).

## 12. Open items and handoffs

- **O1 (contract gap, owner decision).** `integration.worktree` must be absolute (T:931) and no event can change it after `ledger-init`: `draft-replaced` and `plan-approved` exclude it (T:608-610). So `compile` needs the final path, via the `integrationWorktree` seam from 2.4's slot-path function.
- **O2.** 2.3.3 must read the 1.3 registry (`src\router\leases.ts`) and confirm it supports directory-prefix leases. If it does not, `dir: true` writes must be expanded to matching `files` (≤50, else ⊤).
- **O3.** `roleOf`: confirm the class→role mapping against `docs\ROLES.md` and the roles policy. `AnnotatedStep` has no role (PL:387-401).
- **O4.** The hand counts and the verification plan's graph block (≈473-482) were not read here (call cap). They are produced at freeze time into `counts.json` (plan:2311-2316).
- **O5.** D3 depends on 3.2's §3.3 phase-integrated precondition. Confirm before 2.3.4 merges.
- **O6.** Presence of `verification-resource-budget-plan.md` in p23 `docs\plans\` was not confirmed; my grep output was cut off. If it is missing, the freezer reports `NEED MORE`.
- **Handoffs:**
  - 3.1.4: rewrite worktree-root paths in `task.text` to the slot when rendering through `formatLaunchPrompt`.
  - 4.2: read `fixTemplate` via `parsePlan`.
  - 3.1 and 4.1: edges depend on `crossPhase`. If approval changes it, recompile and journal `draft-replaced`.

## Findings

| Round | Findings | Status |
|---|---|---|
| 1 | 17 (QA-2.3-1 to -17) | Fixed in `fa8da92` (the commit lists the fixes by topic, not by id). |
| 2 | 15 (QA-2.3-18 to -32) | Fixed in `6ee2f6a` (names -18 to -27 and -29 to -32; -28 is not named in the commit message); coverage follow-up `3872d0a`. |
| 3 | 1 (major) | QA-2.3-33: fixed in commit `6d1c994`. |

Round 3 closed with no open finding.

## Fixes

- QA-2.3-33 (round 3, major): fixed in commit `6d1c994`.
- Round 1, `fa8da92`: unresolved writes kept or made top, addTasks resolves ledger references and rejects out-of-repo writes and passed gates, corrected ownership fallback, residue limited to asked tasks, exact real-plan assertions, linear top conflicts, dependency clauses, metadata-block ids, inline-code labels, commented graphs, case flag per repository, more write verbs, normalized residue comparison, directory keys, input validation and plan ids.
- Round 2, `6ee2f6a`: writes only from real write evidence (-18), added tasks inherit their phase's prerequisites (-19), reads of untracked files (-20), run-scoped references (-21/-25/-26), addTasks fails closed on unresolved references (-22), URLs never written (-23), exact Order edges (-24), clause ends and labels (-27/-31), case flag in merged-first (-29), ownership rows for new dirs (-30), contract detection on files only (-32); `3872d0a` covers the remaining branches.
- Coverage top-up, commit `ca5cb81` (tests only): `estimate.ts` branches were 81.25 and `index.ts` branches 87.3 before it; both now pass the gate (see Coverage).

## Coverage

Orchestrator, 2026-10-12: `npx vitest run --coverage` on `test/unit/executor-compile*`; 570 tests passed. CI gate per file: 90/90/90 on `src/executor/`.

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `edges.ts` | 99.16 | 93 | 100 | 100 |
| `estimate.ts` | 100 | 97.5 | 100 | 100 |
| `footprint.ts` | 97.3 | 93.51 | 100 | 98.86 |
| `index.ts` | 97.69 | 92.46 | 97.97 | 99.58 |
| `parse.ts` | 96.45 | 90.09 | 100 | 98.32 |
| `residue.ts` | 99.77 | 98.93 | 100 | 100 |
| `validate.ts` | 96.85 | 90.44 | 100 | 97.93 |

- Every file is above the gate.
- Thin margins over the 90 gate: `parse.ts` branches at 90.09 and `validate.ts` branches at 90.44. A small change in either file can drop it below the gate.
- The top-up commit `ca5cb81` (tests only) raised `estimate.ts` branches from 81.25 and `index.ts` branches from 87.3.

## Approved extensions

- Ownership fallback is reported as `inferred` plus an `ownership-assumed` diagnostic.
- New files in another worktree.
- Synchronous `addTasks`.

All three are covered by plan amendment A-2.3-1.

## Deferred findings

- No finding is deferred to a later phase. Items for later phases are listed under Handoffs.

## Handoffs

- 3.1.4: rewrite worktree-root paths in `task.text` to the slot when rendering through `formatLaunchPrompt`; path rewrite.
- 4.2: read `fixTemplate` via `parsePlan`.
- 3.2: `.post` phases (the synthetic `.post` phase for post-QA tasks, design memo §11).
- 3.1 and 4.1: edges depend on `crossPhase`. If approval changes it, recompile and journal `draft-replaced`.

## Plan amendments

- **A-2.3-1** covers the approved extensions: the `inferred` ownership fallback with the `ownership-assumed` diagnostic, new files in another worktree, and synchronous `addTasks`. The orchestrator applies it in `cpx/main`.

## Verdict

Done, pending merge into `cpx/main`.
