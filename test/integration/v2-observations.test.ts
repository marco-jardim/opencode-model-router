import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createV2Observations, type ObservationRecord } from "../../src/compat/v2-observations";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

let host: BgHost | undefined;
afterEach(async () => { await host?.dispose(); host = undefined; restoreEnv(); });

const requiredPrompt = "VERIFY:required\nCheck proof.txt.\n[acceptance]\ncheck: fileExists path=proof.txt\n[/acceptance]";
const completionRows = (rows: ObservationRecord[], callID: string) =>
  rows.filter((row) => row.family === "completion-effect").filter((row) => row.callID === callID);

describe("v2 completion-effect observation boundaries", () => {
  it.each([false, true])("required verification captures once per resumed attempt (background=%s)", async (background) => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    host = await bootBgHost({
      observations,
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { orch: {}, "same-child": { parentID: "orch" } },
    });
    writeFileSync(join(host.project, "proof.txt"), "proof");
    for (const callID of ["required-1", "required-2"]) {
      const sent = await host.before({ sessionID: "orch", agent: "build", messageID: `m-${callID}`, id: callID, tool: "subagent",
        input: { agent: "fast", description: "check proof", prompt: requiredPrompt, background,
          ...(callID === "required-2" ? { sessionID: "same-child" } : {}) } });
      await host.after({ ...sent, status: "completed", result: {
        output: { sessionID: "same-child", status: background ? "running" : "completed", output: "done" }, content: "done",
      } });
      if (background) host.childContext.set("same-child", [{ role: "assistant", content: [{ type: "text", text: "done" }], finish: "stop" }]);
      const end = { type: "session.execution.succeeded", id: `end-${callID}`, data: { sessionID: "same-child" } };
      host.emit(end);
      await host.settled();
      host.emit(end); // duplicate completion must not repeat either capture boundary
      await host.settled();
    }
    await observations.close(); // drain diagnostics before inspecting detached rows (also when writes are deferred)
    for (const callID of ["required-1", "required-2"]) {
      const effects = completionRows(rows, callID);
      const captures = effects.filter((row) => row.effect === "change-set-capture");
      expect(captures.map((row) => row.source)).toEqual(background ? ["background-delta", "required-change"] : ["required-change"]);
      for (const row of effects) expect(row).toMatchObject({ parentSessionID: "orch", callID, childSessionID: "same-child" });
      expect(effects.filter((row) => row.effect === "finish-dispatch").map((row) => row.source)).toEqual(background ? ["background"] : []);
    }
  }, 30_000);

  it.each(["finish", "stored-verdict", "missing-text"] as const)("restored hold observes only an actual finish invocation (%s)", async (recovery) => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    const handle = `vrf_${"a".repeat(24)}`;
    const records = [
      { v: 1, kind: "hold", handle, parent: "orch", child: "restored-child", callID: "restored-call", at: Date.now(),
        dispatch: { prompt: requiredPrompt, description: "check proof", subagentType: "fast" } },
      ...(recovery === "missing-text" ? [] : [{ v: 1, kind: "hold-text", handle, text: "done", status: "succeeded", at: Date.now() }]),
      ...(recovery === "stored-verdict" ? [{ v: 1, kind: "state", handle, state: "verified", at: Date.now(),
        verdict: { pass: false, outcome: "fail", method: "deterministic", reasons: ["failed before restart"], caveats: [] } }] : []),
    ];
    host = await bootBgHost({
      observations,
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { orch: {}, "restored-child": { parentID: "orch" } },
      journalText: records.map((row) => JSON.stringify(row)).join("\n"),
    });
    for (const id of ["adopt-1", "adopt-2"]) {
      host.emit({ type: "session.created", id, data: { sessionID: "restored-child", parentID: "orch" } });
      await host.settled();
    }
    expect(host.synthetic.filter((post) => post.text.startsWith("<router-verdict "))).toHaveLength(1);
    await observations.close();
    const finishes = completionRows(rows, "restored-call").filter((row) => row.effect === "finish-dispatch");
    expect(finishes).toEqual(recovery === "finish" ? [expect.objectContaining({
      source: "restored-hold", parentSessionID: "orch", callID: "restored-call", childSessionID: "restored-child",
    })] : []);
    // G-17: the "finish" case runs the restored hold's real verification, and its git probes of the project spawn
    // processes. The other two cases do not. On a loaded windows-latest runner "finish" took 5810 ms against the 5 s
    // default ("stored-verdict" 1778 ms, "missing-text" 139 ms; PR #116, win22). The limit is the one the other
    // verification cases of this describe already use. No assertion changes.
  }, 30_000);

  it("metadata-only child identity in the foreground annotation matches its timing row", async () => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    host = await bootBgHost({
      observations,
      overrides: { routing: { background: { mode: "off" }, leases: { mode: "off" } } },
      sessions: { orch: {}, "metadata-child": { parentID: "orch" } },
    });
    writeFileSync(join(host.project, "proof.txt"), "proof");
    const sent = await host.before({ sessionID: "orch", agent: "build", messageID: "metadata-message", id: "metadata-call", tool: "subagent",
      input: { agent: "fast", description: "check proof", prompt: requiredPrompt } });
    const result = await host.after({ ...sent, status: "completed", result: { content: "done", metadata: { sessionID: "metadata-child" } } });
    expect(JSON.stringify(result.result)).toContain("router"); // the real foreground path delivered an annotation
    host.emit({ type: "session.execution.succeeded", id: "metadata-end", data: { sessionID: "metadata-child" } });
    await host.settled();
    await observations.close();
    const effects = completionRows(rows, "metadata-call");
    const timing = effects.filter((row) => row.effect === "timing-row-write");
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatchObject({ parentSessionID: "orch", callID: "metadata-call", childSessionID: "metadata-child" });
    expect(effects.filter((row) => row.effect === "annotation-delivery")).toEqual([expect.objectContaining({
      source: "foreground-result", parentSessionID: timing[0].parentSessionID, callID: timing[0].callID, childSessionID: timing[0].childSessionID,
    })]);
  }, 30_000);
});

describe("v2 native-args observation boundary", () => {
  it("records post-legacy/pre-native values and background presence; off/on/broken have byte-identical native args", async () => {
    const results: string[] = [];
    for (const mode of ["off", "on", "broken"] as const) {
      await host?.dispose(); restoreEnv();
      const rows: ObservationRecord[] = [];
      const observations = mode === "off" ? undefined : createV2Observations({ write: (line) => {
        if (mode === "broken") throw new Error("diagnostic failure");
        rows.push(JSON.parse(line));
      } });
      host = await bootBgHost({ observations, overrides: { routing: { background: { mode: "off" }, leases: { mode: "off" } } }, sessions: { orch: {} } });
      for (const background of [undefined, false, true]) {
        const event: ToolEvent = { sessionID: "orch", id: `call-${String(background)}`, messageID: "message", agent: "build", tool: "subagent",
          input: { agent: "fast", description: "secret description", prompt: "secret prompt", ...(background === undefined ? {} : { background }) } };
        const sent = await host.before(event);
        results.push(JSON.stringify(sent.input).split(host.project.replace(/\\/g, "\\\\")).join("<project>"));
      }
      await observations?.close();
      if (mode !== "on") expect(rows).toEqual([]);
      else {
        const calls = rows.filter((r) => r.family === "native-args");
        expect(calls).toHaveLength(3);
        for (const row of calls) {
          expect(row.sessionID).toBe("orch");
          expect(row.after.fields.agent).toEqual(row.before.fields.subagent_type);
          expect(row.after.fields.prompt).toEqual(row.before.fields.prompt);
          expect(row.after.fields).not.toHaveProperty("subagent_type");
          expect(row.after.fields).not.toHaveProperty("task_id");
          expect(row.after.background).toEqual({ present: true, type: "boolean", value: false });
          expect(row.backgroundDecision).toBe(false);
        }
        expect(calls.map((r) => r.before.background.present)).toEqual([false, true, true]);
        expect(JSON.stringify(rows)).not.toContain("secret");
        expect(JSON.stringify(rows)).not.toContain(host.project);
      }
    }
    expect(results.slice(0, 3)).toEqual(results.slice(3, 6));
    expect(results.slice(0, 3)).toEqual(results.slice(6, 9));
  });

  it("the legacy host ignores even an explicitly supplied observation sink", async () => {
    const rows: string[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(line); } });
    host = await bootBgHost({ routerHost: "v1", observations, sessions: { orch: {} } });
    const sent = await host.before({ sessionID: "orch", agent: "build", messageID: "m", id: "v1-call", tool: "subagent", input: { agent: "fast", prompt: requiredPrompt, description: "work" } });
    await host.after({ ...sent, status: "completed", result: { output: { sessionID: "v1-child", status: "completed", output: "done" }, content: "done" } });
    await host.settled();
    await observations.close();
    expect(rows.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ kind: "end", attempted: 0, written: 0 })]);
  });

  it("without verification, an absent background key stays absent and explicit booleans survive", async () => {
    const rows: ObservationRecord[] = [];
    const observations = createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } });
    host = await bootBgHost({ observations,
      overrides: { routing: { background: { mode: "off" }, leases: { mode: "off" } }, enforcement: { verify: { require: "never" } } }, sessions: { orch: {} } });
    for (const background of [undefined, false, true]) {
      await host.before({ sessionID: "orch", agent: "build", messageID: "m", id: `plain-${String(background)}`, tool: "subagent",
        input: { agent: "fast", prompt: "work", description: "work", ...(background === undefined ? {} : { background }) } });
    }
    await observations.close();
    const calls = rows.filter((r) => r.family === "native-args");
    expect(calls.map((r) => r.after.background)).toEqual([
      { present: false, type: "absent" }, { present: true, type: "boolean", value: false }, { present: true, type: "boolean", value: true },
    ]);
    expect(calls.every((r) => r.backgroundDecision === null)).toBe(true);
  });
});
