import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkV2ObservationStream, createV2Observations, observeV2, openV2Observations, OBSERVATION_MAX_ROW_BYTES, type V2Observations } from "../../src/compat/v2-observations";
import { createV2Runtime } from "../../src/compat/v2-client";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import * as configModule from "../../src/router/config";
import v2Plugin from "../../src/v2";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});
vi.mock("../../src/index", () => ({ default: vi.fn() }));
vi.mock("../../src/compat/v2-client", () => ({ createV2Runtime: vi.fn(() => ({ client: {} })) }));
vi.mock("../../src/compat/v2-hooks", () => ({ registerV2Hooks: vi.fn() }));

const effect = () => ({ family: "completion-effect" as const, effect: "finish-dispatch" as const, source: "test",
  parentSessionID: "parent", callID: "call", childSessionID: "child" });

describe("v2 read-only observation sink", () => {
  it("queues detached rows without calling the writer on the recording stack or in microtasks", async () => {
    const lines: string[] = [];
    const write = vi.fn((line: string) => { lines.push(line); });
    let now = 10;
    const state = { phase: "recorded" };
    const sink = createV2Observations({ write, now: () => now });
    try {
      sink.record(() => ({ family: "scheduler", planId: "plan", parentSessionID: "parent", action: "test", state }));
      expect(write).not.toHaveBeenCalled();
      expect(sink.counts()).toEqual({ attempted: 1, written: 0, dropped: 0, failed: 0 });
      state.phase = "mutated";
      now = 20;
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(write).toHaveBeenCalledTimes(1);
      sink.record(effect);
      sink.close(); // Flush the pending second row before its scheduled drain and before the seal.
      expect(checkV2ObservationStream(lines)).toMatchObject([
        { seq: 1, at: 10, state: { phase: "recorded" } }, { seq: 2, at: 20 },
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(write).toHaveBeenCalledTimes(3);
    } finally { sink.close(); }
  });

  it("does not spend a caller's deadline in a slow synchronous writer", () => {
    // A deterministic slow disk: each write consumes more than the verification grace period.
    let clock = 100;
    const sink = createV2Observations({ now: () => clock, write: () => { clock += 2_100; } });
    try {
      const deadline = clock + 2_000;
      sink.record(effect);
      expect(clock).toBe(100);
      expect(clock).toBeLessThan(deadline);
      expect(sink.counts().written).toBe(0);
    } finally { sink.close(); }
    expect(clock).toBe(4_300);
  });

  it("bounds deferred batches and preserves event caps and write faults through explicit flush", async () => {
    const lines: string[] = [];
    const write = vi.fn((line: string) => {
      lines.push(line);
      if (lines.length === 1) throw new Error("wrote then failed");
    });
    const sink = createV2Observations({ maxEvents: 130, write });
    try {
      for (let i = 0; i < 130; i++) sink.record(effect);
      const overflow = vi.fn(effect);
      sink.record(overflow);
      expect(overflow).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(write.mock.calls.length).toBeGreaterThan(0);
      expect(write.mock.calls.length).toBeLessThan(130);
      sink.flush();
      expect(write).toHaveBeenCalledTimes(130);
      expect(sink.counts()).toEqual({ attempted: 131, written: 129, dropped: 1, failed: 1 });
      expect(lines.map((line) => JSON.parse(line).seq)).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
      sink.close();
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: "end", seq: 132, attempted: 131, written: 129, dropped: 1, failed: 1 });
      expect(() => checkV2ObservationStream(lines)).toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(write).toHaveBeenCalledTimes(131);
    } finally { sink.close(); }
  });

  it("drops an oversized row before enqueueing, retaining its sequence gap", () => {
    const lines: string[] = [];
    const sink = createV2Observations({ write: (line) => { lines.push(line); } });
    sink.record(() => ({ family: "scheduler", planId: "plan", parentSessionID: "parent", action: "large", state: "x".repeat(OBSERVATION_MAX_ROW_BYTES) }));
    sink.record(effect);
    expect(lines).toEqual([]);
    sink.flush();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).seq).toBe(2);
    sink.close();
    expect(sink.counts()).toEqual({ attempted: 2, written: 1, dropped: 1, failed: 0 });
    expect(() => checkV2ObservationStream(lines)).toThrow();
  });

  it("includes the seal in the byte cap, even when no seal can fit", () => {
    const sample: string[] = [];
    createV2Observations({ now: () => 42, write: (line) => { sample.push(line); } }).close();
    const sealBytes = Buffer.byteLength(sample[0]);
    for (const maxBytes of [0, sealBytes - 1, sealBytes, sealBytes + 1, 512, 1_024]) {
      const lines: string[] = [];
      const sink = createV2Observations({ maxBytes, now: () => 42, write: (line) => { lines.push(line); } });
      for (let i = 0; i < 12; i++) sink.record(effect);
      sink.close();
      expect(Buffer.byteLength(lines.join("")), `maxBytes=${maxBytes}`).toBeLessThanOrEqual(maxBytes);
      expect(() => checkV2ObservationStream(lines)).toThrow();
      if (maxBytes >= 512) expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: "end", attempted: 12, failed: 0 });
      if (maxBytes === 0) expect(sink.counts().failed).toBe(1);
    }
    const exact: string[] = [];
    createV2Observations({ maxBytes: sealBytes, now: () => 42, write: (line) => { exact.push(line); } }).close();
    expect(Buffer.byteLength(exact.join(""))).toBe(sealBytes);
    expect(checkV2ObservationStream(exact)).toEqual([]);
  });

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
    second.close();
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

describe("v2 setup owns the observation sink for its entire lifetime", () => {
  let dir: string;
  let observations: V2Observations | undefined;
  const context = (): Plugin.Context => ({ location: { directory: dir, project: { directory: dir } } } as Plugin.Context);
  const lines = (): string[] => readFileSync(join(dir, readdirSync(dir)[0]), "utf8").trim().split("\n").filter(Boolean);

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "omr-observe-lifecycle-"));
    vi.stubEnv("MODEL_ROUTER_V2_OBSERVATIONS", dir);
    const bundled: unknown = JSON.parse(readFileSync(new URL("../../tiers.json", import.meta.url), "utf8"));
    vi.spyOn(configModule, "loadConfig").mockReturnValue(configModule.validateConfig(bundled));
    vi.mocked(ModelRouterPlugin).mockImplementation(async (input) => {
      observations = (input as typeof input & { routerObservations?: V2Observations }).routerObservations;
      return {};
    });
    vi.mocked(registerV2Hooks).mockResolvedValue(async () => undefined);
  });
  afterEach(() => {
    observations?.close();
    observations = undefined;
    // Also release the descriptor when the red regression fails before setup can hand back its sink.
    for (const result of vi.mocked(openSync).mock.results) {
      if (result.type === "return") { try { closeSync(result.value); } catch { /* Already closed. */ } }
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { force: true, recursive: true });
  });

  it.each([false, true])("memoizes concurrent disposal and seals after late cleanup events (reject=%s)", async (reject) => {
    const failure = new Error("cleanup failed");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const cleanup = vi.fn(async () => {
      if (started) return; // The real hook cleanup returns early on a second call while the first drains.
      started = true;
      await gate;
      observeV2(observations, () => ({ ...effect(), callID: "late-cleanup" }));
      if (reject) throw failure;
    });
    vi.mocked(registerV2Hooks).mockResolvedValueOnce(cleanup);
    const dispose = await v2Plugin.setup(context());
    observeV2(observations, effect);
    const first = dispose(), second = dispose();
    const settled = Promise.allSettled([first, second]);
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(closeSync).not.toHaveBeenCalled();
      expect(lines().some((line) => JSON.parse(line).kind === "end")).toBe(false);
      expect(second).toBe(first);
      expect(cleanup).toHaveBeenCalledTimes(1);
      release();
      const results = await settled;
      expect(results).toEqual(reject ? [
        { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
      ] : [{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
      expect(checkV2ObservationStream(lines()).map((row) => row.family === "completion-effect" ? row.callID : "")).toEqual(["call", "late-cleanup"]);
      expect(observations?.counts()).toEqual({ attempted: 2, written: 2, dropped: 0, failed: 0 });
      expect(closeSync).toHaveBeenCalledTimes(1);
      expect(dispose()).toBe(first);
    } finally { release(); await settled; }
  });

  it.each(["runtime", "plugin"] as const)("closes and seals when %s initialization fails after open", async (phase) => {
    const failure = new Error(`${phase} initialization failed`);
    if (phase === "runtime") vi.mocked(createV2Runtime).mockImplementationOnce(() => { throw failure; });
    else vi.mocked(ModelRouterPlugin).mockImplementationOnce(async (input) => {
      observations = (input as typeof input & { routerObservations?: V2Observations }).routerObservations;
      observeV2(observations, effect);
      throw failure;
    });
    await expect(v2Plugin.setup(context())).rejects.toBe(failure);
    expect(openSync).toHaveBeenCalledTimes(1);
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(vi.mocked(openSync).mock.results[0].value);
    expect(() => fstatSync(vi.mocked(openSync).mock.results[0].value)).toThrow();
    expect(checkV2ObservationStream(lines())).toHaveLength(phase === "runtime" ? 0 : 1);
    expect(registerV2Hooks).not.toHaveBeenCalled();
  });
});
