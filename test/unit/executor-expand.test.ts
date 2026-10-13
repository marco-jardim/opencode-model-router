// Phase 3.1.4: task expansion (memo phase-3.1.md M36 and §8 "expand.ts (3.1.4)").
import { describe, expect, it } from "vitest";
import {
  expandTask,
  loadExpansionEnv,
  normalizePrefix,
  renderRouteLine,
  renderTaskBlock,
  rewriteAbsolutePaths,
  type ExpandInput,
  type ExpansionEnv,
  type PathMap,
} from "../../src/executor/expand.js";
import {
  ExecutorError,
  FINDINGS_FORMAT,
  LAUNCH_HEADER_PATTERN,
  looksLikePlanPrompt,
  parseLaunchHeader,
  type GitRunner,
  type LedgerV1,
  type ProcessResult,
  type SlotLease,
  type TaskNode,
} from "../../src/executor/types.js";
import { registerSlot, unregisterSlot } from "../../src/executor/slots/env.js";
import { parseRouteLine } from "../../src/routing/classify/route-line.js";
import { PLAN_ID, buildDraft, clone, nonceFor, openAttempt, taskNode as baseTaskNode } from "../fixtures/cpx/ledger/builders.js";

/** The shared builder with a route-less task by default (its default `route.line` is not a `[route ...]` line). */
function taskNode(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return baseTaskNode(id, { route: { line: "", role: "implementer", tier: null, pin: false }, ...patch });
}

const MAIN = "D:\\git\\omr-cpx-main";
const P61 = "D:\\git\\omr-cpx-p61";
const SLOT = "D:\\slots\\slot-1";
const SHA = "c".repeat(40);
const ENV: ExpansionEnv = { worktrees: [MAIN, P61], longPaths: false };

function lease(path = SLOT, owner = "T1"): SlotLease {
  return { slot: "slot-1", path, planId: PLAN_ID, owner, commit: SHA };
}

function ledgerOf(tasks: TaskNode[], patch: Partial<LedgerV1> = {}): LedgerV1 {
  const l = buildDraft(1);
  l.tasks = {};
  for (const t of tasks) l.tasks[t.id] = t;
  l.repo = { ...l.repo, toplevel: MAIN };
  return { ...l, ...patch };
}

function input(l: LedgerV1, taskId: string, attempt = 1, over: Partial<ExpandInput> = {}): ExpandInput {
  return { ledger: l, taskId, attempt, nonce: nonceFor(attempt), slot: lease(SLOT, taskId), env: ENV, ...over };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ExecutorError ? e.code : `other:${String(e)}`;
  }
}

function result(code: number | null, stdout = "", stderr = ""): ProcessResult {
  return { code, signal: null, stdout, stderr, truncated: false, durationMs: 1 };
}

function gitDouble(replies: { list: ProcessResult; config: ProcessResult }): { git: GitRunner; calls: Array<{ args: readonly string[]; cwd: string }> } {
  const calls: Array<{ args: readonly string[]; cwd: string }> = [];
  const git: GitRunner = {
    run: (args, o) => {
      calls.push({ args, cwd: o.cwd });
      return Promise.resolve(args[0] === "worktree" ? replies.list : replies.config);
    },
  };
  return { git, calls };
}

const PORCELAIN =
  "worktree D:/git/omr-cpx-main\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n\n" +
  "worktree D:/git/omr-cpx-p61\nHEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nbranch refs/heads/cpx/p61\n";

describe("expandTask: determinism and the launch header", () => {
  const t = taskNode("T1", {
    route: { line: "[route class=implement risk=low scope=single needs=edit d=none]", role: "implementer", tier: "medium", pin: true },
  });
  const l = ledgerOf([t]);

  it("is byte-stable per attempt and different for attempt n + 1", () => {
    const a = expandTask(input(l, "T1", 1));
    const b = expandTask(input(l, "T1", 1));
    expect(b).toEqual(a);
    expect(b.prompt).toBe(a.prompt);
    const c = expandTask(input(l, "T1", 2));
    expect(c.prompt).not.toBe(a.prompt);
    expect(c.prompt).toContain("#2] nonce=");
  });

  it("round-trips the header through parseLaunchHeader and has no other header-shaped line", () => {
    const p = expandTask(input(l, "T1", 3)).prompt;
    expect(parseLaunchHeader(p, l.sharedContext)).toEqual({ planId: PLAN_ID, taskId: "T1", attempt: 3, nonce: nonceFor(3) });
    expect(looksLikePlanPrompt(p)).toBe(true);
    const matches = p.match(new RegExp(LAUNCH_HEADER_PATTERN.source, "gm")) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("carries no launcher B grammar: no route line, acceptance markers or VERIFY in the prompt", () => {
    const p = expandTask(input(l, "T1")).prompt;
    expect(p).not.toMatch(/\[route/i);
    expect(p).not.toMatch(/\[\/?acceptance\]/i);
    expect(p).not.toMatch(/VERIFY:/);
    expect(p.startsWith("PLAN CONTEXT\nshared notes\n\n[plan ")).toBe(true);
  });

  it("uses \\n only, no trailing spaces, and the memo's section order", () => {
    const rich = taskNode("T1", {
      subtasks: ["first", "second"],
      acceptance: "[acceptance]\ncwd: D:\\git\\omr-cpx-main\ncheck: buildPasses\ncriteria: it works\n[/acceptance]",
      attempts: [{ ...openAttempt(1), context: "the previous attempt failed lint" }],
    });
    const p = expandTask(input(ledgerOf([rich]), "T1", 2)).prompt;
    expect(p).not.toContain("\r");
    expect(p).not.toMatch(/[ \t]$/m);
    const order = ["TASK T1: ", "SUBTASKS", "Writes: ", "Reads: ", "ENVIRONMENT", "ACCEPTANCE", "ATTEMPT CONTEXT", "MUST NOT DO"].map((s) => p.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(p).toContain("1. first\n2. second");
    expect(p).toContain("- it works");
    expect(p).toContain("the previous attempt failed lint");
    expect(p).not.toContain("FINDINGS FORMAT");
  });

  it("states the working directory and the base commit of the slot", () => {
    const p = expandTask(input(l, "T1")).prompt;
    expect(p).toContain(`Working directory: ${SLOT}\n`);
    expect(p).toContain(`Base commit: ${SHA}\n`);
  });

  it("omits ATTEMPT CONTEXT when the latest attempt has none", () => {
    const x = taskNode("T1", { attempts: [openAttempt(1)] });
    expect(expandTask(input(ledgerOf([x]), "T1")).prompt).not.toContain("ATTEMPT CONTEXT");
  });

  it("rejects an unknown task and a shared context that looks like a header", () => {
    expect(codeOf(() => expandTask(input(l, "nope")))).toBe("E_LAUNCH_TASK");
    const bad = ledgerOf([t], { sharedContext: `[plan ${PLAN_ID}:T9#1] nonce=${nonceFor(1)}` });
    expect(codeOf(() => expandTask(input(bad, "T1")))).toBe("E_LAUNCH_TASK");
  });
});

describe("expandTask: route line, acceptance, findings, MUST NOT DO", () => {
  it("re-serializes the route line with root=<slot> and the tier", () => {
    const t = taskNode("T1", {
      route: { line: "[route class=implement risk=medium scope=multi needs=shell,edit d=deterministic root=D:\\git\\omr-cpx-p61 tier=medium pin]", role: "implementer", tier: "medium", pin: true },
    });
    const x = expandTask(input(ledgerOf([t]), "T1"));
    expect(x.routeLine).toBe(`[route class=implement risk=medium scope=multi needs=shell,edit d=deterministic root=${SLOT} tier=medium pin]`);
    const parsed = parseRouteLine(x.routeLine, { positions: "first" });
    expect(parsed.count).toBe(1);
    expect(parsed.line?.root).toBe(SLOT);
    expect(parsed.line?.tier).toBe("medium");
    expect(parsed.line?.pin).toBe(true);
    expect(parsed.line?.ignored).toEqual([]);
    expect(x.workRoot).toBe(SLOT);
  });

  it("[tier:X] gives tier=X pin, and a task without a route line still gets root", () => {
    const pinned = taskNode("T1", { route: { line: "", role: "implementer", tier: "heavy", pin: true } });
    expect(renderRouteLine(pinned, SLOT)).toBe(`[route root=${SLOT} tier=heavy pin]`);
    const plain = taskNode("T1", { route: { line: "", role: "implementer", tier: null, pin: false } });
    expect(renderRouteLine(plain, SLOT)).toBe(`[route root=${SLOT}]`);
  });

  it("rewrites the acceptance block: cwd and every path=", () => {
    const t = taskNode("T1", {
      acceptance:
        `[acceptance]\ncwd: ${P61}\ncheck: fileExists path=${P61}\\test\\fixtures\\a.md\ncheck: fileExists path=${MAIN}\\docs\\b.md\ncriteria: ok\n[/acceptance]`,
    });
    const x = expandTask(input(ledgerOf([t]), "T1"));
    expect(x.acceptance).toBe(
      `[acceptance]\ncwd: ${SLOT}\ncheck: fileExists path=${SLOT}\\test\\fixtures\\a.md\ncheck: fileExists path=${SLOT}\\docs\\b.md\ncriteria: ok\n[/acceptance]`,
    );
  });

  it("gives null acceptance and null verify when the task has none", () => {
    const t = taskNode("T1", { verify: "none", acceptance: null });
    const x = expandTask(input(ledgerOf([t]), "T1"));
    expect(x.acceptance).toBeNull();
    expect(x.verify).toBeNull();
    expect(expandTask(input(ledgerOf([taskNode("T1")]), "T1")).verify).toBe("required");
  });

  it("adds FINDINGS FORMAT for qa only, matching JSON.stringify(FINDINGS_FORMAT)", () => {
    const qa = expandTask(input(ledgerOf([taskNode("T1", { kind: "qa" })]), "T1")).prompt;
    expect(qa).toContain("FINDINGS FORMAT\n");
    expect(qa).toContain("```json");
    expect(qa).toContain(JSON.stringify(FINDINGS_FORMAT));
    expect(qa.indexOf("FINDINGS FORMAT")).toBeGreaterThan(qa.indexOf("MUST NOT DO"));
    for (const kind of ["task", "tests", "fix", "preflight", "manual"] as const) {
      expect(expandTask(input(ledgerOf([taskNode("T1", { kind })]), "T1")).prompt).not.toContain("FINDINGS FORMAT");
    }
  });

  it("states the three MUST NOT DO rules verbatim", () => {
    const p = expandTask(input(ledgerOf([taskNode("T1")]), "T1")).prompt;
    expect(p).toContain(
      "MUST NOT DO\n- no AI attribution in code, comments or docs\n- never run git\n- write only the `Writes:` paths",
    );
  });
});

describe("expandTask: Phase 6.1 with the injected worktree list", () => {
  // Excerpt of the frozen plan (test/fixtures/cpx/plans/critical-path-execution-plan.md, Phase 6.1, tasks 6.1.1 and 6.1.2).
  const ROUTE = `[route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=${P61} tier=medium pin]`;
  const T611 = taskNode("6.1.1", {
    title: "Scripted-provider additions, with unit tests.",
    text:
      "Writes: `D:\\git\\omr-cpx-main\\test\\smoke\\helpers\\cpx-scripted-provider.ts`, `D:\\git\\omr-cpx-main\\test\\smoke\\helpers\\cpx-scripted-provider.test.ts`\n" +
      "(amendment A-0.1-1: the v1-frozen `scripted-provider.ts` and its test stay byte-identical).\n" +
      "Reads: the pre-flight list in `D:\\git\\omr-cpx-main\\docs\\qa\\critical-path-execution\\phase-6.1.md`.",
    route: { line: ROUTE, role: "implementer", tier: "medium", pin: true },
    acceptance:
      `[acceptance]\ncwd: ${P61}\ncheck: buildPasses\ncheck: testsPass\ncriteria: every missing feature is added and unit-tested; npm run smoke:keyless stays green (orchestrator shell)\n[/acceptance]`,
  });
  const T612 = taskNode("6.1.2", {
    title: "Fixtures in `D:\\git\\omr-cpx-main\\test\\fixtures\\cpx\\e2e\\`.",
    text: "Writes: `D:\\git\\omr-cpx-main\\test\\fixtures\\cpx\\e2e\\`. Reads: `D:\\git\\omr-cpx-main\\test\\fixtures\\cpx\\repos\\`.",
    subtasks: [
      "Plan `D:\\git\\omr-cpx-main\\test\\fixtures\\cpx\\e2e\\throughput.md`: 24 tasks over 2 waves.",
      "Reads `D:/git/omr-cpx-main/test/fixtures/cpx/repos/node-npm` and d:\\GIT\\OMR-CPX-P61\\x.",
    ],
    route: { line: ROUTE, role: "implementer", tier: "medium", pin: true },
    acceptance:
      `[acceptance]\ncwd: ${P61}\ncheck: fileExists path=${P61}\\test\\fixtures\\cpx\\e2e\\throughput.md\ncriteria: both plans compile; ${MAIN}\\test\\fixtures\\cpx\\e2e\\throughput.md has no failure\n[/acceptance]`,
  });

  it("loads the worktree list through the GitRunner double", async () => {
    const { git, calls } = gitDouble({ list: result(0, PORCELAIN), config: result(1) });
    const env = await loadExpansionEnv(git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 5000 });
    expect(env).toEqual({ worktrees: [MAIN, P61], longPaths: false });
    expect(calls[0]).toEqual({ args: ["worktree", "list", "--porcelain"], cwd: MAIN });
    expect(calls[1]?.cwd).toBe(SLOT);
    expect(calls[1]?.args).toContain("core.longpaths");
  });

  it("expands both tasks with no p61 or main path left", async () => {
    const { git } = gitDouble({ list: result(0, PORCELAIN), config: result(1) });
    const env = await loadExpansionEnv(git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 5000 });
    const l = ledgerOf([T611, T612]);
    for (const id of ["6.1.1", "6.1.2"]) {
      const x = expandTask(input(l, id, 1, { env }));
      for (const text of [x.prompt, x.routeLine, x.acceptance ?? ""]) {
        expect(text).not.toMatch(/omr-cpx-p61/i);
        expect(text).not.toMatch(/omr-cpx-main/i);
      }
      expect(x.routeLine).toBe(`[route class=implement risk=medium scope=multi needs=shell,edit d=deterministic root=${SLOT} tier=medium pin]`);
      expect(x.acceptance).toContain(`cwd: ${SLOT}\n`);
    }
    const a = expandTask(input(l, "6.1.1", 1, { env }));
    expect(a.prompt).toContain(`Writes: \`${SLOT}\\test\\smoke\\helpers\\cpx-scripted-provider.ts\`, \`${SLOT}\\test\\smoke\\helpers\\cpx-scripted-provider.test.ts\``);
    expect(a.prompt).toContain(`\`${SLOT}\\docs\\qa\\critical-path-execution\\phase-6.1.md\`.`);
    const b = expandTask(input(l, "6.1.2", 1, { env }));
    expect(b.prompt).toContain(`TASK 6.1.2: Fixtures in \`${SLOT}\\test\\fixtures\\cpx\\e2e\\\`.`);
    expect(b.prompt).toContain(`${SLOT}/test/fixtures/cpx/repos/node-npm`);
    expect(b.acceptance).toContain(`path=${SLOT}\\test\\fixtures\\cpx\\e2e\\throughput.md`);
  });

  it("renderTaskBlock uses the map it is given", () => {
    const map: PathMap = { mappable: [MAIN, P61], inRepo: [MAIN, P61], slot: SLOT, longPaths: false };
    const block = renderTaskBlock(ledgerOf([T611]), T611, lease(SLOT, "6.1.1"), map);
    expect(block.startsWith("TASK 6.1.1: Scripted-provider additions, with unit tests.\n")).toBe(true);
    expect(block).not.toMatch(/omr-cpx/i);
  });
});

describe("loadExpansionEnv", () => {
  it("reads core.longpaths = true from the slot", async () => {
    const { git } = gitDouble({ list: result(0, PORCELAIN), config: result(0, "true\n") });
    expect((await loadExpansionEnv(git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).longPaths).toBe(true);
    const off = gitDouble({ list: result(0, PORCELAIN), config: result(0, "false\n") });
    expect((await loadExpansionEnv(off.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).longPaths).toBe(false);
  });

  it("fails with E_GIT when git fails", async () => {
    const bad = gitDouble({ list: result(128, "", "fatal: not a git repository"), config: result(1) });
    await expect(loadExpansionEnv(bad.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).rejects.toMatchObject({ code: "E_GIT" });
    const badConfig = gitDouble({ list: result(0, PORCELAIN), config: result(128, "", "boom") });
    await expect(loadExpansionEnv(badConfig.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).rejects.toMatchObject({ code: "E_GIT" });
  });
});

describe("rewriteAbsolutePaths", () => {
  const map: PathMap = { mappable: [MAIN], inRepo: [MAIN], slot: SLOT, longPaths: false };

  it("maps a prefix at a segment boundary only", () => {
    expect(rewriteAbsolutePaths(`see ${MAIN}\\src\\a.ts and ${MAIN}.`, map)).toBe(`see ${SLOT}\\src\\a.ts and ${SLOT}.`);
    expect(rewriteAbsolutePaths(`${MAIN}`, map)).toBe(SLOT);
    // The prefix ends inside a segment: another directory, not rewritten and not unmappable either.
    const inside = `${MAIN}line\\src\\a.ts and ${MAIN}-old\\x`;
    expect(rewriteAbsolutePaths(inside, map)).toBe(inside);
  });

  it("matches drive paths case-insensitively and with either separator, POSIX paths case-sensitively", () => {
    expect(rewriteAbsolutePaths("d:/GIT/OMR-CPX-MAIN/src/a.ts", map)).toBe(`${SLOT}/src/a.ts`);
    const posix: PathMap = { mappable: ["/home/u/Repo"], inRepo: ["/home/u/Repo"], slot: "/slots/s1", longPaths: false };
    expect(rewriteAbsolutePaths("/home/u/Repo/src/a.ts", posix)).toBe("/slots/s1/src/a.ts");
    expect(rewriteAbsolutePaths("/home/u/repo/src/a.ts", posix)).toBe("/home/u/repo/src/a.ts");
    expect(rewriteAbsolutePaths("/home/u/Repository/x", posix)).toBe("/home/u/Repository/x");
  });

  it("prefers the longest mappable prefix", () => {
    const nested: PathMap = { mappable: [MAIN, `${MAIN}\\sub`], inRepo: [MAIN], slot: SLOT, longPaths: false };
    expect(rewriteAbsolutePaths(`${MAIN}\\sub\\a.ts`, nested)).toBe(`${SLOT}\\a.ts`);
  });

  it("fails with E_LAUNCH_TASK on an in-repo absolute path that is not mappable", () => {
    const m: PathMap = { mappable: [P61], inRepo: [P61, MAIN], slot: SLOT, longPaths: false };
    expect(codeOf(() => rewriteAbsolutePaths(`read ${MAIN}\\a.ts`, m))).toBe("E_LAUNCH_TASK");
    expect(rewriteAbsolutePaths(`read ${P61}\\a.ts and C:\\elsewhere\\b.ts`, m)).toBe(`read ${SLOT}\\a.ts and C:\\elsewhere\\b.ts`);
  });

  it("fails through expandTask for a root declared by another task but not mappable", () => {
    const other = taskNode("T2", { route: { line: "[route class=debug root=D:\\git\\omr-cpx-p62]", role: "implementer", tier: null, pin: false } });
    const t = taskNode("T1", { text: "look at D:\\git\\omr-cpx-p62\\x.ts" });
    expect(codeOf(() => expandTask(input(ledgerOf([t, other]), "T1")))).toBe("E_LAUNCH_TASK");
  });

  it("fails on a rewritten path over 260 characters without core.longpaths, and passes with it", () => {
    const long = `${MAIN}\\${"a".repeat(260)}`;
    expect(codeOf(() => rewriteAbsolutePaths(long, map))).toBe("E_LAUNCH_TASK");
    const on: PathMap = { ...map, longPaths: true };
    expect(rewriteAbsolutePaths(long, on)).toBe(`${SLOT}\\${"a".repeat(260)}`);
    const shortEnough = `${MAIN}\\${"a".repeat(200)}`;
    expect(rewriteAbsolutePaths(shortEnough, map)).toBe(`${SLOT}\\${"a".repeat(200)}`);
  });
});

describe("renderRouteLine: whitelist re-serialization", () => {
  const routeOf = (line: string, over: Partial<TaskNode["route"]> = {}): TaskNode =>
    taskNode("T1", { route: { line, role: "implementer", tier: null, pin: false, ...over } });

  it("accepts S-style fallback ids and dotted ids through the whole expansion", () => {
    for (const id of ["S1", "S12", "S-3", "6.1.1", "T1.a_b"]) {
      const l = ledgerOf([taskNode(id)]);
      const x = expandTask(input(l, id));
      expect(parseLaunchHeader(x.prompt, l.sharedContext)).toMatchObject({ taskId: id });
      expect(x.prompt).toContain(`TASK ${id}: `);
    }
  });

  it("orders fields canonically, drops budget and the declared root, and normalizes needs", () => {
    const line = `[route pin  d=grader needs = edit, shell  scope=repo risk=high class=review budget=40 root="D:\\my dir\\x" tier=fast]`;
    expect(renderRouteLine(routeOf(line), SLOT)).toBe(`[route class=review risk=high scope=repo needs=shell,edit d=grader root=${SLOT} tier=fast pin]`);
  });

  it("task.route.tier and pin win over the line's own", () => {
    expect(renderRouteLine(routeOf("[route class=debug tier=fast]", { tier: "heavy", pin: true }), SLOT)).toBe(
      `[route class=debug root=${SLOT} tier=heavy pin]`,
    );
  });

  it("fails on values outside their token patterns", () => {
    for (const line of [
      "[route class=bogus]",
      "[route risk=extreme]",
      "[route scope=]",
      "[route needs=shell,bogus]",
      "[route d=maybe]",
      "[route tier=ultra]",
      "[route pin=maybe]",
      "[route class=debug class=review]",
      "[route frobnicate=1]",
      "[route class=debug,root=/evil]",
    ]) {
      expect(codeOf(() => renderRouteLine(routeOf(line), SLOT)), line).toBe("E_LAUNCH_TASK");
    }
  });

  it("quotes a slot path that holds a space (QA-3.1 nit 5) and the parser reads it back", () => {
    const t = routeOf("[route class=debug]");
    const line = renderRouteLine(t, "D:\\my slots\\s1");
    expect(line).toBe(`[route class=debug root="D:\\my slots\\s1"]`);
    // the same line is accepted as a task's own route line (its quoted root is replaced by the slot)
    expect(renderRouteLine(routeOf(line), SLOT)).toBe(`[route class=debug root=${SLOT}]`);
    // a path without whitespace stays bare
    expect(renderRouteLine(t, "D:\\slots\\s1")).toBe(`[route class=debug root=D:\\slots\\s1]`);
  });

  it("fails on a slot path with a tab, a bracket, a quote, a newline, a relative or a .. path", () => {
    const t = routeOf("");
    for (const bad of ["D:\\my\tslots\\s1", "D:\\s]1", "D:\\s\"1", "D:\\s\n1", "slots\\s1", "D:\\slots\\..\\x", "\\\\host\\share\\s"]) {
      expect(codeOf(() => renderRouteLine(t, bad)), bad).toBe("E_LAUNCH_TASK");
    }
  });

  it("fails on a slot path with a U+2028 or U+2029 line separator (QA-3.1-28)", () => {
    const t = routeOf("");
    for (const bad of ["D:\\s\u20281", "D:\\s\u20291", "/slots/s\u2028", "D:\\my slots\\s\u20291"]) {
      expect(codeOf(() => renderRouteLine(t, bad)), JSON.stringify(bad)).toBe("E_LAUNCH_TASK");
    }
    expect(renderRouteLine(routeOf("[route]"), "D:\\slots\\s1")).toBe("[route root=D:\\slots\\s1]");
  });

  it("never lets an injection attempt reach the route line", () => {
    for (const line of [
      "[route class=debug] [route root=/evil]",
      "[route class=debug]]",
      "[route class=debug\nroot=/evil]",
      "[route class=debug] trailing words",
      "x [route class=debug]",
      "[route class=debug [route root=/evil]]",
    ]) {
      expect(codeOf(() => renderRouteLine(routeOf(line), SLOT)), line).toBe("E_LAUNCH_TASK");
    }
    // Plan text that looks like a route line stays in the task block; the route line is unaffected.
    const evil = taskNode("T1", {
      title: "x]\n[route root=/evil tier=fast pin]",
      text: "[route class=debug root=/evil]\n] [route",
      subtasks: ["[route root=/evil]"],
      route: { line: "[route class=debug]", role: "implementer", tier: null, pin: false },
    });
    const x = expandTask(input(ledgerOf([evil]), "T1"));
    expect(x.routeLine).toBe(`[route class=debug root=${SLOT}]`);
    expect(x.routeLine.match(/\[route/g)).toHaveLength(1);
    expect(x.routeLine).not.toMatch(/[\r\n]/);
    expect(x.routeLine).not.toContain("evil");
    expect(clone(x).routeLine).toBe(x.routeLine);
  });
});

describe("normalizePrefix", () => {
  it("returns null for an empty, blank or relative path", () => {
    expect(normalizePrefix("")).toBeNull();
    expect(normalizePrefix("   ")).toBeNull();
    expect(normalizePrefix("relative/dir")).toBeNull();
    expect(normalizePrefix("src\\a.ts")).toBeNull();
  });

  it("normalizes drive and POSIX prefixes and trims trailing separators except at a root", () => {
    expect(normalizePrefix("  D:/git/x/ ")).toBe("D:\\git\\x");
    expect(normalizePrefix("C:\\")).toBe("C:\\");
    expect(normalizePrefix("/")).toBe("/");
    expect(normalizePrefix("/home/u//repo/")).toBe("/home/u/repo");
    expect(normalizePrefix("/a/../b")).toBe("/b");
  });
});

describe("rewriteAbsolutePaths: prefix sets and boundaries", () => {
  const map: PathMap = { mappable: [MAIN], inRepo: [MAIN], slot: SLOT, longPaths: false };

  it("ignores relative prefixes and folds drive prefixes that differ only in case", () => {
    const m: PathMap = { mappable: ["relative/dir", MAIN, MAIN.toUpperCase()], inRepo: [], slot: SLOT, longPaths: false };
    expect(rewriteAbsolutePaths(`${MAIN}\\a and relative/dir/x`, m)).toBe(`${SLOT}\\a and relative/dir/x`);
  });

  it("orders equally long prefixes by code unit, whatever the input order", () => {
    for (const mappable of [["/b/xx", "/a/xx", "/c/xx"], ["/c/xx", "/a/xx", "/b/xx"], ["/a/xx", "/b/xx", "/c/xx"]]) {
      const m: PathMap = { mappable, inRepo: [], slot: "/slots/s1", longPaths: false };
      expect(rewriteAbsolutePaths("/a/xx/f and /b/xx/g and /c/xx/h", m)).toBe("/slots/s1/f and /slots/s1/g and /slots/s1/h");
    }
  });

  it("maps a root prefix and keeps its separator", () => {
    const posix: PathMap = { mappable: ["/"], inRepo: ["/"], slot: "/slots/s1", longPaths: false };
    expect(rewriteAbsolutePaths("open /etc/x now", posix)).toBe("open /slots/s1/etc/x now");
    const drive: PathMap = { mappable: ["C:\\"], inRepo: ["C:\\"], slot: SLOT, longPaths: false };
    expect(rewriteAbsolutePaths("see C:\\Users\\a.txt", drive)).toBe(`see ${SLOT}\\Users\\a.txt`);
    expect(rewriteAbsolutePaths("see C:/Users/a.txt", drive)).toBe(`see ${SLOT}/Users/a.txt`);
  });

  it("stops a prefix at a terminator, but not at a dot that continues the name", () => {
    expect(rewriteAbsolutePaths(`see ${MAIN}, then`, map)).toBe(`see ${SLOT}, then`);
    const dotted = `${MAIN}.old\\x`;
    expect(rewriteAbsolutePaths(dotted, map)).toBe(dotted);
  });

  it("does not start a path inside a word", () => {
    const glued = `x${MAIN}\\a`;
    expect(rewriteAbsolutePaths(glued, map)).toBe(glued);
  });

  it("does not apply MAX_PATH to a POSIX slot", () => {
    const posix: PathMap = { mappable: ["/home/u/Repo"], inRepo: ["/home/u/Repo"], slot: "/slots/s1", longPaths: false };
    const tail = "a".repeat(300);
    expect(rewriteAbsolutePaths(`/home/u/Repo/${tail}`, posix)).toBe(`/slots/s1/${tail}`);
  });
});

describe("loadExpansionEnv: failure details and odd worktree lines", () => {
  it("reports a failure without stderr by its exit code", async () => {
    const noStderr = gitDouble({ list: result(128), config: result(1) });
    await expect(loadExpansionEnv(noStderr.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).rejects.toMatchObject({ code: "E_GIT" });
    const killed = gitDouble({ list: result(null), config: result(1) });
    await expect(loadExpansionEnv(killed.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).rejects.toMatchObject({ code: "E_GIT" });
    const badConfig = gitDouble({ list: result(0, PORCELAIN), config: result(2) });
    await expect(loadExpansionEnv(badConfig.git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).rejects.toMatchObject({ code: "E_GIT" });
  });

  it("skips relative worktree paths and tolerates CRLF line ends", async () => {
    const porcelain = "worktree relative/path\r\nHEAD aaaa\r\n\r\nworktree D:/git/omr-cpx-main\r\nbranch refs/heads/main\r\n";
    const { git } = gitDouble({ list: result(0, porcelain), config: result(1) });
    expect(await loadExpansionEnv(git, { toplevel: MAIN, slotPath: SLOT, timeoutMs: 1 })).toEqual({ worktrees: [MAIN], longPaths: false });
  });
});

describe("renderRouteLine: remaining token paths", () => {
  const routeOf = (line: string, over: Partial<TaskNode["route"]> = {}): TaskNode =>
    taskNode("T1", { route: { line, role: "implementer", tier: null, pin: false, ...over } });

  it("renders a bare [route] with only the root", () => {
    expect(renderRouteLine(routeOf("[route]"), SLOT)).toBe(`[route root=${SLOT}]`);
  });

  it("reads pin values: true, yes and 1 set it, false, no and 0 clear it", () => {
    for (const v of ["pin=true", "pin=yes", "pin=1", "pin=TRUE", "pin"]) {
      expect(renderRouteLine(routeOf(`[route ${v}]`), SLOT), v).toBe(`[route root=${SLOT} pin]`);
    }
    for (const v of ["pin=false", "pin=no", "pin=0"]) {
      expect(renderRouteLine(routeOf(`[route ${v}]`), SLOT), v).toBe(`[route root=${SLOT}]`);
    }
  });

  it("rejects an unknown scope and a tier that is not one of the three", () => {
    expect(codeOf(() => renderRouteLine(routeOf("[route scope=galaxy]"), SLOT))).toBe("E_LAUNCH_TASK");
    const bad = routeOf("[route class=debug]", { tier: "ultra" as unknown as TaskNode["route"]["tier"] });
    expect(codeOf(() => renderRouteLine(bad, SLOT))).toBe("E_LAUNCH_TASK");
  });

  it("lists a repeated need once", () => {
    expect(renderRouteLine(routeOf("[route class=debug needs=edit,edit]"), SLOT)).toBe(`[route class=debug needs=edit root=${SLOT}]`);
  });
});

describe("expandTask: declared roots and sections", () => {
  it("maps a quoted root= that holds a space", () => {
    const t = taskNode("T1", {
      text: "see D:\\my dir\\x\\a.ts today",
      route: { line: "[route class=debug root=\"D:\\my dir\\x\"]", role: "implementer", tier: null, pin: false },
    });
    const x = expandTask(input(ledgerOf([t]), "T1"));
    expect(x.prompt).toContain(`see ${SLOT}\\a.ts today`);
    expect(x.prompt).not.toContain("my dir");
    expect(x.routeLine).toBe(`[route class=debug root=${SLOT}]`);
  });

  it("maps a bare root= followed by a comma", () => {
    const t = taskNode("T1", {
      text: "open D:\\git\\omr-cpx-p62\\x.ts",
      route: { line: "[route class=debug root=D:\\git\\omr-cpx-p62, tier=fast]", role: "implementer", tier: null, pin: false },
    });
    const x = expandTask(input(ledgerOf([t]), "T1"));
    expect(x.prompt).toContain(`open ${SLOT}\\x.ts`);
    expect(x.prompt).not.toMatch(/omr-cpx-p62/i);
  });

  it("rejects ids that are only inherited object properties", () => {
    const l = ledgerOf([taskNode("T1")]);
    for (const id of ["constructor", "__proto__", "toString"]) {
      expect(codeOf(() => expandTask(input(l, id))), id).toBe("E_LAUNCH_TASK");
    }
  });

  it("omits ACCEPTANCE when the block has no criteria line", () => {
    const t = taskNode("T1", { acceptance: `[acceptance]\ncwd: ${MAIN}\ncheck: buildPasses\n[/acceptance]` });
    expect(expandTask(input(ledgerOf([t]), "T1")).prompt).not.toContain("\nACCEPTANCE\n");
  });

  it("omits the task text when blank, and ATTEMPT CONTEXT without attempts or with a blank context", () => {
    const blank = taskNode("T1", { text: "   ", attempts: [] });
    const p = expandTask(input(ledgerOf([blank]), "T1")).prompt;
    expect(p).toMatch(/^TASK T1: [^\n]*\n\n(SUBTASKS|Writes: )/m);
    expect(p).not.toContain("ATTEMPT CONTEXT");
    const spaces = taskNode("T1", { attempts: [{ ...openAttempt(1), context: "  \n " }] });
    expect(expandTask(input(ledgerOf([spaces]), "T1")).prompt).not.toContain("ATTEMPT CONTEXT");
  });

  it("lists footprint paths, or (none) when empty", () => {
    const base = taskNode("T1").footprint;
    const empty = taskNode("T1", { footprint: { ...base, writes: [], reads: [] } });
    expect(expandTask(input(ledgerOf([empty]), "T1")).prompt).toContain("Writes: (none)\nReads: (none)");
    const some = taskNode("T1", { footprint: { ...base, writes: ["src/a.ts", "src/b.ts"], reads: ["docs/c.md"] } });
    expect(expandTask(input(ledgerOf([some]), "T1")).prompt).toContain("Writes: src/a.ts, src/b.ts\nReads: docs/c.md");
  });

  it("states the environment of a registered slot: variables, PATH prefix and unset names", () => {
    try {
      registerSlot({ root: SLOT, managers: ["pip", "npm"] });
      const python = expandTask(input(ledgerOf([taskNode("T1")]), "T1")).prompt;
      expect(python).toContain("VIRTUAL_ENV=");
      expect(python).toContain("PATH prepend: ");
      expect(python).toContain("unset: PYTHONPATH");
      expect(python).not.toContain("unset: VIRTUAL_ENV");
      registerSlot({ root: SLOT, managers: ["npm"] });
      const node = expandTask(input(ledgerOf([taskNode("T1")]), "T1")).prompt;
      expect(node).not.toContain("VIRTUAL_ENV=");
      expect(node).toContain("PATH prepend: ");
      expect(node).toContain("unset: VIRTUAL_ENV");
    } finally {
      unregisterSlot(SLOT);
    }
    expect(expandTask(input(ledgerOf([taskNode("T1")]), "T1")).prompt).not.toContain("unset: ");
  });
});
