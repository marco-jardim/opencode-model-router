import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, it, expect } from "vitest";
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
import { GUARD_CUMULATIVE_MULTIPLIER, REFUSAL_CAP, ROUTE_BUDGET_RAISE_MAX, TIER_GUARD_BUDGET } from "../../src/router/guard-profile";
import { DEFAULT_RUN_TIMEOUT_MS, RUN_ARG_RE, RUN_MAX_ARGS, RUN_OUTPUT_BYTES } from "../../src/router/run-tools";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import { authorityFloor, GRANT_NOTES } from "../../src/routing/roles/policy";
import { REDISPATCH_WINDOW_MS, SIGNAL_MASS_CAPS, SIGNAL_WEIGHTS } from "../../src/routing/outcomes/signals";
import { CRITERIA_BUDGET_CHARS } from "../../src/verify/dod";
import { ROLES_RESTART_NOTICE } from "../../src/compat/v2-hooks";
import { parseJsonc } from "../../src/router/jsonc";
import { FINDING_IDS } from "../../src/routing/advisor/findings";
import { runAdvisor } from "../../src/routing/advisor";
import { buildLadder, resolveChosen } from "../../src/routing/engine/ladders";
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

  it("D16: the release contract is version 2.3.0 in one PR closing both #74 and #73", () => {
    // Phase 3.4 prepares the release without merging, tagging or publishing it.
    expect(JSON.parse(read("package.json")).version).toBe("2.3.0");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe("2.3.0");
    expect(lock.packages[""].version).toBe("2.3.0");
    expect(read("CHANGELOG.md")).toContain("## [2.3.0] - 2026-10-07");
    expect(read("CHANGELOG.md")).toMatch(/^## \[Unreleased\]\r?$/m);
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
    expect(text).toContain("matched exactly (no wildcards: a `*` entry is dropped with a notice)");
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

/** Every difference between the guide's roles table and `specs`, cell by cell. */
function roleTableProblems(doc: string, specs: readonly RoleSpec[]): string[] {
  const table = tableAfter(doc, "roles-table");
  if (table === undefined) return ["no roles table"];
  const problems: string[] = [];
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

  it("the action-class table names every role action under its class", () => {
    const rows = guide.split(/\r?\n/).filter((line) => /^\| (local|exec|write|egress) \|/.test(line)).map(cellsOf);
    expect(rows.map((row) => row[0])).toEqual(["local", "exec", "write", "egress"]);
    const hostName = (action: string): string => (action === "router_git" ? "router_git_*" : action === "context7" ? "context7_*" : action);
    for (const [action, cls] of Object.entries(ACTION_CLASS)) {
      expect(rows.find((row) => row[0] === cls)?.[1], action).toContain(tick(hostName(action)));
    }
  });

  it("quotes the budget, steps, signal, exploration and router_run numbers of the code", () => {
    expect(flat).toContain(`${ROUTE_BUDGET_RAISE_MAX} × top role budget + \`REFUSAL_CAP\` + ${ROLE_STEPS_MARGIN}`);
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

  it("the changelog lists roles mode and the §2.9 behaviour changes under [Unreleased]", () => {
    const unreleased = /## \[Unreleased\]([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1]?.replace(/\s+/g, " ") ?? "";
    expect(unreleased).toContain("Roles mode: role × tier × assurance delegation (#84)");
    expect(unreleased).toContain("(docs/ROLES.md)");
    expect(unreleased).toContain("Behaviour change (#84)");
    for (const item of ["Reader guard profile.", "Uncharged denials.", "Whole criteria.", "Header strip.", "Progress notes are incomplete.", "`root=` in the header.",
      "The budget claim is read from the return prefix", "downgrading past this version is unsupported"]) expect(unreleased, item).toContain(item);
    expect(unreleased).toContain(`Explicit \`[acceptance]\` lists over ${CRITERIA_BUDGET_CHARS} code points are no longer graded in full`);
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
