import { afterEach, describe, expect, it } from "vitest";
import { createV2Observations, type ObservationRecord } from "../../src/compat/v2-observations";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

let host: BgHost | undefined;
afterEach(async () => { await host?.dispose(); host = undefined; restoreEnv(); });

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
    host = await bootBgHost({ routerHost: "v1", observations: createV2Observations({ write: (line) => { rows.push(line); } }), sessions: { orch: {} } });
    await host.before({ sessionID: "orch", agent: "build", messageID: "m", id: "v1-call", tool: "subagent", input: { agent: "fast", prompt: "work", description: "work" } });
    expect(rows).toEqual([]);
  });

  it("without verification, an absent background key stays absent and explicit booleans survive", async () => {
    const rows: ObservationRecord[] = [];
    host = await bootBgHost({ observations: createV2Observations({ write: (line) => { rows.push(JSON.parse(line)); } }),
      overrides: { routing: { background: { mode: "off" }, leases: { mode: "off" } }, enforcement: { verify: { require: "never" } } }, sessions: { orch: {} } });
    for (const background of [undefined, false, true]) {
      await host.before({ sessionID: "orch", agent: "build", messageID: "m", id: `plain-${String(background)}`, tool: "subagent",
        input: { agent: "fast", prompt: "work", description: "work", ...(background === undefined ? {} : { background }) } });
    }
    const calls = rows.filter((r) => r.family === "native-args");
    expect(calls.map((r) => r.after.background)).toEqual([
      { present: false, type: "absent" }, { present: true, type: "boolean", value: false }, { present: true, type: "boolean", value: true },
    ]);
    expect(calls.every((r) => r.backgroundDecision === null)).toBe(true);
  });
});
