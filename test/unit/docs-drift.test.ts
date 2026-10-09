import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  ROUTING_DEFAULTS,
  ROUTING_ENGINES,
  ROUTING_TASK_CLASSES,
  resolveRolesRouting,
  resolveRouting,
  validateConfig,
  ROLE_NOTICE_PREFIX,
} from "../../src/router/config";
import {
  AUTHORITY_ACTIONS,
  EXPLORATION_MAX_RATE,
  ROLES_V1_NOTICE,
  RUN_TIMEOUT_BOUNDS,
  sanitizeExploration,
  sanitizeRun,
  workRootProblem,
} from "../../src/router/roles-config";
import { ACTION_CLASS, CONTRACT_HEADING, DEFINING_CLASS, HOST_NATIVE_ROLE_NAMES, SHIPPED_ROLE_SPECS } from "../../src/router/roles";
import type { AuthorityAction, RoleSpec } from "../../src/router/roles";
import { ROLE_DENIED_ACTIONS, ROLE_STEPS_MARGIN, roleAgentSteps } from "../../src/router/role-agents";
import { GUARD_CUMULATIVE_MULTIPLIER, REFUSAL_CAP, roleGuardProfile, ROUTE_BUDGET_RAISE_MAX, TIER_GUARD_BUDGET } from "../../src/router/guard-profile";
import { DEFAULT_RUN_TIMEOUT_MS, RUN_ARG_RE, RUN_MAX_ARGS, RUN_OUTPUT_BYTES } from "../../src/router/run-tools";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import { authorityFloor, effectiveDetection, GRANT_NOTES } from "../../src/routing/roles/policy";
import { REDISPATCH_WINDOW_MS, runSignal, SIGNAL_MASS_CAPS, SIGNAL_WEIGHTS } from "../../src/routing/outcomes/signals";
import { CRITERIA_BUDGET_CHARS } from "../../src/verify/dod";
import { RENDERED_REASONS_MAX } from "../../src/verify/dispatch";
import { GRADER_REASONS_MAX } from "../../src/verify/checker";
import { oneLineReason } from "../../src/routing/roles/authority";
import { CREDENTIAL_ENV_RE } from "../../src/router/run-tools";
import { ROLES_RESTART_NOTICE } from "../../src/compat/v2-hooks";
import { parseJsonc } from "../../src/router/jsonc";
import { FINDING_IDS } from "../../src/routing/advisor/findings";
import { runAdvisor } from "../../src/routing/advisor";
import { buildLadder, buildRoleLadder, resolveChosen } from "../../src/routing/engine/ladders";
import { createDispatchRouter, resetDispatchRouting } from "../../src/routing/wire/dispatch";
import { createEngineRuntime } from "../../src/routing/wire/runtime";
import { resetBindingRegistryForTests } from "../../src/routing/roles/binding";
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
    };
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
  ];

  it("documents every key, and a missing one is detected", () => {
    expect(rolesKeys.filter((key) => keyRow(doc, key) === undefined)).toEqual([]);
    const fixture = rolesKeys.filter((key) => key !== "routing.workRoots").map((key) => `| \`${key}\` |`).join("\n");
    expect(rolesKeys.filter((key) => keyRow(fixture, key) === undefined)).toEqual(["routing.workRoots"]);
  });

  it("the Default column is what resolveRolesRouting applies", () => {
    const cell = (key: string) => keyRow(doc, key)?.[2];
    expect(cell("routing.delegation")).toBe(defaultCell(defaults.delegation));
    expect(cell("routing.exploration.rate")).toBe(defaultCell(defaults.exploration.rate));
    expect(cell("routing.exploration.requireDetection")).toBe(defaultCell(defaults.exploration.requireDetection));
    expect(cell("routing.run.timeoutMs")).toBe(defaultCell(defaults.run.timeoutMs));
    expect(cell("routing.run.scripts")).toBe(`\`${JSON.stringify(defaults.run.scripts).replace(/,/g, ", ")}\``);
    expect(cell("roleAgents")).toBe("`{}`");
    expect(cell("routing.workRoots")).toBe("`[]`");
    expect(defaults.workRoots).toEqual([]);
    expect(Object.keys(defaults.run.commands)).toEqual(["test-files"]);
  });

  it("the resolved-defaults block is what resolveRolesRouting applies", () => {
    const block = /<!-- roles-defaults: v2 -->\s*```jsonc\r?\n([\s\S]*?)```/.exec(doc);
    expect(block).not.toBeNull();
    const documented = parseJsonc(block![1]!) as Record<string, unknown>;
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
      "routing.run.commands", "routing.run.timeoutMs", "routing.workRoots"]) expect(guide, key).toContain(`\`${key}`);
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
function changelogAdded(changelog: string, marker: string): string {
  const text = changelog.replace(/\r\n/g, "\n");
  const dated = /^## \[[^\]\n]+\] - \d{4}-\d{2}-\d{2}$/m.exec(text)?.[0];
  const releases = [sectionOf(text, "## [Unreleased]"), dated === undefined ? "" : sectionOf(text, dated)];
  return releases.map((release) => sectionOf(release, "### Added")).find((added) => added.includes(marker)) ?? "";
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

describe("docs drift: OpenCode v2 TUI status (#90 P2.2)", () => {
  const guide = read("docs/TUI_STATUS.md");
  const flat = guide.replace(/\s+/g, " ");
  const section = sectionOf(read("docs/CONFIG_REFERENCE.md"), "## TUI status options (OpenCode v2)");
  const readme = sectionOf(read("README.md"), "## TUI status (OpenCode v2)");
  const added = changelogAdded(read("CHANGELOG.md"), TUI_CHANGELOG_MARKER);
  const pluginID = STATUS_PLUGIN_ID;
  const docs = [["TUI_STATUS.md", guide], ["CONFIG_REFERENCE.md", section], ["README.md", readme], ["CHANGELOG.md", added]] as const;

  it("finds the guide, both sections and the changelog entry, in [Unreleased] or else the first dated release", () => {
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
