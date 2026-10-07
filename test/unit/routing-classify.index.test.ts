import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../../src/router/config";
import {
  classify,
  classifyMany,
  createClassifierBackend,
  CLASS_OPTIONS,
  INDEX_TIMEOUT_GRACE_MS,
  UNKNOWN_FACTS,
  type BackendResult,
  type BackendStatus,
  type ClassifierBackend,
  type ClassifierSettings,
  type ClassifyDeps,
  type ClassifyInput,
  type FetchLike,
  type HostGenerate,
  type TaskClass,
} from "../../src/routing/classify";
import { hasCredentialSignal, scrubState } from "../../src/routing/classify/scrub";
import { createHostBackend } from "../../src/routing/classify/backends/host";
import { createTypeSafeBackend } from "../../src/routing/classify/backends/typesafe";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = validateConfig(JSON.parse(readFileSync(join(here, "../../tiers.json"), "utf-8")));

function settings(overrides: Partial<ClassifierSettings> = {}): ClassifierSettings {
  return {
    backend: "host",
    model: "opencode-go/deepseek-v4.1-flash",
    baseUrl: null,
    apiKeyEnv: null,
    timeoutMs: 100,
    samples: 1,
    maxStateChars: 2000,
    ...overrides,
  };
}

interface Logs {
  readonly logger: { warn(message: string, extra?: Record<string, unknown>): void };
  readonly messages: string[];
}

function makeLogs(): Logs {
  const messages: string[] = [];
  return { logger: { warn: (message) => void messages.push(message) }, messages };
}

function okResult(
  taskClass: TaskClass,
  confidence = 0.6,
  extra: { risk?: "low" | "medium" | "high"; scope?: "single" | "multi" | "repo" } = {},
): BackendResult {
  return {
    facts: { class: taskClass, confidence, source: "host", ...extra },
    raw: null,
    status: "ok",
    latencyMs: 5,
    calls: 1,
  };
}

function failResult(status: Exclude<BackendStatus, "ok" | "disagree">, reason = "why"): BackendResult {
  return {
    facts: { class: "other", confidence: 0, source: "unknown" },
    raw: null,
    status,
    reason,
    latencyMs: 7,
    calls: status === "disabled" ? 0 : 1,
  };
}

const disagreeResult: BackendResult = {
  facts: { class: "other", confidence: 0, source: "host" },
  raw: null,
  status: "disagree",
  reason: "samples disagree",
  latencyMs: 9,
  calls: 3,
};

function fakeBackend(
  single: (n: number) => BackendResult | Promise<BackendResult>,
  many?: (count: number) => BackendResult[] | Promise<BackendResult[]> | unknown,
) {
  const classifyFn = vi.fn(async (..._args: Parameters<ClassifierBackend["classify"]>) => single(classifyFn.mock.calls.length));
  const classifyManyFn = vi.fn(async (...args: Parameters<ClassifierBackend["classifyMany"]>) => {
    const count = args[0].length;
    return (many ? await many(count) : Array.from({ length: count }, () => okResult("implement"))) as BackendResult[];
  });
  const backend: ClassifierBackend = { id: "host", classify: classifyFn, classifyMany: classifyManyFn };
  return { backend, classifyFn, classifyManyFn };
}

function makeDeps(backend: ClassifierBackend | null, overrides: Partial<ClassifyDeps> = {}): ClassifyDeps & Logs {
  const logs = makeLogs();
  return {
    cfg,
    settings: settings(),
    minClassConfidence: 0.7,
    backend,
    logger: logs.logger,
    random: () => 0.5,
    ...overrides,
    messages: logs.messages,
  };
}

const input = (prompt: string, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({ prompt, ...extra });

describe("classify — rules only", () => {
  it("classifies by rules without a backend and passes stripped/pin/detection through", async () => {
    const deps = makeDeps(null);
    const result = await classify(input("grep for classifyTrivial in src"), deps);
    expect(result.facts).toMatchObject({ class: "search", confidence: 0.8, source: "rules" });
    expect(result.pin).toBe(false);
    expect(result.detection).toBeNull();
    expect(result.stripped).toBe("grep for classifyTrivial in src");
    expect(result.trace).toEqual({
      rules: result.facts,
      routeLine: null,
      routeLines: { count: 0, conflict: false, edgeOnly: true },
      backend: null,
    });
  });

  it("uses the description as part of the rule text and cwd for external_dir", async () => {
    const deps = makeDeps(null);
    const byDescription = await classify({ description: "grep for foo", prompt: "" }, deps);
    expect(byDescription.facts.class).toBe("search");
    const external = await classify(
      input("write the log to C:\\Users\\me\\x.log", { cwd: "D:\\work\\repo" }),
      deps,
    );
    expect(external.facts.needs).toContain("external_dir");
  });

  it("a route line overrides the rules, is stripped, and reports pin and detection", async () => {
    const deps = makeDeps(null);
    const result = await classify(
      input("[route class=design risk=high scope=repo needs=network pin d=grader]\nplan the migration"),
      deps,
    );
    expect(result.facts).toMatchObject({
      class: "design",
      risk: "high",
      scope: "repo",
      confidence: 0.9,
      source: "plan",
    });
    expect(result.facts.needs).toEqual(["shell", "network"]);
    expect(result.pin).toBe(true);
    expect(result.detection).toBe("grader");
    expect(result.stripped).toBe("plan the migration");
    expect(result.trace.routeLine?.class).toBe("design");
    expect(result.trace.rules.source).toBe("rules");
  });

  it("route line facts keep the rules' view of the stripped prompt", async () => {
    const result = await classify(input("[route risk=high]\ngrep for foo"), makeDeps(null));
    expect(result.facts).toMatchObject({ class: "search", risk: "high", source: "rules", confidence: 0.8 });
  });
});

describe("classify — backend gate", () => {
  it.each(["classify", "classifyMany"] as const)("D14 QA-G-B4: %s blocks credentials in acceptance past the prompt head with zero fetches", async (method) => {
    const fetch = vi.fn<FetchLike>();
    const config = settings({ backend: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" });
    const backend = createClassifierBackend(config, { fetch, env: {}, logger: makeLogs().logger });
    const deps = makeDeps(backend, { settings: config });
    const task = input("Find where the cache is built and refactor the loader.\n" + "lorem ipsum dolor sit amet ".repeat(800)
      + "\n[acceptance]\ncriteria: log in as admin with the password hunter2 and the cache loads\n[/acceptance]");
    const results = method === "classify" ? [await classify(task, deps)] : await classifyMany([task, task], deps);
    for (const result of results) expect(result.trace.backendSkipped).toBe("credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not call the backend when the rules are confident", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    const result = await classify(input("grep for foo"), makeDeps(backend));
    expect(classifyFn).not.toHaveBeenCalled();
    expect(result.facts.class).toBe("search");
    expect(result.trace.backend).toBeNull();
  });

  it("does not call the backend when a route line carries a class, even above minClassConfidence 0.95", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    const deps = makeDeps(backend, { minClassConfidence: 0.95 });
    const result = await classify(input("[route class=implement]\nhello there"), deps);
    expect(classifyFn).not.toHaveBeenCalled();
    expect(result.facts).toMatchObject({ class: "implement", confidence: 0.9, source: "route-line" });
  });

  it("does not call the backend when settings.backend is rules or there is no backend", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    await classify(input("hello"), makeDeps(backend, { settings: settings({ backend: "rules" }) }));
    await classify(input("hello"), makeDeps(null));
    expect(classifyFn).not.toHaveBeenCalled();
  });

  it("calls the backend when the rules are unsure, with a state built from the stripped prompt", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("implement"));
    const random = () => 0.25;
    const deps = makeDeps(backend, { random });
    const result = await classify(input("[route risk=low]\nhello world", { description: "Say hi" }), deps);
    expect(classifyFn).toHaveBeenCalledTimes(1);
    const [state, options] = classifyFn.mock.calls[0]!;
    expect(state.text).toBe("Description: Say hi\nTask:\nhello world");
    expect(options.choices).toBe(CLASS_OPTIONS);
    expect(options.random).toBe(random);
    // The rules matched nothing, so the backend label is only recorded (QA-1.2-27), never promoted.
    expect(result.trace.backend).toEqual({
      id: "host",
      status: "ok",
      latencyMs: 5,
      calls: 1,
      label: "implement",
      disagrees: true,
    });
    expect(result.facts).toEqual(result.trace.rules);
  });

  it("a route line without a class does not stop the backend", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("debug"));
    await classify(input("[route risk=high]\nhello"), makeDeps(backend));
    expect(classifyFn).toHaveBeenCalledTimes(1);
  });
});

const UNSURE = "refactor and rename the module"; // rules: implement + mechanical matched, class implement, 0.5

describe("classify — merging the backend answer", () => {
  it("agreement with the rules class raises confidence to 0.8", async () => {
    const { backend } = fakeBackend(() => okResult("implement", 0.6));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts).toMatchObject({ class: "implement", confidence: 0.8, source: "host" });
    expect(result.trace.rules.confidence).toBe(0.5);
    expect(result.trace.backend).toMatchObject({ label: "implement" });
    expect(result.trace.backend?.disagrees).toBeUndefined();
  });

  it("agreement never lowers a higher backend confidence", async () => {
    const { backend } = fakeBackend(() => okResult("implement", 0.95));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts.confidence).toBe(0.95);
  });

  it("on agreement the backend's risk and scope are merged in, and only ever raise the rules facts", async () => {
    const raise = fakeBackend(() => okResult("implement", 0.9, { risk: "high", scope: "repo" }));
    const raised = await classify(input(UNSURE), makeDeps(raise.backend));
    expect(raised.facts).toMatchObject({ class: "implement", risk: "high", scope: "repo", source: "host" });
    expect(raised.facts.needs).toEqual(["edit"]);

    const lower = fakeBackend(() => okResult("implement", 0.6, { risk: "low", scope: "single" }));
    const kept = await classify(input("refactor and rename the logging module across the repo"), makeDeps(lower.backend));
    expect(kept.trace.rules).toMatchObject({ risk: "medium", scope: "repo" });
    expect(kept.facts).toMatchObject({ class: "implement", risk: "medium", scope: "repo" });
  });

  it("a matched class that differs from the rules class stays out of the facts: the label is only traced (QA-1.2-27)", async () => {
    const { backend } = fakeBackend(() => okResult("mechanical", 0.99, { risk: "high", scope: "repo" }));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.facts).toMatchObject({ class: "implement", confidence: 0.5, source: "rules", risk: "medium" });
    expect(result.trace.backend).toMatchObject({ status: "ok", label: "mechanical", disagrees: true });
    expect(result.trace.backend?.rejected).toBeUndefined();
  });

  it("when the rules matched nothing the backend label is recorded but never promoted", async () => {
    const { backend } = fakeBackend(() => okResult("debug"));
    const result = await classify(input("hello"), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.facts).toMatchObject({ class: "other", confidence: 0.2, source: "rules", needs: [] });
    expect(result.trace.backend).toMatchObject({ label: "debug", disagrees: true });
  });

  it("a backend 'other' on a task the rules found nothing in changes nothing", async () => {
    const { backend } = fakeBackend(() => okResult("other", 0.6));
    const result = await classify(input("hello"), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ label: "other" });
    expect(result.trace.backend?.disagrees).toBeUndefined();
  });

  it("disagree keeps the rules class with confidence 0", async () => {
    const { backend } = fakeBackend(() => disagreeResult);
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts).toMatchObject({ class: "implement", confidence: 0, source: "rules" });
    expect(result.trace.backend).toMatchObject({ status: "disagree", reason: "samples disagree" });
  });

  for (const status of ["error", "timeout", "invalid", "disabled"] as const) {
    it(`a ${status} backend result leaves the rules facts unchanged`, async () => {
      const { backend } = fakeBackend(() => failResult(status));
      const result = await classify(input(UNSURE), makeDeps(backend));
      expect(result.facts).toEqual(result.trace.rules);
      expect(result.trace.backend).toMatchObject({ id: "host", status, reason: "why" });
    });
  }
});
describe("classify — final invariants", () => {
  it("mechanical + high risk is capped at 0.5 from rules, route line and backend", async () => {
    const fromRules = await classify(input("rename the auth token variable across the repo"), makeDeps(null));
    expect(fromRules.facts).toMatchObject({ class: "mechanical", risk: "high" });
    expect(fromRules.facts.confidence).toBeLessThanOrEqual(0.5);

    const fromRouteLine = await classify(input("[route class=mechanical risk=high]\nrename a to b"), makeDeps(null));
    expect(fromRouteLine.facts).toMatchObject({ class: "mechanical", risk: "high", source: "route-line" });
    expect(fromRouteLine.facts.confidence).toBe(0.5);

    const { backend } = fakeBackend(() => okResult("mechanical", 0.95, { risk: "high" }));
    const fromBackend = await classify(input("rename foo to bar in a.ts and rm -rf dist"), makeDeps(backend));
    expect(fromBackend.trace.rules).toMatchObject({ class: "mechanical", risk: "high" });
    expect(fromBackend.facts).toMatchObject({ class: "mechanical", risk: "high", source: "host" });
    expect(fromBackend.facts.confidence).toBe(0.5); // agreement lifted it to 0.95; the cap still wins
  });

  it("confidence is rounded; needs are unique and in order", async () => {
    const { backend } = fakeBackend(() => okResult("implement", 0.956789));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts.confidence).toBe(0.96);
    expect(result.facts.needs).toEqual(["edit"]);
  });
});

describe("classify — never throws, never hangs", () => {
  it("a throwing backend leaves the rules facts and is logged", async () => {
    const sync = fakeBackend(() => {
      throw new Error("backend exploded");
    });
    const deps = makeDeps(sync.backend);
    const result = await classify(input("refactor and rename the module"), deps);
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ status: "error", reason: "backend exploded" });
    expect(deps.messages).toEqual(["classifier host: error (backend exploded)"]);
  });

  it("a rejecting backend leaves the rules facts", async () => {
    const { backend } = fakeBackend(() => Promise.reject(new Error("rejected")));
    const result = await classify(input("hello"), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend?.status).toBe("error");
  });

  it("a malformed backend result is treated as invalid", async () => {
    for (const bad of [
      null,
      { status: "ok" },
      { status: "bogus", facts: { class: "debug", confidence: 0.5, source: "host" } },
      { status: "ok", facts: { class: "banana", confidence: 0.5, source: "host" } },
      { status: "ok", facts: { class: "debug", confidence: 7, source: "host" } },
      { status: "ok", facts: { class: "debug", confidence: Number.NaN, source: "host" } },
    ]) {
      const { backend } = fakeBackend(() => bad as unknown as BackendResult);
      const result = await classify(input("hello"), makeDeps(backend));
      expect(result.facts, JSON.stringify(bad)).toEqual(result.trace.rules);
      expect(result.trace.backend?.status).toBe("invalid");
    }
  });

  it("a hung backend settles within timeoutMs + INDEX_TIMEOUT_GRACE_MS + 50 ms with the rules facts", async () => {
    const { backend } = fakeBackend(() => new Promise<BackendResult>(() => undefined));
    const deps = makeDeps(backend, { settings: settings({ timeoutMs: 100 }) });
    const started = performance.now();
    const result = await classify(input("refactor and rename the module"), deps);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(100 + INDEX_TIMEOUT_GRACE_MS + 50);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ status: "timeout" });
    expect(deps.messages[0]).toContain("classifier host: timeout");
  });

  it("a throwing input (forced via a getter) gives UNKNOWN_FACTS and never throws", async () => {
    const hostile = {
      get prompt(): string {
        throw new Error("getter boom");
      },
    } as ClassifyInput;
    const deps = makeDeps(null);
    const result = await classify(hostile, deps);
    expect(result.facts).toBe(UNKNOWN_FACTS);
    expect(result.facts).toMatchObject({ class: "other", confidence: 0, source: "unknown" });
    expect(result.stripped).toBe("");
    expect(result.pin).toBe(false);
    expect(result.trace).toEqual({
      rules: UNKNOWN_FACTS,
      routeLine: null,
      routeLines: { count: 0, conflict: false, edgeOnly: true },
      backend: null,
    });
    expect(deps.messages).toEqual(["classifier failed: getter boom"]);
  });

  it("a prompt that is not a string is treated as empty", async () => {
    const result = await classify({ prompt: undefined as unknown as string }, makeDeps(null));
    expect(result.facts.class).toBe("other");
    expect(result.stripped).toBe("");
  });
});

describe("classifyMany", () => {
  const items = (n: number, prefix = "hello"): ClassifyInput[] =>
    Array.from({ length: n }, (_, i) => input(`${prefix} ${i}`));

  it("returns results in input order and merges per item", async () => {
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("search"),
      () => [okResult("implement"), failResult("invalid")],
    );
    const results = await classifyMany(
      [input(UNSURE), input("grep for foo"), input("hello again"), input("[route class=design]\nx")],
      makeDeps(backend),
    );
    expect(results).toHaveLength(4);
    expect(classifyManyFn).toHaveBeenCalledTimes(1);
    expect(classifyManyFn.mock.calls[0]![0]).toHaveLength(2);
    expect(results[0]!.facts).toMatchObject({ class: "implement", confidence: 0.8, source: "host" });
    expect(results[1]!.facts).toMatchObject({ class: "search", source: "rules" });
    expect(results[2]!.facts).toMatchObject({ class: "other", source: "rules" });
    expect(results[2]!.trace.backend?.status).toBe("invalid");
    expect(results[3]!.facts).toMatchObject({ class: "design", source: "route-line" });
    expect(results[3]!.trace.backend).toBeNull();
    expect(results[3]!.stripped).toBe("x");
  });

  it("chunks gated items by 50, sequentially and in input order", async () => {
    let active = 0;
    let maxActive = 0;
    const sizes: number[] = [];
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("search"),
      async (count) => {
        active++;
        maxActive = Math.max(maxActive, active);
        sizes.push(count);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return Array.from({ length: count }, () => okResult("review"));
      },
    );
    const results = await classifyMany(items(120), makeDeps(backend, { settings: settings({ timeoutMs: 500 }) }));
    expect(sizes).toEqual([50, 50, 20]);
    expect(maxActive).toBe(1);
    expect(classifyManyFn).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.stripped)).toEqual(items(120).map((i) => i.prompt));
    expect(results.every((r) => r.trace.backend?.label === "review")).toBe(true);
    expect(results.every((r) => r.facts.class === "other" && r.facts.source === "rules")).toBe(true);
  });

  it("no gated item means no backend call", async () => {
    const { backend, classifyManyFn } = fakeBackend(() => okResult("search"));
    const results = await classifyMany(
      [input("grep for foo"), input("[route class=debug]\nx"), input("rename a to b in c.ts")],
      makeDeps(backend),
    );
    expect(classifyManyFn).not.toHaveBeenCalled();
    expect(results.map((r) => r.facts.class)).toEqual(["search", "debug", "mechanical"]);
    expect(await classifyMany([], makeDeps(backend))).toEqual([]);
  });

  describe("request counts with the real backends (fake generate / fetch)", () => {
    function hostCounting(samples: 1 | 3) {
      const calls: number[] = [];
      const generate: HostGenerate = {
        text: async (request) => {
          calls.push((request.prompt.match(/<<<ITEM \d+ /g) ?? []).length);
          return { text: "" };
        },
      };
      const logs = makeLogs();
      const config = settings({ samples, timeoutMs: 2000 });
      const backend = createHostBackend({ generate, settings: config, logger: logs.logger });
      return { calls, deps: makeDeps(backend, { settings: config }) };
    }

    it("50 gated items with samples 1 make exactly one request; 51 make two; 0 make none", async () => {
      const fifty = hostCounting(1);
      await classifyMany(items(50), fifty.deps);
      expect(fifty.calls).toEqual([50]);

      const fiftyOne = hostCounting(1);
      await classifyMany(items(51), fiftyOne.deps);
      expect(fiftyOne.calls).toEqual([50, 1]);

      const none = hostCounting(1);
      await classifyMany(items(5, "grep for foo in file"), none.deps);
      expect(none.calls).toEqual([]);
    });

    it("samples 3 triples the host request count", async () => {
      const three = hostCounting(3);
      await classifyMany(items(51), three.deps);
      expect(three.calls.sort((a, b) => a - b)).toEqual([1, 1, 1, 50, 50, 50]);
    });

    it("typesafe makes ceil(gated / 50) requests whatever `samples` is", async () => {
      let requests = 0;
      const fetchFn: FetchLike = async () => {
        requests++;
        return { ok: true, status: 200, text: async () => "{}" };
      };
      const logs = makeLogs();
      const config = settings({
        backend: "typesafe",
        samples: 3,
        baseUrl: "https://api.typesafe.ai",
        apiKeyEnv: "TS_KEY",
        timeoutMs: 2000,
      });
      const backend = createTypeSafeBackend({ fetch: fetchFn, env: { TS_KEY: "k-123456" }, settings: config, logger: logs.logger });
      await classifyMany(items(101), makeDeps(backend, { settings: config }));
      expect(requests).toBe(3);
    });
  });

  it("an item whose preparation fails gets UNKNOWN_FACTS; the others are unaffected", async () => {
    const hostile = {
      get prompt(): string {
        throw new Error("item boom");
      },
    } as ClassifyInput;
    const deps = makeDeps(null);
    const results = await classifyMany([input("grep for foo"), hostile, input("rename a to b in c.ts")], deps);
    expect(results.map((r) => r.facts.class)).toEqual(["search", "other", "mechanical"]);
    expect(results[1]!.facts).toBe(UNKNOWN_FACTS);
    expect(deps.messages).toEqual(["classifier failed: item boom"]);
  });

  it("a hung batch settles within the budget with the rules facts for every item", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      () => new Promise<BackendResult[]>(() => undefined),
    );
    const deps = makeDeps(backend, { settings: settings({ timeoutMs: 100 }) });
    const started = performance.now();
    const results = await classifyMany(items(3), deps);
    expect(performance.now() - started).toBeLessThan(100 + INDEX_TIMEOUT_GRACE_MS + 50);
    expect(results.map((r) => r.trace.backend?.status)).toEqual(["timeout", "timeout", "timeout"]);
    expect(results.every((r) => r.facts.source === "rules")).toBe(true);
    expect(deps.messages).toHaveLength(1);
  });

  it("a rejecting batch leaves the rules facts", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      () => Promise.reject(new Error("batch down")),
    );
    const results = await classifyMany(items(2), makeDeps(backend));
    expect(results.map((r) => r.trace.backend?.status)).toEqual(["error", "error"]);
    expect(results.every((r) => r.facts.source === "rules")).toBe(true);
  });

  it("validates the returned array: wrong length or non-array means every item is invalid", async () => {
    for (const bad of [[okResult("debug")], "nope", null, {}]) {
      const { backend } = fakeBackend(() => okResult("search"), () => bad);
      const results = await classifyMany(items(3), makeDeps(backend));
      expect(results.map((r) => r.trace.backend?.status), JSON.stringify(bad)).toEqual(["invalid", "invalid", "invalid"]);
      expect(results.every((r) => r.facts.source === "rules")).toBe(true);
    }
  });

  it("validates each entry: a bad entry invalidates only its item", async () => {
    const entries = [
      okResult("debug"),
      { status: "ok", facts: { class: "banana", confidence: 0.5, source: "host" } },
      okResult("review", 2),
      { ...okResult("design"), status: "bogus" },
      okResult("design", 0.6),
    ];
    const { backend } = fakeBackend(() => okResult("search"), () => entries);
    const results = await classifyMany(items(5), makeDeps(backend));
    expect(results.map((r) => r.trace.backend?.status)).toEqual(["ok", "invalid", "invalid", "invalid", "ok"]);
    expect(results.map((r) => r.trace.backend?.label)).toEqual(["debug", undefined, undefined, undefined, "design"]);
    expect(results.every((r) => r.facts.class === "other")).toBe(true); // labels are traced, never promoted
  });

  it("applies the same final invariants per item", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      () => [okResult("mechanical", 0.9, { risk: "high" })],
    );
    const [only] = await classifyMany([input("rename foo to bar in a.ts and rm -rf dist")], makeDeps(backend));
    expect(only!.facts).toMatchObject({ class: "mechanical", risk: "high", confidence: 0.5 });
  });
});

describe("createClassifierBackend", () => {
  it("rules → null", () => {
    const logs = makeLogs();
    expect(createClassifierBackend(settings({ backend: "rules" }), { logger: logs.logger })).toBeNull();
    expect(logs.messages).toEqual([]);
  });

  it("host without generate → null and one log line", () => {
    const logs = makeLogs();
    expect(createClassifierBackend(settings({ backend: "host" }), { logger: logs.logger })).toBeNull();
    expect(logs.messages).toEqual(["classifier: host classifier needs the v2 plugin context; using rules"]);
  });

  it("host with generate → the host backend", () => {
    const logs = makeLogs();
    const generate: HostGenerate = { text: async () => ({ text: "search" }) };
    expect(createClassifierBackend(settings({ backend: "host" }), { generate, logger: logs.logger })?.id).toBe("host");
  });

  it("HTTP backends are built with injected fetch/env and do not check the key at build time", () => {
    const logs = makeLogs();
    const fetchFn: FetchLike = async () => ({ ok: true, status: 200, text: async () => "{}" });
    const common = { fetch: fetchFn, env: {}, logger: logs.logger };
    const openai = createClassifierBackend(
      settings({ backend: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKeyEnv: "MISSING" }),
      common,
    );
    const typesafe = createClassifierBackend(
      settings({ backend: "typesafe", baseUrl: "https://api.typesafe.ai", apiKeyEnv: "MISSING" }),
      common,
    );
    expect(openai?.id).toBe("openai-compatible");
    expect(typesafe?.id).toBe("typesafe");
    // Only the one-time effective-host lines (QA-1.2-9); no missing-key complaint at build time.
    expect(logs.messages).toEqual([
      "classifier openai-compatible: effective host localhost (http, loopback)",
      "classifier typesafe: effective host api.typesafe.ai (https)",
    ]);
  });

  it("falls back to the global fetch and process.env when none are injected (nothing is called)", () => {
    const logs = makeLogs();
    const backend = createClassifierBackend(
      settings({ backend: "openai-compatible", baseUrl: "http://localhost:1/v1" }),
      { logger: logs.logger },
    );
    expect(backend?.id).toBe("openai-compatible");
  });

  it("an end-to-end classify through the real host backend with a fake generate", async () => {
    const generate: HostGenerate = { text: vi.fn(async () => ({ text: "implement" })) };
    const logs = makeLogs();
    const config = settings({ backend: "host", timeoutMs: 500 });
    const backend = createClassifierBackend(config, { generate, logger: logs.logger });
    const result = await classify(input(UNSURE), makeDeps(backend, { settings: config }));
    expect(result.facts).toMatchObject({ class: "implement", confidence: 0.8, source: "host" });
    expect(result.trace.backend).toMatchObject({ id: "host", status: "ok", calls: 1 });
  });
});

const STRIPE_KEY = ["sk", "live", "51HxYzAbCdEfGhIjKlMnOpQrSt"].join("_");

describe("credential policy gate (QA-1.2-1)", () => {
  it("never consults the backend for a task that names a credential; the rules facts stand", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    for (const prompt of [
      "hello, the password is hunter2",
      "hello GITHUB_TOKEN",
      `hello ${STRIPE_KEY}`,
      "hello\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ]) {
      const result = await classify(input(prompt), makeDeps(backend));
      expect(result.facts, prompt).toEqual(result.trace.rules);
      expect(result.trace.backend).toBeNull();
      expect(result.trace.backendSkipped).toBe("credentials");
    }
    expect(classifyFn).not.toHaveBeenCalled();
  });

  it("also checks the description", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    const result = await classify(input("hello", { description: "rotate the API key" }), makeDeps(backend));
    expect(classifyFn).not.toHaveBeenCalled();
    expect(result.trace.backendSkipped).toBe("credentials");
  });

  it("confident rules never reach the gate (no skip marker)", async () => {
    const { backend } = fakeBackend(() => okResult("design"));
    const result = await classify(input("grep for password in src"), makeDeps(backend));
    expect(result.trace.backendSkipped).toBeUndefined();
    expect(result.facts.source).toBe("rules");
  });

  it("classifyMany skips only the items that mention credentials", async () => {
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("search"),
      () => [okResult("debug"), okResult("debug")],
    );
    const results = await classifyMany(
      [input("hello one"), input("hello, the token is abc"), input("hello two")],
      makeDeps(backend),
    );
    expect(classifyManyFn).toHaveBeenCalledTimes(1);
    expect(classifyManyFn.mock.calls[0]![0]).toHaveLength(2);
    expect(results.map((r) => r.trace.backendSkipped)).toEqual([undefined, "credentials", undefined]);
    expect(results.map((r) => r.trace.backend?.label)).toEqual(["debug", undefined, "debug"]);
    expect(results.map((r) => r.facts.class)).toEqual(["other", "other", "other"]);
  });
});

/**
 * DF3 (2026-10-06): the credential gate was suspected of a false positive on the live classifier probe. It was not: the probe's
 * own row (20:34:08Z) shows the host backend ran (`trace.backend` = host/ok/other, 1688 ms); the `backendSkipped: "credentials"`
 * rows read as the probe's belonged to another session writing the same `decisions.jsonl`, dispatching long briefs that name
 * credentials. These tests pin both sides of the D14 gate so the next reading of a live row has something to compare against.
 *
 * The rule (QA-1.2-1, QA-1.2-26): the backend is skipped for a task whose description or prompt (a) contains a credential word
 * as a whole word (password, passwd, passphrase, secret, credential, api/access/private/ssh/signing key, token, bearer,
 * authorization, oauth), (b) names an env-style secret (`X_TOKEN`, `X_SECRET`, `X_PASSWORD`, `X_API_KEY`, `*_KEY` in capitals,
 * `.env`), (c) carries a PEM header, or (d) contains anything the scrubber redacts by name or shape (assignment, URL
 * credentials, provider token). An entropy-only redaction (a commit hash, a long identifier) does not skip. "token" gates in its
 * LLM sense too ("fix the token counter"): the text cannot tell the two apart, a false skip costs only the rules facts, a false
 * pass sends a credential off the machine.
 */
describe("credential policy gate: DF3 probe, ordinary prompts, real secrets (QA-1.2-1, DF3)", () => {
  const PROBE_PROMPT = 'Which word is longer, "alpha" or "omega"? Reply with one word only, no tools.';
  const PROBE_DESCRIPTION = "DF3 classifier probe 2";

  it("the DF3 probe is not a credential signal and reaches the backend (the live row: other, 0.2, host ok)", async () => {
    expect(hasCredentialSignal(PROBE_DESCRIPTION + "\n" + PROBE_PROMPT)).toBe(false);
    expect(scrubState(PROBE_DESCRIPTION + "\n" + PROBE_PROMPT)).toBe(PROBE_DESCRIPTION + "\n" + PROBE_PROMPT);

    const { backend, classifyFn } = fakeBackend(() => okResult("other", 0.2));
    const result = await classify(input(PROBE_PROMPT, { description: PROBE_DESCRIPTION }), makeDeps(backend));
    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(result.trace.backendSkipped).toBeUndefined();
    expect(result.trace.backend).toMatchObject({ id: "host", status: "ok", label: "other" });
    // Exactly the facts of the live row at 20:34:08Z: the rules class stands when the backend says `other`.
    expect(result.facts).toEqual({ class: "other", risk: "medium", scope: "single", needs: [], confidence: 0.2, source: "rules" });
  });

  it("the probe in a batch (the /annotate-plan path, one backend call for the whole plan) is not skipped either", async () => {
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("other"),
      () => [okResult("other", 0.2), okResult("other", 0.2)],
    );
    const results = await classifyMany(
      [input(PROBE_PROMPT, { description: PROBE_DESCRIPTION }), input(PROBE_PROMPT, { description: "DF3 classifier probe 1" })],
      makeDeps(backend),
    );
    expect(classifyManyFn).toHaveBeenCalledTimes(1);
    expect(classifyManyFn.mock.calls[0]![0]).toHaveLength(2);
    expect(results.map((r) => r.trace.backendSkipped)).toEqual([undefined, undefined]);
    expect(results.map((r) => r.trace.backend?.status)).toEqual(["ok", "ok"]);
  });

  it("a long brief that names the credential gate is skipped, as designed (what the other session's rows were)", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("design"));
    const brief = [
      "Diagnose and fix a suspected false positive in the classifier's credential policy gate.",
      "Real secrets and keys must still gate: a token, a password or an API key never leaves the machine.",
    ].join("\n");
    const result = await classify(input(brief), makeDeps(backend));
    expect(classifyFn).not.toHaveBeenCalled();
    expect(result.trace.backendSkipped).toBe("credentials");
  });

  // [prompt, gates]: `gates` is the D14 judgement of the rule above, not a measurement of what the rules would call it.
  const ORDINARY: ReadonlyArray<readonly [string, boolean]> = [
    ["fix the token counter in stats.ts", true], // the word "token": an LLM token is indistinguishable from a credential; conservative on purpose
    ["rename the password field label in the login form", true], // names a credential
    ["review the API key rotation doc", true], // names a credential
    ["refactor the Authorization middleware", true], // names the Authorization header
    ["add a unit test for the pricing table in src/routing/engine/ladders.ts", false],
    ["add a composite primary key to the users table migration", false], // `key` alone is prose (only api/access/private/ssh/signing key, or `X_KEY`)
    ["change the cache key to include the model id", false],
    ["explain why the build fails on Windows with ENOENT in scripts/build.mjs", false],
    ["bump vitest to the latest minor and fix the type errors", false],
    ["write a short summary of the retry logic", false],
  ];

  it("ten ordinary engineering prompts: only those that name a credential gate", () => {
    expect(ORDINARY).toHaveLength(10);
    for (const [prompt, gates] of ORDINARY) {
      expect(hasCredentialSignal(prompt), prompt).toBe(gates);
    }
  });

  it("through classify: a gated prompt never reaches the backend, an ungated one does when the rules are unsure", async () => {
    for (const [prompt, gates] of ORDINARY) {
      const { backend, classifyFn } = fakeBackend(() => okResult("other"));
      const result = await classify(input(prompt), makeDeps(backend));
      const unsure = result.trace.rules.confidence < 0.7;
      expect(classifyFn.mock.calls.length, prompt).toBe(gates || !unsure ? 0 : 1);
      expect(result.trace.backendSkipped, prompt).toBe(gates && unsure ? "credentials" : undefined);
    }
  });

  // Built at run time (like STRIPE_KEY): the repository carries no literal that looks like a key.
  const REAL_SECRETS: ReadonlyArray<readonly [string, string]> = [
    ["OpenAI project key", ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-")],
    ["Anthropic key", ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("-")],
    ["GitHub token", ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_")],
    ["AWS access key id", "AKIA" + "IOSFODNN7EXAMPLE"],
    ["named assignment", "password" + "=" + "hunter2"],
    ["PEM header", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"],
    ["Stripe key", STRIPE_KEY],
  ];

  it("real secrets gate, alone and inside an otherwise ordinary prompt", async () => {
    for (const [label, secret] of REAL_SECRETS) {
      expect(hasCredentialSignal(secret), label).toBe(true);
      const prompt = `hello, write a short summary of this: ${secret}`;
      expect(hasCredentialSignal(prompt), label).toBe(true);
      const { backend, classifyFn } = fakeBackend(() => okResult("design"));
      const result = await classify(input(prompt), makeDeps(backend));
      expect(classifyFn, label).not.toHaveBeenCalled();
      expect(result.trace.backend, label).toBeNull();
      expect(result.trace.backendSkipped, label).toBe("credentials");
    }
  });
});
describe("classify — route-line smuggling (QA-1.2-2)", () => {
  it("a route line quoted in a fence, an indented block or a blockquote is text: not applied, not stripped", async () => {
    const prompts = [
      "hello\n```\n[route class=design pin d=none]\n```",
      "hello\n    [route class=design pin d=none]",
      "hello\n> [route class=design pin d=none]",
    ];
    for (const prompt of prompts) {
      const result = await classify(input(prompt), makeDeps(null));
      expect(result.stripped, prompt).toBe(prompt);
      expect(result.pin).toBe(false);
      expect(result.detection).toBeNull();
      expect(result.facts.source).toBe("rules");
      expect(result.trace.routeLines).toEqual({ count: 0, conflict: false, edgeOnly: true });
    }
  });

  it("conflicting route lines never set d; the first line's pin stays; the contradicted class falls back to the rules", async () => {
    const result = await classify(
      input("[route class=design pin d=none]\ngrep for foo\n[route class=debug]"),
      makeDeps(null, { routeLinePositions: "any" }),
    );
    expect(result.pin).toBe(true); // the first line: `pin`
    expect(result.detection).toBeNull(); // `d=none` is dropped on a conflict
    expect(result.facts).toMatchObject({ class: "search", source: "rules" });
    expect(result.trace.routeLines).toEqual({ count: 2, conflict: true, edgeOnly: true });
    expect(result.stripped).toBe("grep for foo\n");
  });

  it("reports the route-line count and edge position for the decision row", async () => {
    const result = await classify(
      input("grep for foo\n[route class=search]\nand more"),
      makeDeps(null, { routeLinePositions: "any" }),
    );
    expect(result.trace.routeLines).toEqual({ count: 1, conflict: false, edgeOnly: false });
  });
});
describe("A19 / QA-1.2-27: the backend only agrees; every other label stays in the trace", () => {
  it("a class the rules did not match is rejected: the rules class stands, the trace says so", async () => {
    const { backend } = fakeBackend(() => okResult("design", 0.95, { risk: "high", scope: "repo" }));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.facts).toMatchObject({ class: "implement", source: "rules", risk: "medium", scope: "single" });
    expect(result.trace.backend).toMatchObject({ id: "host", status: "ok", label: "design", rejected: true });
    expect(result.trace.backend?.disagrees).toBeUndefined();
  });

  it("when the rules matched nothing any label is allowed (not rejected) but is only recorded", async () => {
    const { backend } = fakeBackend(() => okResult("design", 0.99));
    const result = await classify(input("hello"), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ label: "design", disagrees: true });
    expect(result.trace.backend?.rejected).toBeUndefined();
  });

  it("search and recon are one family: either is allowed when the rules matched one of them", async () => {
    const { backend } = fakeBackend(() => okResult("search", 0.6));
    const result = await classify(input("summarize the module and rename its helper"), makeDeps(backend));
    expect(result.trace.rules).toMatchObject({ class: "mechanical", confidence: 0.5 }); // recon + mechanical matched
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ label: "search", disagrees: true });
    expect(result.trace.backend?.rejected).toBeUndefined();
  });

  it("a disagreeing label never raises confidence; an agreeing one lifts it to at least 0.8", async () => {
    const high = fakeBackend(() => okResult("mechanical", 0.99));
    const capped = await classify(input(UNSURE), makeDeps(high.backend));
    expect(capped.facts).toMatchObject({ class: "implement", confidence: 0.5, source: "rules" });
    expect(capped.trace.backend).toMatchObject({ label: "mechanical", disagrees: true });

    const agree = fakeBackend(() => okResult("implement", 0.99));
    expect((await classify(input(UNSURE), makeDeps(agree.backend))).facts.confidence).toBe(0.99);
    const agreeLow = fakeBackend(() => okResult("implement", 0.6));
    expect((await classify(input(UNSURE), makeDeps(agreeLow.backend))).facts.confidence).toBe(0.8);
  });

  it("minClassConfidence only decides whether the backend is asked", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("implement", 0.9));
    await classify(input(UNSURE), makeDeps(backend, { minClassConfidence: 0.4 })); // rules 0.5 >= 0.4: not asked
    expect(classifyFn).not.toHaveBeenCalled();
    await classify(input(UNSURE), makeDeps(backend, { minClassConfidence: 0.9 }));
    expect(classifyFn).toHaveBeenCalledTimes(1);
  });

  it("classifyMany: the same rules per item (agree merges, others are traced, unmatched classes are rejected)", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      () => [okResult("design", 0.99), okResult("design", 0.99), okResult("implement", 0.95)],
    );
    const results = await classifyMany([input("hello one"), input(UNSURE), input(`${UNSURE} again`)], makeDeps(backend));
    expect(results[0]!.facts).toEqual(results[0]!.trace.rules); // no rules match: label design only traced
    expect(results[0]!.trace.backend).toMatchObject({ label: "design", disagrees: true });
    expect(results[1]!.trace.backend).toMatchObject({ label: "design", rejected: true }); // design was not matched
    expect(results[1]!.facts.class).toBe("implement");
    expect(results[2]!.facts).toMatchObject({ class: "implement", confidence: 0.95, source: "host" }); // agrees
  });

  it("a non-ok backend result is never 'rejected' and carries no label", async () => {
    const { backend } = fakeBackend(() => failResult("error"));
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.trace.backend).toMatchObject({ status: "error" });
    expect(result.trace.backend?.rejected).toBeUndefined();
    expect(result.trace.backend?.label).toBeUndefined();
  });
});
describe("classifyMany stops after a failed chunk (QA-1.2-10)", () => {
  const items = (n: number): ClassifyInput[] => Array.from({ length: n }, (_, i) => input(`hello ${i}`));

  it("a chunk whose answers all fail ends the plan's backend calls; the remaining items keep the rules facts", async () => {
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("search"),
      (count) => Array.from({ length: count }, () => failResult("timeout")),
    );
    const deps = makeDeps(backend);
    const results = await classifyMany(items(120), deps);
    expect(classifyManyFn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(120);
    expect(results.slice(0, 50).every((r) => r.trace.backend?.status === "timeout")).toBe(true);
    expect(results.slice(50).every((r) => r.trace.backend?.status === "disabled")).toBe(true);
    expect(results[60]!.trace.backend?.reason).toBe("skipped: the previous batch failed");
    expect(results.every((r) => r.facts.source === "rules")).toBe(true);
    expect(deps.messages.filter((m) => m.includes("skipping 70 remaining items"))).toHaveLength(1);
  });

  it("a rejecting, hung or malformed batch also stops; an all-invalid batch does not", async () => {
    const rejecting = fakeBackend(() => okResult("search"), () => Promise.reject(new Error("down")));
    await classifyMany(items(101), makeDeps(rejecting.backend));
    expect(rejecting.classifyManyFn).toHaveBeenCalledTimes(1);

    const malformed = fakeBackend(() => okResult("search"), () => "nope");
    await classifyMany(items(101), makeDeps(malformed.backend));
    expect(malformed.classifyManyFn).toHaveBeenCalledTimes(1);

    const hung = fakeBackend(() => okResult("search"), () => new Promise<BackendResult[]>(() => undefined));
    await classifyMany(items(101), makeDeps(hung.backend, { settings: settings({ timeoutMs: 20 }) }));
    expect(hung.classifyManyFn).toHaveBeenCalledTimes(1);

    const invalid = fakeBackend(
      () => okResult("search"),
      (count) => Array.from({ length: count }, () => failResult("invalid")),
    );
    await classifyMany(items(101), makeDeps(invalid.backend));
    expect(invalid.classifyManyFn).toHaveBeenCalledTimes(3);
  });

  it("a partially failing chunk (some answers ok) does not stop the plan", async () => {
    const { backend, classifyManyFn } = fakeBackend(
      () => okResult("search"),
      (count) => Array.from({ length: count }, (_, i) => (i === 0 ? okResult("debug") : failResult("error"))),
    );
    await classifyMany(items(120), makeDeps(backend));
    expect(classifyManyFn).toHaveBeenCalledTimes(3);
  });

  it("the last chunk failing logs nothing about skipping", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      (count) => Array.from({ length: count }, () => failResult("error")),
    );
    const deps = makeDeps(backend);
    await classifyMany(items(30), deps);
    expect(deps.messages.some((m) => m.includes("skipping"))).toBe(false);
  });
});
describe("classify bounds its work on huge prompts (QA-1.2-11)", () => {
  it("a 3 MB prompt is classified from its head in well under a second; stripped stays complete", async () => {
    const prompt = `[route class=search]\ngrep for the handler\n${"filler word ".repeat(250_000)}`;
    const started = performance.now();
    const result = await classify(input(prompt), makeDeps(null));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.facts.class).toBe("search");
    expect(result.stripped).toBe(prompt.slice("[route class=search]\n".length));
  });

  it("with a backend, the state built from a huge prompt respects maxStateChars", async () => {
    const { backend, classifyFn } = fakeBackend(() => okResult("search"));
    const deps = makeDeps(backend, { settings: settings({ maxStateChars: 500 }) });
    await classify(input(`hello\n${"filler word ".repeat(250_000)}`), deps);
    const [state] = classifyFn.mock.calls[0]!;
    expect(state.text.length).toBeLessThanOrEqual(500);
  });
});
describe("failure paths still strip route lines (QA-1.2-19)", () => {
  const hostileDescription = (prompt: string): ClassifyInput =>
    ({
      prompt,
      get description(): string {
        throw new Error("description boom");
      },
    }) as ClassifyInput;

  it("classify: a failure after the route line was parsed still returns the prompt without it", async () => {
    const deps = makeDeps(null);
    const result = await classify(hostileDescription("[route class=design pin]\nhello\n[route risk=high]"), deps);
    expect(result.facts).toBe(UNKNOWN_FACTS);
    expect(result.pin).toBe(false);
    expect(result.stripped).toBe("hello\n[route risk=high]"); // default `first`: only the first line is a route line
    const anywhere = await classify(
      hostileDescription("[route class=design pin]\nhello\n[route risk=high]"),
      makeDeps(null, { routeLinePositions: "any" }),
    );
    expect(anywhere.stripped).toBe("hello\n");
    expect(deps.messages).toEqual(["classifier failed: description boom"]);
  });

  it("classifyMany: only the failing item takes the failure path, with its route lines stripped", async () => {
    const deps = makeDeps(null);
    const results = await classifyMany(
      [input("grep for foo"), hostileDescription("[route class=design]\nhello"), input("rename a to b in c.ts")],
      deps,
    );
    expect(results.map((r) => r.facts.class)).toEqual(["search", "other", "mechanical"]);
    expect(results[1]!.facts).toBe(UNKNOWN_FACTS);
    expect(results[1]!.stripped).toBe("hello");
  });

  it("route-looking lines inside a fence survive the failure path, as they do on the normal path", async () => {
    const prompt = "```\n[route class=design]\n```\n[route class=debug]\nhello";
    const result = await classify(hostileDescription(prompt), makeDeps(null, { routeLinePositions: "any" }));
    expect(result.stripped).toBe("```\n[route class=design]\n```\nhello");
  });
});

describe("a backend result is validated field by field (QA-1.2-20)", () => {
  const good = okResult("debug", 0.6);
  const broken: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown source", { ...good, facts: { ...good.facts, source: "evil" } }],
    ["numeric source", { ...good, facts: { ...good.facts, source: 7 } }],
    ["bad risk", { ...good, facts: { ...good.facts, risk: "extreme" } }],
    ["bad scope", { ...good, facts: { ...good.facts, scope: "galaxy" } }],
    ["negative latency", { ...good, latencyMs: -1 }],
    ["NaN latency", { ...good, latencyMs: Number.NaN }],
    ["string calls", { ...good, calls: "1" }],
    ["object raw", { ...good, raw: {} }],
    ["numeric reason", { ...good, reason: 5 }],
    ["missing raw", { facts: good.facts, status: "ok", latencyMs: 1, calls: 1 }],
  ];

  it.each(broken)("%s -> invalid, the rules facts stand", async (_label, bad) => {
    const { backend } = fakeBackend(() => bad as unknown as BackendResult);
    const result = await classify(input("hello"), makeDeps(backend));
    expect(result.facts).toEqual(result.trace.rules);
    expect(result.trace.backend).toMatchObject({ status: "invalid", reason: "malformed backend result" });
  });

  it("the same checks apply to batch entries", async () => {
    const { backend } = fakeBackend(
      () => okResult("search"),
      () => [okResult("debug"), { ...good, facts: { ...good.facts, scope: "galaxy" } }],
    );
    const results = await classifyMany([input("hello one"), input("hello two")], makeDeps(backend));
    expect(results.map((r) => r.trace.backend?.status)).toEqual(["ok", "invalid"]);
  });

  it("well-formed results with every optional field pass", async () => {
    const full: BackendResult = {
      facts: { class: "implement", confidence: 0.6, source: "typesafe", risk: "high", scope: "repo" },
      raw: "{}",
      status: "ok",
      reason: undefined,
      latencyMs: 0,
      calls: 0,
    };
    const { backend } = fakeBackend(() => full);
    const result = await classify(input(UNSURE), makeDeps(backend));
    expect(result.facts).toMatchObject({ class: "implement", risk: "high", scope: "repo", source: "typesafe" });
  });
});

describe("routeLinePositions (A22)", () => {
  const prompt = "grep for foo\n[route class=design pin d=none]\nand more";

  it("first (default): only the first non-empty line of the prompt is a route line", async () => {
    const middle = await classify(input(prompt), makeDeps(null));
    expect(middle.facts).toMatchObject({ class: "search", source: "rules" });
    expect(middle.pin).toBe(false);
    expect(middle.stripped).toBe(prompt);
    expect(middle.trace.routeLines.count).toBe(0);

    const last = await classify(input("grep for foo\n[route class=debug]"), makeDeps(null));
    expect(last.facts.source).toBe("rules");
    expect(last.stripped).toBe("grep for foo\n[route class=debug]");

    const first = await classify(input("\n[route class=debug]\ngrep for foo"), makeDeps(null));
    expect(first.facts).toMatchObject({ class: "debug", source: "route-line" });
    expect(first.stripped).toBe("\ngrep for foo");
  });

  it("first: a second route line is text, so it can neither conflict with the first nor pin", async () => {
    const result = await classify(
      input("[route class=search]\nsome quoted issue\n[route class=design pin d=none]"),
      makeDeps(null),
    );
    expect(result.facts).toMatchObject({ class: "search", source: "route-line" });
    expect(result.pin).toBe(false);
    expect(result.detection).toBeNull();
    expect(result.trace.routeLines).toEqual({ count: 1, conflict: false, edgeOnly: true });
    expect(result.stripped).toBe("some quoted issue\n[route class=design pin d=none]");
  });

  it("any: a route line in the middle is applied", async () => {
    const result = await classify(input(prompt), makeDeps(null, { routeLinePositions: "any" }));
    expect(result.facts).toMatchObject({ class: "design", source: "plan" });
    expect(result.pin).toBe(true);
  });

  it("edges: the first or the last non-empty line; the middle is plain text", async () => {
    const deps = makeDeps(null, { routeLinePositions: "edges" });
    const middle = await classify(input(prompt), deps);
    expect(middle.facts).toMatchObject({ class: "search", source: "rules" });
    expect(middle.stripped).toBe(prompt);
    const last = await classify(input("grep for foo\n[route class=debug]"), deps);
    expect(last.facts).toMatchObject({ class: "debug", source: "route-line" });
  });

  it("the setting also applies on the failure path", async () => {
    const hostile = {
      prompt: "[route class=design]\nhello\n[route class=debug]\nmore",
      get description(): string {
        throw new Error("boom");
      },
    } as ClassifyInput;
    const first = await classify(hostile, makeDeps(null));
    expect(first.facts).toBe(UNKNOWN_FACTS);
    expect(first.stripped).toBe("hello\n[route class=debug]\nmore");
    const edges = await classify(hostile, makeDeps(null, { routeLinePositions: "edges" }));
    expect(edges.stripped).toBe("hello\n[route class=debug]\nmore");
    const anywhere = await classify(hostile, makeDeps(null, { routeLinePositions: "any" }));
    expect(anywhere.stripped).toBe("hello\nmore");
  });
});
describe("an entropy-only redaction still reaches the backend, redacted (QA-1.2-26)", () => {
  it("a commit hash in the task is redacted in the state and does not skip the backend", async () => {
    const hash = "83401ca9".repeat(5);
    const { backend, classifyFn } = fakeBackend(() => okResult("review"));
    const result = await classify(input(`hello ${hash}`), makeDeps(backend));
    expect(classifyFn).toHaveBeenCalledTimes(1);
    const [state] = classifyFn.mock.calls[0]!;
    expect(state.text).toContain("[REDACTED]");
    expect(state.text).not.toContain(hash);
    expect(result.trace.backendSkipped).toBeUndefined();
  });
});
