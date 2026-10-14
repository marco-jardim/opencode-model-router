import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkV2ObservationStream, createV2Observations, observeV2, openV2Observations } from "../../src/compat/v2-observations";

const effect = () => ({ family: "completion-effect" as const, effect: "finish-dispatch" as const, source: "test",
  parentSessionID: "parent", callID: "call", childSessionID: "child" });

describe("v2 read-only observation sink", () => {
  it("off does not evaluate a projection or open/write a file; opt-in files are sealed", () => {
    const dir = mkdtempSync(join(tmpdir(), "omr-observe-"));
    try {
      const make = vi.fn(effect);
      observeV2(openV2Observations({}), make);
      expect(make).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
      const sink = openV2Observations({ MODEL_ROUTER_V2_OBSERVATIONS: dir });
      expect(sink).toBeDefined();
      observeV2(sink, effect);
      sink?.close();
      sink?.close();
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(checkV2ObservationStream(readFileSync(join(dir, files[0]), "utf8").trim().split("\n"))).toHaveLength(1);
      expect(openV2Observations({ MODEL_ROUTER_V2_OBSERVATIONS: join(dir, "missing") })).toBeUndefined();
    } finally { rmSync(dir, { force: true, recursive: true }); }
  });

  it("fingerprints exact own-key values without content/credentials; distinguishes absence and undefined", () => {
    const lines: string[] = [];
    const sink = createV2Observations({ write: (line) => { lines.push(line); }, now: () => 42 });
    const before = Object.freeze({ subagent_type: "fast", task_id: undefined, prompt: "private prompt sk-secret", background: true,
      description: "private file contents", token: "https://user:password@example.org", extension: { b: 2, a: 1 } });
    const after = { agent: "fast", prompt: before.prompt, background: false, description: before.description, token: before.token, extension: { a: 1, b: 2 } };
    observeV2(sink, (args) => ({ family: "native-args", callID: "call", sessionID: "parent", before: args(before), after: args(after), backgroundDecision: false }));
    sink.close();
    const [row] = checkV2ObservationStream(lines);
    if (row.family !== "native-args") throw new Error("missing native arguments");
    expect(row.before.fields.subagent_type).toEqual(row.after.fields.agent);
    expect(row.before.fields.prompt).toEqual(row.after.fields.prompt);
    expect(row.before.fields.task_id.type).toBe("undefined");
    expect(row.after.fields).not.toHaveProperty("task_id");
    expect(row.before.background).toEqual({ present: true, type: "boolean", value: true });
    expect(row.after.background).toEqual({ present: true, type: "boolean", value: false });
    expect(Object.keys(row.before.fields).filter((k) => k.startsWith("key:"))).toHaveLength(2);
    for (const secret of ["private", "sk-secret", "password", "example.org", '"token"', '"extension"']) expect(lines.join("")).not.toContain(secret);
    expect(before.background).toBe(true);
    const other: string[] = [];
    const second = createV2Observations({ write: (line) => { other.push(line); } });
    observeV2(second, (args) => ({ ...row, before: args(before), after: args(after) }));
    expect(JSON.parse(other[0]).before.fields.prompt.digest).not.toBe(row.before.fields.prompt.digest);
  });

  it("bounds rows/events/bytes and detects overflow, missing tails, writer faults, accessors and gaps", () => {
    const lines: string[] = [];
    const sink = createV2Observations({ maxEvents: 2, write: (line) => { lines.push(line); } });
    observeV2(sink, effect); observeV2(sink, effect);
    const extra = vi.fn(effect);
    observeV2(sink, extra);
    expect(extra).not.toHaveBeenCalled();
    sink.close();
    expect(sink.counts()).toEqual({ attempted: 3, written: 2, dropped: 1, failed: 0 });
    expect(() => checkV2ObservationStream(lines)).toThrow();
    const good: string[] = [];
    const clean = createV2Observations({ write: (line) => { good.push(line); } });
    observeV2(clean, effect); observeV2(clean, effect); clean.close();
    expect(() => checkV2ObservationStream(good.slice(1))).toThrow();
    expect(() => checkV2ObservationStream(good.slice(0, -1))).toThrow();
    const fault = createV2Observations({ write: () => { throw new Error("disk full"); } });
    expect(() => { observeV2(fault, effect); fault.close(); }).not.toThrow();
    expect(fault.counts().failed).toBe(2);
    const bounded = createV2Observations({ maxBytes: 0, write: vi.fn() });
    observeV2(bounded, effect);
    expect(bounded.counts().dropped).toBe(1);
    const getter = vi.fn(() => "secret");
    const bag = Object.defineProperty({}, "prompt", { get: getter });
    observeV2(clean, () => effect()); // closed: ignored
    const access = createV2Observations({ write: vi.fn() });
    observeV2(access, (args) => ({ family: "native-args", callID: "c", sessionID: "p", before: args(bag), after: args({}), backgroundDecision: null }));
    expect(access.counts().failed).toBe(1);
    expect(getter).not.toHaveBeenCalled();
    vi.spyOn(access, "record").mockImplementation(() => { throw new Error("broken observer itself"); });
    expect(() => observeV2(access, effect)).not.toThrow();
  });
});
