import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  ROUTING_DEFAULTS,
  ROUTING_ENGINES,
  ROUTING_TASK_CLASSES,
  configuredV2OnlyKeys,
  resetRoutingWarnings,
  resolveRolesRouting,
  resolveRouting,
  validateConfig,
  ROLE_NOTICE_PREFIX,
} from "../../src/router/config";
import {
  AUTHORITY_ACTIONS,
  DEFAULT_REPO_APPROVAL_DAYS,
  EXPLORATION_MAX_RATE,
  REPO_APPROVAL_CAP_DAYS,
  ROLES_V1_NOTICE,
  RUN_TIMEOUT_BOUNDS,
  sanitizeExploration,
  sanitizeRun,
  workRootProblem,
} from "../../src/router/roles-config";
import { ACTION_CLASS, CONTRACT_HEADING, DEFINING_CLASS, HOST_NATIVE_ROLE_NAMES, SHIPPED_ROLE_SPECS, WORK_ROOT_RULE } from "../../src/router/roles";
import type { AuthorityAction, RoleSpec } from "../../src/router/roles";
import { ROLE_DENIED_ACTIONS, ROLE_STEPS_MARGIN, roleAgentSteps } from "../../src/router/role-agents";
import { GUARD_CUMULATIVE_MULTIPLIER, REFUSAL_CAP, roleGuardProfile, ROUTE_BUDGET_RAISE_MAX, TIER_GUARD_BUDGET } from "../../src/router/guard-profile";
import { DEFAULT_RUN_TIMEOUT_MS, RUN_ARG_RE, RUN_MAX_ARGS, RUN_OUTPUT_BYTES } from "../../src/router/run-tools";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import { authorityFloor, effectiveDetection, GRANT_NOTES } from "../../src/routing/roles/policy";
import { REDISPATCH_WINDOW_MS, runSignal, SIGNAL_MASS_CAPS, SIGNAL_WEIGHTS } from "../../src/routing/outcomes/signals";
import { CRITERIA_BUDGET_CHARS } from "../../src/verify/dod";
import { FOREIGN_REFERENCE_NONE } from "../../src/verify/deterministic";
import { RENDERED_REASONS_MAX } from "../../src/verify/dispatch";
import { GRADER_REASONS_MAX } from "../../src/verify/checker";
import { oneLineReason } from "../../src/routing/roles/authority";
import { PLAN_HELP_LINES } from "../../src/commands/output";
import { ROUTER_PLAN_ACTIONS } from "../../src/executor/tool";
import { EXECUTOR_HOME_DIRNAME } from "../../src/executor/paths";
import { defaultSlotsDir } from "../../src/executor/slots/pool";
import { EXECUTOR_INSTRUCTIONS_ORDER } from "../../src/executor/instructions";
import { PLAN_PROVIDER_ORDER } from "../../src/compat/turn-state";
import { EXECUTOR_DEFAULTS, EXECUTOR_LIMITS, INBOX_ID_PREFIX, QA_ROUND_LIMIT } from "../../src/executor/types";
import { breakerTrips, INBOX_TEXT_MAX } from "../../src/executor/unattended";
import { RECOVERY_LIVENESS_MS, RECOVERY_POLL_MS } from "../../src/executor/recovery";
import {
  PLAN_TASK_CHECKS_MIN_MS, PLAN_TASK_GRADER_SLACK_MS, PLAN_TASK_TRANSIENT_RERUNS, PLAN_TASK_RERUN_BACKOFF_MS,
  planTaskChecksBudgetMs, planTaskGraderBudgetMs,
} from "../../src/verify/plan-task";
import { CREDENTIAL_ENV_RE } from "../../src/router/run-tools";
import { APPROVAL_RELOAD_APPLIES, ROLES_RESTART_NOTICE } from "../../src/compat/v2-hooks";
import { approvalReloadLine } from "../../src/commands/approvals";
import { ROUTER_APPROVAL_HELP_LINES } from "../../src/commands/output";
import { APPROVALS_FILE_NAME, APPROVE_MAIN_WORKTREE, MAX_APPROVALS, MAX_APPROVALS_BYTES, type inspectCandidate } from "../../src/routing/roles/approvals";
import { buildRoleDispatchHeader } from "../../src/router/dispatch-header";
import { parseJsonc } from "../../src/router/jsonc";
import { FINDING_IDS } from "../../src/routing/advisor/findings";
import { runAdvisor } from "../../src/routing/advisor";
import { buildLadder, buildRoleLadder, resolveChosen } from "../../src/routing/engine/ladders";
import { APPROVAL_NOTE_TIMEOUT_MS, approvalNote, createDispatchRouter, resetDispatchRouting } from "../../src/routing/wire/dispatch";
import { createEngineRuntime } from "../../src/routing/wire/runtime";
import { resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import {
  GIT_ROOT_MAX_LENGTH, GIT_ROOT_OUTSIDE_PLACEHOLDER, GIT_ROOT_PROVENANCE_PREFIX, GIT_ROOT_PROVENANCE_SUFFIX, GIT_ROOT_TEXTS, GIT_ROOT_TOO_LONG, gitRootCappedNote,
} from "../../src/routing/roles/git-root";
import { LOOKUP_MAX_DIRS } from "../../src/routing/roles/admission";
import {
  EDGE_EXTENDS_DEPTH_MAX, EDGE_EXTENDS_ENTRIES_MAX, EDGE_FILE_BYTES_MAX, EDGE_FILES_MAX, EDGE_OVERRIDES_DEPTH_MAX, EDGE_SPEC_MAX, EDGE_TSCONFIG_VARIANTS_MAX,
  EDGE_VIAS, EDGE_WORKSPACE_ENTRIES_MAX, EDGE_WORKSPACE_PATTERNS_MAX, EDGE_WORKSPACES_MAX, EDGES_MAX, PACKAGE_EDGE_FIELDS, PACKAGE_EDGE_PROTOCOLS,
  SITE_PACKAGES_ENTRIES_MAX, SITE_PACKAGES_FILES_MAX, TSCONFIG_EDGE_KEYS,
} from "../../src/verify/edges";
import { EDGE_NAME_MAX, EDGE_UNADMITTED_NAMES_MAX, EDGE_WALK_MAX, PERIMETER_MAX } from "../../src/verify/perimeter";
import { classifyTrivial, createSessionStore, DEFAULT_TIER_CAPS, resetDispatchRegistry } from "../../src/router/sessions";
import { candidateKey, decide, MAX_EXPLORATION_RATE } from "../../src/routing/engine/kernel";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { advance, buildEscalatePolicy, newLadderState, nextAction, recordAttempt } from "../../src/escalate/ladder";
import type { HostAgentInfo } from "../../src/routing/engine/types";
import {
  FLOOR_LIFT_REASON, RESUME_NAMED_NEEDS_REASON, RESUME_NAMED_NEVER_DOWN_REASON, RESUME_PINNED_REASON, RESUME_REASON, RESUME_RUNNING_REASON,
} from "../../src/routing/outcomes/types";
import { DECISIONS_MAX_BYTES, DECISIONS_MAX_GENERATIONS, FLUSH_MIN_INTERVAL_MS, FLUSH_BATCH_ROWS, MAX_QUEUED_ROWS, MAX_CORRUPT_COPIES, RENAME_RETRY_DELAYS_MS, STALE_TMP_MS } from "../../src/routing/outcomes/types";
import { LOCK_STALE_MS } from "../../src/routing/file-lock";
import type { Detection, Need, Risk, Scope, TaskFacts } from "../../src/routing/classify/types";
import {
  assembleSystemPrompt,
  buildDelegationProtocol,
} from "../../src/router/protocol";
import type { RouterConfig } from "../../src/index";
import {
  childStatus, DEFAULT_EFFORT, DEFAULT_STATUS_OPTIONS, effectiveMainEffort, FALLBACK_AGENT, formatRow, MAX_ROWS_MAX, MAX_ROWS_MIN, parseOptions,
  ROW_SEPARATOR, runningChildren, STATUS_NOTICE_PREFIX, STATUS_OPTION_KEYS, UNKNOWN_MODEL,
} from "../../src/tui/status-model";
import { effortRpc } from "../../src/tui/effort-rpc";
import statusPlugin, {
  appliedOf, BACKOFF_MAX_MS, BACKOFF_START_MS, COMPOSER_SLOT, effortWithVariant, FAILURE_COOLDOWN_MS, FOOTER_SLOT, NO_OWNER_NOTICE,
  POLL_INTERVAL_MS, PULL_STATE_MAX, QUICK_REPULLS, STATUS_PLUGIN_ID, WIDTH_MARGIN,
} from "../../src/tui/plugin";
import tuiEntry from "../../tui";

// `src/tui/plugin.ts` imports `@opentui/solid`, which only the OpenCode host serves. The TUI status pins call `setup` and
// never render, so the three reconciler primitives are stubs here (`test/unit/tui.plugin.test.ts` renders for real).
vi.mock("@opentui/solid", () => ({ createElement: () => ({}), insert: () => undefined, setProp: () => undefined }));

/**
 * Documentation-drift guards.
 *
 * These assert that two things the docs claim stay true of the shipped code:
 * every top-level key of `tiers.json` and selected nested enforcement keys are
 * described in the config reference, and
 * the README quotes the prompt sizes that the golden snapshots actually produce.
 *
 * Both fail on ADDITION, which is the point. Adding a config key or growing the
 * protocol should force the corresponding doc edit in the same change, rather
 * than leaving the docs to rot until someone notices.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf-8");

describe("role dispatch header docs (P2g, OD6)", () => {
  const flat = (path: string) => read(path).replace(/\s+/g, " ");

  it("ROLES.md quotes the rendered location paragraph of the role header", () => {
    const header = buildRoleDispatchHeader({
      agent: "implementer", workRoot: "ROOT", edits: true, location: { name: "app-a", branch: "feat/login", head: "3f2c1a9deadbeef" },
    });
    const paragraph = header.split("\n\n")[1]!.replace("ROOT", "<root>");
    expect(paragraph).toBe("Working directory: <root> (repository app-a, branch feat/login at 3f2c1a9). You are already there — do not ask permission to read or write inside it.");
    expect(flat("docs/ROLES.md")).toContain(paragraph);
    expect(flat("docs/ROLES.md")).toContain("`[router] You are @<role>. Execute this dispatch yourself.`");
  });

  // QA-SYNC1-11: a role child never sees `root=`; the rule names the router's line and ENVIRONMENT, and ROLES.md quotes it.
  it("ROLES.md quotes the work-root rule's precedence sentence word for word", () => {
    const sentence =
      "The router's `Working directory:` line and the work root in this dispatch's ENVIRONMENT win over the working directory in the host's environment block.";
    expect(WORK_ROOT_RULE).toContain(sentence);
    expect(WORK_ROOT_RULE).not.toContain("root=");
    expect(flat("docs/ROLES.md")).toContain(`the role prompt says: "${sentence}"`);
  });

  it("no doc still says the header is built for tier dispatches only", () => {
    const roles = flat("docs/ROLES.md");
    expect(roles).not.toContain("built for tier dispatches only");
    expect(roles).not.toContain("learns its location from refusals");
    const design = flat("docs/design/cross-repo.md");
    expect(design).not.toContain("Header only for tier dispatches");
    expect(design).not.toContain("Role dispatches get no header");
    expect(design).not.toContain("headers are built only for tier dispatches");
  });

  it("dispatchHeader: false also turns off the role header (CONFIG_REFERENCE and ROLES)", () => {
    expect(flat("docs/CONFIG_REFERENCE.md")).toContain("`dispatchHeader: false` also turns off the role header");
    expect(flat("docs/ROLES.md")).toContain("or `dispatchHeader: false`");
  });

  // Q8 (D14): the role header follows I9 — only when relevant.
  it("the role header is emitted only when relevant (ROLES, CONFIG_REFERENCE, design, CHANGELOG)", () => {
    expect(flat("docs/ROLES.md")).toContain(
      "The header is emitted only when cross-repo is configured (`routing.repoParents` is set), the route line declares a target (`repo=`, `branch=` or `root=`), or the work root differs from the session directory; otherwise the dispatch prompt is byte-identical to what it was before the header existed (invariant I9).",
    );
    expect(flat("docs/CONFIG_REFERENCE.md")).toContain(
      "The role header is emitted only when it is relevant (invariant I9): `routing.repoParents` is set, the route line declares `repo=`, `branch=` or `root=`, or the work root differs from the session directory; otherwise the dispatch prompt carries no header.",
    );
    const design = flat("docs/design/cross-repo.md");
    expect(design).toContain("- **Q8.** Decided 2026-10-11: the role dispatch header (OD6) follows I9.");
    expect(design).toContain("| D14 | 2026-10-11 | Q8 decided: the role dispatch header follows I9.");
    expect(design).not.toContain("pending the owner's reading of I9");
    expect(flat("CHANGELOG.md")).toContain("The header is emitted only when it is relevant (owner decision Q8, invariant I9)");
  });

  // Q9 (D15): a refused declared target refuses the dispatch.
  it("a refused declared target refuses the role dispatch (ROLES, design, CHANGELOG)", () => {
    const roles = flat("docs/ROLES.md");
    expect(roles).toContain("a route line that declared `root=`, `repo=` or `branch=` and got none **refuses the dispatch**: the task call fails with `[router] role dispatch @<agent> refused: <note>`");
    expect(roles).toContain("A dispatch that declared nothing is not refused (no declared target, no refusal);");
    expect(roles).not.toContain("Anything else gives **no work root**: the dispatch keeps local reads");
    expect(roles).not.toContain("gives no work root, and so refuses the dispatch with the note");
    expect(roles).not.toContain("an invalid value gives no work root");
    expect(roles).toContain("is an invalid declaration and refuses the dispatch with the note `<key>=<value> is not a valid repository name / branch name: no work root. Fix the route line.`");
    // D17 (QA of D15): an invalid root= refuses; an exact resume cannot change its work root.
    expect(roles).toContain("`root=<value> is not a valid absolute work root: no work root. Fix the route line.`");
    expect(roles).toContain("A refused dispatch fails the `task` call with `[router] role dispatch @<agent> refused: <note>`.");
    expect(roles).toContain("a resume cannot change its work root: dispatch a new child");
    expect(roles).toContain("is always removed, and replaced only when the router adds its own");
    expect(roles).toContain("`repo=<dir> branch=<b>` instead binds the worktree of that directory's repository that is on `<b>`, which may lie outside the parents");
    expect(flat("docs/CONFIG_REFERENCE.md")).toContain("is always removed, and replaced only when the router adds its own");
    const design = flat("docs/design/cross-repo.md");
    expect(design).toContain("| D17 | 2026-10-11 | QA of D15.");
    expect(design).toContain("a resume cannot change its work root: dispatch a new child");
    expect(design).toContain("**Known follow-ups (Q8–Q10 QA), accepted for now:**");
    expect(design).not.toContain("An invalid `branch=` or `repo=` gives no work root and a note.");
    expect(flat("CHANGELOG.md")).not.toContain("now gives no work root and a note");
    expect(flat("CHANGELOG.md")).toContain("a resume cannot change its work root: dispatch a new child");
    expect(design).toContain("- **Q9.** Decided 2026-10-11: a role dispatch whose route line declared `repo=`, `branch=` or `root=`");
    expect(design).toContain("| D15 | 2026-10-11 | Q9 decided: a declared target");
    expect(flat("CHANGELOG.md")).toContain("a refused declared target refuses the dispatch.**");
  });
});
const undocumentedKeys = (doc: string, keys: readonly string[]) =>
  keys.filter((key) => !doc.includes(`\`${key}\``));
const nestedEnforcementKeys = [
  "enforcement.maxDelegationDepth",
  "enforcement.escalate.effortBump",
  "enforcement.escalate.effortBumpMax",
];

describe("docs drift", () => {
  it("N1: pins persistence limits behind the documented storage and flush guarantees", () => {
    expect({ DECISIONS_MAX_BYTES, DECISIONS_MAX_GENERATIONS, FLUSH_MIN_INTERVAL_MS, FLUSH_BATCH_ROWS, MAX_QUEUED_ROWS, MAX_CORRUPT_COPIES, RENAME_RETRY_DELAYS_MS, STALE_TMP_MS, LOCK_STALE_MS }).toEqual({
      DECISIONS_MAX_BYTES: 5 * 1024 * 1024, DECISIONS_MAX_GENERATIONS: 3,
      FLUSH_MIN_INTERVAL_MS: 30_000, FLUSH_BATCH_ROWS: 1000, MAX_QUEUED_ROWS: 5000,
      MAX_CORRUPT_COPIES: 3, RENAME_RETRY_DELAYS_MS: [15, 30, 60, 120, 240],
      STALE_TMP_MS: 3_600_000, LOCK_STALE_MS: 30_000,
    });
    const doc = read("docs/ROUTING_ENGINE.md");
    expect(doc).toContain("about 5 MiB");
    expect(doc).toContain("3 generations kept");
    expect(doc).toContain("at most every 30 s");
    expect(doc).toContain("newest 3 are kept");
  });
  it("documents every tiers.json top-level key in CONFIG_REFERENCE.md", () => {
    const tiers = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const doc = read("docs/CONFIG_REFERENCE.md");

    const keys = Object.keys(tiers);
    // Sanity: a tiers.json that parsed to nothing would make this vacuously green.
    expect(keys.length).toBeGreaterThan(0);

    const undocumented = undocumentedKeys(doc, keys);
    expect(undocumented).toEqual([]);
  });

  it("documents the plugin `agents` block keys in CONFIG_REFERENCE.md", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    for (const key of ["agents", "tier", "description", "prompt", "steps", "readOnly", "allowTools", "permission"]) {
      expect(doc, key).toContain(`\`${key}\``);
    }
    expect(doc.replace(/\s+/g, " ")).toContain("opencode.json wins for the fields it sets");
  });
  it("documents depth and effort bump key paths in CONFIG_REFERENCE.md", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    expect(undocumentedKeys(doc, nestedEnforcementKeys)).toEqual([]);
  });

  it.each(nestedEnforcementKeys)("detects missing nested key %s", (missingKey) => {
    const fixture = nestedEnforcementKeys
      .filter((key) => key !== missingKey)
      .map((key) => `\`${key}\``)
      .join("\n");

    expect(undocumentedKeys(fixture, nestedEnforcementKeys)).toEqual([missingKey]);
  });

  // 30s timeout: this test recomputes the assembled prompts live, which can
  // exceed the 5s default on a cold windows-latest runner (flaked in CI run
  // 32212281722 with a hard timeout, passed on the immediate rerun).
  it("quotes the measured prompt figures in README.md", { timeout: 30_000 }, () => {
    const readme = read("README.md");

    // Recomputed here rather than pinned to a literal, so that growing the
    // protocol fails this test instead of quietly making the README wrong.
    // `validateConfig(tiers.json)` unmodified IS the documented measurement
    // basis: the bundled anthropic preset in normal mode, i.e. the shipped
    // activePreset/activeMode defaults.
    const cfg = validateConfig(
      JSON.parse(read("tiers.json")),
    ) as unknown as RouterConfig;
    const claude = "anthropic/claude-sonnet-4-6";

    const figures = {
      "base protocol": buildDelegationProtocol(cfg).length,
      "Claude orchestrator": assembleSystemPrompt(cfg, claude).length,
      "Claude + enforcement": assembleSystemPrompt(cfg, claude, true).length,
    };

    // Thousands separator, matching how the README writes them.
    const missing = Object.entries(figures)
      .map(([label, chars]) => [label, chars.toLocaleString("en-US")] as const)
      .filter(([, formatted]) => !readme.includes(formatted));

    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost-aware routing engine (#74): docs/ROUTING_ENGINE.md, ADR 0005 and the
// routing section of docs/CONFIG_REFERENCE.md must keep describing the code.
// ---------------------------------------------------------------------------

/** Repo-relative (posix) markdown files whose relative links must resolve. */
const ROUTING_DOCS = [
  "README.md",
  "docs/ROUTING_ENGINE.md",
  "docs/adr/0005-cost-aware-routing-engine.md",
  "docs/plans/README.md",
  "docs/CONFIG_REFERENCE.md",
] as const;

/** GitHub's heading slug: lower case, no backticks or punctuation, spaces become hyphens. */
function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Lines of `text` outside fenced code blocks, with their 1-based numbers. */
function proseLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (opener !== null) {
      const mark = opener[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      return;
    }
    if (fence === null) out.push({ line: index + 1, text: raw });
  });
  return out;
}

function anchorsOf(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text: line } of proseLines(text)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const slug = slugOf(heading[1]!);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/**
 * Relative markdown links (`[text](target)` outside code) of `files` that point at a missing file or,
 * for a `.md` target, at a heading that does not exist. `read` answers `undefined` for a missing file.
 */
function brokenLinks(files: readonly string[], read: (path: string) => string | undefined): string[] {
  const broken: string[] = [];
  for (const file of files) {
    const text = read(file);
    if (text === undefined) {
      broken.push(`${file}: file missing`);
      continue;
    }
    for (const { line, text: raw } of proseLines(text)) {
      const prose = raw.replace(/`[^`]*`/g, "");
      for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1]!;
        if (/^(?:https?:|mailto:)/i.test(target)) continue;
        const [pathPart, anchor] = target.split("#") as [string, string | undefined];
        const destination = pathPart === "" ? file : posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(pathPart)));
        const body = read(destination.replace(/\/$/, ""));
        if (body === undefined) {
          broken.push(`${file}:${line}: ${target} (missing)`);
        } else if (anchor !== undefined && destination.endsWith(".md") && !anchorsOf(body).has(anchor.toLowerCase())) {
          broken.push(`${file}:${line}: ${target} (no such heading)`);
        }
      }
    }
  }
  return broken;
}

/**
 * D16: what is wrong with `changelog` for the package `version`. It has exactly one `## [Unreleased]`, and the first
 * `## ` heading after it is the dated release `## [<version>] - YYYY-MM-DD`. `###` subsections and entries may sit under
 * [Unreleased]; another `## ` heading may not.
 */
function changelogReleaseProblems(changelog: string, version: string): string[] {
  const text = changelog.replace(/\r\n/g, "\n");
  const unreleased = [...text.matchAll(/^## \[Unreleased\]$/gm)];
  if (unreleased.length !== 1) return [`expected one ## [Unreleased] heading, found ${unreleased.length}`];
  const after = text.slice(unreleased[0]!.index! + unreleased[0]![0].length);
  const problems: string[] = [];
  for (const [heading] of after.matchAll(/^## .*$/gm)) {
    const dated = /^## \[([^\]\n]+)\] - \d{4}-\d{2}-\d{2}$/.exec(heading);
    if (dated === null) {
      problems.push(`a ## heading between [Unreleased] and the first dated release: ${heading}`);
      continue;
    }
    if (dated[1] !== version) problems.push(`the first dated release after [Unreleased] is ${heading}, not ${version}`);
    return problems;
  }
  return [...problems, "no dated release after [Unreleased]"];
}

/** Every file or directory under the repo, read lazily; a directory answers an empty string. */
function readRepo(path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf-8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "EISDIR" ? "" : undefined;
  }
}

// ---------------------------------------------------------------------------
// Plan executor (assembled and registered on OpenCode v2 only): docs/EXECUTOR.md names every `/plan` subcommand, every
// `router_plan` action and every `routing.executor` leaf key. Removing one from the doc fails these pins.
// ---------------------------------------------------------------------------

/** The `/plan` subcommands of the help lines: "- `/plan pause|resume|abort <planId>` — ..." gives pause, resume, abort. */
function planSubcommands(lines: readonly string[]): string[] {
  const subs: string[] = [];
  for (const line of lines) {
    const match = /^- `\/plan ([a-z|-]+)/.exec(line);
    if (match !== null) subs.push(...match[1]!.split("|").filter((s) => s.length > 0));
  }
  return subs;
}

/** Dotted leaf paths of `routing.executor` defaults (`slotsDir` is a leaf although its default is null). */
function executorLeafKeys(defaults: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(defaults)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys.push(...executorLeafKeys(value as Record<string, unknown>, `${prefix}${name}.`));
    } else {
      keys.push(`${prefix}${name}`);
    }
  }
  return keys;
}

/** Parse the actual /plan dispatch switch as well as its help, so a parser-only addition cannot escape the pin. */
function planParserSubcommands(source: string): string[] {
  const body = /switch \(sub\) \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
  return [...body.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((m) => m[1]!);
}

/** The private config allowlist, read as source (not evaluated); recurse into blocks such as circuitBreaker. */
function executorKnownLeafKeys(source: string): string[] {
  const known = /const ROUTING_KNOWN_KEYS[^=]*= \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
  const block = (name: string): string[] => {
    const body = new RegExp(`(?:^|\\n)  ${name}: \\[([^\\]]*)\\]`).exec(known)?.[1] ?? "";
    return [...body.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]!);
  };
  const leaves = (name: string, prefix = ""): string[] => block(name).flatMap((key) =>
    block(key).length > 0 ? leaves(key, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
  return leaves("executor");
}

const executorDefaultKeys = executorLeafKeys(ROUTING_DEFAULTS.executor as unknown as Record<string, unknown>);
const executorKnownKeys = executorKnownLeafKeys(read("src/router/config.ts"));
const executorParserCommands = planParserSubcommands(read("src/executor/command.ts"));
const executorDocSurface = {
  commands: [...new Set([...planSubcommands(PLAN_HELP_LINES), ...executorParserCommands])],
  actions: ROUTER_PLAN_ACTIONS as readonly string[],
  keys: [...new Set([...executorDefaultKeys, ...executorKnownKeys])],
};

/** What `doc` lacks of the plan executor surface: one entry per missing command, action or config key. */
function executorDocProblems(doc: string, surface = executorDocSurface): string[] {
  const problems: string[] = [];
  for (const sub of surface.commands) {
    if (!doc.includes(`| \`/plan ${sub}`)) problems.push(`/plan ${sub}`);
  }
  for (const action of surface.actions) {
    if (!doc.includes(`| \`${action}\` |`)) problems.push(`router_plan action ${action}`);
  }
  for (const key of surface.keys) {
    if (!doc.includes(`| \`routing.executor.${key}\` |`)) problems.push(`routing.executor.${key}`);
  }
  return problems;
}

describe("docs drift: plan executor (docs/EXECUTOR.md)", () => {
  const doc = read("docs/EXECUTOR.md");

  it("sees the surface it pins", () => {
    expect(planSubcommands(PLAN_HELP_LINES).sort()).toEqual(
      ["abort", "adopt", "answer", "approve", "inbox", "land", "pause", "resume", "run", "status"],
    );
    expect(ROUTER_PLAN_ACTIONS.length).toBeGreaterThanOrEqual(16);
    expect(executorLeafKeys(ROUTING_DEFAULTS.executor as unknown as Record<string, unknown>)).toContain("circuitBreaker.minAttempts");
    expect(executorParserCommands.length).toBeGreaterThan(0);
    expect([...executorParserCommands].sort()).toEqual(planSubcommands(PLAN_HELP_LINES).sort());
    expect(executorKnownKeys.length).toBeGreaterThan(0);
    expect([...executorKnownKeys].sort()).toEqual([...executorDefaultKeys].sort());
    expect(read("src/executor/tool.ts")).toContain("action: tool.schema.enum(ROUTER_PLAN_ACTIONS)");
  });

  it("names every /plan subcommand, router_plan action and routing.executor key", () => {
    expect(executorDocProblems(doc)).toEqual([]);
  });

  it("fails when a command, an action or a key is removed", () => {
    const leaf = executorLeafKeys(ROUTING_DEFAULTS.executor as unknown as Record<string, unknown>)[0]!;
    expect(executorDocProblems(doc.replaceAll("| `/plan adopt", "| `/plan x"))).toContain("/plan adopt");
    expect(executorDocProblems(doc.replaceAll("| `purge` |", "| `purged` |"))).toContain("router_plan action purge");
    expect(executorDocProblems(doc.replaceAll(`\`routing.executor.${leaf}\``, "`routing.executor.x`"))).toContain(`routing.executor.${leaf}`);
    expect(executorDocProblems(doc.replaceAll("`routing.executor.circuitBreaker.minAttempts`", "`x`"))).toContain(
      "routing.executor.circuitBreaker.minAttempts",
    );
  });

  it("detects deletion of every source-derived command, action and config table row", () => {
    const missingRow = (prefix: string) => doc.split(/\r?\n/).filter((line) => !line.startsWith(prefix)).join("\n");
    for (const sub of executorDocSurface.commands) {
      expect(executorDocProblems(missingRow(`| \`/plan ${sub}`)), sub).toEqual([`/plan ${sub}`]);
    }
    for (const action of executorDocSurface.actions) {
      expect(executorDocProblems(missingRow(`| \`${action}\` |`)), action).toEqual([`router_plan action ${action}`]);
    }
    for (const key of executorDocSurface.keys) {
      expect(executorDocProblems(missingRow(`| \`routing.executor.${key}\` |`)), key).toEqual([`routing.executor.${key}`]);
    }
  });

  it("detects additions to each code surface and extracts nested known keys and parser cases", () => {
    expect(planParserSubcommands('switch (sub) {\n    case "new-command":\n  }')).toEqual(["new-command"]);
    expect(executorKnownLeafKeys('const ROUTING_KNOWN_KEYS = {\n  executor: ["newKey", "nested"],\n  nested: ["leaf"],\n};'))
      .toEqual(["newKey", "nested.leaf"]);
    expect(executorDocProblems(doc, {
      commands: [...executorDocSurface.commands, "new-command"],
      actions: [...executorDocSurface.actions, "new-action"],
      keys: [...executorDocSurface.keys, ...executorLeafKeys({ newBlock: { newKey: null } })],
    })).toEqual(["/plan new-command", "router_plan action new-action", "routing.executor.newBlock.newKey"]);
  });

  it("pins the final safety model, Windows notes, metrics and next-plan checklist", () => {
    const safety = sectionOf(doc, "## Safety model");
    for (const id of ["I1", "I2", "I3", "I4", "I5"]) expect(safety).toContain(`| **${id}** |`);
    expect(safety.replace(/\s+/g, " ")).toContain("claimed in that launch-priority order");
    const windows = sectionOf(doc, "## Windows notes");
    for (const note of ["Same drive", "pnpm store", "UV_CACHE_DIR", "core.longpaths", "260 characters"]) expect(windows).toContain(note);
    expect(sectionOf(doc, "## Troubleshooting")).toContain("60 s probation");
    const metrics = sectionOf(doc, "## Metrics and observations");
    for (const note of ["MODEL_ROUTER_V2_OBSERVATIONS", "dropped=failed=0", "g8Ratio = makespan/bound", "10,000 ms", "not a Phase 6.1 acceptance gate"]) {
      expect(metrics).toContain(note);
    }
    expect(sectionOf(doc, "## Owner checklist for the next real plan")).toContain("/plan run <path>");
    expect(sectionOf(read("README.md"), "## Executing plans")).toContain("docs/EXECUTOR.md");
    expect(read("docs/ROLES.md")).toContain("[the plan executor guide](EXECUTOR.md)");
  });

  it("pins ADR 0007's Accepted status and D1–D20 decision list against the binding plan", () => {
    const plan = read("docs/plans/critical-path-execution-plan.md");
    const expected = [...plan.matchAll(/^\| D(\d+) \|/gm)].map((m) => Number(m[1]));
    const decisions = (text: string) => [...text.matchAll(/^### D(\d+) — /gm)].map((m) => Number(m[1]));
    const adr = read("docs/adr/0007-critical-path-execution.md");
    expect(expected).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(decisions(adr)).toEqual(expected);
    expect(adr).toContain("**Status:** Accepted **Date:** 2026-10-15");
    for (const id of expected) {
      expect(decisions(adr.replace(`### D${id} — `, `### Missing${id} — `)), `missing D${id}`).not.toEqual(expected);
    }
  });

  it("pins the QA-4.1 operator surface: human approval, path rule, --phases format, --plan, attempts, checks, slotsDir", () => {
    const flat = doc.replace(/\s+/g, " ");
    // QA-4.1-1: compiling never starts a plan; with `ask` the user approves, never the model.
    expect(flat).toContain("it does not start the plan");
    expect(flat).toContain("the model never approves on its own");
    expect(flat).not.toMatch(/Compiles the plan file and starts it/);
    // QA-4.1-6, QA-4.1-15: the path rule and the comma-only --phases format.
    expect(flat).toContain("absolute, or relative to the project directory");
    expect(flat).toContain("comma separated without spaces (`--phases 1.1,1.2`)");
    expect(flat).not.toMatch(/comma or space separated/);
    // QA-4.1-5: --plan of inbox and answer.
    expect(flat).toContain("| `/plan inbox [--plan <planId>]`");
    expect(flat).toContain("| `/plan answer [--plan <planId>] <id> <text>`");
    // QA-4.1-15, QA-4.1-8, QA-4.1-12.
    expect(flat).toContain("at most `routing.executor.maxAttempts` attempts per task");
    expect(flat).not.toMatch(/retried up to/);
    expect(flat).toContain("a list of commands is added to them, it never replaces them");
    expect(flat).toContain("A configured `slotsDir` is a root: the executor appends `<planId>`");
    expect(flat).not.toContain("no `<planId>` is appended");
    expect(read("src/executor/create.ts")).toMatch(/return root === null \? defaultSlotsDir\(toplevel, planId\) : join\(root, planId\)/);
    expect(flat).not.toMatch(/another live session/);
    // The help lines say the same.
    const helpText = PLAN_HELP_LINES.join("\n");
    expect(helpText).not.toMatch(/start executing it/);
    expect(helpText).toContain("relative to the project directory");
    expect(helpText).toContain("adopt a plan whose owning session is gone");
  });

  it("pins QA-4.1 round 2: a run request is not approval, project files only tighten, the inbox fallback", () => {
    const flat = doc.replace(/\s+/g, " ");
    // QA-4.1-16: no wording that lets the model read the user's run request as approval.
    expect(flat).toContain("a request to compile or run it is not approval");
    expect(flat).toContain("your request to compile or run it is not approval");
    expect(flat).not.toMatch(/explicitly in the conversation|after you approve it in the conversation/);
    // QA-4.1-17 (amendment A-4.1-2): a project-local override may only tighten the other executor keys.
    expect(flat).toContain(
      "but a project-local override may only tighten them (amendment A-4.1-2): `approve` only to `ask`, `land` only to " +
        "`manual`, `crossPhase` only to `gate`, and the numeric budgets and circuit-breaker values only lower",
    );
    expect(flat).toContain("a project-local override can only set `ask`");
    expect(flat).not.toMatch(/only tune limits and modes and may be set in either file/);
    // QA-4.1-20 nit: /plan inbox without --plan falls back to the runtime's pick.
    expect(flat).toContain("when the session has none, the plan the runtime finds for this session");
  });

  it("documents implemented unattended operation, QA and recovery, not placeholders", () => {
    for (const heading of ["## Unattended operation", "## QA loop", "## Recovery"]) {
      const section = sectionOf(doc, heading);
      expect(section, heading).not.toBe("");
      expect(section, heading).not.toMatch(/Placeholder|text for this section arrives/);
    }
    expect(sectionOf(doc, "## Unattended operation")).toContain("**`F > ratio·N`**");
    expect(sectionOf(doc, "## QA loop")).toContain("`<phaseId>.FIX<round>-<index>`");
    expect(sectionOf(doc, "## Recovery")).toContain("**60 s**");
  });

  it("pins v2 registration, unchanged v1 maps, and the OPENCODE_V2.md handoff", () => {
    const flat = doc.replace(/\s+/g, " ");
    expect(flat).toContain("assembled and registered on OpenCode v2 only");
    expect(flat).toContain("OpenCode v1 is unchanged: no executor tool, command or instructions are registered there");
    expect(doc).not.toMatch(/not active yet|not registered.*yet/);
    const entry = read("src/index.ts");
    expect(entry).toContain("...(isV2Host && routerPlan !== undefined ? { router_plan:");
    expect(entry).toContain("if (isV2Host && planCommand !== undefined)");
    expect(entry).toContain("opencodeConfig.command.plan =");
    expect(read("src/executor/create.ts")).toContain('if (context.routerHost === "v1") return undefined;');
    expect(read("src/v2.ts")).toContain('executor: (host) => createExecutor({ routerHost: "v2", directory }');
    const v1Golden = read("test/golden/v1-plugin-maps.golden.test.ts");
    expect(v1Golden).toContain("default and executor/roles configs are byte-identical to the pre-registration v1 maps");
    expect(v1Golden).toContain("expect(configured).toEqual(defaults)");
    for (const surface of ["tools.json", "commands.json", "router-help.txt"]) expect(v1Golden).toContain(`v1-plugin-maps.${surface}`);
    const v2 = read("docs/OPENCODE_V2.md");
    expect(v2).toContain("(EXECUTOR.md)");
    const section = sectionOf(v2, "## Plan executor").replace(/\s+/g, " ");
    expect(section).toContain("The `router_plan` tool, the `/plan` command and the executor instructions are registered on OpenCode v2 only; OpenCode v1's tool, command and help maps are unchanged.");
    expect(section).not.toMatch(/not active yet|a later phase registers/);
  });

  it("states the root-only authority rule and own-plan read exception (QA-5.1-2)", () => {
    const assembly = sectionOf(doc, "## Assembly and lifecycle").replace(/\s+/g, " ");
    expect(assembly).toContain("a session at depth 0, with no parent");
    expect(assembly).toContain("are root-only, with **no bound-plan-child exception**; a failed parent lookup refuses");
    expect(assembly).toContain("plan child reading **only its own plan**");
    expect(assembly).toContain("A child bound to plan A cannot read plan B");
    expect(assembly).toContain("The same rule guards `router_plan` and `/plan`");
    const authority = assembly.slice(assembly.indexOf("All state-changing and authority"), assembly.indexOf("The read-only"));
    const readOnly = assembly.slice(assembly.indexOf("The read-only"), assembly.indexOf("A child bound"));
    const reads = ["status", "ready", "export"];
    for (const action of ROUTER_PLAN_ACTIONS) {
      expect(reads.includes(action) ? readOnly : authority, action).toContain(`\`${action}\``);
    }
    expect(readOnly).toContain("`/plan inbox` (`status inbox=true`)");
  });

  it("documents preservation of the user's /plan on both hosts (QA-5.1-13)", () => {
    const command = sectionOf(doc, "## `/plan` command").replace(/\s+/g, " ");
    expect(command).toContain("An existing user-defined `/plan` command is preserved");
    expect(command).toContain("on v2 the router logs one conflict warning and leaves `router_plan` available");
    expect(command).toContain("On v1 that user command runs without an executor `/plan` notice");
  });

  it("quotes every assembly unavailable reason from create.ts and v2.ts (QA-5.1-23)", () => {
    const source = read("src/executor/create.ts");
    const reasons = [
      ...[...source.matchAll(/\babsent\("([^"\n]+)"\)/g)].map((m) => m[1]!),
      // prepareExecutor's absences only: the lease port's acquire results also say `ok: false, reason:` but carry a message.
      ...[...source.matchAll(/ok: false, reason: "([^"\n]+)" \}/g)].map((m) => m[1]!),
    ];
    expect(reasons).toEqual([
      "routing.delegation must be roles at start", "routing.leases.mode must be enforce", "no plan-task verifier",
      "enforcement.verify.require is never", "the lease registry is not available", "the child runner is not available",
      "another plan executor already owns this process", "not a git repository",
    ]);
    const setup = read("src/v2.ts");
    const setupReasons = [...setup.matchAll(/\?\s*"([^"\n]+)"|access\.clear\("([^"\n]+)"\)/g)].map((m) => (m[1] ?? m[2])!);
    expect(setupReasons).toEqual([
      "routing.delegation must be roles at start", "routing.leases.mode must be enforce", "enforcement.verify.require is never",
      "the location is outside routing.workRoots", "the child runner is not available",
    ]);
    const assembly = sectionOf(doc, "## Assembly and lifecycle");
    for (const reason of [...reasons, ...setupReasons]) expect(assembly, reason).toContain(`| \`${reason}\` |`);
    const prefixes = [...source.matchAll(/(?:absent\(|reason: )`((?:assembly|repository discovery) failed: )\$\{/g)].map((m) => m[1]!);
    expect(prefixes).toEqual(["assembly failed: ", "repository discovery failed: "]);
    for (const prefix of prefixes) expect(assembly).toContain(`\`${prefix}<error>\``);
    expect(source).toContain("reason = `the plan executor is not available: ${why}`");
    expect(assembly).toContain("`the plan executor is not available: <reason>`");
    expect(source).toContain('let reason = "the plan executor is not available: not initialized"');
    expect(source).toContain('access.clear("disposed")');
    expect(assembly).toContain("the reason is `not initialized`; after disposal it is `disposed`");
  });

  it("pins the executor home, default slots path and instructions provider registration/order", () => {
    expect(EXECUTOR_HOME_DIRNAME).toBe("omr-executor");
    expect(defaultSlotsDir("D:\\repo", "p-test")).toBe("D:\\.omr-slots\\p-test");
    expect(doc).toContain("`<git common dir>\\omr-executor`");
    expect(doc).toContain('`EXECUTOR_HOME_DIRNAME = "omr-executor"`');
    expect(doc).toContain("`<drive>:\\.omr-slots\\<planId>`");
    expect(PLAN_PROVIDER_ORDER).toBe(60);
    expect(EXECUTOR_INSTRUCTIONS_ORDER).toBe(61);
    expect(read("src/compat/v2-hooks.ts")).toContain("...createExecutorInstructionsProvider(built.runtime), order: EXECUTOR_INSTRUCTIONS_ORDER");
    expect(sectionOf(doc, "## Assembly and lifecycle").replace(/\s+/g, " ")).toContain("per-turn state provider at order 61");
  });

  it("documents the trusted slots-root work allowance without widening a role dispatch", () => {
    const workRoots = sectionOf(read("docs/ROLES.md"), "## Work roots").replace(/\s+/g, " ");
    expect(workRoots).toContain("role agents with local actions may work under the trusted slots root");
    expect(workRoots).toContain("`routing.workRoots` is not needed for it, including slots created after registration");
    expect(workRoots).toContain("each child still works only in its own validated work root");
    expect(workRoots).toContain("The executor home (`<git common dir>\\omr-executor`) is denied");
    expect(workRoots).toContain("A project-local `slotsDir` is ignored");
    expect(workRoots).toContain("no slots-root allowance is added (fail closed)");
  });

  it("pins plan-task deadline constants, formulae, shared transient re-runs and backoffs", () => {
    expect({ PLAN_TASK_CHECKS_MIN_MS, PLAN_TASK_GRADER_SLACK_MS, PLAN_TASK_TRANSIENT_RERUNS, PLAN_TASK_RERUN_BACKOFF_MS }).toEqual({
      PLAN_TASK_CHECKS_MIN_MS: 600_000, PLAN_TASK_GRADER_SLACK_MS: 60_000,
      PLAN_TASK_TRANSIENT_RERUNS: 2, PLAN_TASK_RERUN_BACKOFF_MS: [30_000, 60_000],
    });
    expect(planTaskChecksBudgetMs(1)).toBe(600_000);
    expect(planTaskChecksBudgetMs(900_000)).toBe(900_000);
    expect(planTaskGraderBudgetMs(1, "heavy", 300_000)).toBe(360_000);
    expect(planTaskGraderBudgetMs(900_000, "heavy", 300_000)).toBe(900_000);
    const verification = sectionOf(doc, "## Verification of plan tasks").replace(/\s+/g, " ");
    expect(verification).toContain("`max(gateBudgetMs, 600000)`");
    expect(verification).toContain("`max(gateBudgetMs, graderTimeoutMs(tier, override) + 60000)`");
    expect(verification).toContain("`PLAN_TASK_TRANSIENT_RERUNS`: 2");
    expect(verification).toContain("`PLAN_TASK_RERUN_BACKOFF_MS`: `[30000, 60000]`");
    expect(verification).toContain("This allowance is shared across both passes of a mixed block");
    const source = read("src/verify/plan-task.ts");
    expect(source).toContain("let reruns = 0;");
    expect([...source.matchAll(/\blet reruns =/g)]).toHaveLength(1);
    // QA-5.1-4: a disposing verifier re-runs nothing, and dispose cuts the backoff sleep (the transient result stands).
    expect(source).toContain("if (disposing || !isTransientPlanTaskResult(res, cut) || reruns >= PLAN_TASK_TRANSIENT_RERUNS) return res;");
    expect(source).toContain("try { await untilShutdown(sleep(PLAN_TASK_RERUN_BACKOFF_MS[reruns])); } catch { return res; }");
    expect(source.indexOf("let reruns = 0;")).toBeLessThan(source.indexOf("const withReruns ="));
  });

  it("documents inferred-writer routing and the owner's all-verification-modes M39 amendment", () => {
    const routing = sectionOf(doc, "## Task routing and write footprints").replace(/\s+/g, " ");
    expect(routing).toContain("`route-write-conflict`, the task id and source line");
    expect(routing).toContain("read-only role permissions are not widened");
    const verification = sectionOf(doc, "## Verification of plan tasks").replace(/\s+/g, " ");
    expect(verification).toContain("whether `VERIFY` is `required`, `deferred` or `none`");
    expect(verification).toContain("already-implemented/idempotent explanation is not an exception");
    expect(verification).toContain("With an empty write footprint, no-change success remains allowed");
    const amendment = sectionOf(read("docs/qa/critical-path-execution/phase-3.1.md"), "## Owner amendment to M39 (2026-10-14)").replace(/\s+/g, " ");
    expect(amendment).toContain("supersedes the verification-dependent no-change rule in M39");
    expect(amendment).toContain("No idempotent/already-implemented exception was authorized");
  });

  it("pins the never-deferred plan-task gate in both code and docs", () => {
    const source = read("src/verify/plan-task.ts");
    // Required dispatch-gate wiring: modeA/trivial:false cannot skip the gate; accept is awaited directly, not deferred.
    // QA-5.1-14: the grader's parent and creator are the orchestrator the runtime passes with this verify call.
    expect(source).toContain("deps.buildGateDeps(parent, graders, prepared, deadline, false, parent)");
    expect(source).toContain("verifyNow(task, slot, attempt, orchestrator(ctx), (v) => { decided = v; })");
    expect(source).toMatch(/trivial: false,\s+mode: "modeA"/);
    // QA-5.1-4: still awaited directly; only dispose (never a deferral) can cut the wait.
    expect(source).toContain("await untilShutdown(withTimeout(accept(delegation, artefact, gateDeps), deadline.remaining(), \"verification gate\"))");
    expect(source).not.toMatch(/\b(?:deferVerification|deferDispatch|registerPending)\s*\(/);
    const verification = sectionOf(doc, "## Verification of plan tasks").replace(/\s+/g, " ");
    expect(verification).toContain("**Plan-task verification is never deferred**, even with `VERIFY:deferred`");
    expect(verification).toContain("with no pending handle or deferred footer");
    expect(verification).toContain("**unverifiable result costs an attempt and is a breaker sample**");
  });

  it("pins the 4.2 thresholds, ranges and X11 breaker equality boundary", () => {
    expect(INBOX_ID_PREFIX).toEqual({ question: "Q", failure: "F", "usage-limit": "U", landing: "L", flaky: "K", "qa-cap": "R", breaker: "B" });
    for (const prefix of Object.values(INBOX_ID_PREFIX)) expect(sectionOf(doc, "## Unattended operation")).toContain(`\`${prefix}-\``);
    expect(INBOX_TEXT_MAX).toBe(4000);
    expect(EXECUTOR_DEFAULTS.maxAttempts).toBe(3);
    expect(EXECUTOR_LIMITS.maxAttempts).toEqual([1, 6]);
    expect(EXECUTOR_DEFAULTS.qaMaxRounds).toBe(3);
    expect(EXECUTOR_LIMITS.qaMaxRounds).toEqual([1, 8]);
    expect(EXECUTOR_DEFAULTS.circuitBreaker).toEqual({ failureRatio: 0.4, minAttempts: 5, consecutiveFailures: 3 });
    expect(EXECUTOR_LIMITS.failureRatio).toEqual([0.1, 1]);
    expect(EXECUTOR_LIMITS.minAttempts).toEqual([1, 50]);
    expect(EXECUTOR_LIMITS.consecutiveFailures).toEqual([1, 50]);
    expect(QA_ROUND_LIMIT).toBe(999);
    expect({ RECOVERY_LIVENESS_MS, RECOVERY_POLL_MS }).toEqual({ RECOVERY_LIVENESS_MS: 60_000, RECOVERY_POLL_MS: 10_000 });
    expect(read("src/executor/runtime.ts")).toContain("const PROBATION_INTERRUPT_FAILS = 5;");
    const recovery = sectionOf(doc, "## Recovery");
    for (const threshold of ["**60 s**", "**10 s**", "**5 tries**"]) expect(recovery).toContain(threshold);
    expect(recovery.replace(/\s+/g, " ")).toContain("A `running` child whose launching process is provably dead on the same host, and whose stored history shows no tool call in flight, is requeued at once; a child stopped inside a tool, whose processes (for example a `router_run` test) can outlive the host, gets the **60 s** liveness probation like any other unknown child.");
    expect(sectionOf(doc, "## Unattended operation")).toContain("**4000 characters plus an ellipsis**");
    const unattended = sectionOf(doc, "## Unattended operation").replace(/\s+/g, " ");
    expect(unattended).toContain("default **3**, integer range **1–6**");
    expect(unattended).toContain("`failureRatio = 0.4` (range **0.1–1**), `minAttempts = 5` and `consecutiveFailures = 3` (both integer ranges **1–50**)");
    expect(unattended).toContain("**`C ≥ n`**");
    expect(sectionOf(doc, "## QA loop")).toContain("defaults to **3** (integer range **1–8**)");
    expect(sectionOf(doc, "## QA loop")).toContain("round **999** offers only `accept`");
    const sample = (failure: boolean, index: number) => ({ taskId: "1.1", n: index + 1, endedAt: "2026-10-13T00:00:00.000Z", failure });
    const equality = [true, false, true, false, false].map(sample);
    expect(breakerTrips(equality, EXECUTOR_DEFAULTS.circuitBreaker).tripped).toBe(false);
    expect(breakerTrips(Array.from({ length: 15 }, (_, i) => i < 12 && i % 2 === 0).map(sample), EXECUTOR_DEFAULTS.circuitBreaker).tripped).toBe(false);
    expect(breakerTrips([true, false, true, false, true].map(sample), EXECUTOR_DEFAULTS.circuitBreaker).reason).toBe("ratio");
    expect(breakerTrips([true, true, true].map(sample), EXECUTOR_DEFAULTS.circuitBreaker).reason).toBe("consecutive");
  });

  it("has links that resolve", () => {
    expect(brokenLinks(["docs/EXECUTOR.md", "docs/OPENCODE_V2.md", "docs/ROLES.md", "docs/adr/0007-critical-path-execution.md"], readRepo)).toEqual([]);
  });

  it("describes the executor in the changelog as registered on v2 only, v1 maps unchanged (Phase 5.1.2)", () => {
    const changelog = read("CHANGELOG.md").replace(/\r\n/g, "\n");
    const start = changelog.indexOf("## [Unreleased]");
    const next = changelog.indexOf("\n## [", start + 1);
    const unreleased = changelog.slice(start, next === -1 ? undefined : next);
    expect(unreleased).toContain("routing.executor");
    expect(unreleased).toContain("router_plan");
    expect(unreleased).toContain("/plan");
    expect(unreleased).toMatch(/OpenCode v2: plan executor registration/);
    expect(unreleased).not.toMatch(/not registered yet/);
    expect(unreleased).toMatch(/v1 tool,\s+command and help maps are unchanged/);
  });
});

/** Dotted paths of the leaves of a nested defaults object. */
function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? leafPaths(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("docs drift: cost-aware routing engine", () => {
  it("documents every routing key, with its default row, in CONFIG_REFERENCE.md", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    // `roles` and `classifier.presets` have no fixed leaves; every other key is a leaf of the defaults.
    const { roles: _roles, ...defaults } = ROUTING_DEFAULTS as Record<string, unknown>;
    const keys = [...leafPaths(defaults), "classifier.presets", "roles"];
    expect(keys.length).toBeGreaterThan(10);
    const missing = keys.filter((key) => !doc.includes(`| \`${key}\` |`));
    expect(missing).toEqual([]);
  });

  it("documents every routing.executor leaf as a prefix-less routing-table row with its default, and its trust", () => {
    const doc = read("docs/CONFIG_REFERENCE.md").replace(/\r\n/g, "\n");
    const table = doc.slice(doc.indexOf("\n### Keys\n"), doc.indexOf("\n### Trust: which file may set what\n"));
    const trust = doc.slice(doc.indexOf("\n### Trust: which file may set what\n"), doc.indexOf("\n### Engine modes\n"));
    expect(table.length).toBeGreaterThan(0);
    expect(trust.length).toBeGreaterThan(0);
    const leaves = leafPaths({ executor: ROUTING_DEFAULTS.executor });
    expect(leaves.length).toBe(19);
    const rows = table.split("\n").filter((line) => line.startsWith("| `executor."));
    expect(rows.map((line) => /^\| `([^`]+)` \|/.exec(line)?.[1])).toEqual(leaves);
    for (const row of rows) expect(row, row).not.toContain("| `routing.");
    for (const leaf of leaves) {
      const key = leaf.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], ROUTING_DEFAULTS);
      const row = rows.find((line) => line.startsWith(`| \`${leaf}\` |`))!;
      expect(row, leaf).toContain(`| \`${JSON.stringify(key)}\` |`);
    }
    for (const trusted of ["slotsDir", "integrationChecks", "phaseSuite", "provision", "python"]) {
      expect(trust, trusted).toContain(trusted);
      expect(rows.find((line) => line.startsWith(`| \`executor.${trusted}\` |`)), trusted).toContain("Only the global override may set it");
    }
  });

  it("names every engine mode, task class and cost-doctor finding in ROUTING_ENGINE.md", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    const names = [...ROUTING_ENGINES, ...ROUTING_TASK_CLASSES, ...FINDING_IDS];
    expect(names.length).toBeGreaterThan(20);
    expect(undocumentedKeys(doc, names)).toEqual([]);
  });

  it.each(["\n", "\r\n"])("keeps every engine-example block of ROUTING_ENGINE.md valid with %j line endings", (eol) => {
    const doc = read("docs/ROUTING_ENGINE.md").replace(/\r?\n/g, eol);
    const bundled = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const examples = [...doc.matchAll(/<!-- engine-example: ([\w-]+) -->\s*```jsonc\r?\n([\s\S]*?)\r?\n```/g)];
    // shadow, enforce, ollama, opencode-go-host, opencode-go-http, typesafe
    expect(examples.map((m) => m[1])).toEqual(
      expect.arrayContaining(["shadow", "enforce", "ollama", "opencode-go-host", "opencode-go-http", "typesafe"]),
    );
    for (const [, name, body] of examples) {
      const parsed = parseJsonc(body!) as Record<string, unknown>;
      const cfg = validateConfig({ ...bundled, ...parsed });
      const engine = resolveRouting(cfg, "v2").engine;
      const written = (parsed.routing as { engine?: unknown }).engine;
      expect(ROUTING_ENGINES, `example ${name}`).toContain(engine);
      // QA-3.1-18: the example sets the engine it claims to, and the resolved config says the same.
      expect(engine, `example ${name}`).toBe(written);
    }
  });

  it("links the guide and the ADR from the README and the plans index, and credits #73 in the changelog", () => {
    expect(read("README.md")).toContain("docs/ROUTING_ENGINE.md");
    expect(read("README.md")).toContain("docs/adr/0005-cost-aware-routing-engine.md");
    expect(read("docs/plans/README.md")).toContain("../adr/0005-cost-aware-routing-engine.md");
    expect(read("docs/plans/README.md")).toContain("../ROUTING_ENGINE.md");
    const release = /## \[2\.3\.0\] - 2026-10-07([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1] ?? "";
    expect(release).toContain("#73");
    expect(release).toContain("#74");
  });

  it("resolves every relative markdown link of the routing docs, anchors included", () => {
    expect(brokenLinks(ROUTING_DOCS, readRepo)).toEqual([]);
  });

  it("detects a missing file, a missing heading and a missing document", () => {
    const files: Record<string, string> = {
      "docs/a.md": "# A\n\n[ok](b.md) [file](nope.md) [heading](b.md#nothing) [good](b.md#hello-there) [self](#a)\n\n```\n[ignored](nope.md)\n```\n",
      "docs/b.md": "# Hello there\n",
    };
    const read = (path: string) => files[path];
    expect(brokenLinks(["docs/a.md"], read)).toEqual([
      "docs/a.md:3: nope.md (missing)",
      "docs/a.md:3: b.md#nothing (no such heading)",
    ]);
    expect(brokenLinks(["docs/missing.md"], read)).toEqual(["docs/missing.md: file missing"]);
  });
});

// ---------------------------------------------------------------------------
// QA-3.1-3 / QA-3.1-18: the docs' numbers, defaults, ranges, ids and severities are the code's.
// ---------------------------------------------------------------------------

/** Cells of the row of the `routing` keys table whose first cell is `` `key` `` (unescaped pipes only). */
function keyRow(doc: string, key: string): string[] | undefined {
  const line = doc.split(/\r?\n/).find((l) => l.startsWith(`| \`${key}\` |`));
  return line?.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
}

/** The default cell as the doc writes it: JSON for strings, numbers and booleans, `null`, `{}` for an empty map. */
function defaultCell(value: unknown): string {
  if (value === null) return "`null`";
  if (typeof value === "string") return `\`"${value}"\``;
  if (typeof value === "object") return "`{}`";
  return `\`${String(value)}\``;
}

describe("docs drift: the worked example is the real kernel's output (QA-3.1-3)", () => {
  const SONNET = "anthropic/claude-sonnet-5-5";
  const OPUS = "anthropic/claude-opus-5-5";
  // The fixture the guide states: default escalate policy, `roles: {}`, no catalog (no variant steps), ratios 1 / 5 / 20.
  const cfg = {
    activePreset: "p",
    presets: {
      p: {
        fast: { model: SONNET, variant: "low", costRatio: 1 },
        medium: { model: SONNET, variant: "medium", costRatio: 5 },
        heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
      },
    },
    rules: [],
    defaultTier: "medium",
    routing: { engine: "advise", roles: {} },
  } as unknown as RouterConfig;
  const needs: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
  const agents: HostAgentInfo[] = ["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false, permitted: true, grants: needs }));
  const facts: TaskFacts = { class: "implement", risk: "medium", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } as TaskFacts;
  const routing = resolveRouting(cfg, "v2");
  const ladder = buildLadder({ cfg, routing: { roles: routing.roles }, facts, agents });
  const chosen = resolveChosen({ cfg, agents, agent: "medium" })!;
  const decideWith = (store: ReturnType<typeof createOutcomeStore>) =>
    decide({ facts, chosen, ladder, detection: "grader", pin: false, routing, store });
  const costOf = (d: ReturnType<typeof decide>, tier: string): number => {
    const index = ladder.candidates.findIndex((c) => c.tier === tier);
    return d.costs[candidateKey("implement", ladder.candidates[index]!)]!;
  };

  const priors = decideWith(createOutcomeStore({ now: () => 1_000 }));
  const seasoned = createOutcomeStore({ now: () => 1_000 });
  const fast = ladder.candidates.find((c) => c.tier === "fast")!;
  for (let i = 0; i < 10; i++) seasoned.recordVerdict(candidateKey("implement", fast), "pass", { attemptID: `p${i}`, step: "dispatch" });
  for (let i = 0; i < 2; i++) seasoned.recordVerdict(candidateKey("implement", fast), "fail", { attemptID: `f${i}`, step: "dispatch" });
  const withEvidence = decideWith(seasoned);

  const section = (): string => {
    const doc = read("docs/ROUTING_ENGINE.md");
    return doc.slice(doc.indexOf("### Worked example"), doc.indexOf("## Cost units and zero-cost models"));
  };

  it("the router tiers' simulated attempts are the ones the guide tabulates", () => {
    const labelled = (index: number): string => (index < ladder.candidates.length ? ladder.candidates[index]! : ladder.reachable![index - ladder.candidates.length]!).tier;
    expect(ladder.candidates.map((c) => c.tier)).toEqual(["fast", "medium", "heavy"]);
    expect(ladder.candidates.map((_, k) => (ladder.paths?.[k] ?? []).map(labelled))).toEqual([
      ["fast", "fast", "medium"],
      ["medium", "medium", "heavy"],
      ["heavy", "heavy"],
    ]);
  });

  it("prices heavy 23.011, medium 7.162 and fast 4.772 on priors, and keeps the pick for lack of evidence", () => {
    expect(priors.unit).toBe("ratio");
    expect([costOf(priors, "heavy"), costOf(priors, "medium"), costOf(priors, "fast")].map((c) => c.toFixed(3))).toEqual(["23.011", "7.162", "4.772"]);
    expect(0.8 * costOf(priors, "medium")).toBeCloseTo(5.73, 3);
    expect(priors.reasonCode).toBe("kept:evidence");
    expect(priors.switched).toBe(false);
    expect(priors.argmin?.agent).toBe("fast");
    expect(priors.best?.agent).toBe("medium");
  });

  it("after 10 passes and 2 failures fast costs 2.742, below 0.8 · C(medium) = 5.730, and the decision switches", () => {
    expect(costOf(withEvidence, "fast").toFixed(3)).toBe("2.742");
    expect(costOf(withEvidence, "medium").toFixed(3)).toBe("7.162");
    expect((0.8 * costOf(withEvidence, "medium")).toFixed(3)).toBe("5.730");
    expect(withEvidence.reasonCode).toBe("switched");
    expect(withEvidence.best?.agent).toBe("fast");
  });

  /** The guide's Attempts table: tier -> [the attempts it lists, why the cascade ends]. */
  const attemptsTable = (): Map<string, { attempts: string[]; ends: string }> => {
    const rows = new Map<string, { attempts: string[]; ends: string }>();
    for (const line of section().split("\n")) {
      if (!/^\| `(?:fast|medium|heavy)` \|/.test(line)) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      const attempts = [...cells[1]!.replace(/\([^)]*\)/g, "").matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
      rows.set(cells[0]!.replace(/`/g, ""), { attempts, ends: cells[2] ?? "" });
    }
    return rows;
  };

  /** Replays the runner from `start` with a failing verdict after every attempt and returns why it gives up. */
  const endReason = (start: string): string => {
    const policy = buildEscalatePolicy(cfg);
    const ratios: Record<string, number> = { fast: 1, medium: 5, heavy: 20 };
    let state = newLadderState(start, policy);
    for (let i = 0; i < 20; i++) {
      state = recordAttempt(state, ratios[state.currentTier]!);
      const action = nextAction(state, { pass: false, outcome: "fail", reasons: [] }, policy);
      if (action.action === "give_up") return action.reason ?? "";
      if (action.action !== "retry" && action.action !== "escalate") break;
      state = advance(state, action);
    }
    throw new Error(`the runner never gave up from ${start}`);
  };

  it("the guide's Attempts table is ladder.paths, and says why each cascade ends (QA-3.1-R2-4, R2-7)", () => {
    const table = attemptsTable();
    const labelled = (index: number): string => (index < ladder.candidates.length ? ladder.candidates[index]! : ladder.reachable![index - ladder.candidates.length]!).tier;
    for (const [k, candidate] of ladder.candidates.entries()) {
      const row = table.get(candidate.tier);
      expect(row, `row ${candidate.tier}`).toBeDefined();
      expect(row!.attempts, candidate.tier).toEqual((ladder.paths?.[k] ?? []).map(labelled));
    }
    expect([...table.keys()].sort()).toEqual(["fast", "heavy", "medium"]);
    // the real end reasons: the ceiling ends fast and medium, the top of the ladder ends heavy after its retry
    expect(endReason("fast")).toBe("cost ceiling exceeded");
    expect(endReason("medium")).toBe("cost ceiling exceeded");
    expect(endReason("heavy")).toMatch(/top of ladder/);
    expect(table.get("fast")!.ends).toMatch(/cost ceiling/);
    expect(table.get("medium")!.ends).toMatch(/cost ceiling/);
    expect(table.get("heavy")!.ends).toMatch(/top of the ladder/);
    expect(section()).toContain("The cost ceiling ends the `fast` and `medium` cascades; `heavy`'s ends at the top of the ladder after its retry");
  });

  it("the guide prints exactly those figures and states the policy it assumes", () => {
    const text = section();
    const printed = [
      costOf(priors, "heavy"),
      costOf(priors, "medium"),
      costOf(priors, "fast"),
      0.8 * costOf(priors, "medium"),
      costOf(withEvidence, "fast"),
    ].map((c) => c.toFixed(3));
    expect(printed).toEqual(["23.011", "7.162", "4.772", "5.730", "2.742"]);
    // Each figure in its own context (QA-3.1-R2-7): a number that merely appears somewhere else does not satisfy the guide.
    const fig = (value: number): string => value.toFixed(3).replace(".", "\\.");
    expect(text).toMatch(new RegExp(`C\\(heavy\\)\\s*=\\s*${fig(costOf(priors, "heavy"))}`));
    expect(text).toMatch(new RegExp(`C\\(medium\\)\\s*=\\s*${fig(costOf(priors, "medium"))}`));
    expect(text).toMatch(new RegExp(`C\\(fast\\)\\s*=\\s*${fig(costOf(priors, "fast"))}`));
    expect(text).toMatch(new RegExp(`0\\.8 · C\\(medium\\) = 0\\.8 · ${fig(costOf(priors, "medium"))} = ${fig(0.8 * costOf(priors, "medium"))}`));
    expect(text).toMatch(new RegExp(`C\\(fast\\)\\s*=\\s*${fig(costOf(withEvidence, "fast"))}`));
    // the priors figures come before the after-evidence one
    expect(text.search(new RegExp(`C\\(fast\\)\\s*=\\s*${fig(costOf(priors, "fast"))}`))).toBeLessThan(
      text.search(new RegExp(`C\\(fast\\)\\s*=\\s*${fig(costOf(withEvidence, "fast"))}`)),
    );
    expect(text).toContain("`roles: {}`");
    expect(text).toContain("`maxAttemptsPerTier: 1`");
    expect(text).toContain("`maxTotalAttempts: 4`");
    expect(text).toContain("`kept` with reason `evidence`");
  });
});

describe("docs drift: defaults, ranges, ids and severities (QA-3.1-18)", () => {
  const defaults = resolveRouting(validateConfig(JSON.parse(read("tiers.json"))), "v2");

  it("the Default column of the routing keys table is what resolveRouting applies", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    const expected: Record<string, unknown> = {
      engine: defaults.engine,
      profile: defaults.profile,
      margin: defaults.margin,
      minClassConfidence: defaults.minClassConfidence,
      "detection.deterministic": defaults.detection.deterministic,
      "detection.grader": defaults.detection.grader,
      "detection.none": defaults.detection.none,
      "classifier.backend": defaults.classifier.backend,
      "classifier.model": defaults.classifier.model,
      "classifier.baseUrl": defaults.classifier.baseUrl,
      "classifier.apiKeyEnv": defaults.classifier.apiKeyEnv,
      "classifier.timeoutMs": defaults.classifier.timeoutMs,
      "classifier.samples": defaults.classifier.samples,
      "classifier.maxStateChars": defaults.classifier.maxStateChars,
      "classifier.presets": defaults.classifier.presets,
      "outcomes.path": defaults.outcomes.path,
      "outcomes.halfLifeDays": defaults.outcomes.halfLifeDays,
      "outcomes.maxEffectiveSamples": defaults.outcomes.maxEffectiveSamples,
      "sessionReuse.maxContextFraction": defaults.sessionReuse.maxContextFraction,
      "advisor.enabled": defaults.advisor.enabled,
      "advisor.noticeIntervalHours": defaults.advisor.noticeIntervalHours,
      "advisor.notify": defaults.advisor.notify,
      "background.mode": defaults.background.mode,
      "background.minPredictedMs": defaults.background.minPredictedMs,
      "leases.mode": defaults.leases.mode,
      "leases.run": defaults.leases.run,
    };
    for (const key of leafPaths(defaults.executor as unknown as Record<string, unknown>)) {
      const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], defaults.executor);
      expected[`executor.${key}`] = value;
    }
    const wrong: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      const cells = keyRow(doc, key);
      if (cells?.[2] !== defaultCell(value)) wrong.push(`${key}: doc ${cells?.[2] ?? "(no row)"}, code ${defaultCell(value)}`);
    }
    expect(wrong).toEqual([]);
    // every leaf of the resolved defaults is in the table above, so a new defaulted key cannot be forgotten here
    const { roles: _roles, applied: _applied, ...rest } = defaults as unknown as Record<string, unknown>;
    expect(leafPaths(rest).filter((key) => !(key in expected) && key !== "classifier.presets")).toEqual([]);
  });

  /** `[0, 0.9]`, `(0, 0.95]`: the lower and upper bound of a documented range and whether the lower one is excluded. */
  function parseRange(cell: string): { lo: number; hi: number; loExcluded: boolean } {
    const match = /^([[(])\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]$/.exec(cell.replace(/`/g, ""));
    if (match === null) throw new Error(`not a range: ${cell}`);
    return { lo: Number(match[2]), hi: Number(match[3]), loExcluded: match[1] === "(" };
  }

  const ranged: ReadonlyArray<readonly [key: string, block: string, field: string, integer: boolean]> = [
    ["margin", "", "margin", false],
    ["minClassConfidence", "", "minClassConfidence", false],
    ["classifier.timeoutMs", "classifier", "timeoutMs", true],
    ["classifier.maxStateChars", "classifier", "maxStateChars", true],
    ["outcomes.halfLifeDays", "outcomes", "halfLifeDays", false],
    ["outcomes.maxEffectiveSamples", "outcomes", "maxEffectiveSamples", false],
    ["sessionReuse.maxContextFraction", "sessionReuse", "maxContextFraction", false],
    ["advisor.noticeIntervalHours", "advisor", "noticeIntervalHours", false],
  ];
  const bundled = JSON.parse(read("tiers.json")) as Record<string, unknown>;
  const accepts = (routing: Record<string, unknown>): boolean => {
    try {
      validateConfig({ ...bundled, routing });
      return true;
    } catch {
      return false;
    }
  };
  const withValue = (block: string, field: string, value: number): Record<string, unknown> => (block === "" ? { [field]: value } : { [block]: { [field]: value } });

  it.each(ranged)("the documented range of %s is the range validateConfig enforces", (key, block, field, integer) => {
    const cells = keyRow(read("docs/CONFIG_REFERENCE.md"), key);
    expect(cells, `row ${key}`).toBeDefined();
    const { lo, hi, loExcluded } = parseRange(cells![3]!);
    expect(accepts(withValue(block, field, hi)), `${key} = ${hi}`).toBe(true);
    expect(accepts(withValue(block, field, hi + (integer ? 1 : 0.001))), `${key} above ${hi}`).toBe(false);
    expect(accepts(withValue(block, field, loExcluded ? lo : lo - (integer ? 1 : 0.001))), `${key} below ${lo}`).toBe(false);
    expect(accepts(withValue(block, field, loExcluded ? lo + 0.001 : lo)), `${key} = ${lo}`).toBe(true);
    // integer-only keys reject a fractional value inside the range, the others accept it, and the Type column says which (QA-3.1-R2-7)
    const half = lo + 0.5;
    expect(accepts(withValue(block, field, half)), `${key} = ${half}`).toBe(!integer);
    expect(cells![1], `${key} type`).toBe(integer ? "`integer`" : "`number`");
  });

  it("background.* and leases.* are documented as OpenCode v2 only, with the enum values and the range the code accepts (Phase 2.1)", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    const rows = {
      "background.mode": ["auto", "model", "off"],
      "leases.mode": ["enforce", "off"],
      "leases.run": ["annotate", "refuse"],
    } as const;
    for (const [key, values] of Object.entries(rows)) {
      const cells = keyRow(doc, key);
      expect(cells, `row ${key}`).toBeDefined();
      expect(cells![3]!.replace(/[\\`]/g, "").split("|").map((v) => v.trim())).toEqual([...values]);
      expect(cells![4], `${key} v2 only`).toContain("OpenCode v2 only");
      // QA-2.1-32: the v1 notice names the configured features (leases alone are not "background dispatch").
      const notice = key.startsWith("leases.") ? "leases require OpenCode v2" : "background dispatch requires OpenCode v2";
      expect(cells![4], `${key} v1`).toContain(`v1 ignores it and logs one notice per process (\`${notice}; ignored: <keys>\`) naming every configured key`);
      expect(cells![4], `${key} v1 both`).toContain("`background dispatch and leases require OpenCode v2; ignored: <keys>`");
    }
    const ms = keyRow(doc, "background.minPredictedMs");
    expect(ms?.[1]).toBe("`integer`");
    expect(parseRange(ms![3]!)).toEqual({ lo: 0, hi: 3_600_000, loExcluded: false });
    expect(ms![4]).toContain("OpenCode v2 only");
    expect(ms![4]).toContain("v1 ignores it and logs one notice per process (`background dispatch requires OpenCode v2; ignored: <keys>`) naming every configured key");
    // the code takes the documented bounds and falls back to the default outside them
    const minMs = (v: unknown) => resolveRouting(validateConfig({ ...bundled, routing: { background: { minPredictedMs: v } } }), "v2", { warn: () => {} }).background.minPredictedMs;
    resetRoutingWarnings();
    expect([minMs(0), minMs(3_600_000), minMs(3_600_001), minMs(-1), minMs(1.5)]).toEqual([0, 3_600_000, 45_000, 45_000, 45_000]);
    expect(configuredV2OnlyKeys({ routing: { background: { mode: "off" }, leases: { run: "refuse" } } })).toEqual([
      "routing.background.mode",
      "routing.leases.run",
    ]);
  });

  it("the three detection probabilities share the documented [0, 1] range and must not increase with a weaker check", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    for (const key of ["detection.deterministic", "detection.grader", "detection.none"]) {
      const { lo, hi } = parseRange(keyRow(doc, key)![3]!);
      expect([lo, hi]).toEqual([0, 1]);
    }
    const all = (v: number) => ({ detection: { deterministic: v, grader: v, none: v } });
    expect(accepts(all(0))).toBe(true);
    expect(accepts(all(1))).toBe(true);
    expect(accepts(all(1.001))).toBe(false);
    expect(accepts(all(-0.001))).toBe(false);
    expect(accepts({ detection: { deterministic: 0.5, grader: 0.7, none: 0.3 } })).toBe(false);
    expect(read("docs/CONFIG_REFERENCE.md")).toContain("`deterministic ≥ grader ≥ none`");
  });

  it("the sample count is 1 or 3, as documented", () => {
    const cells = keyRow(read("docs/CONFIG_REFERENCE.md"), "classifier.samples");
    expect(cells![3]).toBe("`1` or `3`");
    const withSamples = (samples: number) => ({ classifier: { samples } });
    expect([1, 3].map((n) => accepts(withSamples(n)))).toEqual([true, true]);
    expect([0, 2, 4].map((n) => accepts(withSamples(n)))).toEqual([false, false, false]);
  });

  it("the guide names every policy reason prefix of the decision log (QA-3.1-R2-1/2: kept:resume:pinned and the single prefix)", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    const prefixes = [FLOOR_LIFT_REASON, RESUME_REASON, RESUME_RUNNING_REASON, RESUME_PINNED_REASON, RESUME_NAMED_NEEDS_REASON, RESUME_NAMED_NEVER_DOWN_REASON];
    for (const prefix of prefixes) expect(doc, prefix).toContain(`\`${prefix}\``);
    expect(RESUME_PINNED_REASON.startsWith(RESUME_REASON) && RESUME_RUNNING_REASON.startsWith(RESUME_REASON)).toBe(true);
    // A34 (QA-G-B3): the refused-rewrite prefixes are resume rows too
    expect(RESUME_NAMED_NEEDS_REASON.startsWith(RESUME_REASON) && RESUME_NAMED_NEVER_DOWN_REASON.startsWith(RESUME_REASON)).toBe(true);
    // the kernel's reason codes lead a row once
    for (const code of ["switched", "kept:best-is-chosen", "kept:margin", "kept:evidence", "kept:pinned", "kept:class-confidence", "kept:no-candidates"]) expect(doc, code).toContain(`\`${code}\``);
  });

  it("effort-variant-mismatch and variant-effort are documented as the real advisor produces them: one warning per tier, by variant steps (QA-3.1-R3-1)", () => {
    const bundled = JSON.parse(read("tiers.json")) as Record<string, any>;
    const fixture = (variantSteps: "none" | undefined): RouterConfig => {
      const raw = structuredClone(bundled);
      raw.activePreset = "anthropic";
      raw.routing = { engine: "advise" };
      // medium = { variant: medium, effort: xhigh }: the effort differs from the variant
      raw.presets.anthropic.medium = { ...raw.presets.anthropic.medium, variant: "medium", effort: "xhigh" };
      if (variantSteps !== undefined) raw.enforcement.escalate = { ...raw.enforcement.escalate, variantSteps };
      return validateConfig(raw) as unknown as RouterConfig;
    };
    const idsOfMedium = (cfg: RouterConfig): string[] =>
      runAdvisor(cfg, { agents: [] }, null)
        .filter((f) => f.subject === "medium" && (f.id === "variant-effort" || f.id === "effort-variant-mismatch"))
        .map((f) => f.id);
    // a routing block, no explicit variantSteps: variant steps are on, `variant-effort` speaks and the mismatch finding stays silent
    expect(idsOfMedium(fixture(undefined))).toEqual(["variant-effort"]);
    // variant steps off: the other way round
    expect(idsOfMedium(fixture("none"))).toEqual(["effort-variant-mismatch"]);
    expect(runAdvisor(fixture("none"), { agents: [] }, null).filter((f) => f.id === "effort-variant-mismatch").map((f) => f.subject)).toEqual(["medium"]);

    const guide = read("docs/ROUTING_ENGINE.md");
    const row = guide.split(/\r?\n/).find((line) => line.startsWith("| `effort-variant-mismatch` |")) ?? "";
    expect(row).toContain("**and variant steps are off**");
    expect(row).toContain("`variant-effort` fires for the same tier instead");
    expect(row).toContain("one warning per tier");
    expect(guide).toContain("as `variant-effort` while variant steps are on");
    expect(guide).toContain("as `effort-variant-mismatch` when they are off");
    const adr = read("docs/adr/0005-cost-aware-routing-engine.md");
    expect(adr).toContain("as `variant-effort` while variant steps are on and as `effort-variant-mismatch` when they are off");
  });
  it("the guide documents the A7 effort evidence of Phase 3.2 and keeps the provider-acceptance caveat", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    expect(doc).toContain('{"type":"configuration_update","reasoning":{"effort"');
    expect(doc).toContain("host emission only");
    expect(doc).toMatch(/api\.openai\.com or api\.anthropic\.com honour the in-band effort is \*\*unverified\*\*/);
    expect(doc).not.toContain("The OpenAI Responses route was not exercised");
  });
  it("ADR 0005 has one `### D<n> —` heading for each of D1 to D18, in order", () => {
    const adr = read("docs/adr/0005-cost-aware-routing-engine.md");
    const numbers = [...adr.matchAll(/^### D(\d+) — /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    for (const amendment of ["A31", "A32", "A33"]) expect(adr, amendment).toContain(amendment);
  });

  it("D16: the package version is the newest dated CHANGELOG release, the first one after [Unreleased]; one PR closed both #74 and #73", () => {
    // Phase 3.4 prepared the D16 release without merging, tagging or publishing it. Later releases bump the package, so the
    // package and both lockfile roots have to agree with each other and with the first dated release after [Unreleased].
    // [Unreleased] may hold `###` subsections and entries (QA-P34-1-3 had wrongly required it to be empty).
    const version = JSON.parse(read("package.json")).version as string;
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    const changelog = read("CHANGELOG.md").replace(/\r\n/g, "\n");
    expect(changelogReleaseProblems(changelog, version)).toEqual([]);
    expect(changelog).toContain("## [2.3.0] - 2026-10-07");
    const pr = read("docs/qa/cost-aware-routing/pr-body.md").replace(/\r\n/g, "\n");
    expect(pr).toMatch(/^Closes #74$/m);
    expect(pr).toMatch(/^Closes #73$/m);
    expect(pr).toContain("@javizuurc");
    expect(pr).toContain("TypeSafe");
    const plan = read("docs/plans/cost-aware-routing-engine-plan.md");
    expect(plan).toContain("**D16 — Release `2.3.0`**, one PR, closes #74 and #73.");
    const adr = read("docs/adr/0005-cost-aware-routing-engine.md");
    const decision = adr.split("### D16 — ")[1]?.split("### D17 — ")[0];
    expect(decision).toContain("Release `2.3.0`, one PR");
    expect(decision).toContain("One pull request closes #74 and #73. Target version `2.3.0`.");
  });

  it("D16 detects a first dated release that is not the package version, a ## heading before it and a second [Unreleased]", () => {
    const valid = "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- An entry.\n\n## [2.4.0] - 2026-10-09\n\n### Added\n\n- x\n\n## [2.3.0] - 2026-10-07\n";
    expect(changelogReleaseProblems(valid, "2.4.0")).toEqual([]);
    expect(changelogReleaseProblems(valid.replace(/\n/g, "\r\n"), "2.4.0")).toEqual([]);
    expect(changelogReleaseProblems(valid.replace("### Changed\n\n- An entry.\n\n", ""), "2.4.0")).toEqual([]);
    expect(changelogReleaseProblems(valid, "2.5.0")).toEqual([
      "the first dated release after [Unreleased] is ## [2.4.0] - 2026-10-09, not 2.5.0",
    ]);
    expect(changelogReleaseProblems(valid.replace("## [2.4.0] - 2026-10-09\n\n### Added\n\n- x\n\n", ""), "2.4.0")).toEqual([
      "the first dated release after [Unreleased] is ## [2.3.0] - 2026-10-07, not 2.4.0",
    ]);
    expect(changelogReleaseProblems(valid.replace("### Changed", "## Changed"), "2.4.0")).toEqual([
      "a ## heading between [Unreleased] and the first dated release: ## Changed",
    ]);
    expect(changelogReleaseProblems(valid.replace("## [2.4.0] - 2026-10-09", "## [2.4.0]"), "2.4.0")).toEqual([
      "a ## heading between [Unreleased] and the first dated release: ## [2.4.0]",
      "the first dated release after [Unreleased] is ## [2.3.0] - 2026-10-07, not 2.4.0",
    ]);
    expect(changelogReleaseProblems(`${valid}\n## [Unreleased]\n`, "2.4.0")).toEqual(["expected one ## [Unreleased] heading, found 2"]);
    expect(changelogReleaseProblems("# Changelog\n\n## [Unreleased]\n\n- x\n", "2.4.0")).toEqual(["no dated release after [Unreleased]"]);
  });

  it("D17: the guide documents the stats mode line and the enforce-period window", () => {
    const guide = read("docs/ROUTING_ENGINE.md");
    expect(guide).toContain("D17 mode (use the DF4→DF5 enforce-period window)");
    expect(guide).toContain("zero failed enforced switches");
    expect(guide).toContain("n/a (0 enforced switches)");
  });

  it("the cost-doctor table of the guide lists every finding with the severity the code gives it", () => {
    const source = read("src/routing/advisor/findings.ts");
    const severities = new Map([...source.matchAll(/id: "([a-z-]+)",\s*severity: "(warning|saving|info)"/g)].map((m) => [m[1]!, m[2]!] as const));
    expect([...severities.keys()].sort()).toEqual([...FINDING_IDS].sort());
    const doc = read("docs/ROUTING_ENGINE.md");
    const wrong: string[] = [];
    for (const id of FINDING_IDS) {
      const row = doc.split(/\r?\n/).find((line) => line.startsWith(`| \`${id}\` |`));
      const cells = row?.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      if (cells?.[1] !== severities.get(id)) wrong.push(`${id}: doc ${cells?.[1] ?? "(no row)"}, code ${severities.get(id)}`);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Roles delegation keys (#84): the "Roles delegation" section of CONFIG_REFERENCE.md.
// ---------------------------------------------------------------------------

describe("docs drift: roles delegation keys (#84)", () => {
  const doc = read("docs/CONFIG_REFERENCE.md");
  const defaults = resolveRolesRouting(validateConfig(JSON.parse(read("tiers.json"))), "v2");
  const rolesKeys = [
    "routing.delegation", "roleAgents", "roleAgents.<name>.enabled", "roleAgents.<name>.description", "roleAgents.<name>.prompt",
    "roleAgents.<name>.tierRange", "roleAgents.<name>.budget", "roleAgents.<name>.deny", "routing.exploration.rate",
    "routing.exploration.requireDetection", "routing.run.scripts", "routing.run.commands", "routing.run.timeoutMs", "routing.workRoots",
    "routing.repoParents", "routing.repoDepth", "routing.repoExclude", "routing.repoApprovalDays",
    "routing.roleFloor",
  ];

  it("documents every key, and a missing one is detected", () => {
    expect(rolesKeys.filter((key) => keyRow(doc, key) === undefined)).toEqual([]);
    const fixture = rolesKeys.filter((key) => key !== "routing.workRoots").map((key) => `| \`${key}\` |`).join("\n");
    expect(rolesKeys.filter((key) => keyRow(fixture, key) === undefined)).toEqual(["routing.workRoots"]);
  });

  it("the Default column is what resolveRolesRouting applies", () => {
    const cell = (key: string) => keyRow(doc, key)?.[2];
    expect(cell("routing.delegation")).toBe(defaultCell(defaults.delegation));
    expect(cell("routing.roleFloor")).toBe(defaultCell(defaults.roleFloor));
    expect(defaults.roleFloor).toBe("strict");
    expect(keyRow(doc, "routing.roleFloor")?.[4]).toBe("tiers.json, global (stripped from the project layer)");
    const roleFloorNotice = "only tiers.json or the global override may set it";
    expect(read("src/router/config.ts")).toContain(roleFloorNotice);
    expect(doc.replace(/\s+/g, " ")).toContain(`this key is stripped from the project layer; ${roleFloorNotice}`);
    expect(cell("routing.exploration.rate")).toBe(defaultCell(defaults.exploration.rate));
    expect(cell("routing.exploration.requireDetection")).toBe(defaultCell(defaults.exploration.requireDetection));
    expect(cell("routing.run.timeoutMs")).toBe(defaultCell(defaults.run.timeoutMs));
    expect(cell("routing.run.scripts")).toBe(`\`${JSON.stringify(defaults.run.scripts).replace(/,/g, ", ")}\``);
    expect(cell("roleAgents")).toBe("`{}`");
    expect(cell("routing.workRoots")).toBe("`[]`");
    expect(defaults.workRoots).toEqual([]);
    expect(cell("routing.repoParents")).toBe("`[]`");
    expect(cell("routing.repoDepth")).toBe(defaultCell(defaults.repoDepth));
    expect(cell("routing.repoExclude")).toBe("`[]`");
    expect(cell("routing.repoApprovalDays")).toBe(defaultCell(defaults.repoApprovalDays));
    expect([defaults.repoParents, defaults.repoDepth, defaults.repoExclude, defaults.repoApprovalDays]).toEqual([[], 2, [], 14]);
    expect(Object.keys(defaults.run.commands)).toEqual(["test-files"]);
  });

  it("the resolved-defaults block is what resolveRolesRouting applies", () => {
    const block = /<!-- roles-defaults: v2 -->\s*```jsonc\r?\n([\s\S]*?)```/.exec(doc);
    expect(block).not.toBeNull();
    const documented = parseJsonc(block![1]!) as Record<string, unknown>;
    expect(documented.roleFloor).toBe("strict");
    const { inert: _inert, ...code } = defaults;
    expect(documented).toEqual(JSON.parse(JSON.stringify(code)));
  });

  it("the documented ranges are the ones the sanitisers enforce", () => {
    expect(keyRow(doc, "routing.exploration.rate")?.[3]).toBe(`\`[0, ${EXPLORATION_MAX_RATE}]\``);
    expect(sanitizeExploration({ rate: EXPLORATION_MAX_RATE }).issues).toEqual([]);
    expect(sanitizeExploration({ rate: EXPLORATION_MAX_RATE + 0.001 }).issues).toHaveLength(1);
    expect(keyRow(doc, "routing.run.timeoutMs")?.[3]).toBe(`\`[${RUN_TIMEOUT_BOUNDS.min}, ${RUN_TIMEOUT_BOUNDS.max}]\``);
    for (const [t, ok] of [[RUN_TIMEOUT_BOUNDS.min, true], [RUN_TIMEOUT_BOUNDS.max, true], [RUN_TIMEOUT_BOUNDS.min - 1, false], [RUN_TIMEOUT_BOUNDS.max + 1, false]] as const) {
      expect(sanitizeRun({ timeoutMs: t }).issues.length === 0, `timeoutMs ${t}`).toBe(ok);
    }
    const actions = (keyRow(doc, "roleAgents.<name>.deny")?.[3] ?? "").match(/[a-z_0-9]+(?=[ `\\|])/g) ?? [];
    for (const action of AUTHORITY_ACTIONS) expect(actions, action).toContain(action);
  });

  it("states the command-argument pattern rule and the workRoots rules the code enforces", () => {
    const text = doc.replace(/\s+/g, " ");
    expect(text).toContain("an exact string or a prefix ending in `*`");
    expect(text).toContain("canonical long form");
    expect(text).toContain("`*` crosses separators");
    expect(workRootProblem("D:/git/omr-rta-*")).toBeUndefined();
    expect(workRootProblem("D:/**")).toBeDefined();
    expect(workRootProblem("D:/PROGRA~1/x")).toBeDefined();
    expect(text).toContain("roles delegation requires OpenCode v2; using tiers");
    expect(ROLES_V1_NOTICE).toBe("roles delegation requires OpenCode v2; using tiers");
    expect(text).toContain("never `test/../../x`");
    expect(text).toContain("`D:/git/OMR-RT~1*` and `D:/git/*/PROGRA~1/x` included");
    expect(workRootProblem("D:/git/OMR-RT~1*")).toBeDefined();
    expect(workRootProblem("D:/git/*/PROGRA~1/x")).toBeDefined();
  });

  it("quotes the role-table notice prefix and failure notice the code emits (QA-P11-2)", () => {
    const text = doc.replace(/\s+/g, " ");
    expect(text).toContain(`each starting with \`${ROLE_NOTICE_PREFIX}\``);
    expect(text).toContain("`roles: the role table could not be resolved (<reason>); no role agent will be registered`");
    expect(text).toContain("`costRatio` orders against their names");
  });

  it("states the role rules the code enforces (QA-P11-1)", () => {
    const text = doc.replace(/\s+/g, " ");
    // custom prompts end with the router contract block
    expect(text).toContain(`\`${CONTRACT_HEADING}\``);
    // host-native role names
    for (const name of HOST_NATIVE_ROLE_NAMES) expect(text).toContain(`\`${name}\` replaces the host's native \`${name}\`, in roles mode only`);
    // assurance defaults
    const deterministic = SHIPPED_ROLE_SPECS.filter((s) => s.assurance === "deterministic").map((s) => s.agent);
    expect(deterministic).toEqual(["runner"]);
    expect(SHIPPED_ROLE_SPECS.filter((s) => s.assurance !== "deterministic").every((s) => s.assurance === "none")).toBe(true);
    expect(text).toContain("`runner` ships `deterministic`");
    expect(text).toContain("every other role ships `none`");
    // defining classes named in the doc
    expect([DEFINING_CLASS.research, DEFINING_CLASS.run]).toEqual(["egress", "exec"]);
    expect(Object.entries(DEFINING_CLASS).filter(([k]) => k !== "research" && k !== "run").every(([, c]) => c === "local")).toBe(true);
    expect(text).toContain("(`researcher`: egress; `runner`: `router_run`; every other role: local reads)");
    // exploration is off outside roles mode
    expect(resolveRolesRouting(validateConfig({ ...JSON.parse(read("tiers.json")), routing: { exploration: { rate: 0.1 } } }), "v2").exploration.rate).toBe(0);
    expect(text).toContain("`routing.exploration.rate` is then `0`");
  });

  it("states the script rule router_run applies: exact names, no wildcard entries", () => {
    const text = doc.replace(/\s+/g, " ");
    // plan amendment R9: exact names only; the sanitiser drops a wildcard entry
    expect(text).toContain("matched exactly (no wildcards");
    expect(text).toContain("a `*` entry is dropped with a notice");
    expect(sanitizeRun({ scripts: ["test:*"] }).issues).toHaveLength(1);
    expect(sanitizeRun({ scripts: ["test:unit"] }).issues).toEqual([]);
    expect(text).not.toContain("any `test:*` script is always allowed");
  });
});

// ---------------------------------------------------------------------------
// Roles mode guide (#84 P3.2): docs/ROLES.md, ADR 0006, the CHANGELOG entry.
// The roles table is SHIPPED_ROLE_SPECS and the floor table is authorityFloor.
// ---------------------------------------------------------------------------

const ROLES_DOCS = [
  "docs/ROLES.md",
  "docs/adr/0006-role-tier-assurance-delegation.md",
  "docs/READ_ONLY_TIERS.md",
] as const;

/** Cells of a markdown table line (unescaped pipes only). */
function cellsOf(line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
}

/** The table right after `<!-- marker -->`: its header cells and its body rows (separator dropped). */
function tableAfter(doc: string, marker: string): { header: string[]; rows: string[][] } | undefined {
  const lines = doc.split(/\r?\n/);
  let i = lines.findIndex((line) => line.trim() === `<!-- ${marker} -->`);
  if (i < 0) return undefined;
  i += 1;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  const table: string[][] = [];
  for (; i < lines.length && lines[i]!.trim().startsWith("|"); i += 1) table.push(cellsOf(lines[i]!.trim()));
  if (table.length < 2) return undefined;
  return { header: table[0]!, rows: table.slice(2) };
}

const tick = (text: string): string => `\`${text}\``;

/** The roles-table row the guide must print for a shipped spec. */
function expectedRoleRow(spec: RoleSpec): string[] {
  return [
    tick(spec.agent),
    tick(spec.kind),
    spec.description,
    tick(spec.authority.mode),
    spec.authority.allow.map(tick).join(", "),
    `${tick(spec.tierRange.floor)}–${tick(spec.tierRange.ceiling)}`,
    tick(spec.assurance),
    tick(spec.guard),
    Object.entries(spec.budget).map(([tier, n]) => `${tick(tier)} ${n}`).join(" · "),
    String(roleAgentSteps(spec)),
  ];
}

/** The header of the guide's roles table: the columns {@link expectedRoleRow} fills, in its order. */
const ROLE_TABLE_HEADER: readonly string[] = [
  "Agent", "Kind", "Shipped description (intent)", "Authority mode", "Authority (max)", "Tier range", "Default assurance", "Guard",
  "Budget (calls per tier)", "Host steps",
];

/** Every difference between the guide's roles table and `specs`, cell by cell (header included). */
function roleTableProblems(doc: string, specs: readonly RoleSpec[]): string[] {
  const table = tableAfter(doc, "roles-table");
  if (table === undefined) return ["no roles table"];
  const problems: string[] = [];
  if (JSON.stringify(table.header) !== JSON.stringify(ROLE_TABLE_HEADER)) problems.push(`header ${table.header.join(" | ")}`);
  const byAgent = new Map(table.rows.map((row) => [row[0] ?? "", row] as const));
  for (const spec of specs) {
    const row = byAgent.get(tick(spec.agent));
    if (row === undefined) {
      problems.push(`${spec.agent}: no row`);
      continue;
    }
    const want = expectedRoleRow(spec);
    if (row.length !== want.length) problems.push(`${spec.agent}: ${row.length} cells, code ${want.length}`);
    want.forEach((cell, index) => {
      if (row[index] !== cell) problems.push(`${spec.agent} column ${index + 1}: doc ${row[index] ?? "(none)"}, code ${cell}`);
    });
  }
  for (const agent of byAgent.keys()) if (!specs.some((spec) => tick(spec.agent) === agent)) problems.push(`${agent}: not a shipped role`);
  return problems;
}

/** Floor-table rows: the grants each row stands for (every one must give the documented tier). */
const FLOOR_ROWS: Readonly<Record<string, ReadonlyArray<readonly AuthorityAction[]>>> = {
  "no write (local, egress or exec only)": [
    [], ["read", "glob", "grep", "router_git"], ["webfetch", "websearch", "context7"], ["router_run"], ["read", "glob", "grep", "router_git", "router_run"],
  ],
  "write without exec": [["edit"], ["read", "glob", "grep", "router_git", "edit"]],
  "write + exec": [["edit", "router_run"], ["read", "glob", "grep", "router_git", "edit", "router_run"]],
};
const FLOOR_COLUMNS: readonly Detection[] = ["deterministic", "grader", "none"];
const RISKS: readonly Risk[] = ["low", "medium", "high"];
const SCOPES: readonly Scope[] = ["single", "multi", "repo"];

/** The tier a floor-table cell names for `risk` and `scope`; undefined for a cell of no known shape. */
function floorCell(cell: string, risk: Risk, scope: Scope): string | undefined {
  const plain = /^`(\w+)`$/.exec(cell);
  if (plain !== null) return plain[1];
  const both = /^`(\w+)` if risk `(\w+)` and scope `(\w+)`, else `(\w+)`$/.exec(cell);
  if (both !== null) return risk === both[2] && scope === both[3] ? both[1] : both[4];
  const riskOnly = /^`(\w+)`; `(\w+)` if risk `(\w+)`$/.exec(cell);
  if (riskOnly !== null) return risk === riskOnly[3] ? riskOnly[2] : riskOnly[1];
  return undefined;
}

/** Every (row, detection, risk, scope, grant) where the guide's floor table and `floor` disagree. */
function floorTableProblems(doc: string, floor: typeof authorityFloor): string[] {
  const table = tableAfter(doc, "authority-floor-table");
  if (table === undefined) return ["no floor table"];
  const problems: string[] = [];
  if (JSON.stringify(table.header.slice(1)) !== JSON.stringify(FLOOR_COLUMNS.map(tick))) problems.push(`columns ${table.header.join(" | ")}`);
  const labels = table.rows.map((row) => row[0] ?? "");
  if (JSON.stringify(labels) !== JSON.stringify(Object.keys(FLOOR_ROWS))) problems.push(`rows ${labels.join(" / ")}`);
  for (const row of table.rows) {
    const grants = FLOOR_ROWS[row[0] ?? ""];
    if (grants === undefined) continue;
    FLOOR_COLUMNS.forEach((detection, column) => {
      const cell = row[column + 1] ?? "";
      for (const risk of RISKS) {
        for (const scope of SCOPES) {
          const documented = floorCell(cell, risk, scope);
          if (documented === undefined) {
            problems.push(`${row[0]} / ${detection}: unreadable cell ${cell}`);
            return;
          }
          for (const actions of grants) {
            const code = floor({ actions: new Set(actions), notes: [], workRoot: null }, detection, risk, scope);
            if (code !== documented) problems.push(`${row[0]} / ${detection} / ${risk} / ${scope} / ${actions.join("+") || "no action"}: doc ${documented}, code ${code}`);
          }
        }
      }
    });
  }
  return problems;
}

/** Reuse every strict-table pin for the separately marked gated table, with a live return gate. */
function gatedFloorTableProblems(doc: string, floor: typeof authorityFloor = authorityFloor): string[] {
  const marker = "<!-- authority-floor-gated-table -->";
  const at = doc.indexOf(marker);
  if (at < 0) return ["no gated floor table"];
  const table = doc.slice(at).replace(marker, "<!-- authority-floor-table -->");
  return floorTableProblems(table, (grant, detection, risk, scope) =>
    floor(grant, detection, risk, scope, { mode: "gated", gateAtReturn: true }));
}

describe("docs drift: roles mode guide, ADR 0006 and changelog (#84 P3.2)", () => {
  const guide = read("docs/ROLES.md");
  const flat = guide.replace(/\r?\n>\s?/g, " ").replace(/\s+/g, " ");

  it("the roles table of ROLES.md is SHIPPED_ROLE_SPECS, cell by cell", () => {
    expect(SHIPPED_ROLE_SPECS.length).toBe(7);
    expect(roleTableProblems(guide, SHIPPED_ROLE_SPECS)).toEqual([]);
  });

  it("detects a changed cell, a missing row and an extra row of the roles table", () => {
    const changed = guide.replace("| `fast` 30 · `medium` 40 | 95 |", "| `fast` 31 · `medium` 40 | 95 |");
    expect(changed).not.toBe(guide);
    expect(roleTableProblems(changed, SHIPPED_ROLE_SPECS)).toEqual(["explorer column 9: doc `fast` 31 · `medium` 40, code `fast` 30 · `medium` 40"]);
    const missing = guide.split(/\r?\n/).filter((line) => !line.startsWith("| `general` |")).join("\n");
    expect(roleTableProblems(missing, SHIPPED_ROLE_SPECS)).toEqual(["general: no row"]);
    const narrowed = SHIPPED_ROLE_SPECS.filter((spec) => spec.agent !== "architect");
    expect(roleTableProblems(guide, narrowed)).toEqual(["`architect`: not a shipped role"]);
    const widened = SHIPPED_ROLE_SPECS.map((spec) => (spec.agent === "reviewer" ? { ...spec, authority: { ...spec.authority, allow: [...spec.authority.allow, "edit" as const] } } : spec));
    expect(roleTableProblems(guide, widened)).toEqual([
      "reviewer column 5: doc `read`, `glob`, `grep`, `router_git`, `router_run`, code `read`, `glob`, `grep`, `router_git`, `router_run`, `edit`",
    ]);
    expect(roleTableProblems("# no table\n", SHIPPED_ROLE_SPECS)).toEqual(["no roles table"]);
    // swapped header columns: the rows still match by position, the header pin catches the mislabelling
    const swapped = guide.replace("| Tier range | Default assurance |", "| Default assurance | Tier range |");
    expect(swapped).not.toBe(guide);
    expect(roleTableProblems(swapped, SHIPPED_ROLE_SPECS)).toEqual([
      `header ${[...ROLE_TABLE_HEADER.slice(0, 5), "Default assurance", "Tier range", ...ROLE_TABLE_HEADER.slice(7)].join(" | ")}`,
    ]);
  });

  it("the floor table of ROLES.md is authorityFloor for every grant, detection, risk and scope", () => {
    expect(floorTableProblems(guide, authorityFloor)).toEqual([]);
  });

  it("the gated floor table is authorityFloor with a return gate for every grant, detection, risk and scope", () => {
    expect(gatedFloorTableProblems(guide)).toEqual([]);
    expect(flat).toContain('`routing.roleFloor: "strict"`, the default');
    expect(flat).toContain('`routing.roleFloor: "gated"`, opt-in, global only, OpenCode v2 only');
    expect(flat).toContain("Otherwise the strict table applies.");
    expect(flat).toContain("Deferred `testsPass` does not qualify.");
    expect(flat).toContain("`raise:verification-fail:heavy`");
    expect(flat).toContain("the next tier above `medium` within the role's ceiling and active tier order is `heavy`");
    expect(flat).toContain("only when gating lowers the final floor compared with strict");
    expect(flat).toContain("For gated children, **UNVERIFIABLE** at return also records the same raise");
  });

  it("detects gated table cell and code mutations without weakening the strict-table pins", () => {
    const cell = "| write + exec | `medium` | `medium`; `heavy` if risk `high` | `heavy` |";
    const changed = guide.replace(cell, "| write + exec | `medium` | `heavy` | `heavy` |");
    expect(changed).not.toBe(guide);
    const problems = gatedFloorTableProblems(changed);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => /^write \+ exec \/ grader \/ (low|medium) \//.test(problem))).toBe(true);
    expect(floorTableProblems(changed, authorityFloor)).toEqual([]);
    const strictMutant: typeof authorityFloor = (grant, detection, risk, scope) => authorityFloor(grant, detection, risk, scope);
    expect(gatedFloorTableProblems(guide, strictMutant)).toEqual(problems.map((problem) => problem.replace("doc heavy, code medium", "doc medium, code heavy")));
    const noHighRiskGuard: typeof authorityFloor = (grant, detection, risk, scope, policy) =>
      grant.actions.has("edit") && grant.actions.has("router_run") && detection === "grader"
        ? "medium" : authorityFloor(grant, detection, risk, scope, policy);
    const highRisk = gatedFloorTableProblems(guide, noHighRiskGuard);
    expect(highRisk.length).toBeGreaterThan(0);
    expect(highRisk.every((problem) => problem.startsWith("write + exec / grader / high /"))).toBe(true);
    expect(gatedFloorTableProblems(guide.replace(cell, cell.replace("`medium`; `heavy` if risk `high`", "medium-ish"))))
      .toEqual(["write + exec / grader: unreadable cell medium-ish"]);
    expect(gatedFloorTableProblems("no table")).toEqual(["no gated floor table"]);
  });

  it("D4 records the opt-in cell and the FAIL-to-heavy safety net", () => {
    const d4 = sectionOf(read("docs/adr/0006-role-tier-assurance-delegation.md"), "### D4 — The tier floor is authority × effective detection").replace(/\s+/g, " ");
    for (const text of ['`routing.roleFloor: "strict" | "gated"` defaults to `strict`', "global-only", "inert on OpenCode v1",
      "effective detection `grader`", "other than `high`", "verification actually runs at return (not deferred,",
      "acceptance other than `none`", "`gated:authority`", "FAIL → heavy safety net", "`raise:verification-fail:heavy`"]) {
      expect(d4, text).toContain(text);
    }
    expect(d4).toContain("the next tier above `medium` within the role's ceiling and active tier order is `heavy`");
    expect(d4).toContain("only when gating lowers the final floor compared with strict");
    expect(d4).toContain("For gated children, UNVERIFIABLE at return also records the same raise");
  });

  it("detects a floor cell that differs from the code, a code change and an unreadable cell", () => {
    const changed = guide.replace("| write + exec | `medium` |", "| write + exec | `fast` |");
    expect(changed).not.toBe(guide);
    const problems = floorTableProblems(changed, authorityFloor);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.startsWith("write + exec / deterministic /"))).toBe(true);
    // a code change the doc does not follow: high risk no longer lifts write without detection to heavy
    const mutant: typeof authorityFloor = (grant, detection, risk, scope) =>
      grant.actions.has("edit") && !grant.actions.has("router_run") && detection === "none" ? "medium" : authorityFloor(grant, detection, risk, scope);
    const drift = floorTableProblems(guide, mutant);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((p) => p.startsWith("write without exec / none / high /"))).toBe(true);
    const unreadable = guide.replace("| `medium` | `heavy` | `heavy` |", "| `medium` | heavy-ish | `heavy` |");
    expect(floorTableProblems(unreadable, authorityFloor)).toEqual(["write + exec / grader: unreadable cell heavy-ish"]);
    expect(floorTableProblems("no table", authorityFloor)).toEqual(["no floor table"]);
  });

  it("the action-class table names every role action in exactly one row, the row of its class", () => {
    const rows = guide.split(/\r?\n/).filter((line) => /^\| (local|exec|write|egress) \|/.test(line)).map(cellsOf);
    expect(rows.map((row) => row[0])).toEqual(["local", "exec", "write", "egress"]);
    const hostName = (action: string): string => (action === "router_git" ? "router_git_*" : action === "context7" ? "context7_*" : action);
    /** Actions not named in exactly one row, the row of their class. */
    const misplaced = (table: readonly string[][]): string[] => Object.entries(ACTION_CLASS)
      .filter(([action, cls]) => {
        const naming = table.filter((row) => (row[1] ?? "").includes(tick(hostName(action)))).map((row) => row[0]);
        return JSON.stringify(naming) !== JSON.stringify([cls]);
      })
      .map(([action]) => action);
    expect(misplaced(rows)).toEqual([]);
    // negative fixtures: an action listed under a second class, and one moved to the wrong class
    const edited = (cls: string, cell: (text: string) => string): string[][] => rows.map((row) => (row[0] === cls ? [cls, cell(row[1] ?? "")] : row));
    expect(misplaced(edited("exec", (text) => `${text}, \`edit\``))).toEqual(["edit"]);
    const grepMoved = edited("local", (text) => text.replace("`grep`, ", "")).map((row) => (row[0] === "egress" ? ["egress", `${row[1]}, \`grep\``] : row));
    expect(misplaced(grepMoved)).toEqual(["grep"]);
  });

  it("states what the code does with the role default assurance, the run signal, work-root checks and budgets (QA-P32-1)", () => {
    // default assurance is descriptive: with no gate, claim or [acceptance] block a dispatch is `none`, whatever the role
    expect(effectiveDetection({ routerGate: false, claim: null, acceptance: null })).toBe("none");
    expect(flat).toContain("The role's default assurance in the table below is descriptive only: it never raises or lowers a dispatch's detection.");
    expect(read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ")).toContain("This default is descriptive only and never enters the routing");
    // the run signal: only npm-script-form checks; none → no signal
    expect(runSignal({ childSessionID: "c", runs: [], edits: [], editsObserved: true, acceptance: [] } as unknown as Parameters<typeof runSignal>[0])).toBeNull();
    expect(flat).toContain("**The `run` signal matches npm-script-form checks only.**");
    expect(flat).toContain("A dispatch with no check of that form gets no `run` signal.");
    // P2c.2: any check with its own cwd= drops the run signal for the whole dispatch (acceptanceScriptsOf)
    expect(flat).toContain("A dispatch where any acceptance check has its own `cwd=` (even a relative one inside the work root) gets no run signal at all: such a check may not run in the work root, so no check of that dispatch is credited.");
    // acceptance checks in the work root (DF2-F1 fixed)
    expect(flat).toContain("**Acceptance checks run in the work root.**");
    expect(flat).toContain("a `cwd:` outside that root is refused");
    expect(guide).not.toContain("DF2-F1");
    // dispatch rows vs annotation rows; budgetUsed is not written
    for (const doc of [guide, read("docs/ROUTING_ENGINE.md")]) expect(doc).not.toContain("budgetUsed");
    expect(flat).toContain("`note:binding:<kind>` row with `binding`");
    expect(flat).toContain("`note:signal:<kind>:<pass|fail|none>` row with `signal`");
    // a floor above the role's ceiling: the role has no budget for that tier → the tier agents' budget
    const explorer = SHIPPED_ROLE_SPECS.find((spec) => spec.agent === "explorer")!;
    expect(Object.hasOwn(explorer.budget, "heavy")).toBe(false);
    // QA-G-A3-7: max(the ceiling tier's role budget, the tier agents' budget) — the explorer's medium budget (40) here.
    expect(roleGuardProfile(explorer, "heavy").budget).toBe(Math.max(explorer.budget[explorer.tierRange.ceiling]!, TIER_GUARD_BUDGET));
    expect(flat).toContain(`the dispatch gets max(the role's budget for its ceiling tier, ${TIER_GUARD_BUDGET}) calls`);
    // negative: the pre-QA-G-A3-7 sentence (a flat tier-agent budget) is gone
    expect(flat).not.toContain(`the dispatch gets the tier agents' ${TIER_GUARD_BUDGET} calls`);
    expect(flat).toContain("has a read-only call cap only when it carries `CAP:N` or `CAP:none`");
  });

  it("quotes the budget, steps, signal, exploration and router_run numbers of the code", () => {
    expect(flat).toContain(`${ROUTE_BUDGET_RAISE_MAX} × max(top role budget, ${TIER_GUARD_BUDGET}) + \`REFUSAL_CAP\` + ${ROLE_STEPS_MARGIN}`);
    expect(flat).toContain(`\`REFUSAL_CAP\` = ${REFUSAL_CAP}`);
    expect(flat).toContain(`+ \`REFUSAL_CAP\` (${REFUSAL_CAP}) + ${ROLE_STEPS_MARGIN}`);
    expect(flat).toContain(`never above ${ROUTE_BUDGET_RAISE_MAX} ×`);
    expect(flat).toContain(`total × ${GUARD_CUMULATIVE_MULTIPLIER}`);
    expect(flat).toContain(`unchanged: ${TIER_GUARD_BUDGET} calls, cumulative × ${GUARD_CUMULATIVE_MULTIPLIER}`);
    expect(flat).toContain(`(${[...new Set(SHIPPED_ROLE_SPECS.map(roleAgentSteps))].join(" or ")} for the shipped roles)`);
    expect(flat).toContain(`| \`verdict\` | ${SIGNAL_WEIGHTS.deterministic} (pass or fail) |`);
    expect(flat).toContain(`| \`run\` | ${SIGNAL_WEIGHTS.run} (success only) |`);
    expect(SIGNAL_MASS_CAPS.run.negative).toBe(0);
    expect(flat).toContain(`| \`grader\` | ${SIGNAL_WEIGHTS.grader} (pass or fail) |`);
    expect(flat).toContain(`| \`incomplete\` | ${SIGNAL_WEIGHTS.incomplete} (failure) |`);
    expect(flat).toContain(`| \`redispatch\` | ${SIGNAL_WEIGHTS.redispatch} (failure, on the earlier attempt) |`);
    expect(flat).toContain(`| \`budget\`, \`authority\` | ${SIGNAL_WEIGHTS.recorded} (recorded, no tier penalty) |`);
    expect(flat).toContain(`within ${REDISPATCH_WINDOW_MS / 60_000} minutes`);
    expect(MAX_EXPLORATION_RATE).toBe(EXPLORATION_MAX_RATE);
    expect(flat).toContain(`at most \`${MAX_EXPLORATION_RATE}\``);
    expect(flat).toContain(`starting with \`${ROUTER_BUDGET_NOTE_PREFIX}\``);
    expect(flat).toContain(`\`${RUN_ARG_RE.source}\` (at most ${RUN_MAX_ARGS} arguments)`);
    expect(flat).toContain(`(default ${DEFAULT_RUN_TIMEOUT_MS} ms)`);
    expect(flat).toContain(`output bounded to ${RUN_OUTPUT_BYTES / 1024} KiB`);
  });

  it("quotes the notices, grant notes and denied actions the code emits", () => {
    expect(flat).toContain(ROLES_V1_NOTICE);
    expect(flat).toContain(ROLES_RESTART_NOTICE);
    for (const note of [GRANT_NOTES.shell, GRANT_NOTES.web, GRANT_NOTES.noWorkRoot]) expect(flat).toContain(note);
    const denied = `${ROLE_DENIED_ACTIONS.slice(0, -1).map(tick).join(", ")} and ${tick(ROLE_DENIED_ACTIONS[ROLE_DENIED_ACTIONS.length - 1]!)} denied explicitly`;
    expect(flat).toContain(denied);
    for (const key of ["routing.delegation", "roleAgents", "routing.exploration.rate", "routing.exploration.requireDetection", "routing.run.scripts",
      "routing.run.commands", "routing.run.timeoutMs", "routing.workRoots", "routing.repoParents", "routing.repoDepth",
      "routing.repoExclude", "routing.repoApprovalDays", "routing.roleFloor"]) expect(guide, key).toContain(`\`${key}`);
  });

  it("cross-repo Phase 4: quotes the /router approve help lines, the refusal note and the reload/restart lines the code emits", async () => {
    for (const line of ROUTER_APPROVAL_HELP_LINES) expect(flat, line).toContain(line);
    const identity = { path: "<path>", commonDir: "<path>\\.git", roots: ["0".repeat(40)], origin: "<origin>", branch: "<branch>", head: "<head7>" };
    const note = await approvalNote("<path>", { inspect: async () => identity as unknown as Awaited<ReturnType<typeof inspectCandidate>> });
    expect(note).toBe("<path> is a git repository outside routing.repoParents (origin <origin>, branch <branch> at <head7>). Only the user can approve it: ask the user to run /router approve <path>, then dispatch again.");
    expect(flat).toContain(note);
    const problem = await approvalNote("<path>", { inspect: async () => "<problem>" });
    expect(flat).toContain(problem);
    expect(flat).toContain(`within ${APPROVAL_NOTE_TIMEOUT_MS / 1000} seconds`);
    // The guide says the approval applies after the reload (spike T6), with the restart line as the fallback.
    expect(APPROVAL_RELOAD_APPLIES).toBe(true);
    const approve = { kind: "approve", path: "<path>" } as const;
    const revoke = { kind: "revoke", path: "<path>" } as const;
    for (const line of [
      approvalReloadLine(approve, APPROVAL_RELOAD_APPLIES),
      approvalReloadLine(revoke, APPROVAL_RELOAD_APPLIES),
      approvalReloadLine(approve, APPROVAL_RELOAD_APPLIES, "<error>"),
      approvalReloadLine(revoke, APPROVAL_RELOAD_APPLIES, "<error>"),
    ]) expect(flat, line).toContain(line);
    expect(flat).toContain(`; ${APPROVE_MAIN_WORKTREE}`);
    expect(flat).toContain(`(global only, 1–${REPO_APPROVAL_CAP_DAYS}, default ${DEFAULT_REPO_APPROVAL_DAYS})`);
    expect(flat).toContain(`${REPO_APPROVAL_CAP_DAYS} days after it was approved at the latest`);
    expect(flat).toContain(`At most ${MAX_APPROVALS} approvals and ${MAX_APPROVALS_BYTES / 1024} KiB`);
    expect(flat).toContain(`\`${APPROVALS_FILE_NAME}\``);
    expect(read("docs/CONFIG_REFERENCE.md")).toContain(`\`${APPROVALS_FILE_NAME}\``);
    const unreleased = /## \[2\.8\.0\] - 2026-10-13([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("Approve repositories outside routing.repoParents with /router approve (OpenCode v2, roles mode; inert on v1) (#107).");
    const design = read("docs/design/cross-repo.md").replace(/\s+/g, " ");
    expect(design).toContain("| D29 | 2026-10-12 | Phase 4 channel: a human-typed `/router approve` command instead of a permission ask");
    expect(design).not.toContain("A first-use approval was requested (Phase 4)");
  });

  it("ADR 0006 has D1–D13 in order, the evidence E1–E13 and only the literature L1–L14", () => {
    const adr = read("docs/adr/0006-role-tier-assurance-delegation.md");
    expect([...adr.matchAll(/^### D(\d+) — /gm)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect([...adr.matchAll(/^\| E(\d+) \|/gm)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect([...adr.matchAll(/^- \[L(\d+)\] /gm)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    const cited = new Set([...adr.matchAll(/\bL(\d+)\b/g)].map((m) => Number(m[1])));
    expect([...cited].filter((n) => n < 1 || n > 14)).toEqual([]);
    expect([...adr.matchAll(/^\| RH(\d+) \|/gm)].map((m) => Number(m[1]))).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("the changelog lists roles mode and the §2.9 behaviour changes under [2.4.0]", () => {
    const unreleased = /## \[2\.4\.0\] - 2026-10-09([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("Roles mode: role × tier × assurance delegation (#84)");
    expect(unreleased).toContain("(docs/ROLES.md)");
    expect(unreleased).toContain("Behaviour change (#84)");
    for (const item of ["Reader guard profile.", "Uncharged denials.", "Whole criteria.", "Header strip.", "Progress notes are incomplete.", "`root=` in the header.",
      "The budget claim is read from the return prefix", "downgrading past this version is unsupported"]) expect(unreleased, item).toContain(item);
    expect(unreleased).toContain(`Explicit \`[acceptance]\` lists over ${CRITERIA_BUDGET_CHARS} code points are no longer graded in full`);
    // QA-P32-1-5: R8(3), R8(2), R8(7), R7 single-dash, R7 cost-inverted roles, the v2-only class reader case
    expect(unreleased).toContain("After a verification FAIL of a role child the router raises its tier on the next resume itself; the orchestrator never sets `tier=` or `model`.");
    expect(unreleased).toContain(`Role agents' host \`steps\` = ${ROUTE_BUDGET_RAISE_MAX} × max(the top role budget, ${TIER_GUARD_BUDGET}) + \`REFUSAL_CAP\` (${REFUSAL_CAP}) + ${ROLE_STEPS_MARGIN}.`);
    expect(unreleased).toContain("A role dispatch has a read-only call cap only when it carries `CAP:N` or `CAP:none`.");
    expect(unreleased).toContain("single-dash arguments carrying `/`, `\\` or `..` are refused");
    expect(unreleased).toContain("A role whose tier range the active preset's `costRatio` orders against the tier names is disabled with a notice.");
    expect(unreleased).toContain("`class=review|recon|search` (OpenCode v2 with a routing engine other than `static`; never on v1)");
    expect(unreleased).toContain("the `run` signal matches npm-script-form checks only");
    expect(unreleased).toContain("A role dispatch's acceptance checks run in its work root; a `cwd:` outside it is refused.");
    expect(unreleased).not.toContain("budgetUsed");
  });

  it("P2b.6: checks in other repositories — the texts of the code are in VERIFICATION.md, the protocol and the [Unreleased] entry", () => {
    const verification = read("docs/VERIFICATION.md").replace(/\s+/g, " ");
    const section = /## Checks in other repositories([\s\S]*?)\n## /.exec(read("docs/VERIFICATION.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(section).not.toBe("");
    const gate = read("src/verify/gate.ts");
    const deterministic = read("src/verify/deterministic.ts");
    // code-to-doc: each fragment is in the source that emits it AND in the section
    const pinned: Array<[string, string]> = [
      [gate, "a per-check cwd= is honoured only in roles mode; nothing ran"],
      [gate, "is not affected or full; nothing ran"],
      [gate, "and its read set; nothing ran"],
      [gate, "is not covered by any check root ("],
      [gate, "links this work root (node_modules/"],
      [gate, "and no check ran there; add a check such as: check: testsPass cwd="],
      [gate, "the change in the work root could not be observed and no check runs there ("],
      [gate, "consumer discovery stopped before finishing "],
      [gate, "; a repository there may link this work root unchecked; add a check such as: check: testsPass cwd="],
      [gate, "no check root"],
      [deterministic, "runs in another repository ("],
      [deterministic, "and must use scope=full: affected tests cannot be attributed to a change in the work root"],
      [deterministic, "failed; the change under verification is in the work root, so this failure can be neither excused nor attributed: "],
    ];
    for (const [source, fragment] of pinned) {
      expect(source, fragment).toContain(fragment);
      expect(section, fragment).toContain(fragment);
    }
    expect(section).toContain(`\`${FOREIGN_REFERENCE_NONE}\``);
    // the user-facing syntax and the caveats of the section
    for (const text of ["check: testsPass cwd=\"D:\\git\\app-a\" scope=full", "`scope=affected|full`", "A relative `cwd=` stays inside `W`", "must be inside `W` or in the read set",
      "unverifiable** and nothing runs", "unverifiable, never a fail", "gets no reference", "UNVERIFIED", "may be deferred like any other (`VERIFY:deferred`, the default)", "It is verified at once, not deferred, only in the cases listed there.", "A `scope=` alone is ignored there",
      "On OpenCode v1 the keys are ignored", "(I2)", "(I3)", "gives no run signal",
      "a check whose repository top contains the change root", "(no check root)"]) expect(section, text).toContain(text);
    expect(read("docs/ROLES.md").replace(/\s+/g, " ")).toContain("(./VERIFICATION.md#checks-in-other-repositories)");
    expect(verification).toContain("link pins");
    // the configured protocol teaches cwd= / scope=full; the default one does not
    const protocol = read("src/router/protocol.ts");
    expect(protocol).toContain("A check may run in another repository of the read set with cwd= and must then use scope=full");
    expect(protocol).toContain("check: testsPass cwd=\"<repo>\" scope=full");
    // the changelog entry
    const unreleased = /## \[2\.8\.0\] - 2026-10-13([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    for (const item of ["**Checks in other repositories (OpenCode v2, roles mode) (#107).**", "check: testsPass cwd=\"<repo>\" scope=full", "`is not covered by any check root`",
      "never a fail", "is a consumer", "UNVERIFIED", "(link pins)", "`a per-check cwd= is honoured only in roles mode`",
      "A dispatch with per-check keys may be deferred, see \"Deferred verification across repositories\" below.",
      "**Deferred verification across repositories (OpenCode v2, roles mode) (#107).**", "The dispatch is verified at once, not deferred, when I4 already refuses at return",
      "link targets are observed again", "turns a pass UNVERIFIED with a caveat (a fail keeps it)",
      "**A full-scope `testsPass` is no longer run synchronously when the producer changed nothing (OpenCode v2) (#107).**", "owner decision OD-P2e-2",
      "such a dispatch (and one whose `testsPass` check has `scope=full`) now defers instead of blocking the return",
      "Config `testScope` does not affect `lintClean` (only a per-check `scope=full` runs lint unscoped), so a `lintClean`-only dispatch with no change still passes without running anything"]) {
      expect(unreleased, item).toContain(item);
    }
    expect(unreleased).not.toContain("verified synchronously, never deferred");
  });

  it("P3a: consumer testsPass scope=affected across a link — the cross-link reasons of runner.ts/deterministic.ts are in VERIFICATION.md", () => {
    const runner = read("src/verify/runner.ts");
    const deterministic = read("src/verify/deterministic.ts");
    const verificationFlat = read("docs/VERIFICATION.md").replace(/\s+/g, " ");
    // code-to-doc: the static parts of each S6 reason (a template's parts between its ${…}) are in the source AND in the guide
    const reasons: ReadonlyArray<readonly [code: string, source: string, parts: readonly string[]]> = [
      ["cross-link-unsupported", runner, ["a change in a linked repository needs vitest ", " to scope: this check runs ", " to scope: the resolved vitest is "]],
      ["cross-link-gone", runner, ["changed file gone in the linked repository (deleted or renamed away): "]],
      ["cross-link-unreachable", runner, ["the path of ", " in the linked repository contains node_modules, which vitest never follows"]],
      ["cross-link-unchecked", runner, ["the consumer's vitest projects are not read; use scope=full",
        "cannot check which consumer tests import the linked repository ", "; use scope=full"]],
      ["cross-link-ignored-over-bounds", runner, ["too many ignored modules in the linked repository to pass as inputs: "]],
      ["cross-link-ignored-unavailable", runner, ["the ignored modules of the linked repository could not be listed: "]],
      ["cross-link-build-stale", deterministic, ["the build output in ", " is older than ", " changed in the linked repository; ",
        "rebuild it (e.g. a buildPasses check in the linked repository before this one) or use scope=full"]],
    ];
    for (const [code, source, parts] of reasons) {
      expect(source, code).toContain(`"${code}"`);
      expect(verificationFlat, code).toContain(`\`${code}\``);
      for (const part of parts) {
        expect(source, `${code}: ${part}`).toContain(part);
        expect(verificationFlat, `${code}: ${part}`).toContain(part);
      }
    }
    // the zero-selection note (Y2) and the completeness note (QA-1 M2), static parts
    for (const part of ["vitest selected no test in ", " for the change in ", "; the link may not be followed ",
      "(resolve.preserveSymlinks, a built entry, or no test imports the changed files): use scope=full", "vitest did not run ", " consumer test file(s) that import the linked repository (", "); the link may not be followed: use scope=full"]) {
      expect(runner, part).toContain(part);
      expect(verificationFlat, part).toContain(part);
    }
    // the guide's statements: the section, its limits, and the refusal that still applies
    for (const text of ["### A consumer check with scope=affected", "only static imports"]) expect(verificationFlat, text).toContain(text);
    expect(read("docs/ROLES.md").replace(/\s+/g, " ")).toContain("(./VERIFICATION.md#a-consumer-check-with-scopeaffected)");
    // the changelog entry
    const unreleased = /## \[2\.8\.0\] - 2026-10-13([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("**A consumer `testsPass` with `scope=affected` runs `vitest related` across a link (OpenCode v2, roles mode; inert on v1) (#107).**");
  });

  it("P3b: router_git root — the texts of git-root.ts are in ROLES.md, the other docs and the [Unreleased] entries", () => {
    const source = read("src/routing/roles/git-root.ts");
    const roles = read("docs/ROLES.md").replace(/\s+/g, " ");
    // code-to-doc: each fragment is a string literal of git-root.ts AND in the guide; a template pins its static parts in the source
    const templates = new Map<string, readonly string[]>([[GIT_ROOT_TOO_LONG, ["`is longer than ", " characters`"]]]);
    expect(GIT_ROOT_TEXTS.length).toBeGreaterThan(0);
    for (const fragment of GIT_ROOT_TEXTS) {
      for (const part of templates.get(fragment) ?? [JSON.stringify(fragment)]) expect(source, fragment).toContain(part);
      expect(roles, fragment).toContain(fragment);
    }
    expect(GIT_ROOT_TOO_LONG).toBe(`is longer than ${GIT_ROOT_MAX_LENGTH} characters`);
    // not in GIT_ROOT_TEXTS: the redaction placeholder (F6) and the cap note of the name lookup (N2, a template)
    expect(source).toContain(JSON.stringify(GIT_ROOT_OUTSIDE_PLACEHOLDER));
    expect(roles).toContain(`\`${GIT_ROOT_OUTSIDE_PLACEHOLDER}\``);
    for (const part of ["`The search stopped after ", " directories`"]) expect(source, part).toContain(part);
    expect(roles).toContain(gitRootCappedNote(LOOKUP_MAX_DIRS));
    // the provenance line (its fixed parts are literals of the source) and the tool's refusal prefix
    for (const part of [GIT_ROOT_PROVENANCE_PREFIX, GIT_ROOT_PROVENANCE_SUFFIX]) expect(source, part).toContain(JSON.stringify(part));
    expect(roles).toContain(`\`${GIT_ROOT_PROVENANCE_PREFIX}<name> (<branch>) at <worktree>${GIT_ROOT_PROVENANCE_SUFFIX}\``);
    expect(read("src/router/git-tools.ts")).toContain("[router_git] error: refused: ");
    expect(roles).toContain("start with `[router_git] error: refused: ` and nothing runs");
    // the guide's statements: who may pass root, when the argument exists, W as root, read-only, repoExclude worktrees
    for (const text of ["role agents only", "a restart is needed after adding parents", "`root` equal to the work root behaves as no `root`",
      "no branch argument", "never refreshes the index", "worktrees of a repository excluded by `routing.repoExclude`"]) expect(roles, text).toContain(text);
    // the other docs
    expect(read("docs/READ_ONLY_TIERS.md").replace(/\s+/g, " ")).toContain("`root` is a roles-mode feature: tier agents and the orchestrator are refused");
    const config = read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ");
    expect(config).toContain("enables the `root` argument of `router_git_*`");
    expect(config).toContain("also covers the linked worktrees of an excluded repository");
    // the changelog entries
    const unreleased = /## \[2\.8\.0\] - 2026-10-13([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("**`router_git_*` in other repositories (OpenCode v2, roles mode; inert on v1) (#107).**");
    expect(unreleased).toContain("**Worktrees of an excluded repository are refused (OpenCode v2, roles mode) (#107).**");
  });

  it("P2e: deferred verification across repositories is documented as the code words it (S11 caveat, cross-repo reasons, placement identity)", () => {
    const wiring = read("src/verify/wiring.ts");
    const verificationFlat = read("docs/VERIFICATION.md").replace(/\s+/g, " ");
    const pinned: Array<[string, string]> = [
      ["the linked repository ", "S11 caveat prefix"],
      [" changed since the producer returned; the checks ran against its new state", "S11 changed"],
      [" could not be observed again since the producer returned", "S11 unobserved"],
      [" no longer resolves to the same repository since the producer returned; nothing ran", "placement identity"],
    ];
    for (const [fragment, why] of pinned) {
      expect(wiring, why).toContain(fragment);
      expect(verificationFlat, why).toContain(fragment);
    }
    // the cross-repo reason and its detail texts are internal (the after-hook reads only `branch-switched`): the docs describe the behaviour
    expect(wiring, "cross-repo detail").toContain("a linked repository could not be observed within the deferral bound; verified synchronously");
    expect(wiring, "cross-repo detail").toContain("a repository of the perimeter changed during the dispatch while an unattributable writer ran; verified synchronously");
    for (const text of ["**Verified at once.** The dispatch is not deferred: it is verified before return (internally the reason `cross-repo`, which is not shown to anyone)",
      "A refusal never reaches the deferred finish: the dispatch is verified at once, with its refusal.",
      "a linked repository could not be observed within the deferral bound;",
      "I4 already refuses at return (a repository of the perimeter changed during the dispatch while an unattributable writer ran)",
      "**A placement whose directory did not exist at return** is reported at `router_verify` as `no longer resolves to the same repository since the producer returned`",
      "**What S11 does not cover.** S11 observes the direct link targets of `W` again and notices a link retargeted or added after the return. It does not cover nested link targets, ignored files (for example `dist/`) or skip-worktree/assume-unchanged edits in the linked repository. The reference stays exact only through link pins.",
      "**A full scope defers instead of blocking the return (OpenCode v2).** A dispatch with no changed files and a full-scope `testsPass` used to run the full suite synchronously before the return (it was never passed as \"no changed files\"); on OpenCode v2 it now defers instead, and for a `delegate` that also means no synchronous ladder.",
      "Config `testScope` does not affect `lintClean`: only a per-check `scope=full` runs lint unscoped, so a `lintClean`-only dispatch with no change still passes without running anything.",
      "On OpenCode v2 that exception does not apply when the `testsPass` is full scope (config `testScope: \"full\"` or a per-check `scope=full`): such a dispatch defers."]) expect(verificationFlat, text).toContain(text);
    expect(verificationFlat).toContain("### Deferred verification across repositories");
    expect(verificationFlat).not.toContain("never deferred");
    expect(verificationFlat).not.toContain("interim until deferred verification supports the perimeter");
    const roles = read("docs/ROLES.md").replace(/\s+/g, " ");
    expect(roles).toContain("(./VERIFICATION.md#deferred-verification-across-repositories)");
    const config = read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ");
    expect(config).toContain("A deferred dispatch with a perimeter.");
    expect(config).toContain("(per-check `scope=full`, or config `testScope: \"full\"` on OpenCode v2 only) defers instead of blocking the return; config `testScope` does not affect `lintClean` (only a per-check `scope=full` runs lint unscoped), so a no-change `lintClean` still passes without running.");
    expect(config).toContain("On OpenCode v2 this does not hold when the `testsPass` is full scope (config `testScope: \"full\"`, or a per-check `scope=full`): that dispatch defers instead of blocking the return");
    expect(config).toContain("verified at once (nothing is shown to the user for this; a refusal never reaches the deferred finish)");
    expect(roles).toContain("The dispatch is verified at once, not deferred, when I4 already refuses at return");
    const design = read("docs/design/cross-repo.md").replace(/\s+/g, " ");
    for (const text of ["| D18 |", "| D19 |", "### Phase 2 implemented (notes)", "LINK_DRIFT_CAVEAT"]) expect(design, text).toContain(text);
    // Phase 3 (b): the owner decisions and the QA follow-ups are recorded in the design.
    for (const text of ["| D20 |", "| D21 |", "Known follow-ups (P3b QA)"]) expect(design, text).toContain(text);
  });

  it("P3c: dependency edges outside node_modules — the labels, bounds and texts of the code are in VERIFICATION.md and the [Unreleased] entries", () => {
    const doc = read("docs/VERIFICATION.md");
    const verificationFlat = doc.replace(/\s+/g, " ");
    const section = /### Dependencies outside node_modules([\s\S]*?)\n### /.exec(doc)?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(section).not.toBe("");
    const perimeter = read("src/verify/perimeter.ts");
    const gate = read("src/verify/gate.ts");
    const wiring = read("src/verify/wiring.ts");
    // every `via` label of the fixed vocabulary (SD-P3c-5): the package.json template with each field and protocol, the others verbatim
    expect(EDGE_VIAS.length).toBe(PACKAGE_EDGE_FIELDS.length * PACKAGE_EDGE_PROTOCOLS.length + TSCONFIG_EDGE_KEYS.length + 4);
    expect(section).toContain("`package.json <field> (<protocol>)`");
    for (const via of EDGE_VIAS) {
      const pkg = /^package\.json (\S+) \((\S+)\)$/.exec(via);
      if (pkg === null) expect(section, via).toContain(`\`${via}\``);
      else for (const part of [pkg[1]!, pkg[2]!]) expect(section, via).toContain(`\`${part}\``);
    }
    // every bound, as the code sets it (SD-P3c-4; QA-1 M1, M2, M5; QA-1 m2)
    const workspaceManifests = Number(/const WORKSPACE_MANIFESTS_MAX = (\d+);/.exec(perimeter)?.[1]);
    expect(perimeter).toContain("files: Math.max(EDGE_LIMITS.files, 2 * WORKSPACE_MANIFESTS_MAX + 16)");
    const consumerFiles = Math.max(EDGE_FILES_MAX, 2 * workspaceManifests + 16);
    const scopeTextMax = Number(/export const SCOPE_TEXT_MAX = (\d+);/.exec(gate)?.[1]);
    expect(Number(/export const LINK_CAVEAT_TEXT_MAX = (\d+);/.exec(wiring)?.[1])).toBe(scopeTextMax);
    expect(wiring).toContain("const room = Math.max(0, PERIMETER_MAX - 1 - observedSeeds);");
    for (const text of [
      `a file over ${EDGE_FILE_BYTES_MAX / (1024 * 1024)} MiB is skipped`,
      `at most ${EDGES_MAX} distinct targets, ${EDGE_FILES_MAX} files and ${EDGE_WORKSPACES_MAX} workspace packages (${consumerFiles} files and ${workspaceManifests} packages when the edges of a working-set worktree are read for consumers)`,
      `from at most ${EDGE_WORKSPACE_PATTERNS_MAX} \`workspaces\` patterns whose listings read at most ${EDGE_WORKSPACE_ENTRIES_MAX} entries in total`,
      `${EDGE_TSCONFIG_VARIANTS_MAX} root \`tsconfig.*.json\` files`,
      `an \`extends\` chain at most ${EDGE_EXTENDS_DEPTH_MAX} deep, at most ${EDGE_EXTENDS_ENTRIES_MAX} entries of one \`extends\` array`,
      `\`overrides\` at most ${EDGE_OVERRIDES_DEPTH_MAX} levels deep`,
      `one site-packages listing of at most ${SITE_PACKAGES_ENTRIES_MAX} entries, and at most ${SITE_PACKAGES_FILES_MAX} \`.pth\`, finder and \`.egg-link\` files`,
      `A spec longer than ${EDGE_SPEC_MAX} characters, or a target more than ${EDGE_WALK_MAX} directories below its parent, is not admitted, with no filesystem call.`,
      `At most ${EDGE_UNADMITTED_NAMES_MAX} unadmitted targets are named; the others are counted only.`,
      `is capped at ${scopeTextMax} characters, with a trailing \`…\` when cut, then escaped`,
      `an unadmitted edge target's name is at most ${EDGE_NAME_MAX} characters`,
      `it counts toward the perimeter's ${PERIMETER_MAX} roots`,
      `more new dependencies than the perimeter's ${PERIMETER_MAX} roots leave room for, means the dispatch is verified at once (no handle)`,
    ]) expect(section, text).toContain(text);
    // code-to-doc: each fragment is in the source that emits it, and the section quotes it
    const pinned: Array<[source: string, code: string, quoted: string]> = [
      [gate, "links this work root (${displaySafe(consumer.via)})", "`links this work root (<via>)`"],
      [perimeter, "`${edge.via} in ${edge.from}`", "followed by ` in <file>`"],
      [gate, "${scopeText(root.name)} (not admitted)", "`<name> (not admitted)`"],
      [wiring, "\"[verify] dispatch perimeter: declared dependency edges were cut by a bound\"", "`[verify] dispatch perimeter: declared dependency edges were cut by a bound`"],
    ];
    for (const [source, code, quoted] of pinned) {
      expect(source, code).toContain(code);
      expect(section, quoted).toContain(quoted);
    }
    // the guide's statements: v2 only, never pinned, the junction-spelled parent, the removed dependency, the consumer and PnP notes
    for (const text of ["(OpenCode v2, roles mode; inert on v1, no config key)", "**In the perimeter, never pinned.**", "repository code is never evaluated",
      "so a `file:` edge written through a junction-spelled parent is a consumer too",
      "A dependency the producer removed during the dispatch is not observed again at `router_verify`, unless `W` declares it again; then it is \"changed\".",
      "An edge never makes the reference approximate (a documented limit)."]) expect(section, text).toContain(text);
    for (const text of ["So is one with no such link that declares a dependency edge into `W`'s repository",
      "In roles mode on OpenCode v2, a `portal:`/`link:` spec in `package.json` is still read as a declared dependency edge",
      `a dependency the producer added during the dispatch could not be observed within the deferral bound, or more were added than the perimeter's ${PERIMETER_MAX} roots leave room for`,
      "**Declared dependency edges at S11.** S11 observes the admitted targets of `W`'s declared dependency edges again as it does link targets, with the same caveats, and notices an edge added or retargeted after the return; an edge target is never pinned."])
      expect(verificationFlat, text).toContain(text);
    // the other docs
    const roles = read("docs/ROLES.md").replace(/\s+/g, " ");
    for (const text of ["(./VERIFICATION.md#dependencies-outside-node_modules)", "A link or edge target that is not admitted is named `(not admitted)`"]) expect(roles, text).toContain(text);
    expect(read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ")).toContain("No config key turns the edges on or off; see `docs/VERIFICATION.md` → \"Dependencies outside node_modules\".");
    // the changelog entries
    const unreleased = /## \[2\.8\.0\] - 2026-10-13([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    for (const item of ["**Dependencies outside `node_modules` (OpenCode v2, roles mode; inert on v1) (#107).**", "`<name> (not admitted)`",
      "`links this work root (<via>)`", "`[verify] dispatch perimeter: declared dependency edges were cut by a bound`",
      "**A dependency the producer adds during a deferred dispatch is frozen at return (OpenCode v2, roles mode) (#107).**",
      "verify the dispatch at once (no handle)", "unless the work root declares it again (then it is \"changed\")"]) expect(unreleased, item).toContain(item);
  });

  it("QA-P32-2: a missing d= is none, graders weigh half only when independent, run matching by entry name, R9(5), code map", () => {
    // roles mode: an [acceptance] block without a d= claim (and without the router's gate) is `none`
    expect(effectiveDetection({ routerGate: false, claim: null, acceptance: "grader" })).toBe("none");
    expect(effectiveDetection({ routerGate: false, claim: "grader", acceptance: "grader" })).toBe("grader");
    expect(effectiveDetection({ routerGate: false, claim: "deterministic", acceptance: "deterministic" })).toBe("grader");
    expect(flat).toContain("**Unlike a tier dispatch, a role dispatch without a `d=` claim is `none` even when its prompt has an `[acceptance]` block**");
    expect(read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ")).toContain("a role dispatch without `d=` is `none` even when its prompt has an `[acceptance]` block");
    const flatAdr = read("docs/adr/0006-role-tier-assurance-delegation.md").replace(/\s+/g, " ");
    expect(flatAdr).toContain("a role dispatch without a `d=` claim is `none` even when its prompt has an `[acceptance]` block");
    // graders: 0.5 when independent, nothing otherwise, never a weight-1 verdict signal
    expect(SIGNAL_WEIGHTS.grader).toBe(0.5);
    expect(flat).toContain("**Graders weigh half, and only when independent.**");
    expect(flat).toContain("there is never a weight-1 `verdict` signal");
    expect(flat).toContain("records nothing at all: no store change, no verdict row, no signal row");
    expect(flatAdr).toContain("An LLM grader's verdict of a role dispatch is never a weight-1 `verdict`");
    const engine = read("docs/ROUTING_ENGINE.md").replace(/\s+/g, " ");
    expect(engine).toContain("an independent grader (tier ≥ the producer's, another model) adds 0.5");
    expect(engine).toContain("needs about twice as many verdicts");
    expect(engine).toContain("**Role dispatches have fewer verdict rows still:**");
    const unreleased = /## \[2\.4\.0\] - 2026-10-09([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("moves the outcome store by 0.5 with a `grader` signal row only when the grader is independent");
    // run matching is by router_run entry name
    expect(flat).toContain("a command named `test` counts for `npm test`; one named `test-files` never does");
    expect(flat).toContain("or an independent grader's verdict (weight 0.5)");
    // R9(5): no outputPaths on 2.0.24
    expect(flat).toContain("**Truncated tool outputs are unreadable on OpenCode 2.0.24.** Its tool-success events carry no `outputPaths`");
    // where things live: the work-root module and the gate exist and are named
    for (const path of ["src/routing/roles/work-root.ts", "src/verify/gate.ts"]) {
      expect(readRepo(path), path).toBeDefined();
      expect(guide).toContain(`\`${path}\``);
    }
    expect(guide).not.toContain("the role has no budget for that tier:");
  });

  it("README and READ_ONLY_TIERS describe router_run's shell precisely; the class reader case is v2-only; ADR wording follows the plan", () => {
    expect(read("README.md")).toContain("no shell controlled by the caller; npm script bodies still run in npm's pinned script shell");
    const readOnly = read("docs/READ_ONLY_TIERS.md").replace(/\s+/g, " ");
    expect(readOnly).toContain("no shell controlled by the caller; npm script bodies still run in npm's pinned script shell");
    expect(readOnly).toContain("it never applies on v1, where the engine is always `static`");
    const adr = read("docs/adr/0006-role-tier-assurance-delegation.md");
    const flatAdr = adr.replace(/\s+/g, " ");
    expect(adr).toMatch(/^\| E8 \|.*candidate cut site `src\/verify\/dod\.ts:62`/m);
    expect(adr).toMatch(/^\| E13 \|.*\| owner override, #81 review, PLAN-3 \|\r?$/m);
    expect(flatAdr).toContain("the dispatch header naming a route line's `root=`, and the I7 budget-incomplete rule");
    expect(flatAdr).toContain("is descriptive and never enters the routing");
    expect(flatAdr).toContain("only checks of that form are matched to runs");
    expect(adr).not.toContain("budgetUsed");
  });

  it("links the guide and ADR 0006 from the README, the plans index, the config reference and the routing guide", () => {
    expect(read("README.md")).toContain("(docs/ROLES.md)");
    expect(read("README.md")).toContain("(docs/adr/0006-role-tier-assurance-delegation.md)");
    expect(read("docs/plans/README.md")).toContain("(../adr/0006-role-tier-assurance-delegation.md)");
    expect(read("docs/plans/README.md")).toContain("(../ROLES.md)");
    expect(read("docs/CONFIG_REFERENCE.md")).toContain("(./ROLES.md)");
    expect(read("docs/ROUTING_ENGINE.md")).toContain("(./ROLES.md)");
  });

  it("resolves every relative markdown link of the roles docs, anchors included", () => {
    expect(brokenLinks(ROLES_DOCS, readRepo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #84 P3.3 global QA (plan amendments R9, R10): the guard table of ENFORCEMENT.md, the budget numbers after the
// P3.3 fixes, the R10 statements and the v1 statement of the README.
// ---------------------------------------------------------------------------

/** Every guard name `src/guard/guards.ts` can return (`guard: "<name>"` literals). */
function guardNamesOf(source: string): string[] {
  return [...new Set([...source.matchAll(/\bguard: "([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

/** Guard names missing from the `<!-- guard-table -->` table of `doc`, and names it lists that the code never returns. */
function guardTableProblems(doc: string, names: readonly string[]): string[] {
  const table = tableAfter(doc, "guard-table");
  if (table === undefined) return ["no guard table"];
  const listed = table.rows.map((row) => /^`([a-z_]+)`$/.exec(row[row.length - 1] ?? "")?.[1]).filter((name): name is string => name !== undefined);
  return [
    ...names.filter((name) => !listed.includes(name)).map((name) => `${name}: no row`),
    ...listed.filter((name) => !names.includes(name)).map((name) => `${name}: not a guard of the code`),
  ];
}

describe("docs drift: #84 P3.3 global QA (R9, R10)", () => {
  const enforcement = read("docs/ENFORCEMENT.md");
  const flatEnforcement = enforcement.replace(/\s+/g, " ");
  const guide = read("docs/ROLES.md").replace(/\r?\n>\s?/g, " ").replace(/\s+/g, " ");
  const unreleased = /## \[2\.4\.0\] - 2026-10-09([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
  const names = guardNamesOf(read("src/guard/guards.ts"));

  it("R3: executor resumes match BUDGET_RESUMES and numeric read caps are documented as advisory", async () => {
    const { BUDGET_RESUMES } = await import("../../src/executor/types");
    expect(read("docs/EXECUTOR.md")).toContain(`up to **${BUDGET_RESUMES} times** (\`BUDGET_RESUMES\`)`);
    expect(guide).toContain("numeric read-only caps are advisory banners, not hard stops");
    expect(flatEnforcement).toContain("Numeric `CAP:N` read-only caps remain advisory banners, not hard stops");
  });

  it("the guard table of ENFORCEMENT.md lists every guard the code returns, and only those (C-1)", () => {
    expect(names).toEqual(["anti_self_script", "cumulative_iteration_cap", "deliverable_first", "denied_cap", "iteration_cap", "read_budget", "redundant_read"]);
    expect(guardTableProblems(enforcement, names)).toEqual([]);
    // negative fixtures: a dropped row, an invented guard, no table
    const dropped = enforcement.split(/\r?\n/).filter((line) => !line.includes("| `denied_cap` |")).join("\n");
    expect(guardTableProblems(dropped, names)).toEqual(["denied_cap: no row"]);
    expect(guardTableProblems(enforcement, names.filter((name) => name !== "read_budget"))).toEqual(["read_budget: not a guard of the code"]);
    expect(guardTableProblems("# no table\n", names)).toEqual(["no guard table"]);
    // read_budget is producer-only; role agents are guarded with role budgets
    expect(flatEnforcement).toContain("**producer profile only**; a reader dispatch never gets it");
    expect(flatEnforcement).toContain("role-agent child sessions");
    expect(flatEnforcement).toContain(`(\`REFUSAL_CAP\` = ${REFUSAL_CAP}, \`src/router/guard-profile.ts\`)`);
    expect(flatEnforcement).toContain(`| \`cumulativeBudget\` | \`budget\` × ${GUARD_CUMULATIVE_MULTIPLIER} (\`CUMULATIVE_BUDGET_MULTIPLIER\`) |`);
    expect(enforcement).toContain("(./READ_ONLY_TIERS.md#reader-guard-profile-84)");
    expect(enforcement).toContain("(./ROLES.md#budgets)");
    expect(brokenLinks(["docs/ENFORCEMENT.md"], readRepo)).toEqual([]);
  });

  it("quotes the P3.3 budget rules: the lifted-tier fallback, the host steps and the cumulative ceiling (QA-G-A3-6/7, QA-G-A3-2-2)", () => {
    // fallback: max(the ceiling tier's role budget, TIER_GUARD_BUDGET); a small ceiling budget is lifted to the tier agents' budget
    const small = { guard: "reader" as const, budget: { fast: 10 }, tierRange: { ceiling: "fast" } };
    expect(roleGuardProfile(small, "medium").budget).toBe(TIER_GUARD_BUDGET);
    expect(roleGuardProfile({ guard: "reader", budget: { fast: 60 }, tierRange: { ceiling: "fast" } }, "medium").budget).toBe(60);
    expect(guide).toContain(`max(the role's budget for its ceiling tier, ${TIER_GUARD_BUDGET}) calls — never less than the role on its ceiling, nor less than a tier agent`);
    // steps: 2 × max(top budget, TIER_GUARD_BUDGET) + REFUSAL_CAP + margin, also for a role whose budgets are all below it
    expect(roleAgentSteps({ budget: { fast: 10 } })).toBe(ROUTE_BUDGET_RAISE_MAX * TIER_GUARD_BUDGET + REFUSAL_CAP + ROLE_STEPS_MARGIN);
    expect(guide).toContain(`${ROUTE_BUDGET_RAISE_MAX} × max(the top budget of the role, ${TIER_GUARD_BUDGET}) + \`REFUSAL_CAP\` (${REFUSAL_CAP}) + ${ROLE_STEPS_MARGIN}`);
    expect(guide).not.toContain(`${ROUTE_BUDGET_RAISE_MAX} × the top budget of the role + \`REFUSAL_CAP\``);
    // cumulative: 3 × the largest round budget; a resume without budget= keeps the previous one
    expect(guide).toContain(`${GUARD_CUMULATIVE_MULTIPLIER} × the largest round budget the child had`);
    expect(guide).toContain("a resume without `budget=` keeps the child's previous `budget=`");
    expect(unreleased).toContain(`gets max(the role's budget for its ceiling tier, ${TIER_GUARD_BUDGET}). The cumulative ceiling is ${GUARD_CUMULATIVE_MULTIPLIER} × the largest round budget the child had.`);
    const adr = read("docs/adr/0006-role-tier-assurance-delegation.md").replace(/\s+/g, " ");
    expect(adr).toContain(`${ROUTE_BUDGET_RAISE_MAX} × max(the top role budget, ${TIER_GUARD_BUDGET}) + \`REFUSAL_CAP\` + ${ROLE_STEPS_MARGIN}`);
    expect(adr).toContain(`the cumulative ceiling is ${GUARD_CUMULATIVE_MULTIPLIER} × the largest round budget the child had`);
    expect(adr).not.toContain("Tier agents keep 25 / × 3, and so does a role dispatch");
    // advisory: refusals count toward denied_cap; an out-of-budget NEED MORE: budget is still a budget stop
    expect(guide).toContain("in `advisory` mode as well (`advisory` never stops)");
    expect(guide).not.toContain("the `[router budget]` note for a guard stop never appears");
  });

  it("states R10: verdict-only outcome store, the verification-reason rendering in tiers mode too, no credential passthrough", () => {
    // R10(1)
    expect(guide).toContain("`run`, `incomplete` and `redispatch` are routing statistics only");
    expect(read("docs/adr/0006-role-tier-assurance-delegation.md").replace(/\s+/g, " ")).toContain("`run`, `incomplete` and `redispatch` signals are routing statistics only");
    expect(unreleased).toContain("`run`, `incomplete` and `redispatch` rows are routing statistics only");
    // R10(2): the behaviour-change entry quotes the code's limits
    expect(RENDERED_REASONS_MAX).toBe(GRADER_REASONS_MAX);
    const cap = oneLineReason("x".repeat(1000)).length;
    expect(oneLineReason("a\n\nb")).toBe("a b");
    const sentence = `Verification reasons are rendered one per line with line breaks joined, at most ${RENDERED_REASONS_MAX} items plus a count of the rest; an LLM grader's text is cut at ${cap} characters.`;
    expect(unreleased).toContain(`**Verification reasons, in tiers mode too.** ${sentence}`);
    const behaviour = unreleased.slice(unreleased.indexOf("Behaviour change (#84)"));
    expect(behaviour).toContain(sentence);
    // negative fixture: the sentence pinned with another limit is not in the changelog
    expect(unreleased).not.toContain(sentence.replace(`at most ${RENDERED_REASONS_MAX} items`, `at most ${RENDERED_REASONS_MAX + 1} items`));
    // R10(3): no envPassthrough; PGPASSWORD / MYSQL_PWD are credential-like
    for (const name of ["PGPASSWORD", "MYSQL_PWD"]) {
      expect(CREDENTIAL_ENV_RE.test(name), name).toBe(true);
      expect(guide).toContain(`\`${name}\``);
    }
    expect(read("docs/CONFIG_REFERENCE.md").replace(/\s+/g, " ")).toContain("`routing.run` has no `envPassthrough` key");
    expect(guide).toContain("There is no passthrough option: credential-like names are always stripped.");
  });

  it("the README names the v1 notice, the advisor info and the behaviour-change entry; ADR 0006 records R0–R10 (C-2, C-9)", () => {
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(readme).not.toContain("the only effect is an opt-in prose line");
    expect(readme).toContain(`the plugin logs one notice per process, \`${ROLES_V1_NOTICE}\``);
    expect(FINDING_IDS).toContain("roles-on-legacy-host");
    expect(readme).toContain("the advisor info `roles-on-legacy-host`");
    // the link lands on the 2.4.0 release heading; its section's first `### Changed` holds the behaviour-change entry
    expect(readme).toContain("[behaviour change entry](CHANGELOG.md#240---2026-10-09)");
    const changelog = read("CHANGELOG.md").replace(/\r\n/g, "\n");
    expect(anchorsOf(changelog).has("240---2026-10-09")).toBe(true);
    const release = /^## \[2\.4\.0\] - 2026-10-09$([\s\S]*?)^## \[/m.exec(changelog)?.[1] ?? "";
    const firstChanged = release.split(/^### /m).find((section) => /^Changed\n/.test(section)) ?? "";
    expect(firstChanged).toContain("Behaviour change (#84)");
    const adr = read("docs/adr/0006-role-tier-assurance-delegation.md");
    expect(adr).toContain("amendments R0–R10 and adversarial QA");
    expect(adr).not.toContain("amendments R0–R8");
  });

  it("the README's v1-freeze note links to the 2.5.0 release, whose first `### Changed` holds the freeze entry", () => {
    const readme = read("README.md");
    expect(readme).toContain("[changelog entry](CHANGELOG.md#250---2026-10-09)");
    expect(readme).not.toContain("CHANGELOG.md#unreleased");
    const changelog = read("CHANGELOG.md").replace(/\r\n/g, "\n");
    expect(anchorsOf(changelog).has("250---2026-10-09")).toBe(true);
    const release = /^## \[2\.5\.0\] - 2026-10-09$([\s\S]*?)^## \[/m.exec(changelog)?.[1] ?? "";
    const firstChanged = release.split(/^### /m).find((section) => /^Changed\n/.test(section)) ?? "";
    expect(firstChanged).toContain("OpenCode v1 support is in feature freeze");
  });
});

// ---------------------------------------------------------------------------
// #84 P3.3 global QA round 2: what a dynamic role's route-line `needs=` does (QA-G-C-2-1), through the real role dispatch path,
// and what a `subagentTiers` entry for a role name does (QA-G-C-2-2).
// ---------------------------------------------------------------------------

describe("docs drift: #84 P3.3 global QA round 2 (QA-G-C-2-1, QA-G-C-2-2)", () => {
  const guide = read("docs/ROLES.md").replace(/\r?\n>\s?/g, " ").replace(/\s+/g, " ");
  const engine = read("docs/ROUTING_ENGINE.md").replace(/\s+/g, " ");
  const unreleased = /## \[2\.4\.0\] - 2026-10-09([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
  const tiers = JSON.parse(read("tiers.json")) as Record<string, unknown>;

  /** The router's dispatch path for `general` (roles mode, static engine) in a temp session directory; `grantOf` routes one prompt. */
  async function rolePath<T>(run: (grantOf: (prompt: string) => Promise<string[]>) => Promise<T>): Promise<T> {
    const main = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-drift-needs-")));
    const outcomes = mkdtempSync(join(tmpdir(), "omr-drift-needs-outcomes-"));
    const cfg = validateConfig({ ...tiers, activePreset: "anthropic", routing: { delegation: "roles", engine: "static", outcomes: { path: outcomes } } });
    // the catalog: every tier's first role rung, with its variant
    const byModel = new Map<string, Set<string>>();
    for (const tier of ["fast", "medium", "heavy"]) {
      const c = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "probe", window: { floor: tier, ceiling: tier, pinned: null } }).candidates[0]!;
      const variants = byModel.get(c.model) ?? new Set<string>();
      if (c.variant !== null && c.variant !== "default") variants.add(c.variant);
      byModel.set(c.model, variants);
    }
    const catalog = [...byModel].map(([model, variants]) => {
      const [providerID, id] = model.split("/") as [string, string];
      return { providerID, id, variants: [...variants].map((v) => ({ id: v })), limit: { context: 200_000, output: 32_000 }, cost: [] };
    });
    const logger = { warn: () => undefined };
    const runtime = createEngineRuntime({ loadConfig: () => cfg, listAgents: async () => [], listModels: async () => catalog, logger });
    const router = createDispatchRouter({
      runtime,
      getSession: async (id) => (id === "root"
        ? { id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" }, permissions: [], location: { directory: main } }
        : { id, parentID: "root", agent: "general", location: { directory: main } }),
      graderAgent: "router-grader",
      directory: main,
      logger,
      listWorktrees: async () => `worktree ${main.replace(/\\/g, "/")}\nHEAD 0123\nbranch refs/heads/main\n`,
      realpath: (path) => realpathSync.native(path),
      isBypassed: () => false,
      env: {},
    });
    let n = 0;
    const grantOf = async (prompt: string): Promise<string[]> => {
      const outcome = await router.route({ callID: `drift-${++n}`, sessionID: "root", agent: "build", args: { agent: "general", description: "work item", prompt }, cfg });
      return [...outcome.role!.grant.actions];
    };
    try {
      return await run(grantOf);
    } finally {
      await runtime.dispose();
      resetDispatchRouting();
      resetDispatchRegistry();
      resetBindingRegistryForTests();
      for (const dir of [main, outcomes]) rmSync(dir, { recursive: true, force: true });
    }
  }

  it("QA-G-C-2-1: a dynamic role's needs= replaces the needs the text implies — it adds a need the text never names", async () => {
    await rolePath(async (grantOf) => {
      const quiet = "Look at the parser module and list its entry points.";
      const writes = "Read the release notes and write a short summary into your answer only.";
      // no route-line needs: `general` gets what the text implies (local only here; edit for "write")
      expect(await grantOf(`[route class=other risk=low scope=single]\n${quiet}`)).toEqual(["read", "glob", "grep", "router_git"]);
      expect(await grantOf(`[route class=other risk=low scope=single]\n${writes}`)).toContain("edit");
      // needs= ADDS: edit on a text that names no edit
      expect(await grantOf(`[route class=other risk=low scope=single needs=edit]\n${quiet}`)).toContain("edit");
      // needs= REPLACES: the text's edit is dropped, the listed shell gives router_run
      const replaced = await grantOf(`[route class=other risk=low scope=single needs=shell]\n${writes}`);
      expect(replaced).toContain("router_run");
      expect(replaced).not.toContain("edit");
      // the route class's implied needs stay: class=implement keeps edit with needs=shell
      expect(await grantOf(`[route class=implement risk=low scope=single needs=shell]\n${quiet}`)).toEqual(expect.arrayContaining(["edit", "router_run"]));
      // always inside the role max: needs=web gives `general` no egress
      expect(await grantOf(`[route class=other risk=low scope=single needs=web]\n${quiet}`)).toEqual(["read", "glob", "grep", "router_git"]);
    });
    const sentence = "a route-line `needs=` replaces the needs the text implies";
    for (const [name, text] of [["ROLES.md", guide], ["ROUTING_ENGINE.md", engine], ["CHANGELOG.md", unreleased]] as const) {
      expect(text, name).toContain(sentence);
      // negative: the wording QA-G-C-2-1 found false
      for (const wrong of ["only narrows the classifier's needs", "never a need the classifier did not find", "a need the classifier did not find is never added", "the route line only narrows"]) {
        expect(text, `${name}: ${wrong}`).not.toContain(wrong);
      }
    }
    expect(guide).toContain("are the dispatch's needs, whether or not the text names them, always inside the role max");
  });

  it("QA-G-C-2-2: a subagentTiers entry for a role name gives its children the tier's default read-only cap and, for fast, the trivial bypass", () => {
    const cfg = validateConfig({ ...tiers, subagentTiers: { explorer: "fast" } });
    const tierNames = ["fast", "medium", "heavy"];
    const store = createSessionStore();
    const output = { parts: [{ type: "text", text: "Look at the parser module and list its entry points." }] };
    expect(store.registerFromChatMessage({ agent: "explorer", sessionID: "s1" }, output, cfg, tierNames).registered).toBe(true);
    expect(store.getCap("s1")).toBe(cfg.tierCaps?.fast ?? DEFAULT_TIER_CAPS.fast);
    // without the entry a role name is no tier session: no cap from this path
    const plain = validateConfig({ ...tiers });
    expect(createSessionStore().registerFromChatMessage({ agent: "explorer", sessionID: "s2" }, output, plain, tierNames).registered).toBe(false);
    // the trivial bypass is tier-gated to fast
    expect(classifyTrivial("find the config loader", "medium", cfg)).toBe(false);
    expect(DEFAULT_TIER_CAPS).toEqual({ fast: 8, medium: 5, heavy: 3 });
    expect(guide).toContain(`gives that role's children the mapped tier's default read-only call cap (\`tierCaps\`, else ${DEFAULT_TIER_CAPS.fast} / ${DEFAULT_TIER_CAPS.medium} / ${DEFAULT_TIER_CAPS.heavy} for \`fast\` / \`medium\` / \`heavy\`) and, for \`fast\`, the trivial-dispatch bypass`);
    expect(guide).toContain("only when it carries `CAP:N` or `CAP:none` (or when a `subagentTiers` entry maps the role's name to a tier");
    // negative: the claim QA-G-C-2-2 found false
    expect(guide).not.toContain("back under the tier agents' 25-call cap");
    expect(read("docs/adr/0006-role-tier-assurance-delegation.md").replace(/\s+/g, " ")).toContain("or when a `subagentTiers` entry maps the role's name to a tier");
  });
});

// ---------------------------------------------------------------------------
// OpenCode v2 TUI status (#90 P2.2): docs/TUI_STATUS.md, the "TUI status options (OpenCode v2)" section of
// CONFIG_REFERENCE.md, the README section and the [Unreleased] entry. The options tables are the parser's keys,
// defaults and `maxRows` range; the slot names are the ones `setup` claims per option; the plugin id, the rpc id, the
// timings and the fallbacks are the code's; the v2 TUI config file is `cli.json`, never `tui.json`. The plugin is
// imported with `@opentui/solid` stubbed (see the `vi.mock` at the top of this file).
// ---------------------------------------------------------------------------

/** `source` without block comments and `//` line comments (a `//` only counts after the line start or whitespace). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `text` as a literal inside a RegExp source. */
function reEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prose lines of `text` (outside fenced blocks) longer than `max` columns; table rows are exempt. */
function longProseLines(text: string, max = 120): string[] {
  return proseLines(text).filter((line) => !line.text.startsWith("|") && line.text.length > max).map((line) => `${line.line}: ${line.text}`);
}

/** The lines inside the fenced blocks of `text`, fences excluded. */
function fencedLines(text: string): string[] {
  const prose = new Set(proseLines(text).map((line) => line.line));
  return text.split(/\r?\n/).filter((line, index) => !prose.has(index + 1) && !/^\s{0,3}(`{3,}|~{3,})/.test(line));
}

/** What `statusPlugin.setup` does with `options`: the slots it claims and the toasts it shows (cleaned up at once). */
function setupWith(options: unknown): { slots: string[]; toasts: string[] } {
  const slots: string[] = [];
  const toasts: string[] = [];
  const context = {
    options,
    ui: {
      slot: (claim: { append: string }) => {
        slots.push(claim.append);
        return () => undefined;
      },
      toast: { show: (toast: { message: string }) => void toasts.push(toast.message) },
    },
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    statusPlugin.setup(context as unknown as Parameters<typeof statusPlugin.setup>[0])();
  } finally {
    warn.mockRestore();
  }
  return { slots, toasts };
}

/** The `heading` line of `doc` and what follows it up to the next heading of the same or a higher level (fences skipped); "" when absent. */
function sectionOf(doc: string, heading: string): string {
  const level = heading.indexOf(" ");
  const prose = proseLines(doc);
  const start = prose.find((line) => line.text === heading)?.line;
  if (start === undefined) return "";
  const next = new RegExp(`^#{1,${level}} `);
  const end = prose.find((line) => line.line > start && next.test(line.text))?.line;
  return doc.split(/\r?\n/).slice(start - 1, end === undefined ? undefined : end - 1).join("\n");
}

/**
 * The `### Added` section holding `marker`: that of `## [Unreleased]`, else that of the first dated release (where the
 * entry lands at release time); "" when neither holds it.
 */
/**
 * The `### Added` section holding `marker`, in [Unreleased] or else in one release: `release` (the version that shipped
 * the entry, e.g. "2.5.0") when given, otherwise the first dated release.
 */
function changelogAdded(changelog: string, marker: string, release?: string): string {
  const text = changelog.replace(/\r\n/g, "\n");
  const heading = release === undefined ? /^## \[[^\]\n]+\] - \d{4}-\d{2}-\d{2}$/m : new RegExp(`^## \\[${release.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
  const dated = heading.exec(text)?.[0];
  const releases = [sectionOf(text, "## [Unreleased]"), dated === undefined ? "" : sectionOf(text, dated)];
  return releases.map((section) => sectionOf(section, "### Added")).find((added) => added.includes(marker)) ?? "";
}

const TUI_CHANGELOG_MARKER = "**OpenCode v2 TUI status (#90).**";

const TUI_OPTIONS_HEADER: readonly string[] = ["Key", "Type", "Default", "Values / range", "Controls"];

/** Every difference between the `<!-- tui-status-options -->` table of `doc` and the parser's keys, types, defaults and range. */
function tuiOptionsTableProblems(doc: string): string[] {
  const table = tableAfter(doc, "tui-status-options");
  if (table === undefined) return ["no options table"];
  const problems: string[] = [];
  if (JSON.stringify(table.header) !== JSON.stringify(TUI_OPTIONS_HEADER)) problems.push(`header ${table.header.join(" | ")}`);
  const keys = table.rows.map((row) => row[0] ?? "");
  const want = STATUS_OPTION_KEYS.map((key) => tick(key));
  if (JSON.stringify(keys) !== JSON.stringify(want)) problems.push(`keys ${keys.join(", ")}; code ${want.join(", ")}`);
  for (const row of table.rows) {
    const key = /^`(\w+)`$/.exec(row[0] ?? "")?.[1];
    if (key === undefined || !Object.hasOwn(DEFAULT_STATUS_OPTIONS, key)) continue;
    const value = (DEFAULT_STATUS_OPTIONS as Readonly<Record<string, unknown>>)[key];
    const type = typeof value === "boolean" ? "`boolean`" : "`integer`";
    const range = typeof value === "boolean" ? "`true \\| false`" : `\`[${MAX_ROWS_MIN}, ${MAX_ROWS_MAX}]\``;
    if (row[1] !== type) problems.push(`${key} type: doc ${row[1] ?? "(none)"}, code ${type}`);
    if (row[2] !== defaultCell(value)) problems.push(`${key} default: doc ${row[2] ?? "(none)"}, code ${defaultCell(value)}`);
    if (row[3] !== range) problems.push(`${key} range: doc ${row[3] ?? "(none)"}, code ${range}`);
  }
  return problems;
}

/** The host slot names (`prompt.footer.status`, `session.composer.top`, …) `text` names in backticks, sorted. */
function slotNamesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/`((?:app|home|prompt|session|sidebar)\.[a-z.]*[a-z])`/g)].map((m) => m[1]!))].sort();
}

/** The `plugins` list of every `<!-- cli.json example -->` JSON block of `text`. */
function cliJsonExamples(text: string): unknown[][] {
  return [...text.matchAll(/<!-- cli\.json example -->\s*```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => {
    const parsed = JSON.parse(m[1]!) as { plugins?: unknown };
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  });
}

/**
 * What is wrong with a `cli.json` example's `plugins` list: a `package` that is the plugin id (its options would be
 * dropped) or neither the package name nor a directory ending in it (the host ignores a path to `tui.ts`), options
 * `parseOptions` rejects, a string other than the `-<id>` selector, or an explicit entry after that selector.
 */
function cliJsonEntryProblems(plugins: readonly unknown[], id: string): string[] {
  const problems: string[] = [];
  let selector = false;
  for (const entry of plugins) {
    if (typeof entry === "string") {
      if (entry === `-${id}`) selector = true;
      else problems.push(`string entry ${entry}`);
      continue;
    }
    const { package: name, options } = (entry ?? {}) as { package?: unknown; options?: unknown };
    if (selector) problems.push(`explicit entry ${String(name)} after -${id}`);
    if (name === id) problems.push(`package is the plugin id ${id}`);
    else if (typeof name !== "string" || !/(?:^|[\\/])opencode-model-router$/.test(name)) problems.push(`package ${String(name)}`);
    problems.push(...parseOptions(options).notices);
  }
  return problems;
}

/**
 * `tui.json` named in a fenced block, or in a prose paragraph that does not say it is OpenCode v1's file and name
 * `cli.json` (the only way the docs may mention it).
 */
function tuiJsonProblems(text: string): string[] {
  const prose = proseLines(text);
  const proseNumbers = new Set(prose.map((line) => line.line));
  const problems: string[] = [];
  if (text.split(/\r?\n/).some((line, index) => !proseNumbers.has(index + 1) && line.includes("tui.json"))) problems.push("a fenced block names tui.json");
  for (const paragraph of prose.map((line) => line.text).join("\n").split(/\n\s*\n/)) {
    if (paragraph.includes("tui.json") && !(paragraph.includes("cli.json") && /\bv1\b/.test(paragraph))) {
      problems.push(`tui.json as a v2 config file: ${paragraph.replace(/\s+/g, " ").trim()}`);
    }
  }
  return problems;
}

describe("docs drift: the per-turn router state on OpenCode v2 (Phase 1.2.6)", () => {
  const v2Doc = read("docs/OPENCODE_V2.md");
  const verification = read("docs/VERIFICATION.md");
  const state = sectionOf(v2Doc, "## Per-turn router state");
  const flatState = state.replace(/\s+/g, " ");
  const flatVerification = verification.replace(/\s+/g, " ");

  it("OPENCODE_V2.md has the section and states what it contains, where it goes, its bound and its cache hint", () => {
    expect(state).not.toBe("");
    expect(flatState).toMatch(/late verification notices/);
    expect(flatState).toMatch(/list of still-unverified delegations/);
    expect(flatState).toMatch(/the route hint/);
    expect(flatState).toContain("`<router-state>`");
    expect(flatState).toMatch(/last `user` message that the router appends after the conversation on every request/);
    expect(flatState).toMatch(/regenerated for each request and never persisted/);
    expect(flatState).toMatch(/not in the session history/);
    expect(flatState).toMatch(/child sessions, graders and role sessions get no state and no hint/);
    expect(flatState).toMatch(/at most 6000 characters/);
    expect(flatState).toContain("`… 12 more lines`");
    expect(flatState).toContain("` (router_plan action=status)`");
    expect(flatState).toMatch(/one ephemeral cache breakpoint/);
    expect(flatState).toMatch(/on the last non-blank text part of the last real message or, when that message has no such part, on its last `tool-result` or `media` part/);
    expect(flatState).toMatch(/When it has neither, there is no hint: the tail is still added, and the host may then mark the tail itself/);
    expect(flatState).toMatch(/never moves to an earlier message/);
    expect(flatState).toMatch(/no 1-hour TTL/);
    expect(flatState).toMatch(/OpenCode v2\.0\.26 cannot set the TTL of the tools breakpoint/);
    expect(flatState).toMatch(/ADR 0007, decision D5, withdrawn/);
    expect(flatState).toMatch(/frozen per session/);
    expect(flatState).toMatch(/agent name, the orchestrator's model, the agent's and the session's permission rules and the configuration are unchanged/);
    expect(flatState).toMatch(/A change of the agent catalog alone does not regenerate it/);
    expect(flatState).not.toMatch(/the agent catalog and the orchestrator's model are unchanged/);
    expect(flatState).toMatch(/OpenCode v1 keeps the old delivery, unchanged/);
    expect(longProseLines(state)).toEqual([]);
  });

  it("the bound in the guide is the code's, and no cache-lifetime setting exists", () => {
    expect(read("src/compat/turn-state.ts")).toMatch(/export const TURN_STATE_MAX_CHARS = 6000;/);
    expect(read("src/compat/turn-state.ts")).toContain("type: \"ephemeral\"");
    expect(withoutComments(read("src/compat/turn-state.ts"))).not.toMatch(/\bttl(Seconds)?\b/i);
    for (const path of ["docs/CONFIG_REFERENCE.md", "docs/OPENCODE_V2.md", "src/router/config.ts"]) {
      expect(read(path), path).not.toContain("promptCache");
    }
  });

  it("VERIFICATION.md says the pending list and the late notices arrive in the per-turn state on v2 and notices stay until read", () => {
    expect(flatVerification).toMatch(/On OpenCode v2 the pending list and the late notices arrive in the per-turn router state/);
    expect(flatVerification).toMatch(/a `<router-state>` message the router appends after the conversation on every request and never stores in the session history/);
    expect(flatVerification).toMatch(/stays there on every turn until `router_verify` returns its handle/);
    expect(flatVerification).toMatch(/On OpenCode v1 the notice is a one-time block in the orchestrator's system prompt/);
    expect(flatVerification).toContain("(OPENCODE_V2.md#Per-turn-router-state)");
    expect(anchorsOf(v2Doc).has("per-turn-router-state")).toBe(true);
  });
});

describe("docs drift: background-first dispatch, held results, leases and pending persistence on OpenCode v2 (Phase 2.1.7)", () => {
  const v2Doc = read("docs/OPENCODE_V2.md");
  const rolesDoc = read("docs/ROLES.md");
  const verification = read("docs/VERIFICATION.md");
  const background = sectionOf(v2Doc, "## Background dispatches");
  const flatBackground = background.replace(/\s+/g, " ");
  const flatRoles = rolesDoc.replace(/\s+/g, " ");
  const flatVerification = verification.replace(/\s+/g, " ");
  const backgroundSource = read("src/compat/background.ts");
  const hooksSource = read("src/compat/v2-hooks.ts");
  const configSource = read("src/router/config.ts");

  it("OPENCODE_V2.md documents the background policy, held results, the router state sections, restarts, off and v1", () => {
    expect(background).not.toBe("");
    expect(anchorsOf(v2Doc).has("background-dispatches")).toBe(true);
    expect(flatBackground).toMatch(/`Background dispatches` block/);
    expect(flatBackground).toMatch(/never poll or sleep/);
    expect(flatBackground).toMatch(/a held result is not usable until its verdict/);
    expect(flatBackground).toMatch(/never report a task done while dispatches are listed in flight/);
    expect(flatBackground).toMatch(/a lease refusal is resolved by waiting for the holder, not by retrying/);
    // QA-2.1-12: `routing.background.mode: "off"` renders no block at all, the lease rule included.
    expect(flatBackground).toMatch(/The whole block, the lease rule included, is left out when `routing.background.mode` is `off`; the lease rule alone when `routing.leases.mode` is `off`/);
    expect(read("src/router/protocol.ts")).toContain('if (routing.background.mode === "off") return "";');
    expect(flatBackground).toMatch(/The v1 protocol is unchanged/);
    expect(read("src/router/protocol.ts")).toContain('export const BACKGROUND_DISPATCHES_HEADING = "## Background dispatches";');
    expect(flatBackground).toContain("`routing.background.mode`");
    expect(flatBackground).toMatch(/defaults to `auto` and `routing.background.minPredictedMs` to `45000`/);
    expect(flatBackground).toMatch(/An explicit `background: false` is always honored/);
    expect(flatBackground).toMatch(/An estimate that is only the built-in prior never selects a call/);
    expect(flatBackground).toMatch(/1000 attempts are already in flight/);
    expect(flatBackground).toMatch(/an explicit `background: true` is turned into `background: false`/);
    expect(flatBackground).toContain('<subagent sessionID="<child>" state="held">held — verdict pending (vrf_…)</subagent>');
    expect(flatBackground).toContain('<router-verdict handle="vrf_…" sessionID="<child>" verdict="PASS|FAIL|UNVERIFIABLE">');
    expect(flatBackground).toMatch(/placeholder stays in force for the rest of the session/);
    expect(flatBackground).toContain(
      "[router] Refused: session <child> is held for verification (<handle>). Its result arrives with the verdict; resume it after that.",
    );
    expect(flatBackground).toMatch(/retried three times with backoff and then stays pending for the next start/);
    expect(flatBackground).toMatch(/256 per parent session, 10000 in all/);
    expect(flatBackground).toMatch(/The terminal UI and `session.export` still show the original to the human/);
    expect(flatBackground).toMatch(/`Completed since your last turn`/);
    expect(flatBackground).toMatch(/`Held for verification — not usable until the verdict`/);
    expect(flatBackground).toMatch(/`In flight \(background\)`/);
    expect(flatBackground).toMatch(/`Do not report the task done while dispatches are listed here\.`/);
    expect(flatBackground).toMatch(/under `routing.background.mode: "off"` none of the three is rendered/);
    expect(flatBackground).toContain("`pending.jsonl`");
    expect(flatBackground).toMatch(/redacts every `<subagent>` element it has not seen processed until a retry succeeds/);
    expect(flatBackground).toMatch(/reproduces the previous request, system prompt, running-ack text and results byte for byte/);
    expect(flatBackground).toMatch(/It does not turn off file leases \(`routing.leases.mode`\) or the restart persistence/);
    expect(flatBackground).toMatch(/OpenCode v1 is unchanged: none of this runs there/);
    expect(flatBackground).toContain("(VERIFICATION.md#pending-handles-survive-restarts)");
    expect(flatBackground).toContain("(ROLES.md#file-leases)");
    expect(longProseLines(background)).toEqual([]);
  });

  it("the policy, placeholder, verdict, refusal, caps and section headers in the guide are the code's", () => {
    expect(configSource).toContain('background: Object.freeze({ mode: "auto" as BackgroundMode, minPredictedMs: 45_000 })');
    expect(configSource).toContain('leases: Object.freeze({ mode: "enforce" as LeasesMode, run: "annotate" as LeasesRunPolicy })');
    expect(backgroundSource).toContain("export const MAX_LIVE_ATTEMPTS = 1000;");
    expect(backgroundSource).toContain("export const MAX_HOLDS_PER_PARENT = 256;");
    expect(backgroundSource).toContain("export const MAX_HOLDS_GLOBAL = 10_000;");
    expect(backgroundSource).toContain("const SYNTHETIC_ATTEMPTS = 3;");
    expect(backgroundSource).toContain('<subagent sessionID="${child}" state="held">held — verdict pending (${handle})</subagent>');
    expect(backgroundSource).toContain('<router-verdict handle="${handle}" sessionID="${child}" verdict="${v.verdict}">');
    expect(backgroundSource).toContain(
      "[router] Refused: session ${child} is held for verification (${handle}). Its result arrives with the verdict; resume it after that.",
    );
    expect(backgroundSource).toContain("[router] Completed since your last turn:");
    expect(backgroundSource).toContain("[router] Held for verification — not usable until the verdict:");
    expect(backgroundSource).toContain("[router] In flight (background): ${live.length}");
    expect(backgroundSource).toContain("Do not report the task done while dispatches are listed here.");
    expect(backgroundSource).toContain("export const PENDING_GUARANTEES_TEXT = \"router guarantees pending\";");
  });

  it("ROLES.md documents the background rules and the file leases, with the router's refusal texts", () => {
    expect(anchorsOf(rolesDoc).has("background-dispatches")).toBe(true);
    expect(anchorsOf(rolesDoc).has("file-leases")).toBe(true);
    expect(flatRoles).toContain("(#background-dispatches)");
    expect(flatRoles).toContain("(#file-leases)");
    expect(flatRoles).toMatch(/the roles protocol carries a `Background dispatches` block, the same one the tiers protocol gets/);
    expect(flatRoles).toMatch(/never poll or sleep/);
    expect(flatRoles).toMatch(/resolve a lease refusal by waiting for the holder, not by retrying/);
    expect(flatRoles).toContain("(OPENCODE_V2.md#background-dispatches)");
    expect(flatRoles).toMatch(/gets no `background` key, so the host default applies/);
    expect(flatRoles).toMatch(/every child session \(a role dispatch or a tier dispatch\) takes a lease on the files it writes, for as long as it runs/);
    expect(flatRoles).toMatch(/Root orchestrator sessions take none: a root write is refused only while a child holds that file/);
    expect(flatRoles).toMatch(/`routing.leases.mode` \(`enforce`, the default, or `off`\)/);
    expect(flatRoles).toMatch(/`routing.leases.run` \(`annotate`, the default, or `refuse`\)/);
    expect(flatRoles).toMatch(/Do not retry: the lease ends when that session ends\./);
    expect(flatRoles).toMatch(/\[router\] <n> result\(s\) omitted: under edit by <holders>\./);
    expect(flatRoles).toMatch(/result may be contaminated/);
    expect(flatRoles).toMatch(/the six-hour sweep/);
    expect(flatRoles).toMatch(/treated as a root, which never blocks the orchestrator and never overrides a child's lease/);
    expect(flatRoles).toMatch(/`routing.background` and `routing.leases` are likewise OpenCode v2 only/);
    const leasesSection = sectionOf(rolesDoc, "## File leases").replace(/\s+/g, " ");
    for (const fragment of [
      "Finish without that file, or return `NEED MORE: lease <path>`. Do not retry: the lease ends when that session ends.",
      "Finish without it, or return `NEED MORE: lease <path>`.",
      "Pass the file path explicitly, or return `NEED MORE: lease <tree>`.",
      "Wait for that session to end.",
    ]) {
      expect(leasesSection, fragment).toContain(fragment);
      expect(backgroundSource, fragment).toContain(fragment.replaceAll("`", "\\`").replace("<path>", "${r.path}").replace("<tree>", "${holder.tree}"));
    }
    expect(backgroundSource).toContain("result(s) omitted: under edit by");
    expect(hooksSource).toContain("result(s) omitted: under edit by");
    expect(read("src/router/leases.ts")).toContain("result may be contaminated");
  });

  it("VERIFICATION.md documents required verification in the background and the persisted pending handles", () => {
    expect(anchorsOf(verification).has("required-verification-in-the-background")).toBe(true);
    expect(anchorsOf(verification).has("pending-handles-survive-restarts")).toBe(true);
    expect(flatVerification).toMatch(/a `VERIFY:required` delegation can run in the background/);
    expect(flatVerification).toMatch(/keeps the guarantee of the required path at the time the child finishes, not at the time of dispatch/);
    expect(flatVerification).toContain(
      "[router] Running in the background (<child>). Its result is held until verification finishes.",
    );
    expect(flatVerification).toContain("Its result will arrive unverified; the verdict follows in the router state.");
    expect(flatVerification).toMatch(/runs the same required gate as a foreground call/);
    expect(flatVerification).toMatch(/gets an `UNVERIFIABLE` verdict with the child's text and `\[router\] not verified: <reason>`/);
    expect(flatVerification).toMatch(/waits for those file leases to end, up to its deadline, then runs with the usual caveat/);
    expect(flatVerification).toMatch(/With `routing.background.mode: "off"` none of this happens/);
    expect(flatVerification).toMatch(/On OpenCode v2 they are also written to disk and survive a restart/);
    expect(flatVerification).toContain("`pending.jsonl`");
    expect(flatVerification).toContain("`routing.outcomes.path`");
    // QA-2.1-8: the documented location is the one `resolvePendingJournalDir` returns.
    expect(flatVerification).toContain("`$XDG_STATE_HOME/opencode-model-router` when that variable is an absolute path (not on Windows), else `~/.local/state/opencode-model-router`");
    expect(flatVerification).toMatch(/append-only, one JSON object per line with `"v": 1`/);
    expect(flatVerification).toMatch(/`inflight` and hold records are fsynced before the router acknowledges the dispatch/);
    expect(flatVerification).toMatch(/A torn or invalid line, and a line of an unknown version, is skipped/);
    expect(flatVerification).toMatch(/A held entry past that age becomes `UNVERIFIABLE`/);
    expect(flatVerification).toMatch(/Hold records have no TTL/);
    expect(flatVerification).toMatch(/stays dormant until the process sees its parent session/);
    expect(flatVerification).toContain("`pending.claims`");
    expect(flatVerification).toContain("`the dispatch was lost in a restart`");
    expect(flatVerification).toContain("`not verified: lost in restart`");
    expect(flatVerification).toMatch(/OpenCode v1 keeps its in-memory behavior and writes no `pending.jsonl`/);
    expect(flatVerification).toContain("(#pending-handles-survive-restarts)");
    expect(flatVerification).toContain("(OPENCODE_V2.md#background-dispatches)");
  });

  it("the persistence in the guide is the code's: file name, claims directory, fsync rule, lost-in-restart text, running acks", () => {
    const index = read("src/index.ts");
    expect(index).toContain('join(pendingDir, "pending.jsonl")');
    expect(index).toContain('join(pendingDir, "pending.claims")');
    expect(index).toContain('record.kind === "inflight" || record.kind === "hold"');
    // QA-2.1-8: the journal lives in the durable per-user state directory, not next to the outcome store.
    expect(index).toContain("resolvePendingJournalDir({ homedir: homedir(), platform: process.platform, xdgStateHome: process.env.XDG_STATE_HOME })");
    expect(backgroundSource).toContain("[router] the dispatch was lost in a restart");
    expect(backgroundSource).toContain("[router] not verified: lost in restart");
    expect(hooksSource).toContain("Its result is held until verification finishes.");
    expect(hooksSource).toContain("Its result will arrive unverified; the verdict follows in the router state.");
    expect(hooksSource).toContain("Router guarantees apply when it completes.");
  });
});

describe("docs drift: OpenCode v2 TUI status (#90 P2.2)", () => {
  const guide = read("docs/TUI_STATUS.md");
  const flat = guide.replace(/\s+/g, " ");
  const section = sectionOf(read("docs/CONFIG_REFERENCE.md"), "## TUI status options (OpenCode v2)");
  const readme = sectionOf(read("README.md"), "## TUI status (OpenCode v2)");
  const added = changelogAdded(read("CHANGELOG.md"), TUI_CHANGELOG_MARKER, "2.5.0"); // shipped in 2.5.0
  const pluginID = STATUS_PLUGIN_ID;
  const docs = [["TUI_STATUS.md", guide], ["CONFIG_REFERENCE.md", section], ["README.md", readme], ["CHANGELOG.md", added]] as const;

  it("finds the guide, both sections and the changelog entry, in [Unreleased] or else its release (2.5.0)", () => {
    for (const [name, text] of docs) expect(text.length, name).toBeGreaterThan(200);
    const entry = `- ${TUI_CHANGELOG_MARKER} x\n`;
    const released = `# Changelog\n\n## [Unreleased]\n\n## [2.5.0] - 2026-10-10\n\n### Added\n\n${entry}\n## [2.4.0] - 2026-10-09\n`;
    expect(changelogAdded(released, TUI_CHANGELOG_MARKER)).toBe(`### Added\n\n${entry}`);
    expect(changelogAdded(released.replace(/\n/g, "\r\n"), TUI_CHANGELOG_MARKER)).toBe(`### Added\n\n${entry}`);
    const pending = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${entry}\n## [2.4.0] - 2026-10-09\n`;
    expect(changelogAdded(pending, TUI_CHANGELOG_MARKER)).toBe(`### Added\n\n${entry}`);
    // only in an older release, or nowhere: not found
    const older = `# Changelog\n\n## [Unreleased]\n\n## [2.5.0] - 2026-10-10\n\n### Added\n\n- y\n\n## [2.4.0] - 2026-10-09\n\n### Added\n\n${entry}`;
    expect(changelogAdded(older, TUI_CHANGELOG_MARKER)).toBe("");
    // a named release finds the entry below a newer one, and only there
    expect(changelogAdded(older, TUI_CHANGELOG_MARKER, "2.4.0")).toBe(`### Added\n\n${entry}`);
    expect(changelogAdded(older, TUI_CHANGELOG_MARKER, "2.5.0")).toBe("");
  });

  it("(a) both options tables are STATUS_OPTION_KEYS with DEFAULT_STATUS_OPTIONS and the maxRows range parseOptions enforces", () => {
    expect(Object.keys(DEFAULT_STATUS_OPTIONS)).toEqual([...STATUS_OPTION_KEYS]);
    expect(tuiOptionsTableProblems(guide)).toEqual([]);
    expect(tuiOptionsTableProblems(section)).toEqual([]);
    const maxRowsNotices = (maxRows: unknown): number => parseOptions({ maxRows }).notices.length;
    expect([MAX_ROWS_MIN, MAX_ROWS_MAX].map(maxRowsNotices)).toEqual([0, 0]);
    expect([MAX_ROWS_MIN - 1, MAX_ROWS_MAX + 1, MAX_ROWS_MIN + 0.5, String(MAX_ROWS_MIN)].map(maxRowsNotices)).toEqual([1, 1, 1, 1]);
    for (const key of STATUS_OPTION_KEYS.filter((k) => k !== "maxRows")) {
      expect(parseOptions({ [key]: false }).options[key], key).toBe(false);
      expect(parseOptions({ [key]: "false" }).notices, key).toHaveLength(1);
    }
    for (const [name, text] of docs) for (const key of STATUS_OPTION_KEYS) expect(text, `${name}: ${key}`).toContain(tick(key));
  });

  it("(a) detects a dropped row, a changed type, default or range, an extra row and a missing table", () => {
    const dropped = section.split("\n").filter((line) => !line.startsWith("| `childView` |")).join("\n");
    expect(tuiOptionsTableProblems(dropped)).toEqual([expect.stringMatching(/^keys .*; code /)]);
    const maxRowsRow = section.split("\n").find((line) => line.startsWith("| `maxRows` |")) ?? "(no maxRows row)";
    const withRow = (row: string): string => section.replace(maxRowsRow, row);
    const range = `\`[${MAX_ROWS_MIN}, ${MAX_ROWS_MAX}]\``;
    const fallback = tick(String(DEFAULT_STATUS_OPTIONS.maxRows));
    expect(tuiOptionsTableProblems(withRow(maxRowsRow.replace(`| ${fallback} |`, "| `99` |")))).toEqual([`maxRows default: doc \`99\`, code ${fallback}`]);
    expect(tuiOptionsTableProblems(withRow(maxRowsRow.replace(range, "`[1, 99]`")))).toEqual([`maxRows range: doc \`[1, 99]\`, code ${range}`]);
    expect(tuiOptionsTableProblems(withRow(maxRowsRow.replace("`integer`", "`number`")))).toEqual(["maxRows type: doc `number`, code `integer`"]);
    const extra = `${maxRowsRow}\n| \`compact\` | \`boolean\` | \`false\` | \`true \\| false\` | x |`;
    expect(tuiOptionsTableProblems(withRow(extra))).toEqual([expect.stringMatching(/^keys .*`compact`; code /)]);
    expect(tuiOptionsTableProblems("# no table\n")).toEqual(["no options table"]);
  });

  it("(b) names the two slots setup claims, each for the options that claim it, and no other slot", () => {
    const footer = FOOTER_SLOT;
    const composer = COMPOSER_SLOT;
    expect([footer, composer]).toEqual(["prompt.footer.status", "session.composer.top"]);
    // what setup claims: G1 (`footer`) the footer slot, G2 and G3 (`childView`, `runningRow`) one composer slot
    expect(setupWith(undefined).slots).toEqual([footer, composer]);
    expect(setupWith({ footer: false }).slots).toEqual([composer]);
    // `childView: false` keeps the composer slot only when G3 is on (by default it is not, A12)
    expect(setupWith({ childView: false }).slots).toEqual(DEFAULT_STATUS_OPTIONS.runningRow ? [footer, composer] : [footer]);
    expect(setupWith({ childView: false, runningRow: true }).slots).toEqual([footer, composer]);
    expect(setupWith({ runningRow: true }).slots).toEqual([footer, composer]);
    expect(setupWith({ runningRow: false }).slots).toEqual([footer, composer]);
    expect(setupWith({ childView: false, runningRow: false }).slots).toEqual([footer]);
    expect(setupWith({ footer: false, childView: false, runningRow: false }).slots).toEqual([]);
    expect(setupWith({ enabled: false }).slots).toEqual([]);
    expect(slotNamesOf(guide)).toEqual([footer, composer]);
    expect(slotNamesOf(section)).toEqual([footer, composer]);
    for (const [name, text] of docs) expect(slotNamesOf(text).filter((slot) => slot !== footer && slot !== composer), name).toEqual([]);
    for (const doc of [guide, section]) {
      const controls = new Map((tableAfter(doc, "tui-status-options")?.rows ?? []).map((row) => [row[0] ?? "", row[4] ?? ""] as const));
      expect(controls.get("`footer`")).toContain(tick(footer));
      expect(controls.get("`childView`")).toContain(tick(composer));
      expect(controls.get("`runningRow`")).toContain(tick(composer));
    }
    expect(slotNamesOf("`prompt.footer` and `sidebar.content`")).toEqual(["prompt.footer", "sidebar.content"]);
  });

  it("(b) states what the defaults show: the running-delegates rows are opt-in, and how to turn them on (A12)", () => {
    // the owner decision: G3 off by default, G1 and G2 on
    expect([DEFAULT_STATUS_OPTIONS.footer, DEFAULT_STATUS_OPTIONS.childView, DEFAULT_STATUS_OPTIONS.runningRow]).toEqual([true, true, false]);
    // the options the docs quote turn the rows on, away from the default
    expect(parseOptions({ runningRow: true })).toEqual({ options: { ...DEFAULT_STATUS_OPTIONS, runningRow: true }, notices: [] });
    const turnOn = tick('"options": { "runningRow": true }');
    for (const [name, text] of docs) {
      const prose = text.replace(/\s+/g, " ");
      expect(prose, name).toContain(turnOn);
      expect(prose, name).toMatch(/[Oo]pt-in/);
      expect(prose, name).toMatch(/the main session shows only the footer's (?:`effort <value>`|effort)/);
    }
    // a cli.json example of the guide and of the README turns the rows on, as parseOptions reads it
    const turnsOn = (plugins: readonly unknown[]): boolean =>
      plugins.some((entry) => typeof entry === "object" && entry !== null && parseOptions((entry as { options?: unknown }).options).options.runningRow);
    expect(turnsOn(cliJsonExamples(guide).flat())).toBe(true);
    expect(turnsOn(cliJsonExamples(readme).flat())).toBe(true);
    expect(turnsOn([{ package: "opencode-model-router", options: { maxRows: 6 } }])).toBe(false);
  });

  it("(c) names the plugin id and the effort rpc as the code defines them, and no other id", () => {
    expect(pluginID).toBe("opencode-model-router.status");
    expect(statusPlugin.id).toBe(pluginID);
    expect(tuiEntry).toBe(statusPlugin);
    expect(effortRpc.id).toBe("opencode-model-router.effort");
    expect(Object.keys(effortRpc.methods)).toEqual(["effortOf"]);
    expect(Object.keys(effortRpc.methods.effortOf.input.properties)).toEqual(["sessionID"]);
    expect(Object.keys(effortRpc.methods.effortOf.output.properties)).toContain("thinkingBudget");
    expect(guide).toContain(tick(pluginID));
    expect(section).toContain(tick(pluginID));
    for (const text of [guide, readme, added]) expect(text).toContain(tick(effortRpc.id));
    const [method] = Object.keys(effortRpc.methods);
    const [input] = Object.keys(effortRpc.methods.effortOf.input.properties);
    expect(flat).toContain(tick(`${method}({ ${input} })`));
    expect(flat).toMatch(/`thinkingBudget`, but the views do not display it/);
    for (const [name, text] of docs) {
      expect(text, name).toContain(`"-${pluginID}"`);
      const ids = new Set([...text.matchAll(/opencode-model-router\.[a-z]+\b/g)].map((m) => m[0]));
      expect([...ids].filter((id) => id !== pluginID && id !== effortRpc.id), name).toEqual([]);
    }
    expect(flat).toMatch(new RegExp(`do not write \`"package": "${reEscape(pluginID)}"\`.{0,120}enable selector, and its \`options\` are dropped`));
  });

  it("(c) every cli.json example uses the package name or directory, valid options and the selector after the entries", () => {
    const guideExamples = cliJsonExamples(guide);
    const readmeExamples = cliJsonExamples(readme);
    expect(guideExamples).toHaveLength(3);
    expect(readmeExamples).toHaveLength(1);
    for (const plugins of [...guideExamples, ...readmeExamples]) {
      expect(plugins.length).toBeGreaterThan(0);
      expect(cliJsonEntryProblems(plugins, pluginID)).toEqual([]);
    }
    const entries = guideExamples.flat();
    expect(entries).toContainEqual(expect.objectContaining({ package: "opencode-model-router" }));
    expect(entries).toContainEqual(expect.objectContaining({ package: expect.stringMatching(/^\/.*\/opencode-model-router$/) }));
    expect(entries).toContain(`-${pluginID}`);
    // negative fixtures
    expect(cliJsonEntryProblems([{ package: pluginID, options: { maxRows: 6 } }], pluginID)).toEqual([`package is the plugin id ${pluginID}`]);
    expect(cliJsonEntryProblems([{ package: "/x/opencode-model-router/tui.ts" }], pluginID)).toEqual(["package /x/opencode-model-router/tui.ts"]);
    expect(cliJsonEntryProblems([{ package: "opencode-model-router", options: { maxRows: MAX_ROWS_MAX + 1 } }], pluginID)).toHaveLength(1);
    expect(cliJsonEntryProblems([`-${pluginID}`, { package: "opencode-model-router" }], pluginID)).toEqual([`explicit entry opencode-model-router after -${pluginID}`]);
    expect(cliJsonEntryProblems([pluginID], pluginID)).toEqual([`string entry ${pluginID}`]);
  });

  it("(d) names cli.json as the v2 TUI config file and never tells v2 users to use tui.json", () => {
    for (const [name, text] of docs) {
      expect(text, name).toContain("`cli.json`");
      expect(tuiJsonProblems(text), name).toEqual([]);
    }
    for (const text of [guide, section]) {
      expect(text).toContain("`<config dir>/cli.json`");
      expect(text).toContain("`~/.config/opencode/cli.json`");
    }
    expect(flat).toMatch(/`tui\.json` is OpenCode v1's TUI config file\. OpenCode v2 reads it only to migrate it when `cli\.json` does not exist/);
    // negative fixtures
    expect(tuiJsonProblems("Add the entry to `~/.config/opencode/tui.json`.\n")).toHaveLength(1);
    expect(tuiJsonProblems("Options go in `cli.json`.\n\nOr in `tui.json` on v2.\n")).toHaveLength(1);
    expect(tuiJsonProblems("```json\n// tui.json\n{}\n```\n")).toEqual(["a fenced block names tui.json"]);
    expect(tuiJsonProblems("`tui.json` is OpenCode v1's file; v2 uses `cli.json`.\n")).toEqual([]);
  });

  it("quotes the notices parseOptions emits and the rows the views render", () => {
    const invalid = parseOptions({ maxRows: "x" }).notices[0] ?? "(no notice)";
    expect(invalid).toBe(`${STATUS_NOTICE_PREFIX}invalid TUI options ("maxRows" must be an integer from ${MAX_ROWS_MIN} to ${MAX_ROWS_MAX}); using defaults for those keys`);
    expect(section.replace(/\s+/g, " ")).toContain(tick(invalid));
    expect(flat).toContain(tick(parseOptions("x").notices[0] ?? "(no notice)"));
    // F2: unknown keys are named in the same toast, which setup shows once; the guide prints both toasts, verbatim
    const both = parseOptions({ maxRows: "x", compact: true }).notices;
    expect(both).toEqual([`${STATUS_NOTICE_PREFIX}invalid TUI options ("maxRows" must be an integer from ${MAX_ROWS_MIN} to ${MAX_ROWS_MAX}; unknown keys "compact"); using defaults for those keys`]);
    const printed = fencedLines(guide);
    expect(printed).toContain(invalid);
    expect(printed).toContain(both[0]);
    expect(flat).toMatch(/For `\{ "maxRows": "x" \}` and for `\{ "maxRows": "x", "compact": true \}` the toasts are/);
    for (const text of [flat, section.replace(/\s+/g, " ")]) expect(text).toMatch(/names every invalid and every unknown key/);
    expect(setupWith({ maxRows: "x" }).toasts).toEqual([invalid]);
    expect(setupWith({ maxRows: "x", compact: true }).toasts).toEqual(both);
    expect(setupWith({ maxRows: 6 }).toasts).toEqual([]);
    // the rows
    const row = ["<agent>", "<model>", "<effort>"].join(ROW_SEPARATOR);
    expect(formatRow(["<agent>", "<model>", "<effort>"], 80)).toBe(row);
    for (const [name, text] of docs) {
      expect(text, name).toContain(tick(row));
      expect(text, name).toContain("`+<k> more`");
    }
    expect(effortWithVariant("high", "max")).toBe("high (max)");
    expect(effortWithVariant("high", "high")).toBe("high");
    expect(effortWithVariant("high")).toBe("high");
    expect(flat).toMatch(new RegExp(`\`<effort> \\(<variant>\\)\`, for example ${reEscape(tick(effortWithVariant("high", "max")))}`));
    expect(flat).toContain(tick(`effort ${DEFAULT_EFFORT}`));
    // F10: the fallbacks of a running delegate without agent, title or model
    const bare = runningChildren({
      rootID: "root", family: ["root", "child"], status: () => "running", sessions: (id) => ({ id, parentID: "root" }),
      messages: () => [], models: [], max: 4,
    });
    expect(bare.rows).toEqual([{ id: "child", agent: FALLBACK_AGENT, model: UNKNOWN_MODEL, effort: DEFAULT_EFFORT }]);
    expect(flat).toMatch(new RegExp(`session title, else ${reEscape(tick(FALLBACK_AGENT))}`));
    expect(flat).toMatch(new RegExp(`model ${reEscape(tick(UNKNOWN_MODEL))} and the effort ${reEscape(tick(DEFAULT_EFFORT))}`));
  });

  it("states the effort fallbacks: the footer shows `effort default`, the delegate rows the message's variant (F1)", () => {
    const current = { providerID: "p", modelID: "m" };
    // footer: no channel answer → default; a selected variant → nothing (the host row shows it)
    expect(effectiveMainEffort({ current })).toBe(DEFAULT_EFFORT);
    expect(effectiveMainEffort({ selectedVariant: "max", current })).toBeUndefined();
    expect(effectiveMainEffort({ current, applied: { effort: "high", ...current } })).toBe("high");
    expect(effectiveMainEffort({ current, applied: { effort: "high", providerID: "p", modelID: "other" } })).toBe(DEFAULT_EFFORT);
    // delegate rows: no channel answer → the message's variant, else default
    const session = { id: "child", parentID: "root", agent: "fast" };
    const message = (variant?: string) => ({ id: "a", type: "assistant", model: { id: "m", providerID: "p", ...(variant === undefined ? {} : { variant }) } });
    expect(childStatus({ session, messages: [message("low")], models: [] })?.effort).toBe("low");
    expect(childStatus({ session, messages: [message()], models: [] })?.effort).toBe(DEFAULT_EFFORT);
    expect(childStatus({ session, messages: [message("low")], models: [], applied: { effort: "medium", ...current } })?.effort).toBe("medium");
    const fallback = /footer shows `effort default`,? and the (?:delegated session and running-delegate|delegate) rows show the message's variant/;
    for (const text of [flat, readme.replace(/\s+/g, " "), added.replace(/\s+/g, " ")]) expect(text).toMatch(fallback);
    expect(flat).toMatch(/has no answer, the footer shows `effort default`/);
    for (const [name, text] of docs) {
      const prose = text.replace(/\s+/g, " ");
      for (const wrong of ["views fall back to the message's variant", "the views use the message's variant", "without it the rows show"]) {
        expect(prose, `${name}: ${wrong}`).not.toContain(wrong);
      }
    }
  });

  it("quotes the host versions, the poll, retry and width numbers and the peer dependency of the code", () => {
    expect(flat).toContain(`every ${POLL_INTERVAL_MS / 1000} s while the session runs`);
    expect(flat).toContain(`(${BACKOFF_START_MS / 1000} s, doubling up to ${BACKOFF_MAX_MS / 1000} s)`);
    expect(flat).toContain(`it stops asking about that session for at least ${FAILURE_COOLDOWN_MS / 1000} s`);
    // GA-2, R2-2: the quick re-pulls of a running delegated session without an effort yet, counted per remembered session;
    // root sessions keep the normal cadence (also in the limitation). GA-1: a reopened view keeps the last answer
    expect(flat).toContain(
      `While a running delegated session has not reported an effort yet, an answer without one is followed by another call after ${BACKOFF_START_MS / 1000} s, at most ${QUICK_REPULLS} times per session; the count is kept per remembered session (the last ${PULL_STATE_MAX}). Root sessions keep the normal cadence.`,
    );
    expect(flat).toContain(
      `The quick re-pulls after an answer without an effort apply to delegated sessions only (at most ${QUICK_REPULLS} per remembered session, the last ${PULL_STATE_MAX}); a root session is asked at the normal cadence.`,
    );
    expect(flat).toContain("the first call right away");
    expect(flat).toContain("A view that is closed and opened again shows the session's last answer at once, before its next call.");
    // B-1, R2-5: the verified hosts, and what an unverified 2.0.20–2.0.23 host is expected (not observed) to show
    expect(flat).toContain(
      "Verified on OpenCode 2.0.24–2.0.26.** On 2.0.20–2.0.23 the TUI entry is not verified; if it fails to load there, the host is expected to show `Plugin failed` and the server plugin keeps working.",
    );
    expect(flat).not.toContain("if it fails to load there, the host shows");
    // R2-1: the terminal width, not the composer; long rows run into the sidebar, in the Width section and the limitation
    const width = new RegExp(`terminal width minus ${WIDTH_MARGIN} columns, not to the composer, and never wrap`, "g");
    expect(flat.match(width)).toHaveLength(2);
    expect(flat.match(/row longer than the composer is not shortened to it and runs into the sidebar's columns/g)).toHaveLength(2);
    expect(flat).toMatch(/short rows were verified on one line with the sidebar open and closed/);
    // F4: what was verified on which hosts
    expect(flat).toMatch(/needs OpenCode 2\.0\.24 or later/);
    expect(flat).toMatch(/verified on 2\.0\.24, 2\.0\.25 and 2\.0\.26 with a scripted provider/);
    expect(read("README.md")).toContain("v2 **2.0.20+** (TUI status: 2.0.24+)");
    expect(flat).toMatch(/v1 never loads `tui\.ts`/);
    const peers = Object.keys(JSON.parse(read("package.json")).peerDependencies as Record<string, string>);
    expect(peers).toContain("@opencode-ai/plugin");
    expect(flat).toMatch(/needs the `@opencode-ai\/plugin` peer dependency installed/);
    for (const text of [flat, readme.replace(/\s+/g, " ")]) expect(text).toMatch(/[Tt]he router applies no effort to primary agents/);
  });

  it("links the guide from the README, the deep-dive list, the config reference and the changelog; the guide's links resolve", () => {
    expect(readme).toContain("(docs/TUI_STATUS.md)");
    expect(readme).toContain("(docs/CONFIG_REFERENCE.md#tui-status-options-opencode-v2)");
    expect(read("README.md")).toContain("- `docs/TUI_STATUS.md` —");
    expect(section).toContain("(./TUI_STATUS.md)");
    expect(added).toContain(TUI_CHANGELOG_MARKER);
    expect(added).toContain("(docs/TUI_STATUS.md)");
    const v2 = read("docs/OPENCODE_V2.md");
    expect(v2).toContain("(./TUI_STATUS.md)");
    expect(v2.replace(/\s+/g, " ")).toContain(`plugin rpc ${tick(effortRpc.id)}`);
    expect(brokenLinks(["docs/TUI_STATUS.md", "docs/OPENCODE_V2.md"], readRepo)).toEqual([]);
    for (const path of ["tui.ts", "src/tui/plugin.ts", "src/tui/status-model.ts", "src/tui/effort-rpc.ts", "src/tui/effort-channel.ts"]) {
      expect(readRepo(path), path).toBeDefined();
      expect(guide, path).toContain(tick(path));
    }
    // F18, R2-5: the prose of the guide and of the CONFIG_REFERENCE section is wrapped (table rows and code blocks cannot be)
    expect(longProseLines(guide)).toEqual([]);
    expect(longProseLines(section)).toEqual([]);
    const long = "x".repeat(121);
    expect(longProseLines(`ok\n${long}\n`)).toEqual([`2: ${long}`]);
    expect(longProseLines(`| ${long} |\n\`\`\`text\n${long}\n\`\`\`\n`)).toEqual([]);
  });

  it("the views never display the thinking budget (F9)", () => {
    for (const path of ["src/tui/plugin.ts", "src/tui/status-model.ts"]) {
      expect(withoutComments(read(path)), path).not.toContain("thinkingBudget");
    }
    // the channel output the views take: the budget is dropped, and a turn with a budget but no effort gives no effort
    expect(appliedOf({ effort: "high", providerID: "p", modelID: "m", thinkingBudget: 2048 })).toEqual({ effort: "high", providerID: "p", modelID: "m" });
    expect(appliedOf({ providerID: "p", modelID: "m", thinkingBudget: 2048 })).toBeUndefined();
    expect(flat).toMatch(/thinking budget \(`thinking\.budgetTokens`\) instead of an effort, the row shows the variant or `default`/);
    // the comment stripper keeps code and drops both comment forms
    expect(withoutComments("const a = x.thinkingBudget; // thinkingBudget\n/* thinkingBudget */ const b = 1;")).toBe("const a = x.thinkingBudget; \n const b = 1;");
    expect(withoutComments("// thinkingBudget\n/**\n * thinkingBudget\n */\nconst url = \"http://x\";")).not.toContain("thinkingBudget");
  });

  it("states the QA round 1 wording: auto-load, grandchildren, load failures, no Solid owner, version skew, the recorded effort", () => {
    // F3: auto-loaded only when the server entry loads
    expect(flat).toMatch(/auto-loaded only when the server entry loads/);
    expect(flat).not.toMatch(/The TUI entry is loaded only when/);
    expect(readme.replace(/\s+/g, " ")).toMatch(/auto-loads the TUI entry .{0,80}when the server entry loads/);
    expect(section.replace(/\s+/g, " ")).toMatch(/and the server entry loads/);
    // F5: grandchildren, as the code keeps them, hedged on the host's family list
    const family = runningChildren({
      rootID: "root", family: ["root", "child", "grandchild"], status: () => "running",
      sessions: (id) => ({ id, agent: id, parentID: id === "grandchild" ? "child" : "root" }), messages: () => [], models: [], max: 1,
    });
    expect([family.rows.map((row) => row.id), family.overflow]).toEqual([["child"], 1]);
    expect(flat).toMatch(/grandchildren\) are included when the host lists them in the root session's family/);
    // R2-3: a row lasts while the delegate's session runs
    expect(flat).toMatch(/goes away when the delegate finishes \(its session is no longer running\)/);
    expect(readme.replace(/\s+/g, " ")).toMatch(/until the delegate finishes \(its session is no longer running\)/);
    for (const text of [flat, readme.replace(/\s+/g, " ")]) expect(text).not.toMatch(/has answered/);
    // F6, R2-2, R2-7: the forms observed on the real hosts, verbatim; no stale marker or solid-js item
    for (const observed of [
      "`TUI opencode-model-router.status`", "`TUI opencode-model-router.status local`", "`Plugin failed: <path>`",
      "`Plugin failed: C:\\Users\\…`", "`⊙ 1 plugin failed /plugins`", "`x <path> failed, local`",
    ]) expect(guide, observed).toContain(observed);
    expect(flat).toMatch(/The `\/plugins` dialog shows a `TUI opencode-model-router\.status` row/);
    expect(flat).toMatch(/Observed on 2\.0\.24–2\.0\.26 when the TUI entry failed to load/);
    expect(flat).not.toMatch(/`plugin failed` marker in the footer|is marked `failed`|Cannot find package/);
    // F17, R2-4, GA-5: the no-owner toast verbatim as the code words it (its effect, no unreproduced cause), and what it means
    const owner = NO_OWNER_NOTICE.slice(0, NO_OWNER_NOTICE.indexOf(":") + 1);
    expect(owner).toBe("render has no Solid owner:");
    expect(flat).toContain(`A \`${STATUS_NOTICE_PREFIX}${NO_OWNER_NOTICE}\` toast.`);
    expect(NO_OWNER_NOTICE).not.toMatch(/node_modules|solid-js|shadows/);
    expect(flat).toMatch(/running-delegates row stays hidden/);
    expect(flat).not.toMatch(/named cause|was not reproduced/);
    expect(flat).toMatch(/if the toast persists, report it/);
    // F15: version skew of a package-name entry
    expect(flat).toMatch(/another version of the package than the server entry\. A local directory path .{0,40}avoids this/);
    // F16: what the server records
    expect(flat).toMatch(/records the effort the request carried after its `chat\.params` bridge .{0,90}with the turn's model and variant/);
    expect(flat).not.toMatch(/a role dispatch's variant/);
  });

  it("states the QA round 1 rules for the effort suffix, the row shrinking and the pull spacing (F12–F14)", () => {
    // F12: `(<variant>)` only when both are set, neither is `default`, and they differ ignoring case (values trimmed)
    expect(effortWithVariant("high", "max")).toBe("high (max)");
    expect(effortWithVariant(" high ", " max ")).toBe("high (max)");
    expect(effortWithVariant("high", "High")).toBe("high");
    expect(effortWithVariant("high", DEFAULT_EFFORT)).toBe("high");
    expect(effortWithVariant(DEFAULT_EFFORT, "max")).toBe(DEFAULT_EFFORT);
    expect(effortWithVariant("high", " ")).toBe("high");
    expect(flat).toMatch(/else the variant of the message's \(or, before the first message, the session's\) model; else `default`/);
    expect(flat).toMatch(/both values are set \(not blank\), neither is `default`, and they differ ignoring case/);
    expect(flat).not.toMatch(/else the model's variant/);
    // the session's model before the first message: its variant is the effort
    const early = childStatus({ session: { id: "child", parentID: "root", model: { id: "m", providerID: "p", variant: "low" } }, messages: [], models: [] });
    expect(early?.effort).toBe("low");
    // F13: the first part (the agent, else the model) shrinks first
    expect(formatRow(["abcdefghij", "model", "high"], 20)).toBe(`abcd…${ROW_SEPARATOR}model${ROW_SEPARATOR}high`);
    expect(formatRow(["", "modelname-long", "high"], 12)).toBe(`mode…${ROW_SEPARATOR}high`);
    expect(flat).toMatch(/the first part \(the agent, else the model\) shrinks first/);
    expect(flat).not.toMatch(/: the agent shrinks first/);
    // F14: trigger-driven pulls are spaced like the poll
    expect(flat).toMatch(new RegExp(`at most every ${POLL_INTERVAL_MS / 1000} s, when the session's status or latest message changes`));
  });
});
