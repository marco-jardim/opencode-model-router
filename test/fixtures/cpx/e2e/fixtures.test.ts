import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePlan } from "../../../../src/executor/compile/parse";
import { Reach } from "../../../../src/executor/compile/edges";
import { isFindingsReport } from "../../../../src/executor/types";
import { buildDelegationDoD } from "../../../../src/verify/dispatch";
import { createVerificationWiring } from "../../../../src/verify/wiring";
import { compileOpts, makeHarness, planPathOf } from "../plans/harness";
import { loadScript, scriptedTurns, type PlanScript, type TaskScript } from "./scripts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repositories = ["node-pnpm", "node-npm", "py-pip"];
const phases = ["1.1", "1.2", "2.1", "2.2"];

function repositoryFiles(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? repositoryFiles(join(directory, entry.name), relative)
      : [relative];
  });
}

function planText(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

function writeTurns(script: PlanScript, task: TaskScript) {
  return scriptedTurns(script, task).flatMap(({ reply }) => "tool" in reply ? [reply.input] : []);
}

function checkProviderScript(script: PlanScript, task: TaskScript): void {
  const turns = scriptedTurns(script, task);
  expect(turns.reduce((sum, turn) => sum + turn.delayMs, 0)).toBe(task.durationMs);
  expect(turns[0].delayMs).toBe(task.durationMs);
  for (const { reply } of turns) {
    if ("tool" in reply) {
      expect(reply.tool).toBe("write");
      expect(Object.keys(reply.input).sort()).toEqual(["content", "path"]);
      expect(reply.input.path).toMatch(/^(node-pnpm|node-npm|py-pip)\//);
      expect(reply.input.path).not.toMatch(/\\|(?:^|\/)\.\.(?:\/|$)/);
      expect(typeof reply.input.content).toBe("string");
    } else if (!reply.text.startsWith("DONE:") && !reply.text.startsWith("ESCALATE: human:")) {
      expect(isFindingsReport(JSON.parse(reply.text))).toBe(true);
    }
  }
  expect("text" in turns[turns.length - 1].reply).toBe(true);
}

// Run the unchanged suite against a scripted source in memory: no fixture or temp-file writes.
function suiteWithSource(source: string, suite: string) {
  const test = planText(`node-npm/${suite}`).replace('import { total } from "../src/index.js";', "");
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: `${source}\n${test}`, encoding: "utf8", timeout: 15000,
  });
}

describe("offline critical-path e2e fixtures", () => {
  it.each(["throughput", "resilience"] as const)("%s.md compiles with the 2.3 compiler", async (name) => {
    const script = loadScript(name);
    const filename = `${name}.md`;
    const text = planText(filename);
    const parsed = parsePlan(text);
    expect(parsed.waves.map((wave) => wave.id)).toEqual(["1", "2"]);
    expect(parsed.phases.map((phase) => phase.id)).toEqual(phases);
    expect(parsed.ownership).toHaveLength(4);
    expect(parsed.tasks).toHaveLength(24);
    for (const phase of phases) {
      expect(parsed.tasks.filter((task) => task.phase === phase)).toHaveLength(6);
      expect(parsed.tasks.find((task) => task.id === `${phase}.QA`)?.kind).toBe("qa");
    }
    const files = repositories.flatMap((repo) => repositoryFiles(join(root, repo), repo));
    const harness = makeHarness({ inline: { [filename]: text }, view: { files } });
    const config = { ...harness.config, ...script.executor };
    const { draft } = await harness.compiler.compile(planPathOf(filename), compileOpts(harness, { config }));
    expect(harness.compiler.validate(draft)).toEqual([]);
    expect(Object.keys(draft.tasks)).toHaveLength(24);
    expect(script.schemaVersion).toBe(1);
    expect(script.plan).toBe(filename);
    expect(script.executor).toEqual({ maxParallel: 4, crossPhase: "inferred" });
    expect(Object.keys(script.tasks).sort()).toEqual(Object.keys(draft.tasks).sort());
    expect(Object.keys(script.phaseSuites)).toEqual(phases);
    expect(script.localChecks["1.2"]).toEqual([
      { cwd: "node-npm", command: "node", args: ["--test", "test/index.test.js"] },
    ]);
    expect(isFindingsReport(script.defaults.qa)).toBe(true);
    for (const task of Object.values(draft.tasks)) {
      expect(task.footprint.confidence, task.id).toBe("explicit");
      const behavior = script.tasks[task.id];
      expect(behavior.durationMs, task.id).toBe(Number(/Scripted duration: (\d+) ms/.exec(task.text)?.[1]));
      checkProviderScript(script, behavior);
      if (task.kind === "qa") {
        const reply = scriptedTurns(script, behavior)[0].reply;
        expect("text" in reply && isFindingsReport(JSON.parse(reply.text))).toBe(true);
      }
    }
    for (const phase of phases) {
      expect(draft.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: `${phase}.1`, to: `${phase}.4`, kind: "conflict" }),
        expect.objectContaining({ from: `${phase}.2`, to: `${phase}.5`, kind: "structural" }),
        expect.objectContaining({ from: `${phase}.3`, to: `${phase}.5`, kind: "structural" }),
      ]));
    }
    if (name === "resilience") {
      const reach = new Reach(Object.keys(draft.tasks), (id) => draft.tasks[id]?.phase ?? null, phases);
      for (const edge of draft.edges) reach.add(edge.from, edge.to);
      expect(reach.concurrent("1.1.2", "1.1.3")).toBe(true);
      expect(draft.tasks["1.1.3"].footprint.writes).toEqual(["node-pnpm/artifacts/c.json"]);
    }
  });

  it("keeps throughput confined to clean deterministic completions", () => {
    const text = planText("throughput.md");
    expect(text).not.toMatch(/failure|question|429|restart|ESCALATE/i);
    const parsed = parsePlan(text);
    expect(parsed.tasks.filter((task) => task.kind === "qa")).toHaveLength(4);
    expect(parsed.tasks.every((task) => task.verify !== "required")).toBe(true);
    expect(text).toContain('Every QA returns `{"findings":[]}`');
    const script = loadScript("throughput");
    expect(JSON.stringify(script)).not.toMatch(/failure|question|429|restart|ESCALATE/i);
    expect(script.injections).toEqual([]);
    expect(script.generatedTasks ?? {}).toEqual({});
    expect(script.backgroundDispatches ?? []).toEqual([]);
    expect(Object.values(script.tasks).reduce((sum, task) => sum + task.durationMs, 0)).toBe(156000);
    for (const task of parsed.tasks) {
      const turns = scriptedTurns(script, script.tasks[task.id]);
      if (task.kind === "qa") expect(turns.map((turn) => turn.reply)).toEqual([{ text: '{"findings":[]}' }]);
      else {
        expect(turns).toHaveLength(2);
        expect(writeTurns(script, script.tasks[task.id])).toEqual([
          { path: script.tasks[task.id].writePath, content: '{"complete":true}\n' },
        ]);
      }
    }
  });

  it("scripts every resilience injection and its recovery without adding initial tasks", () => {
    const script = loadScript("resilience");
    expect(script.injections.map((injection) => injection.kind)).toEqual([
      "hidden-overlap", "phase-only-regression", "human-escalation", "qa-findings", "rate-limit", "host-restart",
      "ad-hoc-background", "user-backgrounded", "required-verification",
    ]);
    for (const injection of script.injections) {
      expect(injection.checkpoint).not.toBe("");
      if ("task" in injection) expect(script.tasks[injection.task]).toBeDefined();
      if ("recovery" in injection) checkProviderScript(script, injection.recovery);
      if ("dispatch" in injection) expect(script.backgroundDispatches?.some((call) => call.id === injection.dispatch)).toBe(true);
    }
    const overlap = script.injections.find((injection) => injection.kind === "hidden-overlap")!;
    expect(script.tasks[overlap.holder].writePath).toBe(overlap.path);
    expect(writeTurns(script, script.tasks[overlap.task])[0].path).toBe(overlap.path);
    expect(overlap.expectedToolResult).toBe("lease-conflict");
    expect(overlap.holdUntil).toBe("1.1.3:first-write-refused");
    const human = script.injections.find((injection) => injection.kind === "human-escalation")!;
    expect(scriptedTurns(script, script.tasks[human.task])[0].reply).toEqual({
      text: `ESCALATE: ${script.tasks[human.task].escalation}`,
    });
    expect(writeTurns(script, script.tasks[human.task])).toEqual([]);
    expect(human.answer).not.toBe("");
    expect(human.independentTask).toBe("2.1.4");
    const qa = script.injections.find((injection) => injection.kind === "qa-findings")!;
    const report = script.tasks[qa.task].findings!;
    expect(isFindingsReport(report)).toBe(true);
    expect(report.findings).toHaveLength(2);
    expect(Object.keys(script.generatedTasks ?? {})).toEqual([...qa.fixTasks, qa.reviewTask]);
    report.findings.forEach((finding, index) => {
      expect(script.generatedTasks?.[qa.fixTasks[index]].writePath).toBe(finding.files[0]);
    });
    for (const task of Object.values(script.generatedTasks ?? {})) checkProviderScript(script, task);
    const burst = script.injections.find((injection) => injection.kind === "rate-limit")!;
    expect(burst.fault).toBe("rate-limit");
    expect(burst.options).toEqual({ times: 3, retryAfterSeconds: 1 });
    expect(burst.faultDelayMs).toBe(0);
    const restart = script.injections.find((injection) => injection.kind === "host-restart")!;
    expect(restart.checkpoint).toBe("2.1.1:integrated-and-2.1.4:running");
    expect(restart.resumeCommand).toBe("/plan resume");
    expect(restart.recovery).toEqual(script.tasks[restart.task]);
    expect(script.tailAssertions).toEqual(expect.arrayContaining([
      "hidden-write-refused-by-lease", "leased-file-unchanged", "integration-head-always-green",
      "independent-progress-during-human-wait", "two-generated-fixes", "three-429s-replies-not-consumed",
      "restart-equivalent-to-baseline", "adhoc-tail-annotation-once", "user-backgrounded-verification-at-completion-once",
      "C4-and-C15-held-through-context-and-compaction", "no-output-before-verdict", "otherwise-foreground-fallback",
    ]));
  });

  it("injects a regression that the unchanged local suite misses and the phase suite catches", () => {
    const script = loadScript("resilience");
    const regression = script.injections.find((injection) => injection.kind === "phase-only-regression")!;
    const broken = writeTurns(script, script.tasks[regression.task]).find((write) => write.path === "node-npm/src/index.js")?.content;
    const repaired = writeTurns(script, regression.recovery).find((write) => write.path === "node-npm/src/index.js")?.content;
    expect(typeof broken).toBe("string");
    expect(typeof repaired).toBe("string");
    if (typeof broken !== "string" || typeof repaired !== "string") throw new Error("missing regression sources");
    const local = suiteWithSource(broken, "test/index.test.js");
    const phase = suiteWithSource(broken, "test/phase.test.js");
    expect(local.error).toBeUndefined();
    expect(phase.error).toBeUndefined();
    expect(local.status).toBe(regression.expectedLocalExit);
    expect(phase.status).toBe(regression.expectedPhaseExit);
    expect(phase.stdout).toContain("phase suite preserves negative totals");
    expect(repaired).toBe(planText("node-npm/src/index.js").replace(/\r\n/g, "\n"));
    expect(suiteWithSource(repaired, "test/index.test.js").status).toBe(0);
    expect(suiteWithSource(repaired, "test/phase.test.js").status).toBe(0);
  });

  it("keeps background probes non-plan, verifies user backgrounding, and conditions holding on C4 AND C15", () => {
    const script = loadScript("resilience");
    const calls = script.backgroundDispatches!;
    expect(calls.map((call) => call.id)).toEqual(["adhoc-background", "user-backgrounded", "required-held"]);
    for (const call of calls) {
      expect(script.tasks[call.id]).toBeUndefined();
      expect(call.prompt).toContain(`CPX_E2E_CALL=${call.id}`);
      checkProviderScript(script, call.script);
      expect(call.prompt).toContain(`VERIFY:${call.verify}`);
    }
    expect(new Set(calls.map((call) => call.script.writePath)).size).toBe(3);
    expect(calls[0]).toMatchObject({ background: true, verify: "deferred" });
    expect(calls[0].prompt).toMatch(/^check: testsPass$/m);
    expect(calls[1]).toMatchObject({ background: false, verify: "required", userAction: "background-while-running" });
    expect(calls[1].prompt).toContain(`check: fileExists path=${calls[1].script.writePath}`);
    expect(calls[2]).toMatchObject({ background: true, verify: "required", holdVerdictUntil: "context-and-compaction-placeholder-observed" });
    expect(calls[2].prompt).not.toMatch(/^\s*check:/m);
    const held = script.injections.find((injection) => injection.kind === "required-verification")!;
    expect(held.onlyWhen).toEqual(["C4", "C15"]);
    expect(held.otherwise).toBe("foreground");
  });

  it("classifies every background prompt with the enforced product verifier, not its sidecar label", async () => {
    const wiring = createVerificationWiring({
      client: {}, directory: root,
      getConfig: () => ({
        activePreset: "fixture", presets: { fixture: { medium: { model: "fixture/offline" } } },
        defaultTier: "medium", rules: [], enforcement: { verify: { require: "always" } },
      }),
    });
    try {
      for (const call of loadScript("resilience").backgroundDispatches!) {
        const dod = buildDelegationDoD({ prompt: call.prompt, description: call.id });
        const directives = wiring.directivesFor(call.prompt);
        // Enforcement has no per-dispatch "none": a non-deferred DoD runs the required gate.
        const actual = wiring.isDeferred(dod, directives) ? "deferred" : "required";
        expect(actual, call.id).toBe(call.verify);
        if (call.id === "required-held") {
          expect(dod.kind).toBe("checker");
          expect(dod.checks).toEqual([]);
          expect(dod.criteria).toContain("node-npm/background/held.json contains complete=true");
        } else {
          expect(dod.kind, call.id).toBe("deterministic");
          expect(dod.checks.map(check => check.kind), call.id).toContain(call.id === "adhoc-background" ? "testsPass" : "fileExists");
        }
      }
    } finally {
      await wiring.disposeVerification();
    }
  });

  it("runs both dependency-free Node suites without provisioning", () => {
    for (const [repo, files] of [
      ["node-npm", ["test/index.test.js", "test/phase.test.js"]],
      ["node-pnpm", ["test/index.test.mjs"]],
    ] as const) {
      const output = execFileSync(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", ...files], {
        cwd: join(root, repo), encoding: "utf8", timeout: 15000,
      });
      expect(output).toMatch(/# fail 0/);
    }
  });

  it("typechecks the TypeScript fixture with the pre-provisioned compiler", () => {
    const compiler = fileURLToPath(new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url));
    execFileSync(process.execPath, [compiler, "--noEmit", "-p", join(root, "node-pnpm/tsconfig.json")], {
      encoding: "utf8", timeout: 15000,
    });
  });

  it("leaves Python provisioning requirements-only and offline", () => {
    expect(readdirSync(join(root, "py-pip"))).not.toEqual(expect.arrayContaining(["pyproject.toml", "uv.lock"]));
    const requirements = planText("py-pip/requirements.txt");
    expect(requirements.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#"))).toEqual([]);
    expect(planText("py-pip/tests/test_total.py")).toContain("from mypkg import total");
  });
});
