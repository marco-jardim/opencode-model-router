import { describe, expect, test } from "vitest";
import {
  DEFAULT_EFFORT,
  DEFAULT_STATUS_OPTIONS,
  ELLIPSIS,
  FALLBACK_AGENT,
  STATUS_NOTICE_PREFIX,
  STATUS_OPTION_KEYS,
  UNKNOWN_MODEL,
  childStatus,
  displayWidth,
  effectiveMainEffort,
  effortLabel,
  formatRow,
  latestAssistant,
  modelLabel,
  parseOptions,
  runningChildren,
  truncate,
  type AppliedEffort,
  type MessageLike,
  type ModelInfo,
  type ModelRef,
  type RunningChildrenInput,
  type SessionLike,
  type SessionStatus,
} from "../../src/tui/status-model";

const MODELS: ModelInfo[] = [
  { id: "claude-fable-5", providerID: "anthropic", name: "Claude Fable 5", variants: ["low", "high"] },
  { id: "gpt-5", providerID: "openai", name: "GPT-5", variants: ["minimal", "high"] },
  { id: "gpt-5", providerID: "azure", name: "GPT-5" },
  { id: "local-7b", providerID: "ollama" },
];

function ref(providerID: string, id: string, variant?: string): ModelRef {
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

function assistant(id: string, model: ModelRef | undefined, created?: number, agent?: string): MessageLike {
  const message: MessageLike = { id, role: "assistant" };
  if (model !== undefined) message.model = model;
  if (created !== undefined) message.time = { created };
  if (agent !== undefined) message.agent = agent;
  return message;
}

function applied(providerID: string, modelID: string, effort: string): AppliedEffort {
  return { providerID, modelID, effort };
}

const GRIN = "\u{1F600}";
const THUMBS_MEDIUM = "\u{1F44D}\u{1F3FD}";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
const FLAG_BR = "\u{1F1E7}\u{1F1F7}";
const FLAG_SCOTLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
const KEYCAP_ONE = "1\uFE0F\u20E3";
const HEART_EMOJI = "\u2764\uFE0F";

/** True when the string holds a high or low surrogate without its pair. */
function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

describe("modelLabel", () => {
  test("uses the display name of the entry with the same provider and id", () => {
    expect(modelLabel(ref("anthropic", "claude-fable-5"), MODELS)).toBe("Claude Fable 5");
  });

  test("falls back to the raw id for an unknown model id", () => {
    expect(modelLabel(ref("anthropic", "claude-unknown-9"), MODELS)).toBe("claude-unknown-9");
    expect(modelLabel(ref("mistral", "gpt-x"), [])).toBe("gpt-x");
  });

  test("falls back to the id when the entry has no name or a blank one", () => {
    expect(modelLabel(ref("ollama", "local-7b"), MODELS)).toBe("local-7b");
    expect(modelLabel(ref("p", "m"), [{ providerID: "p", id: "m", name: "  " }])).toBe("m");
  });

  test("matches provider and id together, not the id alone", () => {
    const models: ModelInfo[] = [{ providerID: "a", id: "m", name: "Model A" }];
    expect(modelLabel(ref("b", "m"), models)).toBe("m");
  });

  test("undefined ref or blank id → undefined", () => {
    expect(modelLabel(undefined, MODELS)).toBeUndefined();
    expect(modelLabel(ref("anthropic", ""), MODELS)).toBeUndefined();
    expect(modelLabel(ref("anthropic", "   "), MODELS)).toBeUndefined();
  });

  test("appends the provider when another provider's entry shares the display name", () => {
    expect(modelLabel(ref("openai", "gpt-5"), MODELS)).toBe("GPT-5 (openai)");
    expect(modelLabel(ref("azure", "gpt-5"), MODELS)).toBe("GPT-5 (azure)");
  });

  test("appends the provider when unnamed entries of different providers share the id", () => {
    const models: ModelInfo[] = [
      { providerID: "openrouter", id: "qwen3" },
      { providerID: "ollama", id: "qwen3" },
    ];
    expect(modelLabel(ref("ollama", "qwen3"), models)).toBe("qwen3 (ollama)");
  });

  test("appends the provider for an unknown ref whose id equals another provider's display name", () => {
    expect(modelLabel(ref("custom", "GPT-5"), MODELS)).toBe("GPT-5 (custom)");
  });

  test("same name twice within one provider gets no suffix", () => {
    const models: ModelInfo[] = [
      { providerID: "p", id: "m1", name: "Same" },
      { providerID: "p", id: "m2", name: "Same" },
    ];
    expect(modelLabel(ref("p", "m1"), models)).toBe("Same");
  });

  test("a blank providerID gets no empty suffix", () => {
    const models: ModelInfo[] = [
      { providerID: "", id: "m", name: "Shared" },
      { providerID: "q", id: "n", name: "Shared" },
    ];
    expect(modelLabel(ref("", "m"), models)).toBe("Shared");
  });
});

describe("effortLabel", () => {
  test("shows the variant", () => {
    expect(effortLabel(ref("openai", "gpt-5", "high"))).toBe("high");
  });

  test("missing variant → default", () => {
    expect(effortLabel(ref("openai", "gpt-5"))).toBe(DEFAULT_EFFORT);
    expect(effortLabel(undefined)).toBe("default");
  });

  test("variant 'default', empty or blank → default", () => {
    expect(effortLabel(ref("openai", "gpt-5", "default"))).toBe("default");
    expect(effortLabel(ref("openai", "gpt-5", ""))).toBe("default");
    expect(effortLabel(ref("openai", "gpt-5", "  "))).toBe("default");
  });

  test("the effective effort wins over the variant", () => {
    expect(effortLabel(ref("openai", "gpt-5", "low"), "xhigh")).toBe("xhigh");
    expect(effortLabel(undefined, "max")).toBe("max");
  });

  test("an empty or 'default' effective effort falls back to the variant", () => {
    expect(effortLabel(ref("openai", "gpt-5", "low"), "")).toBe("low");
    expect(effortLabel(ref("openai", "gpt-5", "low"), "default")).toBe("low");
    expect(effortLabel(ref("openai", "gpt-5"), "default")).toBe("default");
  });

  test("values are trimmed", () => {
    expect(effortLabel(ref("openai", "gpt-5", " high "))).toBe("high");
    expect(effortLabel(undefined, " default ")).toBe("default");
  });

  test("a variant that is not in the model's variants list is shown as recorded", () => {
    expect(effortLabel(ref("anthropic", "claude-fable-5", "ultra"))).toBe("ultra");
  });
});

describe("effectiveMainEffort (G1, A3)", () => {
  const current = { providerID: "openai", modelID: "gpt-5" };

  test("a selected variant → undefined (the host row shows it)", () => {
    expect(effectiveMainEffort({ selectedVariant: "high" })).toBeUndefined();
    expect(effectiveMainEffort({ selectedVariant: "high", applied: applied("openai", "gpt-5", "max"), current })).toBeUndefined();
    expect(effectiveMainEffort({ selectedVariant: "default" })).toBeUndefined();
  });

  test("an empty selected variant counts as none", () => {
    expect(effectiveMainEffort({ selectedVariant: "" })).toBe("default");
    expect(effectiveMainEffort({ selectedVariant: "", applied: applied("openai", "gpt-5", "high"), current })).toBe("high");
  });

  test("the applied effort when it was recorded for the current model", () => {
    expect(effectiveMainEffort({ applied: applied("openai", "gpt-5", "medium"), current })).toBe("medium");
  });

  test("the applied effort of another model → default", () => {
    expect(effectiveMainEffort({ applied: applied("openai", "gpt-4", "medium"), current })).toBe("default");
    expect(effectiveMainEffort({ applied: applied("azure", "gpt-5", "medium"), current })).toBe("default");
  });

  test("no applied effort or no current model → default", () => {
    expect(effectiveMainEffort({})).toBe("default");
    expect(effectiveMainEffort({ current })).toBe("default");
    expect(effectiveMainEffort({ applied: applied("openai", "gpt-5", "high") })).toBe("default");
  });

  test("an empty or 'default' applied effort → default", () => {
    expect(effectiveMainEffort({ applied: applied("openai", "gpt-5", ""), current })).toBe("default");
    expect(effectiveMainEffort({ applied: applied("openai", "gpt-5", "default"), current })).toBe("default");
  });
});

describe("latestAssistant", () => {
  test("no messages → undefined", () => {
    expect(latestAssistant([])).toBeUndefined();
  });

  test("picks the latest by time.created, not by array position", () => {
    const newer = assistant("m2", ref("openai", "gpt-5"), 200);
    const older = assistant("m1", ref("openai", "gpt-5"), 100);
    expect(latestAssistant([newer, older])).toBe(newer);
  });

  test("equal times → the later array entry wins", () => {
    const first = assistant("m1", ref("openai", "gpt-5"), 100);
    const second = assistant("m2", ref("openai", "gpt-5"), 100);
    expect(latestAssistant([first, second])).toBe(second);
  });

  test("skips user messages and assistant messages without a usable model", () => {
    const withModel = assistant("m1", ref("openai", "gpt-5"), 100);
    const messages: MessageLike[] = [
      withModel,
      { id: "u1", role: "user", model: ref("openai", "gpt-5"), time: { created: 300 } },
      assistant("m2", undefined, 400),
      assistant("m3", ref("openai", ""), 500),
    ];
    expect(latestAssistant(messages)).toBe(withModel);
    expect(latestAssistant([messages[1], messages[2]])).toBeUndefined();
  });

  test("a missing or non-finite time sorts as the oldest", () => {
    const timed = assistant("m1", ref("openai", "gpt-5"), 100);
    const untimed = assistant("m2", ref("openai", "gpt-5"));
    const nan = assistant("m3", ref("openai", "gpt-5"), Number.NaN);
    expect(latestAssistant([timed, untimed, nan])).toBe(timed);
    expect(latestAssistant([untimed, nan])).toBe(nan);
  });
});

describe("childStatus (G2, A5)", () => {
  const session: SessionLike = { id: "child", parentID: "root", model: ref("openai", "gpt-5", "low") };

  test("a child without messages yet falls back to session.model", () => {
    expect(childStatus({ session, messages: [], models: MODELS })).toEqual({ model: "GPT-5 (openai)", effort: "low" });
  });

  test("model switch mid-session: the latest assistant message wins", () => {
    const messages = [
      assistant("m1", ref("openai", "gpt-5", "high"), 100),
      assistant("m2", ref("anthropic", "claude-fable-5"), 200),
    ];
    expect(childStatus({ session, messages, models: MODELS })).toEqual({ model: "Claude Fable 5", effort: "default" });
  });

  test("no ref anywhere → undefined", () => {
    expect(childStatus({ session: { id: "child", parentID: "root" }, messages: [], models: MODELS })).toBeUndefined();
    expect(
      childStatus({ session: { id: "child", model: ref("openai", "") }, messages: [assistant("m1", undefined, 1)], models: MODELS }),
    ).toBeUndefined();
  });

  test("an applied effort recorded for the ref's model wins over the variant", () => {
    const status = childStatus({ session, messages: [], models: MODELS, applied: applied("openai", "gpt-5", "xhigh") });
    expect(status).toEqual({ model: "GPT-5 (openai)", effort: "xhigh" });
  });

  test("an applied effort of another model is ignored", () => {
    expect(childStatus({ session, messages: [], models: MODELS, applied: applied("azure", "gpt-5", "xhigh") })?.effort).toBe("low");
    expect(childStatus({ session, messages: [], models: MODELS, applied: applied("openai", "gpt-4", "xhigh") })?.effort).toBe("low");
  });

  test("an empty applied effort falls back to the variant", () => {
    expect(childStatus({ session, messages: [], models: MODELS, applied: applied("openai", "gpt-5", "") })?.effort).toBe("low");
  });

  test("a variant 'default' or a missing variant shows default", () => {
    const messages = [assistant("m1", ref("openai", "gpt-5", "default"), 1)];
    expect(childStatus({ session, messages, models: MODELS })?.effort).toBe("default");
    expect(childStatus({ session: { id: "c", model: ref("ollama", "local-7b") }, messages: [], models: MODELS })).toEqual({
      model: "local-7b",
      effort: "default",
    });
  });

  test("a variant missing from the model's variants list is shown as recorded", () => {
    const messages = [assistant("m1", ref("anthropic", "claude-fable-5", "turbo"), 1)];
    expect(childStatus({ session, messages, models: MODELS })?.effort).toBe("turbo");
  });

  test("agent: session.agent first, then the latest assistant message's agent", () => {
    const messages = [assistant("m1", ref("openai", "gpt-5"), 1, "explorer")];
    expect(childStatus({ session: { ...session, agent: "implementer" }, messages, models: MODELS })?.agent).toBe("implementer");
    expect(childStatus({ session: { ...session, agent: " " }, messages, models: MODELS })?.agent).toBe("explorer");
  });

  test("no agent known → no agent key", () => {
    const status = childStatus({ session, messages: [], models: MODELS });
    expect(status).toBeDefined();
    expect(status !== undefined && "agent" in status).toBe(false);
  });
});

interface FakeChild {
  id: string;
  status?: SessionStatus;
  session?: SessionLike;
  messages?: MessageLike[];
  applied?: AppliedEffort;
}

function fakeHost(children: FakeChild[], extra: Partial<RunningChildrenInput> = {}): RunningChildrenInput & { messageCalls: string[] } {
  const byID = new Map(children.map((c) => [c.id, c]));
  const messageCalls: string[] = [];
  return {
    rootID: "root",
    family: ["root", ...children.map((c) => c.id)],
    status: (id) => byID.get(id)?.status ?? "idle",
    sessions: (id) => byID.get(id)?.session,
    messages: (id) => {
      messageCalls.push(id);
      return byID.get(id)?.messages ?? [];
    },
    models: MODELS,
    applied: (id) => byID.get(id)?.applied,
    max: 4,
    messageCalls,
    ...extra,
  };
}

function child(id: string, created: number | undefined, more: Partial<SessionLike> = {}): SessionLike {
  const session: SessionLike = { id, parentID: "root", agent: `agent-${id}`, model: ref("openai", "gpt-5", "high"), ...more };
  if (created !== undefined) session.time = { created };
  return session;
}

describe("runningChildren (G3)", () => {
  test("empty family or root only → no rows", () => {
    expect(runningChildren(fakeHost([], { family: [] }))).toEqual({ rows: [], overflow: 0 });
    expect(runningChildren(fakeHost([]))).toEqual({ rows: [], overflow: 0 });
  });

  test("mixed idle/running: keeps running children only, never the root", () => {
    const host = fakeHost([
      { id: "a", status: "running", session: child("a", 10) },
      { id: "b", status: "idle", session: child("b", 20) },
      { id: "c", status: "running", session: child("c", 30) },
    ]);
    host.status = (id) => (id === "b" ? "idle" : "running");
    const result = runningChildren(host);
    expect(result.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(result.overflow).toBe(0);
  });

  test("skips ids without a session or without a parentID", () => {
    const host = fakeHost([
      { id: "gone", status: "running" },
      { id: "orphan", status: "running", session: child("orphan", 1, { parentID: undefined }) },
      { id: "blank", status: "running", session: child("blank", 2, { parentID: " " }) },
      { id: "ok", status: "running", session: child("ok", 3) },
    ]);
    expect(runningChildren(host).rows.map((r) => r.id)).toEqual(["ok"]);
  });

  test("a row carries agent, model label and effort", () => {
    const host = fakeHost([
      {
        id: "a",
        status: "running",
        session: child("a", 1, { agent: "implementer" }),
        messages: [assistant("m1", ref("anthropic", "claude-fable-5", "high"), 5)],
      },
    ]);
    expect(runningChildren(host).rows).toEqual([{ id: "a", agent: "implementer", model: "Claude Fable 5", effort: "high" }]);
  });

  test("a child without messages yet uses session.model", () => {
    const host = fakeHost([{ id: "a", status: "running", session: child("a", 1, { model: ref("ollama", "local-7b", "low") }) }]);
    expect(runningChildren(host).rows[0]).toMatchObject({ model: "local-7b", effort: "low" });
  });

  test("a running child without any model ref → model 'unknown', effort 'default'", () => {
    const host = fakeHost([
      { id: "a", status: "running", session: { id: "a", parentID: "root", agent: "explorer", time: { created: 1 } } },
      { id: "b", status: "running", session: { id: "b", parentID: "root", title: "Find the bug", time: { created: 2 } } },
      { id: "c", status: "running", session: { id: "c", parentID: "root", title: "  ", time: { created: 3 } } },
    ]);
    expect(runningChildren(host).rows).toEqual([
      { id: "a", agent: "explorer", model: UNKNOWN_MODEL, effort: DEFAULT_EFFORT },
      { id: "b", agent: "Find the bug", model: "unknown", effort: "default" },
      { id: "c", agent: FALLBACK_AGENT, model: "unknown", effort: "default" },
    ]);
  });

  test("agent falls back to the latest assistant agent, then the title, then 'subagent'", () => {
    const host = fakeHost([
      {
        id: "a",
        status: "running",
        session: child("a", 1, { agent: undefined }),
        messages: [assistant("m1", ref("openai", "gpt-5"), 1, "reviewer")],
      },
      { id: "b", status: "running", session: child("b", 2, { agent: undefined, title: "Title B" }) },
      { id: "c", status: "running", session: child("c", 3, { agent: undefined }) },
    ]);
    expect(runningChildren(host).rows.map((r) => r.agent)).toEqual(["reviewer", "Title B", "subagent"]);
  });

  test("applied effort per child: matching model wins, other model ignored", () => {
    const host = fakeHost([
      { id: "a", status: "running", session: child("a", 1), applied: applied("openai", "gpt-5", "max") },
      { id: "b", status: "running", session: child("b", 2), applied: applied("anthropic", "claude-fable-5", "max") },
    ]);
    expect(runningChildren(host).rows.map((r) => r.effort)).toEqual(["max", "high"]);
  });

  test("works without an applied channel", () => {
    const host = fakeHost([{ id: "a", status: "running", session: child("a", 1) }]);
    delete host.applied;
    expect(runningChildren(host).rows[0]?.effort).toBe("high");
  });

  test("order: created ascending, then id; equal timestamps are deterministic", () => {
    const children: FakeChild[] = [
      { id: "z", status: "running", session: child("z", 50) },
      { id: "m", status: "running", session: child("m", 50) },
      { id: "b", status: "running", session: child("b", 70) },
      { id: "a", status: "running", session: child("a", 10) },
      { id: "q", status: "running", session: child("q", 50) },
    ];
    const expected = ["a", "m", "q", "z", "b"];
    const forward = runningChildren(fakeHost(children, { max: 10 }));
    const backward = runningChildren(fakeHost([...children].reverse(), { max: 10 }));
    expect(forward.rows.map((r) => r.id)).toEqual(expected);
    expect(backward.rows.map((r) => r.id)).toEqual(expected);
  });

  test("a missing creation time sorts first", () => {
    const host = fakeHost([
      { id: "timed", status: "running", session: child("timed", 5) },
      { id: "untimed", status: "running", session: child("untimed", undefined) },
    ]);
    expect(runningChildren(host).rows.map((r) => r.id)).toEqual(["untimed", "timed"]);
  });

  test("a duplicate id in the family counts once", () => {
    const host = fakeHost([{ id: "a", status: "running", session: child("a", 1) }], { family: ["root", "a", "a", "root"] });
    expect(runningChildren(host)).toMatchObject({ rows: [{ id: "a" }], overflow: 0 });
  });

  test("huge family: at most max rows, overflow counts the rest, only shown rows read messages", () => {
    const children: FakeChild[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `ses_${String(i).padStart(4, "0")}`;
      children.push({ id, status: i % 2 === 0 ? "running" : "idle", session: child(id, 1000 - i) });
    }
    const host = fakeHost(children);
    const result = runningChildren(host);
    expect(result.rows).toHaveLength(4);
    expect(result.overflow).toBe(496);
    expect(result.rows.map((r) => r.id)).toEqual(["ses_0998", "ses_0996", "ses_0994", "ses_0992"]);
    expect(host.messageCalls).toEqual(["ses_0998", "ses_0996", "ses_0994", "ses_0992"]);
  });

  test("max is clamped to at least 1 and floored; NaN → 1; Infinity → all", () => {
    const children: FakeChild[] = ["a", "b", "c"].map((id, i) => ({ id, status: "running", session: child(id, i) }));
    const count = (max: number) => runningChildren(fakeHost(children, { max }));
    expect(count(0)).toMatchObject({ overflow: 2 });
    expect(count(0).rows).toHaveLength(1);
    expect(count(-5).rows).toHaveLength(1);
    expect(count(2.9).rows).toHaveLength(2);
    expect(count(Number.NaN).rows).toHaveLength(1);
    expect(count(Number.POSITIVE_INFINITY)).toMatchObject({ overflow: 0 });
    expect(count(Number.POSITIVE_INFINITY).rows).toHaveLength(3);
  });

  test("duplicate model names across providers keep their suffix in rows", () => {
    const host = fakeHost([
      { id: "a", status: "running", session: child("a", 1, { model: ref("azure", "gpt-5") }) },
      { id: "b", status: "running", session: child("b", 2, { model: ref("openai", "gpt-5") }) },
    ]);
    expect(runningChildren(host).rows.map((r) => r.model)).toEqual(["GPT-5 (azure)", "GPT-5 (openai)"]);
  });
});

describe("displayWidth", () => {
  test("ASCII and empty", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("model-router")).toBe(12);
  });

  test("CJK, Hangul and fullwidth count 2; halfwidth katakana 1", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("한국어")).toBe(6);
    expect(displayWidth("ＡＢ")).toBe(4);
    expect(displayWidth("\u3000")).toBe(2);
    expect(displayWidth("ｱｲ")).toBe(2);
    expect(displayWidth("𠀀")).toBe(2);
    expect(displayWidth("a日b")).toBe(4);
  });

  test("emoji count 2, including modifiers, ZWJ sequences, flags and keycaps", () => {
    expect(displayWidth(GRIN)).toBe(2);
    expect(displayWidth(THUMBS_MEDIUM)).toBe(2);
    expect(displayWidth(FAMILY)).toBe(2);
    expect(displayWidth(FLAG_BR)).toBe(2);
    expect(displayWidth(FLAG_SCOTLAND)).toBe(2);
    expect(displayWidth(KEYCAP_ONE)).toBe(2);
    expect(displayWidth(HEART_EMOJI)).toBe(2);
    expect(displayWidth(`${GRIN}\uFE0F`)).toBe(2);
    expect(displayWidth(`${FLAG_BR}\u{1F1E6}`)).toBe(4);
  });

  test("text-presentation symbols stay 1", () => {
    expect(displayWidth("\u2764")).toBe(1);
    expect(displayWidth("\u00A9")).toBe(1);
    expect(displayWidth("\u{1F1E7}a")).toBe(3);
  });

  test("combining marks count 0", () => {
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("a\u0300\u0301\u0302")).toBe(1);
    expect(displayWidth("\u0301")).toBe(0);
    expect(displayWidth("か\u3099")).toBe(2);
  });

  test("control and format characters count 0", () => {
    expect(displayWidth("a\tb\n")).toBe(2);
    expect(displayWidth("\u001b[31m")).toBe(4);
    expect(displayWidth("\u007f\u0085")).toBe(0);
    expect(displayWidth("a\u200bb")).toBe(2);
    expect(displayWidth("\u200d")).toBe(0);
    expect(displayWidth("\n\u0301")).toBe(0);
  });

  test("a lone surrogate counts 1", () => {
    expect(displayWidth("\ud800")).toBe(1);
  });
});

describe("truncate", () => {
  test("width ≤ 0 or NaN → empty", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -3)).toBe("");
    expect(truncate("abc", Number.NaN)).toBe("");
    expect(truncate("abc", 0.5)).toBe("");
  });

  test("text that fits is returned unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("日本", 4)).toBe("日本");
    expect(truncate("", 5)).toBe("");
    expect(truncate("abc", Number.POSITIVE_INFINITY)).toBe("abc");
  });

  test("a cut appends the ellipsis within the width", () => {
    expect(truncate("abcdef", 4)).toBe(`abc${ELLIPSIS}`);
    expect(truncate("abcdef", 1)).toBe("…");
    expect(truncate("abcdef", 4.9)).toBe("abc…");
  });

  test("wide characters are never half-cut", () => {
    expect(truncate("日本語テキスト", 5)).toBe("日本…");
    expect(truncate("日本語", 4)).toBe("日…");
    expect(displayWidth(truncate("日本語", 4))).toBe(3);
    expect(truncate("日本語", 2)).toBe("…");
  });

  test("never splits a surrogate pair, a ZWJ sequence or a flag", () => {
    const emoji = truncate(GRIN.repeat(3), 4);
    expect(emoji).toBe(`${GRIN}…`);
    expect(hasLoneSurrogate(emoji)).toBe(false);
    expect(truncate(FAMILY.repeat(2), 3)).toBe(`${FAMILY}…`);
    expect(truncate(`${FLAG_BR}\u{1F1F5}\u{1F1F9}`, 3)).toBe(`${FLAG_BR}…`);
    expect(truncate(`a${THUMBS_MEDIUM}`, 3)).toBe(`a${THUMBS_MEDIUM}`);
    expect(truncate(`a${THUMBS_MEDIUM}b`, 3)).toBe("a…");
  });

  test("keeps combining marks with their base", () => {
    expect(truncate("e\u0301e\u0301e\u0301e\u0301", 3)).toBe("e\u0301e\u0301…");
  });

  test("zero-width characters are kept while they fit and dropped after the cut", () => {
    expect(truncate("ab\u200bcd", 3)).toBe("ab\u200b…");
    expect(truncate("a日\u200bb", 2)).toBe("a…");
  });

  test("never exceeds the width and never leaves a lone surrogate", () => {
    const samples = [
      "model-router",
      "日本語のモデル名",
      `${GRIN}a${GRIN}b${GRIN}c`,
      `e\u0301日${GRIN}${FLAG_BR}x`,
      THUMBS_MEDIUM.repeat(3),
      `${FAMILY}${FLAG_SCOTLAND}${KEYCAP_ONE}${HEART_EMOJI}`,
      "a\u0301\u0302b",
    ];
    for (const sample of samples) {
      for (let width = 1; width <= displayWidth(sample) + 1; width++) {
        const out = truncate(sample, width);
        expect(displayWidth(out)).toBeLessThanOrEqual(width);
        expect(hasLoneSurrogate(out)).toBe(false);
      }
    }
  });

  test("very long names are cut to exactly the width", () => {
    const long = "x".repeat(10_000);
    const out = truncate(long, 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith("…")).toBe(true);
    expect(displayWidth(truncate("語".repeat(5000), 41))).toBe(41);
  });
});

describe("formatRow", () => {
  test("joins non-blank parts with ' · '", () => {
    expect(formatRow(["implementer", "GPT-5", "high"], 80)).toBe("implementer · GPT-5 · high");
    expect(formatRow(["", "GPT-5", "  ", "high"], 80)).toBe("GPT-5 · high");
  });

  test("truncates to the width", () => {
    expect(formatRow(["implementer", "Claude Fable 5", "high"], 20)).toBe("implementer · Claud…");
    expect(displayWidth(formatRow(["探索者", "モデル", "高"], 9))).toBeLessThanOrEqual(9);
  });

  test("no parts or width 0 → empty", () => {
    expect(formatRow([], 10)).toBe("");
    expect(formatRow(["", " "], 10)).toBe("");
    expect(formatRow(["a", "b"], 0)).toBe("");
  });
});

describe("parseOptions (D7)", () => {
  test("undefined or null → defaults, no notice", () => {
    expect(parseOptions(undefined)).toEqual({ options: DEFAULT_STATUS_OPTIONS, notices: [] });
    expect(parseOptions(null)).toEqual({ options: DEFAULT_STATUS_OPTIONS, notices: [] });
    expect(DEFAULT_STATUS_OPTIONS).toEqual({ enabled: true, footer: true, childView: true, runningRow: true, maxRows: 4 });
  });

  test("an empty object → defaults, no notice", () => {
    expect(parseOptions({})).toEqual({ options: { ...DEFAULT_STATUS_OPTIONS }, notices: [] });
  });

  test("valid values are applied", () => {
    const raw = { enabled: false, footer: false, childView: false, runningRow: false, maxRows: 20 };
    expect(parseOptions(raw)).toEqual({ options: raw, notices: [] });
    expect(parseOptions({ maxRows: 1 }).options.maxRows).toBe(1);
  });

  test.each([["string"], [3], [true], [[]], [[{ enabled: false }]], [() => ({})]])(
    "a non-object (%j) → defaults and one notice",
    (raw) => {
      const parsed = parseOptions(raw);
      expect(parsed.options).toEqual(DEFAULT_STATUS_OPTIONS);
      expect(parsed.notices).toEqual(["model-router status: options must be an object; using the defaults."]);
    },
  );

  test.each(["enabled", "footer", "childView", "runningRow"] as const)("a non-boolean %s → default and a notice", (key) => {
    for (const bad of ["yes", 1, 0, null, {}, "false"]) {
      const parsed = parseOptions({ [key]: bad });
      expect(parsed.options[key]).toBe(true);
      expect(parsed.notices).toEqual([`model-router status: option "${key}" must be true or false; using true.`]);
    }
  });

  test.each([[0], [21], [-1], [2.5], ["4"], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [true]])(
    "maxRows %j → default 4 and a notice",
    (bad) => {
      const parsed = parseOptions({ maxRows: bad });
      expect(parsed.options.maxRows).toBe(4);
      expect(parsed.notices).toEqual(['model-router status: option "maxRows" must be an integer from 1 to 20; using 4.']);
    },
  );

  test("unknown keys → one notice listing them; known keys still apply", () => {
    const parsed = parseOptions({ footer: false, colour: "red", max_rows: 3, "": 1 });
    expect(parsed.options).toEqual({ ...DEFAULT_STATUS_OPTIONS, footer: false });
    expect(parsed.notices).toEqual(['model-router status: unknown options ignored: "colour", "max_rows", "".']);
  });

  test("several problems → one notice each, flags first, then maxRows, then unknown keys", () => {
    const parsed = parseOptions({ extra: 1, maxRows: 99, runningRow: "no", enabled: 0, childView: false });
    expect(parsed.options).toEqual({ ...DEFAULT_STATUS_OPTIONS, childView: false });
    expect(parsed.notices).toHaveLength(4);
    expect(parsed.notices[0]).toContain('"enabled"');
    expect(parsed.notices[1]).toContain('"runningRow"');
    expect(parsed.notices[2]).toContain('"maxRows"');
    expect(parsed.notices[3]).toContain('"extra"');
    for (const text of parsed.notices) expect(text.startsWith(STATUS_NOTICE_PREFIX)).toBe(true);
  });

  test("explicit undefined values count as absent", () => {
    expect(parseOptions({ footer: undefined, maxRows: undefined })).toEqual({ options: { ...DEFAULT_STATUS_OPTIONS }, notices: [] });
  });

  test("the result is a fresh object, the defaults stay frozen", () => {
    const parsed = parseOptions(undefined);
    parsed.options.maxRows = 9;
    expect(DEFAULT_STATUS_OPTIONS.maxRows).toBe(4);
    expect(Object.isFrozen(DEFAULT_STATUS_OPTIONS)).toBe(true);
  });

  test("the option keys match the parsed shape", () => {
    expect([...STATUS_OPTION_KEYS].sort()).toEqual(Object.keys(parseOptions(undefined).options).sort());
  });
});
