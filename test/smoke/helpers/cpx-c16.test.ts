import { describe, expect, it } from "vitest";
import { c16StoredTool, parseC16Processes } from "./cpx-c16";

describe("C16 process snapshots", () => {
  const row = { ProcessId: 42, ParentProcessId: 12, Name: "node.exe", CreationDate: "2026-10-15T12:00:00.123Z", CommandLine: 'node "hold.cjs" leaf C16_NPM "C:\\project"' };
  it("accepts CIM singleton/array JSON and preserves creation identity and quoted command lines", () => {
    const [single] = parseC16Processes(`\uFEFF${JSON.stringify(row)}`, "win32");
    expect(single).toEqual({ pid: 42, ppid: 12, pgid: null, name: "node.exe", createdAt: row.CreationDate, commandLine: row.CommandLine });
    expect(parseC16Processes(JSON.stringify([row]), "win32")).toEqual([single]);
  });
  it("parses ps lstart with a padded day without losing the command", () => {
    expect(parseC16Processes(' 42 12 40 Thu Oct  1 12:34:56 2026 /usr/bin/node "hold.cjs" leaf C16_DIRECT /project\n', "linux"))
      .toEqual([{ pid: 42, ppid: 12, pgid: 40, name: "node", createdAt: "Thu Oct 1 12:34:56 2026", commandLine: '/usr/bin/node "hold.cjs" leaf C16_DIRECT /project' }]);
  });
  it("rejects broken observations rather than silently classifying them dead", () => {
    expect(() => parseC16Processes(JSON.stringify({ ...row, CreationDate: null }), "win32")).toThrow(/identity/);
    expect(() => parseC16Processes("42 12 node", "linux")).toThrow(/identity/);
  });
});

describe("C16 stored call status", () => {
  it.each(["running", "streaming", "pending", "completed", "error"])("reads %s verbatim in entries and assistant parts", status => {
    const entry = { type: "tool", tool: "cpx_probe_spawn_hold", id: "call-1", status };
    for (const history of [[entry], [{ type: "assistant", parts: [{ ...entry, status: undefined, state: { status } }] }], [{ role: "assistant", content: [entry] }]]) {
      expect(c16StoredTool(history, entry.tool, entry.id)).toMatchObject({ visible: true, status });
    }
    // OpenCode v2's AssistantTool schema uses name/id/state, not tool/status.
    expect(c16StoredTool([{ type: "assistant", content: [{ type: "tool", name: entry.tool, id: entry.id, state: { status } }] }], entry.tool, entry.id))
      .toMatchObject({ visible: true, status });
  });
  it("does not confuse another call, user text or an input lookalike with the stored call", () => {
    const entry = { type: "tool", tool: "shell", id: "other", status: "running" };
    expect(c16StoredTool([entry, { type: "user", text: JSON.stringify(entry) }, { input: { ...entry, id: "wanted" } }], "shell", "wanted"))
      .toEqual({ visible: false, status: null, entry: null });
    expect(c16StoredTool([{ ...entry, status: undefined }], "shell", "other").status).toBeNull();
  });
});
