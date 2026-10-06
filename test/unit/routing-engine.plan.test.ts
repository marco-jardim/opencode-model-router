import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveRouting, validateConfig } from "../../src/router/config";
import type { RouterConfig } from "../../src/router/config";
import { classifyMany as realClassifyMany } from "../../src/routing/classify";
import { parseRouteLine } from "../../src/routing/classify/route-line";
import {
  CLASS_STATIC_TIER,
  TASK_CLASSES,
  UNKNOWN_FACTS,
} from "../../src/routing/classify/types";
import type {
  ClassifyInput,
  ClassifyResult,
  Detection,
  Need,
  TaskClass,
  TaskFacts,
} from "../../src/routing/classify/types";
import { MIN_EVIDENCE_TO_MOVE } from "../../src/routing/engine/protocol-line";
import { annotateSteps, detectionOf, formatRouteLine } from "../../src/routing/engine/plan";
import type { AnnotateDeps, PlanStep } from "../../src/routing/engine/plan";
import type { HostAgentInfo } from "../../src/routing/engine/types";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import type { OutcomeKey } from "../../src/routing/outcomes/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const shipped: RouterConfig = validateConfig(JSON.parse(readFileSync(join(here, "../../tiers.json"), "utf-8")));
const cfg: RouterConfig = { ...shipped, activePreset: "anthropic" };
const routing = resolveRouting(cfg, "v2");
const ALL_NEEDS: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
const AGENTS: HostAgentInfo[] = ["fast", "medium", "heavy"].map((id) => ({
  id,
  mode: "subagent",
  hidden: false,
  permitted: true,
  grants: ALL_NEEDS,
}));

/** The real 1.2 `classifyMany` (rules only), bound to its deps with route lines recognised anywhere. */
function realDeps(): AnnotateDeps["classifyMany"] {
  return (inputs) =>
    realClassifyMany(inputs, {
      cfg,
      settings: { backend: "rules", model: null, baseUrl: null, apiKeyEnv: null, timeoutMs: 100, samples: 1, maxStateChars: 2000 },
      minClassConfidence: routing.minClassConfidence,
      backend: null,
      logger: { warn: () => undefined },
      routeLinePositions: "any",
    });
}

function deps(over: Partial<AnnotateDeps> = {}): AnnotateDeps {
  return { cfg, routing, agents: AGENTS, store: null, classifyMany: realDeps(), ...over };
}

function facts(cls: TaskClass, over: Partial<TaskFacts> = {}): TaskFacts {
  return { class: cls, risk: "medium", scope: "single", needs: [], confidence: 0.9, source: "rules", ...over };
}

function stub(f: TaskFacts, text: string, over: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    facts: f,
    pin: false,
    detection: null,
    stripped: text,
    trace: { rules: f, routeLine: null, routeLines: { count: 0, conflict: false, edgeOnly: true }, backend: null },
    ...over,
  };
}

/** Classifier stub: every step gets the facts of `factsFor(index)`. */
function stubDeps(factsFor: (index: number) => TaskFacts, over: Partial<AnnotateDeps> = {}): AnnotateDeps {
  return deps({ classifyMany: async (inputs) => inputs.map((input, index) => stub(factsFor(index), input.prompt)), ...over });
}

const step = (id: string, text: string): PlanStep => ({ id, text });
const ACCEPT_TESTS = "[acceptance]\ncheck: testsPass\n[/acceptance]";

// ---------------------------------------------------------------------------
// detectionOf / formatRouteLine
// ---------------------------------------------------------------------------

describe("detectionOf", () => {
  it("testsPass → deterministic; criteria only → grader; nothing → none", () => {
    expect(detectionOf(`Fix it\n${ACCEPT_TESTS}`)).toBe("deterministic");
    expect(detectionOf("Fix it\n[acceptance]\ncheck: buildPasses\ncheck: lintClean\n[/acceptance]")).toBe("deterministic");
    expect(detectionOf("Fix it\n[acceptance]\ncheck: fileExists path=a.txt\n[/acceptance]")).toBe("deterministic");
    expect(detectionOf("Fix it\n[acceptance]\ncriteria: the endpoint answers 200\n[/acceptance]")).toBe("grader");
    expect(detectionOf("Fix it\n[acceptance]\ncriteria: ok\ncheck: testsPass\n[/acceptance]")).toBe("deterministic");
    expect(detectionOf("Fix it")).toBe("none");
    expect(detectionOf("Fix it\n[acceptance]\ndeliverable: a.txt\n[/acceptance]")).toBe("none");
    expect(detectionOf("Fix it\n[acceptance]\ncheck: testsPass")).toBe("none"); // unclosed block
    expect(detectionOf("")).toBe("none");
  });
});

describe("formatRouteLine", () => {
  it("fixed field order; needs omitted when empty; pin last", () => {
    expect(formatRouteLine(facts("implement"), "none", false)).toBe("[route class=implement risk=medium scope=single d=none]");
    expect(formatRouteLine(facts("debug", { risk: "high", scope: "repo", needs: ["shell", "edit"] }), "deterministic", true)).toBe(
      "[route class=debug risk=high scope=repo needs=shell,edit d=deterministic pin]",
    );
  });

  it("emits needs in NEEDS order and round-trips through the 1.2 parser", () => {
    const f = facts("mechanical", { risk: "low", needs: ["external_dir", "network", "shell"] });
    const line = formatRouteLine(f, "grader", false);
    expect(line).toBe("[route class=mechanical risk=low scope=single needs=shell,network,external_dir d=grader]");
    const parsed = parseRouteLine(line, { positions: "first" });
    expect(parsed.count).toBe(1);
    expect(parsed.line).toMatchObject({ class: "mechanical", risk: "low", scope: "single", needs: ["shell", "network", "external_dir"], detection: "grader", pin: false });
  });

  it("only vocabulary values: anything else is replaced by the conservative value", () => {
    const bad = { ...facts("implement"), class: "weird", risk: "x", scope: "y" } as unknown as TaskFacts;
    expect(formatRouteLine(bad, "nope" as Detection, false)).toBe("[route class=other risk=medium scope=single d=none]");
  });
});

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

const PLAN_TEXTS = [
  "Search the repo for usages of parseConfig",
  "grep every call to loadConfig and list the files",
  "Implement the cache eviction in src/cache.ts",
  "Add an api endpoint GET /health",
  "Refactor the config loader into two modules",
  "Write tests for the eviction policy",
  "Fix the build error in src/index.ts",
  "Review the pull request for security problems",
  "Design the architecture of the new routing engine",
  "Rename the helper across the files",
  "Read the changelog and summarise",
  "Update the config file with the new key",
  "Create the file docs/notes.md",
  "Debug the failing integration test",
  "Do the thing",
  "List the files under src",
  "Check whether the lockfile exists",
  "Count the TODO comments",
  "Perform a root cause analysis of the memory growth",
  "Migrate the database schema to v3",
];

describe("annotateSteps — a 20-step plan in one pass", () => {
  const steps = PLAN_TEXTS.map((text, i) => step(`s${i + 1}`, `${text}\nmore detail for step ${i + 1}`));

  it("calls classifyMany exactly once with every step, in order", async () => {
    const spy = vi.fn(realDeps());
    const out = await annotateSteps(steps, deps({ classifyMany: spy }));
    expect(PLAN_TEXTS).toHaveLength(20);
    expect(spy).toHaveBeenCalledTimes(1);
    const inputs = spy.mock.calls[0]![0] as readonly ClassifyInput[];
    expect(inputs).toHaveLength(20);
    inputs.forEach((input, i) => {
      expect(input.prompt).toBe(steps[i]!.text);
      expect(input.description).toBe(PLAN_TEXTS[i]);
    });
    expect(out.map((a) => a.id)).toEqual(steps.map((s) => s.id));
  });

  it("annotates each step: engine tier = the class's static tier, route line right after the task line", async () => {
    const out = await annotateSteps(steps, deps());
    out.forEach((a, i) => {
      const source = steps[i]!;
      const [first, second, ...rest] = a.text.split("\n");
      const staticTier = CLASS_STATIC_TIER[a.facts.class] ?? cfg.defaultTier;
      expect(a.tierSource).toBe("engine");
      expect(a.routeSource).toBe("engine");
      expect(a.tier).toBe(staticTier); // empty store: the annotation equals the static mapping
      expect(first).toBe(`${PLAN_TEXTS[i]} [tier:${a.tier}]`);
      expect(second).toBe(a.routeLine);
      expect(rest).toEqual([`more detail for step ${i + 1}`]);
      expect(a.routeLine).toBe(formatRouteLine(a.facts, a.detection, a.pin));
      // The route line is recognised by the 1.2 parser in the first-line position of a dispatch.
      const parsed = parseRouteLine(a.dispatchPrompt, { positions: "first" });
      expect(parsed.count).toBe(1);
      expect(parsed.line?.class).toBe(a.facts.class);
      expect(a.dispatchPrompt.split("\n")[0]).toBe(a.routeLine);
      expect(a.dispatchPrompt).toBe(`${a.routeLine}\n${PLAN_TEXTS[i]} [tier:${a.tier}]\nmore detail for step ${i + 1}`);
      expect(source.text).toContain(PLAN_TEXTS[i]!); // the input is never mutated
    });
  });

  it("empty store: every class lands on its static tier, `other` on the default tier", async () => {
    const classes = [...TASK_CLASSES];
    const out = await annotateSteps(
      classes.map((c) => step(c, `a ${c} step`)),
      stubDeps((i) => facts(classes[i]!), { store: createOutcomeStore() }),
    );
    expect(out.map((a) => a.tier)).toEqual(classes.map((c) => CLASS_STATIC_TIER[c] ?? cfg.defaultTier));
  });

  it("no steps → no classification call", async () => {
    const spy = vi.fn(realDeps());
    expect(await annotateSteps([], deps({ classifyMany: spy }))).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a rejected classification leaves UNKNOWN_FACTS and the default tier, never switching", async () => {
    const out = await annotateSteps(
      [step("a", "Do something"), step("b", "Do more")],
      deps({ classifyMany: async () => Promise.reject(new Error("backend down")) }),
    );
    for (const a of out) {
      expect(a.facts).toEqual(UNKNOWN_FACTS);
      expect(a.tier).toBe(cfg.defaultTier);
      expect(a.routeLine).toBe("[route class=other risk=medium scope=single d=none]");
      expect(a.decision?.switched ?? false).toBe(false);
    }
  });

  it("a missing result falls back to UNKNOWN_FACTS for that step only", async () => {
    const out = await annotateSteps(
      [step("a", "Search the repo"), step("b", "Search more")],
      deps({ classifyMany: async (inputs) => [stub(facts("search", { risk: "low" }), inputs[0]!.prompt)] }),
    );
    expect(out[0]!.facts.class).toBe("search");
    expect(out[0]!.tier).toBe("fast");
    expect(out[1]!.facts).toEqual(UNKNOWN_FACTS);
    expect(out[1]!.tier).toBe(cfg.defaultTier);
  });

  it("falls back to the default tier when the preset lacks the class's static tier", async () => {
    const small: RouterConfig = { ...cfg, presets: { anthropic: { medium: cfg.presets.anthropic!.medium! } }, defaultTier: "medium" };
    const out = await annotateSteps([step("a", "Search the repo")], stubDeps(() => facts("search", { risk: "low" }), { cfg: small, routing: resolveRouting(small, "v2") }));
    expect(out[0]!.tier).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Existing tags are preserved
// ---------------------------------------------------------------------------

describe("annotateSteps — existing [tier:X] and [route …] are preserved", () => {
  it("keeps an existing tier tag verbatim, never re-emits it and never lets the engine override it", async () => {
    const out = await annotateSteps(
      [step("a", "Implement the cache [tier:fast]\ndetails")],
      stubDeps(() => facts("implement")),
    );
    const a = out[0]!;
    expect(a.tier).toBe("fast");
    expect(a.tierSource).toBe("existing");
    expect(a.text.match(/\[tier:/g)).toHaveLength(1);
    expect(a.text.split("\n")[0]).toBe("Implement the cache [tier:fast]");
    expect(a.routeSource).toBe("engine");
    expect(a.text.split("\n")[1]).toBe(a.routeLine);
  });

  it("the first tier tag wins when a step carries several; `[tier:heavy]` pins the step (D13)", async () => {
    const out = await annotateSteps(
      [step("a", "Refactor [tier:heavy] and later [tier:fast]"), step("b", "Search [tier:fast]")],
      stubDeps((i) => facts(i === 0 ? "implement" : "search", { risk: "low" })),
    );
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.pin).toBe(true);
    expect(out[0]!.routeLine.endsWith(" pin]")).toBe(true);
    expect(out[0]!.decision?.reasonCode).toBe("kept:pinned");
    expect(out[1]!.pin).toBe(false);
  });

  it("keeps an existing route line verbatim, never duplicates it, and adds only the tier tag", async () => {
    const text = "Search the repo\n[route class=search risk=low scope=single d=deterministic]\ndetails";
    const out = await annotateSteps([step("a", text)], deps());
    const a = out[0]!;
    expect(a.routeSource).toBe("existing");
    expect(a.routeLine).toBe("[route class=search risk=low scope=single d=deterministic]");
    expect(a.text).toBe("Search the repo [tier:fast]\n[route class=search risk=low scope=single d=deterministic]\ndetails");
    expect(a.detection).toBe("deterministic"); // `d=` on the route line wins
    expect(parseRouteLine(a.text, { positions: "any" }).count).toBe(1);
  });

  it("a route line on the first line stays first; the tier tag goes on the task line", async () => {
    const out = await annotateSteps([step("a", "[route class=debug]\nFix the bug in parse()\nmore")], deps());
    const a = out[0]!;
    expect(a.text).toBe("[route class=debug]\nFix the bug in parse() [tier:medium]\nmore");
    expect(a.dispatchPrompt).toBe("[route class=debug]\nFix the bug in parse() [tier:medium]\nmore");
    expect(a.facts.class).toBe("debug");
  });

  it("a route line deeper in the text is kept in place and still leads the dispatch prompt (A22)", async () => {
    const out = await annotateSteps([step("a", "Implement it\nbody line\n[route class=implement risk=medium scope=single d=none]\ntail")], deps());
    const a = out[0]!;
    expect(a.text).toBe("Implement it [tier:medium]\nbody line\n[route class=implement risk=medium scope=single d=none]\ntail");
    expect(a.dispatchPrompt).toBe("[route class=implement risk=medium scope=single d=none]\nImplement it [tier:medium]\nbody line\ntail");
  });

  it("annotating an annotated plan is the identity (idempotent), field for field", async () => {
    const original = [
      step("a", `Implement the cache in src/cache.ts\n${ACCEPT_TESTS}`),
      step("b", "Design the architecture of the new engine"),
      step("c", "QA the release candidate"),
      step("d", "Search the repo [tier:fast]"),
      step("e", "Do the thing"),
    ];
    const first = await annotateSteps(original, deps());
    const second = await annotateSteps(first.map((a) => step(a.id, a.text)), deps());
    expect(second.map((a) => a.text)).toEqual(first.map((a) => a.text));
    expect(second.map((a) => a.dispatchPrompt)).toEqual(first.map((a) => a.dispatchPrompt));
    expect(second.map((a) => a.routeLine)).toEqual(first.map((a) => a.routeLine));
    expect(second.map((a) => a.tier)).toEqual(first.map((a) => a.tier));
    expect(second.every((a) => a.tierSource === "existing" && a.routeSource === "existing")).toBe(true);
    expect(first.every((a) => a.tierSource === "engine" || a.id === "d")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acceptance → detection; pin; placement
// ---------------------------------------------------------------------------

describe("annotateSteps — detection and pin", () => {
  it("[acceptance] with testsPass → d=deterministic; criteria only → grader; none → none", async () => {
    const out = await annotateSteps(
      [
        step("t", `Implement the parser\n${ACCEPT_TESTS}`),
        step("g", "Implement the parser\n[acceptance]\ncriteria: handles empty input\n[/acceptance]"),
        step("n", "Implement the parser"),
      ],
      stubDeps(() => facts("implement", { needs: ["edit"] })),
    );
    expect(out.map((a) => a.detection)).toEqual(["deterministic", "grader", "none"]);
    expect(out[0]!.routeLine).toBe("[route class=implement risk=medium scope=single needs=edit d=deterministic]");
    expect(out[1]!.routeLine).toContain(" d=grader");
    expect(out[2]!.routeLine).toContain(" d=none");
    // The acceptance block survives in the dispatch prompt, after the route line.
    expect(out[0]!.dispatchPrompt.startsWith(`${out[0]!.routeLine}\nImplement the parser [tier:medium]\n[acceptance]`)).toBe(true);
  });

  it("a plan `d=` from the classifier beats the acceptance block", async () => {
    const out = await annotateSteps(
      [step("a", `Implement it\n${ACCEPT_TESTS}`)],
      deps({ classifyMany: async (inputs) => [stub(facts("implement"), inputs[0]!.prompt, { detection: "grader" })] }),
    );
    expect(out[0]!.detection).toBe("grader");
  });

  it("pins a step whose first line names QA (word-bounded, case-sensitive) or whose route line pins", async () => {
    const out = await annotateSteps(
      [step("a", "QA the release"), step("b", "Run the QAT suite"), step("c", "run qa checks"), step("d", "Ship it\n[route class=implement pin]")],
      stubDeps(() => facts("implement")),
    );
    expect(out.map((a) => a.pin)).toEqual([true, false, false, true]);
    expect(out[0]!.routeLine.endsWith(" pin]")).toBe(true);
    expect(out[0]!.decision?.pinned).toBe(true);
  });

  it("a pinned step keeps the static tier even with overwhelming evidence", async () => {
    const store = createOutcomeStore();
    for (let i = 0; i < 20; i++) store.recordVerdict("design|router:heavy|anthropic/claude-opus-5-5#xhigh" as OutcomeKey, "fail", { attemptID: `h${i}`, step: "dispatch" });
    for (let i = 0; i < 20; i++) store.recordVerdict("design|router:medium|anthropic/claude-sonnet-5-5#medium" as OutcomeKey, "pass", { attemptID: `m${i}`, step: "dispatch" });
    const out = await annotateSteps([step("a", `QA design of the engine\n${ACCEPT_TESTS}`)], stubDeps(() => facts("design", { risk: "high" }), { store }));
    expect(out[0]!.tier).toBe("heavy");
  });
});

describe("annotateSteps — evidence moves the engine tier", () => {
  const HEAVY_KEY = "design|router:heavy|anthropic/claude-opus-5-5#xhigh" as OutcomeKey;
  const MEDIUM_KEY = "design|router:medium|anthropic/claude-sonnet-5-5#medium" as OutcomeKey;
  const FAST_KEY = "design|router:fast|anthropic/claude-sonnet-5-5#low" as OutcomeKey;
  const designStep = step("a", `Design the new cache architecture\n${ACCEPT_TESTS}`);
  const designFacts = () => facts("design", { risk: "high" });

  function storeWith(heavyFails: number, mediumPasses: number) {
    const store = createOutcomeStore();
    for (let i = 0; i < heavyFails; i++) store.recordVerdict(HEAVY_KEY, "fail", { attemptID: `h${i}`, step: "dispatch" });
    for (let i = 0; i < mediumPasses; i++) store.recordVerdict(MEDIUM_KEY, "pass", { attemptID: `m${i}`, step: "dispatch" });
    // fast is the cheapest rung on priors; only evidence against it leaves medium as the argmin.
    for (let i = 0; i < heavyFails; i++) store.recordVerdict(FAST_KEY, "fail", { attemptID: `f${i}`, step: "dispatch" });
    return store;
  }

  it("strong evidence against heavy and for medium moves a verified design step to medium", async () => {
    const store = storeWith(20, 20);
    expect(store.posterior(MEDIUM_KEY).n).toBeGreaterThanOrEqual(MIN_EVIDENCE_TO_MOVE);
    const out = await annotateSteps([designStep], stubDeps(designFacts, { store }));
    expect(out[0]!.decision?.switched).toBe(true);
    expect(out[0]!.tier).toBe("medium");
    expect(out[0]!.text.split("\n")[0]).toBe("Design the new cache architecture [tier:medium]");
  });

  it("the same step without verification (d = none, high risk) never moves down (D9)", async () => {
    const out = await annotateSteps([step("a", "Design the new cache architecture")], stubDeps(designFacts, { store: storeWith(20, 20) }));
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.decision?.switched).toBe(false);
  });

  it("an untrusted class (confidence below minClassConfidence) keeps the static tier", async () => {
    const out = await annotateSteps([designStep], stubDeps(() => facts("design", { risk: "high", confidence: 0.3 }), { store: storeWith(20, 20) }));
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.decision?.reasonCode).toBe("kept:class-confidence");
  });

  it("a down switch to a rung with no recorded outcomes is refused by the kernel itself (A24, kept:evidence)", async () => {
    // heavy fails 20×, but the cheaper rungs have no data at all: the priors alone never move the step down.
    const store = createOutcomeStore();
    for (let i = 0; i < 20; i++) store.recordVerdict(HEAVY_KEY, "fail", { attemptID: `h${i}`, step: "dispatch" });
    const out = await annotateSteps([designStep], stubDeps(designFacts, { store }));
    expect(out[0]!.decision?.reasonCode).toBe("kept:evidence");
    expect(out[0]!.decision?.best?.agent).not.toBe("heavy");
    expect(out[0]!.tier).toBe("heavy");
  });

  it("an up switch is not gated by the kernel, but the plan still wants evidence on the winner", async () => {
    const FAST_SEARCH = "search|router:fast|anthropic/claude-sonnet-5-5#low" as OutcomeKey;
    const MEDIUM_SEARCH = "search|router:medium|anthropic/claude-sonnet-5-5#medium" as OutcomeKey;
    const searchStep = step("s", `Search the repo\n${ACCEPT_TESTS}`);
    const searchFacts = () => facts("search", { risk: "high" }); // a costly give-up makes the dearer, reliable rung worth it
    const store = (mediumPasses: number) => {
      const s = createOutcomeStore();
      for (let i = 0; i < 20; i++) s.recordVerdict(FAST_SEARCH, "fail", { attemptID: `f${i}`, step: "dispatch" });
      for (let i = 0; i < mediumPasses; i++) s.recordVerdict(MEDIUM_SEARCH, "pass", { attemptID: `m${i}`, step: "dispatch" });
      return s;
    };
    const backed = await annotateSteps([searchStep], stubDeps(searchFacts, { store: store(20) }));
    expect(backed[0]!.decision?.reasonCode).toBe("switched");
    expect(backed[0]!.decision?.best?.agent).toBe("medium");
    expect(backed[0]!.tier).toBe("medium");
    const bare = await annotateSteps([searchStep], stubDeps(searchFacts, { store: store(0) }));
    expect(bare[0]!.decision?.switched).toBe(true); // the kernel does not gate a switch up ...
    expect(bare[0]!.decision?.best?.agent).not.toBe("fast");
    expect(bare[0]!.tier).toBe("fast"); // ... the plan keeps the static tier until the winner has data
  });
  it("weak evidence (n < 5) and a missing store keep the static tier even if the kernel would switch on priors", async () => {
    const weak = await annotateSteps([designStep], stubDeps(designFacts, { store: storeWith(3, 3) }));
    expect(weak[0]!.tier).toBe("heavy");
    // Priors only, margin 0: the kernel itself may switch, the plan still annotates the static tier.
    const zero: RouterConfig = { ...cfg, routing: { margin: 0 } };
    const none = await annotateSteps(
      [step("a", `Implement it\n${ACCEPT_TESTS}`)],
      stubDeps(() => facts("implement", { needs: ["edit"] }), { cfg: zero, routing: resolveRouting(zero, "v2"), store: null }),
    );
    expect(none[0]!.tier).toBe("medium");
  });
});

describe("QA-1.4-7 / QA-1.4-8: heavy and QA steps are pinned, QA steps run on heavy", () => {
  const implement = () => facts("implement");

  it("a `[tier:heavy]` step whose route line lacks `pin` gets ` pin` appended to that line only", async () => {
    const text = "Refactor the loader [tier:heavy]\n[route class=implement risk=medium scope=single d=none]\nbody";
    const out = await annotateSteps([step("a", text)], stubDeps(implement));
    const a = out[0]!;
    expect(a.text).toBe("Refactor the loader [tier:heavy]\n[route class=implement risk=medium scope=single d=none pin]\nbody");
    expect(a.routeEdited).toBe(true);
    expect(a.changed).toBe(true);
    expect(a.pin).toBe(true);
    expect(a.routeSource).toBe("existing");
    expect(a.routeLine).toBe("[route class=implement risk=medium scope=single d=none pin]");
    expect(a.dispatchPrompt).toBe("[route class=implement risk=medium scope=single d=none pin]\nRefactor the loader [tier:heavy]\nbody");
    expect(a.decision?.reasonCode).toBe("kept:pinned");
  });

  it("keeps indentation, trailing whitespace and every other field; `pin=false` becomes `pin`", async () => {
    const out = await annotateSteps(
      [
        step("a", "Do it [tier:heavy]\n  [route class=search pin=false d=grader]  \nbody"),
        step("b", "QA the build\n[route]\nbody"),
      ],
      stubDeps(() => facts("search", { risk: "low" })),
    );
    expect(out[0]!.text).toBe("Do it [tier:heavy]\n  [route class=search pin d=grader]  \nbody");
    expect(out[0]!.routeLine).toBe("[route class=search pin d=grader]");
    expect(out[1]!.text).toBe("QA the build [tier:heavy]\n[route pin]\nbody");
    expect(out[1]!.routeEdited).toBe(true);
  });

  it("an existing route line that already pins is untouched and not reported as edited", async () => {
    const text = "Do it [tier:heavy]\n[route class=search d=none pin]";
    const out = await annotateSteps([step("a", text)], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.text).toBe(text);
    expect(out[0]!.routeEdited).toBe(false);
    expect(out[0]!.changed).toBe(false);
  });

  it("an existing route line on a step that needs no pin is not edited", async () => {
    const text = "Do it [tier:fast]\n[route class=search d=none]";
    const out = await annotateSteps([step("a", text)], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.text).toBe(text);
    expect(out[0]!.pin).toBe(false);
    expect(out[0]!.routeEdited).toBe(false);
  });

  it("an untagged QA step gets heavy and a pin, whatever the class says", async () => {
    const out = await annotateSteps(
      [step("a", "QA the release candidate"), step("b", "## QA round 2\ndetails")],
      stubDeps(() => facts("search", { risk: "low" })),
    );
    for (const a of out) {
      expect(a.tier).toBe("heavy");
      expect(a.tierSource).toBe("engine");
      expect(a.pin).toBe(true);
      expect(a.routeLine.endsWith(" pin]")).toBe(true);
      expect(a.decision?.reasonCode).toBe("kept:pinned");
    }
    expect(out[0]!.text.split("\n")[0]).toBe("QA the release candidate [tier:heavy]");
    expect(out[1]!.text.split("\n")[0]).toBe("## QA round 2 [tier:heavy]");
  });

  it("a preset without a heavy tier uses the default tier for a QA step", async () => {
    const small: RouterConfig = { ...cfg, presets: { anthropic: { fast: cfg.presets.anthropic!.fast!, medium: cfg.presets.anthropic!.medium! } }, defaultTier: "medium" };
    const out = await annotateSteps([step("a", "QA the release")], stubDeps(() => facts("search", { risk: "low" }), { cfg: small, routing: resolveRouting(small, "v2") }));
    expect(out[0]!.tier).toBe("medium");
    expect(out[0]!.pin).toBe(true);
  });

  it("an existing tier tag still wins over the QA default (but the step is pinned)", async () => {
    const out = await annotateSteps([step("a", "QA the release [tier:fast]")], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.tier).toBe("fast");
    expect(out[0]!.tierSource).toBe("existing");
    expect(out[0]!.pin).toBe(true);
  });

  it("a QA step never moves on evidence", async () => {
    const store = createOutcomeStore();
    for (let i = 0; i < 20; i++) store.recordVerdict("search|router:heavy|anthropic/claude-opus-5-5#xhigh" as OutcomeKey, "fail", { attemptID: `h${i}`, step: "dispatch" });
    for (let i = 0; i < 20; i++) store.recordVerdict("search|router:fast|anthropic/claude-sonnet-5-5#low" as OutcomeKey, "pass", { attemptID: `f${i}`, step: "dispatch" });
    const out = await annotateSteps([step("a", `QA the release\n${ACCEPT_TESTS}`)], stubDeps(() => facts("search", { risk: "low" }), { store }));
    expect(out[0]!.tier).toBe("heavy");
  });

  it("an engine-chosen heavy is pinned too, so that annotating the annotated plan changes nothing", async () => {
    const out = await annotateSteps([step("a", "Design the engine")], stubDeps(() => facts("design", { risk: "high" })));
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.pin).toBe(true);
    expect(out[0]!.decision?.pinned).toBe(false); // the kernel decided before the tier was final
  });
});

describe("QA-1.4-13: the QA match is narrow", () => {
  const pins = async (lines: readonly string[]) =>
    (await annotateSteps(lines.map((l, i) => step(`s${i}`, l)), stubDeps(() => facts("search", { risk: "low" })))).map((a) => a.pin);

  it("a leading QA word or a named QA activity pins and forces heavy", async () => {
    expect(await pins(["QA the release", "QA: verify the fix", "- QA review of the diff", "## QA round 2", "1. QA sign-off", "**QA** the release", "Prepare the QA review", "Hold the QA gate"])).toEqual(
      Array.from({ length: 8 }, () => true),
    );
  });

  it("incidental mentions are routine work: no pin, no heavy tag", async () => {
    const lines = ["Write the QA notes", "Update the QA docs", "Run the QAT suite", "Explain quality assurance", "run qa checks", "Rename QAHelper"];
    expect(await pins(lines)).toEqual(lines.map(() => false));
  });
});

describe("QA-1.4-20: a tier tag inside an inline code span is not a tag", () => {
  const stubSearch = () => facts("search", { risk: "low" });

  it("Document the `[tier:heavy]` tag syntax: no existing tag, no pin, the engine tags the step", async () => {
    const out = await annotateSteps([step("a", "Document the `[tier:heavy]` tag syntax")], stubDeps(stubSearch));
    const a = out[0]!;
    expect(a.tierSource).toBe("engine");
    expect(a.tier).toBe("fast");
    expect(a.pin).toBe(false);
    expect(a.text.split("\n")[0]).toBe("Document the `[tier:heavy]` tag syntax [tier:fast]");
    // The appended tag is the real one: annotating again changes nothing.
    const again = await annotateSteps([step("a", a.text)], stubDeps(stubSearch));
    expect(again[0]!.text).toBe(a.text);
    expect(again[0]!.tierSource).toBe("existing");
    expect(again[0]!.tier).toBe("fast");
  });

  it("longer backtick runs, several spans and a real tag after a span", async () => {
    const out = await annotateSteps(
      [
        step("double", "Explain ``[tier:heavy]`` and ```[tier:medium]``` here"),
        step("real", "Explain `[tier:heavy]` then tag it [tier:medium]"),
        step("two", "Use `a` and `[tier:heavy]` and `b`"),
      ],
      stubDeps(stubSearch),
    );
    expect(out.map((a) => [a.tierSource, a.tier])).toEqual([["engine", "fast"], ["existing", "medium"], ["engine", "fast"]]);
    expect(out.map((a) => a.pin)).toEqual([false, false, false]);
  });

  it("an unclosed backtick is plain text: the tag after it still counts", async () => {
    const out = await annotateSteps([step("a", "Mind the ` tick [tier:heavy]")], stubDeps(stubSearch));
    expect(out[0]!.tierSource).toBe("existing");
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.pin).toBe(true);
  });
});
describe("QA-1.4-19 (A26): the result reports how many steps the annotation pinned", () => {
  const plan = [
    step("design", "Design the new engine"), // engine-chosen heavy → pinned
    step("qa", "QA the release"), // QA → heavy + pin
    step("tagged", "Refactor [tier:heavy]\n[route class=implement d=none]"), // existing route line edited to add pin
    step("already", "Ship it [tier:heavy]\n[route class=implement d=none pin]"), // already pinned: not this annotation's work
    step("plain", "Search the repo"), // not pinned
    step("route", "Ship [tier:fast]\n[route class=search pin]"), // pinned by the plan itself
  ];
  const stubFacts = (index: number) => facts(index === 0 ? "design" : index === 2 || index === 3 ? "implement" : "search", { risk: index === 0 ? "high" : "low" });

  it("counts the pins this annotation added: engine route lines carrying pin and edited route lines", async () => {
    const out = await annotateSteps(plan, stubDeps(stubFacts));
    expect(out.map((a) => a.pin)).toEqual([true, true, true, true, false, true]);
    expect(out.pinnedCount).toBe(3);
  });

  it("is an array property that does not leak into equality or iteration; annotating again pins nothing", async () => {
    const first = await annotateSteps(plan, stubDeps(stubFacts));
    expect(Object.keys(first)).toEqual(first.map((_, i) => String(i)));
    expect([...first]).toHaveLength(plan.length);
    const second = await annotateSteps(first.map((a) => step(a.id, a.text)), stubDeps(stubFacts));
    expect(second.pinnedCount).toBe(0);
    expect((await annotateSteps([], deps())).pinnedCount).toBe(0);
    expect(await annotateSteps([], deps())).toEqual([]);
  });
});
describe("QA-1.4-18: a verb or adjective before QA, and QA followed by on/of/for, a colon or the line end", () => {
  const pins = async (lines: readonly string[]) =>
    (await annotateSteps(lines.map((l, i) => step(`s${i}`, l)), stubDeps(() => facts("search", { risk: "low" })))).map((a) => a.pin);

  it("recognises the QA steps the first match missed", async () => {
    const lines = [
      "Run QA on phase 3",
      "Perform QA",
      "Final QA",
      "Do QA for the release",
      "run QA on the branch",
      "Perform the QA of the build",
      "Adversarial QA of the diff",
      "Senior QA review",
      "Phase 3 QA on the build",
      "Release gate: QA:",
      "Schedule the final QA",
    ];
    expect(await pins(lines)).toEqual(lines.map(() => true));
  });

  it("a QA step found this way is tagged heavy and pinned like any other", async () => {
    const out = await annotateSteps([step("a", "Run QA on phase 3")], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.tier).toBe("heavy");
    expect(out[0]!.pin).toBe(true);
    expect(out[0]!.text.split("\n")[0]).toBe("Run QA on phase 3 [tier:heavy]");
  });

  it("finding ids, longer words and plain mentions stay routine work", async () => {
    const lines = [
      "Fix QA-1.4-3 finding",
      "QA-1.4-15: tighten the evidence gate",
      "Write the QA notes",
      "Update the QA docs",
      "Run the QAT suite",
      "run qa checks",
      "Do the QA2 migration",
      "Rename QAHelper",
      "Explain the QA process",
    ];
    expect(await pins(lines)).toEqual(lines.map(() => false));
  });
});
describe("QA-1.4-9: fenced blocks hold no tag, route line or task line; annotation is idempotent", () => {
  it("tags and route lines inside a fence are text: the engine annotates the real task line", async () => {
    const text = "```\n[tier:heavy]\n[route class=debug pin]\n```\nFix the thing\nmore";
    const spy = vi.fn(async (inputs: readonly ClassifyInput[]) => inputs.map((input) => stub(facts("search", { risk: "low" }), input.prompt)));
    const out = await annotateSteps([step("a", text)], deps({ classifyMany: spy }));
    const a = out[0]!;
    expect(a.tierSource).toBe("engine");
    expect(a.routeSource).toBe("engine");
    expect(a.pin).toBe(false);
    expect(a.text).toBe(`\`\`\`\n[tier:heavy]\n[route class=debug pin]\n\`\`\`\nFix the thing [tier:fast]\n${a.routeLine}\nmore`);
    expect(spy.mock.calls[0]![0][0]!.description).toBe("Fix the thing");
    // The fenced route line stays in the dispatch prompt; only the real one leads it.
    expect(a.dispatchPrompt).toBe(`${a.routeLine}\n\`\`\`\n[tier:heavy]\n[route class=debug pin]\n\`\`\`\nFix the thing [tier:fast]\nmore`);
  });

  it("a fence marker is never the task line; an unclosed fence leaves nothing to annotate", async () => {
    const out = await annotateSteps(
      [step("a", "```ts\ncode();\n```\nDo it"), step("b", "```\nnever closed\nstill code")],
      stubDeps(() => facts("search", { risk: "low" })),
    );
    expect(out[0]!.text.split("\n")[3]).toBe("Do it [tier:fast]");
    expect(out[1]!.text).toBe("```\nnever closed\nstill code");
    expect(out[1]!.changed).toBe(false);
    expect(out[1]!.dispatchPrompt.split("\n")[0]).toBe(out[1]!.routeLine);
  });

  it("a real tag or route line outside the fence is still found", async () => {
    const text = "```\n[tier:heavy]\n```\nDo it [tier:medium]\n[route class=implement d=none]";
    const out = await annotateSteps([step("a", text)], stubDeps(() => facts("implement")));
    expect(out[0]!.tier).toBe("medium");
    expect(out[0]!.tierSource).toBe("existing");
    expect(out[0]!.routeSource).toBe("existing");
    expect(out[0]!.text).toBe(text);
  });

  it("re-annotating an annotated plan twice is byte-identical", async () => {
    const original = [
      step("plain", "Search the repo for parseConfig\nmore"),
      step("fence", "```\n[tier:heavy]\n[route class=debug pin]\n```\nFix the thing"),
      step("open", "```\nnever closed"),
      step("crlf", "\r\nSearch the repo\r\nmore\r\n"),
      step("indent", "   - indented step\n      deeper"),
      step("tab", "\ttabbed step"),
      step("qa", "QA the release"),
      step("heavy-route", "Refactor it [tier:heavy]\n[route class=implement risk=medium scope=single d=none]"),
      step("design", "Design the new engine"),
      step("acceptance", `Implement the parser\n${ACCEPT_TESTS}`),
      step("blank", "  \n "),
      step("route-first", "[route class=debug]\nFix the bug"),
    ];
    const first = await annotateSteps(original, deps());
    const second = await annotateSteps(first.map((a) => step(a.id, a.text)), deps());
    const third = await annotateSteps(second.map((a) => step(a.id, a.text)), deps());
    expect(second.map((a) => a.text)).toEqual(first.map((a) => a.text));
    expect(third.map((a) => a.text)).toEqual(first.map((a) => a.text));
    expect(second.map((a) => a.dispatchPrompt)).toEqual(first.map((a) => a.dispatchPrompt));
    expect(second.every((a) => !a.changed)).toBe(true);
    expect(second.map((a) => a.pin)).toEqual(first.map((a) => a.pin));
    expect(second.map((a) => a.tier)).toEqual(first.map((a) => a.tier));
    expect(first.some((a) => a.changed)).toBe(true);
  });
});
describe("annotateSteps — placement", () => {
  it("indents the route line with the task line's leading spaces, never 4 or more", async () => {
    const out = await annotateSteps(
      [step("a", "  - indented two"), step("b", "      six spaces deep"), step("c", "\ttabbed step"), step("d", "flush")],
      stubDeps(() => facts("search", { risk: "low" })),
    );
    const lines = out.map((a) => a.text.split("\n")[1]!);
    expect(lines.map((l) => /^ */.exec(l)![0].length)).toEqual([2, 3, 0, 0]);
    for (const a of out) {
      expect(a.text.split("\n")[1]!.startsWith("\t")).toBe(false);
      // Recognised by the parser wherever it sits.
      expect(parseRouteLine(a.text, { positions: "any" }).count).toBe(1);
      // And route line first in the dispatch prompt, flush left.
      expect(a.dispatchPrompt.startsWith("[route ")).toBe(true);
    }
  });

  it("skips leading blank lines and preserves CRLF endings", async () => {
    const out = await annotateSteps([step("a", "\r\n\r\nSearch the repo\r\nmore\r\n")], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.text).toBe(`\r\n\r\nSearch the repo [tier:fast]\r\n${out[0]!.routeLine}\r\nmore\r\n`);
    // QA-1.4-14: the dispatch prompt keeps the step's own line ending.
    expect(out[0]!.dispatchPrompt).toBe(`${out[0]!.routeLine}\r\n\r\n\r\nSearch the repo [tier:fast]\r\nmore\r\n`);
    expect(out[0]!.dispatchPrompt).not.toMatch(/(?<!\r)\n/);
  });

  it("a one-line step gets the route line on a new line; a blank step is returned unchanged", async () => {
    const out = await annotateSteps([step("a", "Search the repo"), step("b", "  \n ")], stubDeps(() => facts("search", { risk: "low" })));
    expect(out[0]!.text).toBe(`Search the repo [tier:fast]\n${out[0]!.routeLine}`);
    expect(out[1]!.text).toBe("  \n ");
    expect(out[1]!.dispatchPrompt.startsWith("[route ")).toBe(true);
  });

  it("is deterministic: equal inputs give equal annotations", async () => {
    const steps = PLAN_TEXTS.slice(0, 8).map((text, i) => step(`s${i}`, text));
    const a = await annotateSteps(steps, deps());
    const b = await annotateSteps(steps, deps());
    expect(b.map((x) => x.text)).toEqual(a.map((x) => x.text));
  });
});
