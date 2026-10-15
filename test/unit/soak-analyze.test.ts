import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The CLI is deliberately plain ESM; vitest resolves its dynamic product/oracle TS imports.
// @ts-expect-error Plain JS CLI has no declaration file.
import { analyze, evidenceStatus, formatReport, main, resolveInputs } from "../../scripts/soak-analyze.mjs";
import { parseLogLine } from "../../src/routing/outcomes/persist";
import { resolvePendingJournalDir } from "../../src/verify/pending";

type Row = Record<string, any>;
const fixtures = fileURLToPath(new URL("../fixtures/soak/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const BASE = Date.parse("2026-10-12T09:00:00.000Z");
const IDS = ["G1", "G2", "G6", "G8", "G9", "G3", "G11"];
const scratch: string[] = [];
const json = async (name: string): Promise<any> => JSON.parse(await readFile(path.join(fixtures, name), "utf8"));
const jsonl = async (file: string, rows: Row[]) => writeFile(file, rows.map(row => JSON.stringify(row) + "\n").join(""));
const vrf = (i: number) => `vrf_${String(i).padStart(24, "0")}`;
const verdict = (outcome = "pass") => ({ pass: outcome === "pass", outcome, method: "deterministic", reasons: [] });
const hold = (i: number) => ({ v: 1, kind: "hold", handle: vrf(i), parent: "parent", child: `child-${i}`, callID: `call-${i}`, at: BASE });
const posted = (i: number, at = BASE + 200) => ({ v: 1, kind: "posted", handle: vrf(i), at });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(fixtures, ".run-")); scratch.push(root);
  const observations = path.join(root, "observations"), outcomes = path.join(root, "outcomes"), pending = path.join(root, "pending.jsonl");
  await Promise.all([mkdir(observations), mkdir(outcomes), writeFile(pending, "")]);
  return { root, projectRoot: root, observations, outcomes, pending };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function stream(s: Setup, rows: Row[], name = "123-fixture.jsonl", streamID = "synthetic") {
  const wire = rows.map((row, i) => ({ ...row, v: 1, stream: streamID, seq: i + 1 }));
  const seal = { v: 1, stream: streamID, seq: wire.length + 1, at: rows.at(-1)?.at ?? BASE, kind: "end",
    attempted: wire.length, written: wire.length, dropped: 0, failed: 0 };
  await jsonl(path.join(s.observations, name), [...wire, seal]);
}
const scheduler = (action: string, state: Row, at = BASE, planId = "plan") =>
  ({ at, family: "scheduler", planId, parentSessionID: "parent", action, state });
const effect = (i: number, effectName: string, at: number, extra: Row = {}) => ({
  at, family: "completion-effect", effect: effectName, source: "verify-handles", parentSessionID: "parent",
  childSessionID: `child-${i}`, callID: `call-${i}`, handle: vrf(i), ...extra,
});
async function populate(s: Setup, id: string, n: number, bad = false) {
  if (!n) return;
  if (id === "G1" || id === "G3") {
    const template = await json("decision.json");
    const rows = Array.from({ length: n }, (_, i) => id === "G1"
      ? { ...template, decisionID: `decision-${i}`, mode: ["enforce", "shadow", "advise"][i % 3],
        tier: bad && i === 0 ? "heavy" : "medium", window: { ...template.window, ceiling: "medium" } }
      : { v: 1, kind: "verdict", ts: template.ts, sessionID: "parent", decisionID: `decision-${i}`,
        childSessionID: `child-${i}`, attemptID: `attempt-${i}`, key: template.chosen.key, verdict: "fail", step: "dispatch",
        fallback: { marker: "C15", forced: !(bad && i === 0) } });
    expect(rows.every(row => parseLogLine(JSON.stringify(row)) !== null)).toBe(true);
    await jsonl(path.join(s.outcomes, "decisions.jsonl"), rows);
  } else if (id === "G2" || id === "G9") {
    const template = await json("pending.json"), pendingRows: Row[] = [], effects: Row[] = [];
    for (let i = 1; i <= n; i++) {
      pendingRows.push({ ...template, handle: vrf(i), child: `child-${i}`, callID: `call-${i}`, createdAt: BASE,
        ...(id === "G9" ? { kind: "hold", at: BASE, state: "held" } : {}) });
      if (id === "G9") {
        // Actual restored-hold observations have NO handle; reconcile the product's three-part identity.
        effects.push(effect(i, "finish-dispatch", BASE + 100, { handle: undefined, source: "restored-hold" }));
        effects.push(effect(i, "annotation-delivery", BASE + 200, { source: "held-synthetic" }));
        pendingRows.push({ v: 1, kind: "posted", handle: vrf(i), at: BASE + 200 });
        if (bad && i === 1) pendingRows.push(posted(i, BASE + 201));
      } else {
        pendingRows.push({ v: 1, kind: "state", handle: vrf(i), state: "verifying", at: BASE + 100 },
          { v: 1, kind: "state", handle: vrf(i), state: "verified", verdict: verdict(), at: BASE + 200 });
        effects.push(effect(i, "verification-settle", BASE + 200));
        if (bad && i === 1) {
          pendingRows.push({ v: 1, kind: "state", handle: vrf(i), state: "verifying", at: BASE + 201 },
            { v: 1, kind: "state", handle: vrf(i), state: "verified", verdict: verdict(), at: BASE + 202 });
          effects.push(effect(i, "verification-settle", BASE + 202));
        }
      }
    }
    await jsonl(s.pending, pendingRows);
    await stream(s, effects.sort((a, b) => a.at - b.at));
  } else if (id === "G6") {
    const graph = (await json("idle.json"))[1].state;
    graph.tasks = ["a", "b", "c"].map(id => ({ ...graph.tasks[0], id })); graph.writeConflicts = [["a", "b"]];
    const rows = [scheduler("attach", graph)];
    for (let i = 0; i < n; i++) {
      const taskRef = `plan:${["a", "b", "c"][i]}`;
      rows.push(scheduler("lease-acquire", { taskRef, ok: true }));
      if (!bad || i !== 0) rows.push(scheduler("lease-release", { taskRef }));
    }
    await stream(s, rows);
  } else if (id === "G8") {
    const rows: Row[] = [];
    for (let i = 0; i < n; i++) {
      const template: Row[] = await json("idle.json"), start = BASE + i * 20_000;
      const duration = bad && i === 0 ? 10_001 : 1_000;
      rows.push(...template.map((r, j) => {
        const at = start + (j >= 6 ? duration : 0);
        if ("clockMs" in r.state) r.state.clockMs = at;
        return scheduler(r.action, r.state, at, `plan-${i}`);
      }));
    }
    await stream(s, rows);
  } else if (id === "G11") {
    await jsonl(path.join(s.outcomes, "timings.jsonl"), Array.from({ length: n }, (_, i) => ({
      kind: "dispatch-timing", v: 1, ts: new Date(BASE).toISOString(), parentSessionID: "parent", childSessionID: `child-${i}`,
      callID: `call-${i}`, role: "implementer", class: "code", scope: "local", tier: "medium", model: "fixture/model",
      background: true, startedAt: BASE, endedAt: BASE + 1, durationMs: 1, outcome: "failed", capacity: "usage-limit",
      paused: !(bad && i === 0),
    })));
  }
}

describe("offline soak evidence statuses", () => {
  for (const id of IDS) {
    it.each([
      ["not-observed", 0, false], ["insufficient", 1, false], ["ok", 3, false], ["violated", 3, true],
    ] as const)(`${id}: %s`, async (status, n, bad) => {
      const s = await setup(); await populate(s, id, n, bad);
      const report = await analyze(s), c = report.criteria[id];
      expect(c.status).toBe(status); expect(c.observed).toBe(n);
      expect(c.violationCount > 0).toBe(bad);
      if (n) expect(c.evidence[0].file).toEqual(expect.any(String));
      if (bad) expect(c.violations[0]).toMatchObject({ id: expect.any(String), at: expect.any(String), reason: expect.any(String) });
    });
  }
  it("empty inputs are all not observed, never passing", async () => {
    const report = await analyze(await setup());
    expect(Object.values(report.criteria).map((c: any) => c.status)).toEqual(IDS.map(() => "not-observed"));
    expect(report.unreadable).toBe(0); expect(formatReport(report)).toContain("not observed");
    expect(report.criteria.G8.g8Ratio).toBe("not applicable");
  });
  it("reuses status threshold without treating zero as success", () => {
    expect([0, 1, 2, 3].map(n => evidenceStatus(n, 0))).toEqual(["not-observed", "insufficient", "insufficient", "ok"]);
    expect(evidenceStatus(0, 1)).toBe("violated");
  });
  it("reports the 10,001 ms episode, including when --since cuts across it", async () => {
    const s = await setup(); await populate(s, "G8", 1, true);
    const report = await analyze({ ...s, since: new Date(BASE + 10_000).toISOString() });
    expect(report.criteria.G8.violations[0]).toMatchObject({ ms: 10_001 });
    expect(report.criteria.G8.faultCount).toBe(0);
  });
  it("counts malformed lines unreadable and blocks passing evidence", async () => {
    const s = await setup(); await populate(s, "G1", 3);
    await copyFile(path.join(fixtures, "malformed.jsonl"), s.pending);
    await writeFile(path.join(s.outcomes, "decisions.jsonl"), "broken\n", { flag: "a" });
    const report = await analyze(s);
    expect(report.unreadable).toBe(4); expect(report.criteria.G1.status).toBe("insufficient");
    expect(report.unreadableEvidence[0].line).toEqual(expect.any(Number));
  });
  it("unsealed captures and oracle faults mean insufficient evidence, not violations", async () => {
    const s = await setup(); await populate(s, "G8", 3);
    const file = path.join(s.observations, "123-fixture.jsonl");
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n"); rows.pop();
    await writeFile(file, rows.join("\n") + "\n");
    const report = await analyze(s);
    expect(report.unreadable).toBe(1); expect(report.criteria.G8.observed).toBe(0);
    expect(report.criteria.G8.violationCount).toBe(0); expect(report.criteria.G8.faults[0].reason).toContain("incomplete");
  });
  it("an oracle unknown-eligibility fault is insufficient, never a violation", async () => {
    const s = await setup(); await populate(s, "G8", 1, true);
    const file = path.join(s.observations, "123-fixture.jsonl");
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    await stream(s, rows.filter(row => row.kind !== "end" && row.action !== "route"));
    const c = (await analyze(s)).criteria.G8;
    expect(c.status).toBe("insufficient"); expect(c.violationCount).toBe(0);
    expect(c.observed).toBe(0); expect(c.faultCount).toBe(1);
    expect(c.faults[0].reason).toContain("unknown eligibility");
  });
  it("repeated posted records are duplicate held delivery evidence", async () => {
    const s = await setup(); await populate(s, "G9", 3);
    const rows = (await readFile(s.pending, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    await jsonl(s.pending, [...rows, ...rows]);
    const report = await analyze(s);
    expect(report.criteria.G2.status).toBe("violated"); expect(report.criteria.G9.status).toBe("violated");
    expect(report.criteria.G2.evidence.every((e: any) => e.deliveries === 2)).toBe(true);
  });
  it("counts real executor event formats, ignores uncommitted batches, and dedupes history", async () => {
    const s = await setup(), dir = path.join(s.observations, "executor", "plan"); await mkdir(dir, { recursive: true });
    const events: Row[] = [
      { type: "metric", metric: { name: "counter", key: "child-process", value: 1, labels: { taskId: "a", n: "1", child: "child", nonce: "nonce" } } },
      { type: "task-integrated", taskId: "a", from: "old", to: "new" },
      { type: "attempt-ended", taskId: "a", n: 1, outcome: "lost", endedAt: new Date(BASE).toISOString(), detail: "restart" },
      { type: "metric", metric: { name: "capacity", provider: "provider", change: "pause", from: 4, to: 4, until: null, errorType: "provider.quota", status: null } },
      { type: "inbox-added", item: { id: "U-1", kind: "usage-limit", createdAt: new Date(BASE).toISOString(), taskId: "a", text: "quota", answer: null } },
    ].map((row, i) => ({ ...row, seq: i + 1, batch: i + 1, last: true, at: new Date(BASE).toISOString() }));
    await jsonl(path.join(dir, "events.1.1.jsonl"), events);
    await jsonl(path.join(dir, "history.jsonl"), events.filter(e => e.type === "metric"));
    const report = await analyze(s);
    expect(report.dogfood).toMatchObject({ plansRun: 1, tasksIntegrated: 1, childProcesses: 1, restartsRecovered: 1 });
    expect(report.criteria.G11.observed).toBe(2); expect(report.criteria.G11.violationCount).toBe(0);
    await jsonl(path.join(dir, "events.6.1.jsonl"), [{ ...events[0], seq: 6, batch: 6, last: false }]);
    expect((await analyze(s)).unreadable).toBe(1);
  });
  it("rejects oversized and torn lines with bounded readers", async () => {
    const s = await setup();
    await writeFile(s.pending, "x".repeat(1024 * 1024 + 1) + "\n{}");
    expect((await analyze(s)).unreadable).toBe(2);
  });
  it("registration and settlement journal snapshots are not duplicate deliveries", async () => {
    const s = await setup(); await populate(s, "G2", 3);
    const rows = (await readFile(s.pending, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    // pending.persistedRecords writes current entry + state, not the history
    // of every verifying transition (src/verify/pending.ts:2355-2362).
    const snapshots = rows.filter(row => row.kind === "entry").flatMap(entry => [
      { ...entry, state: "verified" },
      { v: 1, kind: "state", handle: entry.handle, state: "verified", verdict: verdict(), at: BASE + 500 },
    ]);
    await jsonl(s.pending, [...rows, ...snapshots]);
    expect((await analyze(s)).criteria.G2.status).toBe("ok");
  });
  it("uses a deferred terminal state without observations, and detects an unregistered settlement", async () => {
    const s = await setup(); await populate(s, "G2", 1);
    await rm(path.join(s.observations, "123-fixture.jsonl"));
    const c = (await analyze(s)).criteria.G2;
    expect(c.observed).toBe(1); expect(c.violationCount).toBe(0); expect(c.evidence[0].deliveries).toBe(1);
    await jsonl(s.pending, [{ v: 1, kind: "state", handle: vrf(1), state: "verified", verdict: verdict(), at: BASE + 200 }]);
    expect((await analyze(s)).criteria.G2.violations[0].reason).toContain("without a prior hold/registration");
    await writeFile(s.pending, ""); await stream(s, [effect(1, "verification-settle", BASE)]);
    expect((await analyze(s)).criteria.G2.violations[0].reason).toContain("without a registration");
  });
  it("does not call an open handle lost or passed", async () => {
    const s = await setup(); const pending = await json("pending.json"); pending.createdAt = BASE;
    await jsonl(s.pending, [pending]);
    const report = await analyze(s);
    expect(report.criteria.G2.open).toBe(1); expect(report.criteria.G2.status).toBe("not-observed");
    expect(report.criteria.G9.status).toBe("not-observed");
  });
  it("does not infer omitted historical windows, pauses, or C15 fallbacks", async () => {
    const s = await setup(); await populate(s, "G1", 3);
    const file = path.join(s.outcomes, "decisions.jsonl");
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => { const row = JSON.parse(line); delete row.window; return row; });
    await jsonl(file, rows); expect((await analyze(s)).criteria.G1.status).toBe("insufficient");
    await populate(s, "G3", 1);
    const fail = JSON.parse((await readFile(file, "utf8")).trim()); delete fail.fallback; await jsonl(file, [fail]);
    expect((await analyze(s)).criteria.G3.status).toBe("not-observed");
    await populate(s, "G11", 3);
    const timings = path.join(s.outcomes, "timings.jsonl");
    await jsonl(timings, (await readFile(timings, "utf8")).trimEnd().split("\n").map(line => { const row = JSON.parse(line); delete row.paused; return row; }));
    expect((await analyze(s)).criteria.G11.status).toBe("insufficient");
  });
  it("validates dates and keeps registration context before --since", async () => {
    const s = await setup(); await populate(s, "G2", 3);
    expect((await analyze({ ...s, since: new Date(BASE + 100).toISOString() })).criteria.G2.status).toBe("ok");
    expect((await analyze({ ...s, until: new Date(BASE - 1).toISOString() })).criteria.G2.status).toBe("not-observed");
    await expect(analyze({ ...s, since: "invalid" })).rejects.toThrow("interval");
  });
  it("uses product default paths and relative outcome-path semantics", async () => {
    const s = await setup(); const defaults = await resolveInputs({ observations: s.observations });
    expect(defaults.outcomes).toContain("opencode-model-router-trajectory");
    expect((await resolveInputs({ observations: s.observations, outcomes: "nested" })).outcomes).toBe(path.join(defaults.outcomes, "nested"));
    expect(defaults.pending.endsWith(path.join("opencode-model-router", "pending.jsonl"))).toBe(true);
    expect(resolvePendingJournalDir({ homedir: "/home/example", platform: "linux", xdgStateHome: "/state" })).toBe(path.join("/state", "opencode-model-router"));
  });
  it("writes JSON outside inputs without mutating them; refuses overwrite aliases", async () => {
    const s = await setup(); await populate(s, "G2", 3);
    vi.spyOn(process, "cwd").mockReturnValue(s.root);
    const files = [s.pending, ...await readdir(s.observations).then(names => names.map(n => path.join(s.observations, n)))];
    const before = await Promise.all(files.map(file => readFile(file)));
    const args = ["--observations", s.observations, "--outcomes", s.outcomes, "--pending", s.pending];
    const output = path.join(s.root, "report.json"); vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main([...args, "--json", output])).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).criteria.G2.status).toBe("ok");
    expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before);
    await expect(main([...args, "--json", s.pending])).rejects.toThrow("pending journal");
    await expect(main([...args, "--json", path.join(s.observations, "report.json")])).rejects.toThrow("outside");
    await expect(main([...args, "--json", output])).rejects.toThrow();
    await expect(main(["--nonsense"])).rejects.toThrow("invalid argument");
  });
});

describe("G2 durable journal deliveries", () => {
  it.each([
    ["hold + posted is ok", 1, "ok"],
    ["hold without posted is violated", 0, "violated"],
    ["hold + posted + posted is violated", 2, "violated"],
  ] as const)("%s", async (_label, deliveries, status) => {
    const s = await setup();
    await jsonl(s.pending, [1, 2, 3].flatMap(i => [hold(i), ...Array.from({ length: deliveries }, (_, n) => posted(i, BASE + 200 + n))]));
    const c = (await analyze(s)).criteria.G2;
    expect(c.status).toBe(status); expect(c.observed).toBe(3);
    expect(c.violationCount).toBe(deliveries === 1 ? 0 : 3);
    expect(c.evidence.every((e: any) => e.deliveries === deliveries && e.deliveryKind === "posted")).toBe(true);
  });
  it("posted without a hold/registration is violated", async () => {
    const s = await setup(); await jsonl(s.pending, [posted(1)]);
    const c = (await analyze(s)).criteria.G2;
    expect(c.status).toBe("violated"); expect(c.observed).toBe(1);
    expect(c.violations[0]).toMatchObject({ id: vrf(1), line: 1 });
    expect(c.violations[0].reason).toContain("without a prior hold/registration");
  });
  it("a later hold does not excuse a posted record lacking a prior registration", async () => {
    const s = await setup(); await jsonl(s.pending, [posted(1), hold(1)]);
    expect((await analyze(s)).criteria.G2.status).toBe("violated");
  });
  it.each([1, 2])("posted plus %i matching held-synthetic observations is one durable delivery", async attempts => {
    const s = await setup(); await jsonl(s.pending, [hold(1), posted(1)]);
    await stream(s, Array.from({ length: attempts }, (_, n) => effect(1, "annotation-delivery", BASE + 100 + n, { source: "held-synthetic" })));
    const c = (await analyze(s)).criteria.G2;
    expect(c.observed).toBe(1); expect(c.violationCount).toBe(0);
    expect(c.evidence[0].deliveries).toBe(1); expect(c.evidence[0].corroboration).toHaveLength(attempts);
    expect(c.heldAnnotationAttempts).toBe(attempts);
  });
  it("an annotation invocation without posted is not durable delivery evidence", async () => {
    const s = await setup(); await jsonl(s.pending, [hold(1)]);
    await stream(s, [effect(1, "annotation-delivery", BASE + 100, { source: "held-synthetic" })]);
    const c = (await analyze(s)).criteria.G2;
    expect(c.status).toBe("violated"); expect(c.evidence[0].deliveries).toBe(0);
  });
  it("regresses the four-line hold/posted history with no observation stream", async () => {
    const s = await setup(); await copyFile(path.join(fixtures, "held-posted.jsonl"), s.pending);
    const report = await analyze(s), c = report.criteria.G2;
    expect(report.unreadable).toBe(0);
    expect(c).toMatchObject({ observed: 2, violationCount: 0, status: "insufficient", faultCount: 0 });
    expect(c.evidence.map((e: any) => e.deliveries)).toEqual([1, 1]);
    expect(c.evidence.map((e: any) => e.line)).toEqual([2, 4]);
  });
  it.each(["pass", "fail", "unverifiable", "legacy"])("a deferred %s verdict settles once without posted or a late notice", async outcome => {
    const s = await setup(), entry = await json("pending.json");
    const terminal: Row = verdict(outcome === "legacy" ? "pass" : outcome);
    if (outcome === "legacy") delete terminal.outcome;
    await jsonl(s.pending, [1, 2, 3].flatMap(i => [
      { ...entry, handle: vrf(i), child: `child-${i}`, callID: `call-${i}`, createdAt: BASE },
      { v: 1, kind: "state", handle: vrf(i), state: "verifying", at: BASE + 100 },
      { v: 1, kind: "state", handle: vrf(i), state: "verified", verdict: terminal, at: BASE + 200 },
    ]));
    const c = (await analyze(s)).criteria.G2;
    expect(c).toMatchObject({ status: "ok", observed: 3, violationCount: 0 });
    expect(c.evidence.every((e: any) => e.deliveryKind === "verified-state" && e.deliveries === 1)).toBe(true);
  });
  it("retryable deferred settle invocations do not duplicate the final terminal verdict", async () => {
    const s = await setup(), entry = await json("pending.json"); entry.createdAt = BASE;
    await jsonl(s.pending, [entry,
      { v: 1, kind: "state", handle: vrf(1), state: "verifying", at: BASE + 10 },
      { v: 1, kind: "state", handle: vrf(1), state: "unverified", at: BASE + 20 },
      { v: 1, kind: "state", handle: vrf(1), state: "verifying", at: BASE + 30 },
      { v: 1, kind: "state", handle: vrf(1), state: "verified", verdict: verdict(), at: BASE + 40 },
    ]);
    await stream(s, [effect(1, "verification-settle", BASE + 20, { source: "claim-error" }), effect(1, "verification-settle", BASE + 40)]);
    const c = (await analyze(s)).criteria.G2;
    expect(c.violationCount).toBe(0); expect(c.evidence[0].deliveries).toBe(1); expect(c.settleInvocations).toBe(2);
  });
  it("processed closes the dispatch, not the deferred verification handle", async () => {
    const s = await setup(), entry = await json("pending.json"); entry.createdAt = BASE;
    await jsonl(s.pending, [entry, { v: 1, kind: "processed", callID: "call-1", child: "child-1", at: BASE + 100 }]);
    const c = (await analyze(s)).criteria.G2;
    expect(c).toMatchObject({ observed: 0, open: 1, violationCount: 0, status: "not-observed" });
  });
  it("an invocation with no terminal state is insufficient to prove deferred settlement", async () => {
    const s = await setup(), entry = await json("pending.json"); entry.createdAt = BASE;
    await jsonl(s.pending, [entry]); await stream(s, [effect(1, "verification-settle", BASE + 100)]);
    const report = await analyze(s), c = report.criteria.G2;
    expect(c.observed).toBe(0); expect(c.violationCount).toBe(0); expect(c.faultCount).toBeGreaterThan(0);
    expect(c.status).not.toBe("ok"); expect(report.unreadable).toBe(0);
  });
  it("a malformed verified state is unreadable, never a successful settlement", async () => {
    const s = await setup(), entry = await json("pending.json"); entry.createdAt = BASE;
    await jsonl(s.pending, [entry, { v: 1, kind: "state", handle: vrf(1), state: "verified", at: BASE + 100 }]);
    const report = await analyze(s);
    expect(report.unreadable).toBe(1); expect(report.criteria.G2.observed).toBe(0);
  });
});

describe("real soak analyzer CLI (without Vitest's TypeScript transforms)", () => {
  it.each(["empty", "fixtures"] as const)("runs on %s inputs from the repository root", async kind => {
    const s = await setup();
    if (kind === "fixtures") {
      await populate(s, "G1", 3);
      await populate(s, "G2", 3);
      await populate(s, "G11", 3);
    }
    const output = path.join(s.root, "cli-report.json");
    const env = { ...process.env };
    // Inheriting VITEST would skip the CLI loader and hide exactly this regression.
    // No --loader / --import / --experimental-strip-types flags may leak in either.
    for (const key of Object.keys(env)) if (key.startsWith("VITEST") || key === "NODE_OPTIONS") delete env[key];
    const result = spawnSync(process.execPath, ["scripts/soak-analyze.mjs", "--observations", s.observations,
      "--outcomes", s.outcomes, "--pending", s.pending, "--json", output], {
      cwd: repoRoot, env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report = JSON.parse(await readFile(output, "utf8"));
    expect(Object.keys(report.criteria).sort()).toEqual([...IDS].sort());
    expect(report.unreadable).toBe(0);
    expect(result.stdout).toContain("Criterion");
    if (kind === "empty") {
      expect(Object.values(report.criteria).map((c: any) => c.status)).toEqual(IDS.map(() => "not-observed"));
      expect(Object.values(report.criteria).every((c: any) => c.observed === 0)).toBe(true);
    } else {
      for (const id of ["G1", "G2", "G11"]) expect(report.criteria[id]).toMatchObject({ status: "ok", observed: 3, violationCount: 0 });
    }
  }, 30_000);
});
