import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ROUTING_DEFAULTS,
  ROUTING_ENGINES,
  ROUTING_TASK_CLASSES,
  resolveRouting,
  validateConfig,
} from "../../src/router/config";
import { parseJsonc } from "../../src/router/jsonc";
import { FINDING_IDS } from "../../src/routing/advisor/findings";
import { runAdvisor } from "../../src/routing/advisor";
import { buildLadder, resolveChosen } from "../../src/routing/engine/ladders";
import { candidateKey, decide } from "../../src/routing/engine/kernel";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { advance, buildEscalatePolicy, newLadderState, nextAction, recordAttempt } from "../../src/escalate/ladder";
import type { HostAgentInfo } from "../../src/routing/engine/types";
import {
  FLOOR_LIFT_REASON, RESUME_NAMED_NEEDS_REASON, RESUME_NAMED_NEVER_DOWN_REASON, RESUME_PINNED_REASON, RESUME_REASON, RESUME_RUNNING_REASON,
} from "../../src/routing/outcomes/types";
import type { Need, TaskFacts } from "../../src/routing/classify/types";
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
  it("documents every tiers.json top-level key in CONFIG_REFERENCE.md", () => {
    const tiers = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const doc = read("docs/CONFIG_REFERENCE.md");

    const keys = Object.keys(tiers);
    // Sanity: a tiers.json that parsed to nothing would make this vacuously green.
    expect(keys.length).toBeGreaterThan(0);

    const undocumented = undocumentedKeys(doc, keys);
    expect(undocumented).toEqual([]);
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

  it("keeps every engine-example block of ROUTING_ENGINE.md a valid configuration", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    const bundled = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const examples = [...doc.matchAll(/<!-- engine-example: ([\w-]+) -->\s*```jsonc\n([\s\S]*?)\n```/g)];
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
    const unreleased = /## \[Unreleased\]([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1] ?? "";
    expect(unreleased).toContain("#73");
    expect(unreleased).toContain("#74");
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
