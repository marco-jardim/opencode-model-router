import { describe, expect, it, vi } from "vitest";
import {
  PLAN_PROVIDER_NAME,
  TURN_STATE_MAX_CHARS,
  TURN_STATE_ROOT,
  createTurnStateRegistry,
  placeTurnState,
  routerCacheHint,
  type TurnStateProvider,
} from "../../src/compat/turn-state";

const WRAPPER = "<router-state>\n".length + "\n</router-state>".length;

function setup(translate?: (text: string) => string) {
  const warn = vi.fn();
  const registry = createTurnStateRegistry({ logger: { warn }, ...(translate ? { translate } : {}) });
  return { registry, warn };
}

function provider(name: string, order: number, text: string | undefined, active?: () => boolean): TurnStateProvider {
  return { name, order, render: () => text, ...(active ? { active } : {}) };
}

describe("constants", () => {
  it("exposes the bound, the plan name and a unique root symbol", () => {
    expect(TURN_STATE_MAX_CHARS).toBe(6000);
    expect(PLAN_PROVIDER_NAME).toBe("plan");
    expect(typeof TURN_STATE_ROOT).toBe("symbol");
    expect(TURN_STATE_ROOT.description).toBe("router.turnState.root");
    expect(Symbol.keyFor(TURN_STATE_ROOT)).toBeUndefined();
  });

  it("creates a fresh parameterless ephemeral hint without a TTL", () => {
    const a = routerCacheHint();
    const b = routerCacheHint();
    expect(a).toEqual({ type: "ephemeral" });
    expect(a).not.toBe(b);
    expect(Object.keys(a)).toEqual(["type"]);
  });
});

describe("registration", () => {
  it("orders sections by (order, name) with a name tie-break", () => {
    const { registry } = setup();
    registry.registerTurnStateProvider(provider("zeta", 5, "Z5"));
    registry.registerTurnStateProvider(provider("beta", 20, "B20"));
    registry.registerTurnStateProvider(provider("alpha", 5, "A5"));
    registry.registerTurnStateProvider(provider("first", 1, "F1"));
    expect(registry.buildTurnState("s")).toBe("<router-state>\nF1\n\nA5\n\nZ5\n\nB20\n</router-state>");
  });

  it("is deterministic for equal provider outputs, whatever the registration order", () => {
    const one = setup();
    const two = setup();
    for (const p of [provider("a", 1, "x"), provider("b", 1, "y"), provider("c", 0, "z")]) one.registry.registerTurnStateProvider(p);
    for (const p of [provider("c", 0, "z"), provider("b", 1, "y"), provider("a", 1, "x")]) two.registry.registerTurnStateProvider(p);
    expect(one.registry.buildTurnState("s")).toBe(two.registry.buildTurnState("s"));
    expect(one.registry.buildTurnState("s")).toBe(one.registry.buildTurnState("s"));
  });

  it("rejects duplicate names", () => {
    const { registry } = setup();
    registry.registerTurnStateProvider(provider("a", 1, "x"));
    expect(() => registry.registerTurnStateProvider(provider("a", 2, "y"))).toThrow(/already registered/);
    expect(registry.buildTurnState("s")).toContain("x");
    expect(registry.buildTurnState("s")).not.toContain("y");
  });

  it("rejects an invalid name or order", () => {
    const { registry } = setup();
    const bad: unknown[] = [
      provider("", 1, "x"),
      provider("a", Number.NaN, "x"),
      provider("a", Number.POSITIVE_INFINITY, "x"),
      { name: 5, order: 1, render: () => "x" },
      { name: "a", order: "1", render: () => "x" },
      null,
      undefined,
    ];
    for (const value of bad) expect(() => registry.registerTurnStateProvider(value as TurnStateProvider)).toThrow();
    expect(registry.buildTurnState("s")).toBeUndefined();
    // A rejected registration leaves the name free.
    expect(() => registry.registerTurnStateProvider(provider("a", 1, "x"))).not.toThrow();
  });

  it("unregisters, idempotently", () => {
    const { registry } = setup();
    const off = registry.registerTurnStateProvider(provider("a", 1, "x"));
    registry.registerTurnStateProvider(provider("b", 2, "y"));
    off();
    off();
    expect(registry.buildTurnState("s")).toBe("<router-state>\ny\n</router-state>");
  });

  it("ignores a stale unregister after the name was registered again", () => {
    const { registry } = setup();
    const first = provider("a", 1, "old");
    const off = registry.registerTurnStateProvider(first);
    off();
    registry.registerTurnStateProvider(provider("a", 1, "new"));
    off();
    expect(registry.buildTurnState("s")).toBe("<router-state>\nnew\n</router-state>");
    // The same provider object registered again is a new registration too.
    const second = setup();
    const offOne = second.registry.registerTurnStateProvider(first);
    offOne();
    const offTwo = second.registry.registerTurnStateProvider(first);
    offOne();
    expect(second.registry.buildTurnState("s")).toBe("<router-state>\nold\n</router-state>");
    offTwo();
    expect(second.registry.buildTurnState("s")).toBeUndefined();
  });
});

describe("buildTurnState", () => {
  it("returns undefined without providers and without state", () => {
    const { registry } = setup();
    expect(registry.buildTurnState("s")).toBeUndefined();
    registry.registerTurnStateProvider(provider("a", 1, undefined));
    registry.registerTurnStateProvider(provider("b", 2, ""));
    registry.registerTurnStateProvider(provider("c", 3, " \n\t "));
    registry.registerTurnStateProvider({ name: "d", order: 4, render: () => 42 as unknown as string });
    expect(registry.buildTurnState("s")).toBeUndefined();
  });

  it("passes the session id and trims each section", () => {
    const { registry } = setup();
    const render = vi.fn((sid: string) => `\n  in ${sid}  \n`);
    registry.registerTurnStateProvider({ name: "a", order: 1, render });
    expect(registry.buildTurnState("ses_1")).toBe("<router-state>\nin ses_1\n</router-state>");
    expect(render).toHaveBeenCalledWith("ses_1");
  });

  it("returns exactly 6000 characters unchanged, wrapper included", () => {
    const { registry } = setup();
    registry.registerTurnStateProvider(provider("a", 1, "x".repeat(TURN_STATE_MAX_CHARS - WRAPPER)));
    const out = registry.buildTurnState("s")!;
    expect(out.length).toBe(6000);
    expect(out).toBe(`<router-state>\n${"x".repeat(TURN_STATE_MAX_CHARS - WRAPPER)}\n</router-state>`);
  });

  it("overflows at 6001 characters with a line-granular overflow line", () => {
    const { registry } = setup();
    const first = "a".repeat(5000);
    const second = "b".repeat(TURN_STATE_MAX_CHARS - WRAPPER - first.length);
    registry.registerTurnStateProvider(provider("a", 1, `${first}\n${second}`));
    // 5000 + 1 + 969 + wrapper = 6001
    expect(`<router-state>\n${first}\n${second}\n</router-state>`.length).toBe(6001);
    const out = registry.buildTurnState("s")!;
    expect(out).toBe(`<router-state>\n${first}\n… 1 more lines\n</router-state>`);
    expect(out.length).toBeLessThanOrEqual(6000);
  });

  it("counts the overflow line against the bound and never cuts a line", () => {
    const { registry } = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"y".repeat(90)}`);
    registry.registerTurnStateProvider(provider("a", 1, lines.slice(0, 50).join("\n")));
    registry.registerTurnStateProvider(provider("b", 2, lines.slice(50).join("\n")));
    const out = registry.buildTurnState("s")!;
    expect(out.length).toBeLessThanOrEqual(6000);
    const body = out.slice("<router-state>\n".length, -"\n</router-state>".length).split("\n");
    const overflow = body.pop()!;
    const match = /^… (\d+) more lines$/.exec(overflow)!;
    expect(match).not.toBeNull();
    const kept = body.filter((line) => line !== "");
    for (const line of kept) expect(lines).toContain(line);
    expect(kept.length + Number(match[1])).toBe(100);
    // Longest prefix: one more line would not fit.
    const longer = `<router-state>\n${body.join("\n")}\nline 000 ${"y".repeat(90)}\n… ${match[1]} more lines\n</router-state>`;
    expect(longer.length).toBeGreaterThan(out.length);
    expect(body.length).toBeGreaterThan(0);
    expect(body[body.length - 1]).not.toBe("");
  });

  it("does not count dropped blank lines and trims trailing blanks of the kept part", () => {
    const { registry } = setup();
    const chunk = `${"c".repeat(2000)}\n${"d".repeat(2000)}`;
    registry.registerTurnStateProvider(provider("a", 1, chunk));
    registry.registerTurnStateProvider(provider("b", 2, chunk));
    // body: 4 lines of 2000 chars + a blank separator → only the first two lines and the blank separator fit.
    const out = registry.buildTurnState("s")!;
    expect(out).toBe(`<router-state>\n${"c".repeat(2000)}\n${"d".repeat(2000)}\n… 2 more lines\n</router-state>`);
  });

  it("falls back to the overflow line alone when not even one line fits", () => {
    const { registry } = setup();
    registry.registerTurnStateProvider(provider("a", 1, `${"x".repeat(7000)}\nsecond`));
    expect(registry.buildTurnState("s")).toBe("<router-state>\n… 2 more lines\n</router-state>");
  });

  it("adds the plan suffix only while the plan provider is active", () => {
    const big = Array.from({ length: 120 }, (_, i) => `row ${i} ${"z".repeat(80)}`).join("\n");
    const run = (plan: TurnStateProvider | undefined, other?: TurnStateProvider) => {
      const { registry } = setup();
      if (plan) registry.registerTurnStateProvider(plan);
      registry.registerTurnStateProvider(other ?? provider("big", 50, big));
      return registry.buildTurnState("s")!;
    };
    const withoutPlan = run(undefined);
    expect(withoutPlan).toMatch(/\n… \d+ more lines\n<\/router-state>$/);
    expect(withoutPlan).not.toContain("router_plan");

    const inactive = run(provider(PLAN_PROVIDER_NAME, 0, "plan line", () => false));
    expect(inactive).not.toContain("router_plan");

    const noActive = run(provider(PLAN_PROVIDER_NAME, 0, "plan line"));
    expect(noActive).not.toContain("router_plan");

    const active = run(provider(PLAN_PROVIDER_NAME, 0, "plan line", () => true));
    expect(active).toMatch(/\n… \d+ more lines \(router_plan action=status\)\n<\/router-state>$/);
    expect(active.length).toBeLessThanOrEqual(6000);

    // Another provider's activity is not the plan's.
    const otherActive = run(undefined, { ...provider("other", 1, big, () => true) });
    expect(otherActive).not.toContain("router_plan");

    // The suffix is not added when nothing overflows.
    const { registry } = setup();
    registry.registerTurnStateProvider(provider(PLAN_PROVIDER_NAME, 0, "plan line", () => true));
    expect(registry.buildTurnState("s")).toBe("<router-state>\nplan line\n</router-state>");
  });

  it("logs a throwing provider once per name across builds and skips its section", () => {
    const { registry, warn } = setup();
    registry.registerTurnStateProvider({ name: "bad", order: 1, render: () => { throw new Error("boom Bearer abcdefghijklmnop"); } });
    registry.registerTurnStateProvider(provider("good", 2, "ok"));
    expect(registry.buildTurnState("s")).toBe("<router-state>\nok\n</router-state>");
    expect(registry.buildTurnState("s")).toBe("<router-state>\nok\n</router-state>");
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0]!;
    expect(message).toBe('[router] turn state: provider "bad" failed; section skipped');
    expect((meta as { error: string }).error).toContain("boom");
    expect((meta as { error: string }).error).not.toContain("abcdefghijklmnop");
  });

  it("logs a non-Error throw and a second failing provider separately", () => {
    const { registry, warn } = setup();
    registry.registerTurnStateProvider({ name: "a", order: 1, render: () => { throw "plain"; } });
    registry.registerTurnStateProvider({ name: "b", order: 2, render: () => { throw new Error("two"); } });
    expect(registry.buildTurnState("s")).toBeUndefined();
    expect(registry.buildTurnState("s")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect((warn.mock.calls[0]![1] as { error: string }).error).toBe("plain");
  });

  it("treats a throwing active as no activity, logged once", () => {
    const { registry, warn } = setup();
    registry.registerTurnStateProvider({ name: "a", order: 1, render: () => "x", active: () => { throw new Error("nope"); } });
    expect(registry.hasActivity("s")).toBe(false);
    expect(registry.hasActivity("s")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(registry.buildTurnState("s")).toBe("<router-state>\nx\n</router-state>");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs a throwing plan active during overflow and omits the suffix", () => {
    const { registry, warn } = setup();
    registry.registerTurnStateProvider({ name: PLAN_PROVIDER_NAME, order: 0, render: () => "p", active: () => { throw new Error("x"); } });
    registry.registerTurnStateProvider(provider("big", 5, Array.from({ length: 200 }, () => "q".repeat(60)).join("\n")));
    const out = registry.buildTurnState("s")!;
    expect(out).not.toContain("router_plan");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("applies translate before the bound", () => {
    const { registry } = setup((text) => text.replaceAll("@", "xx"));
    // 2985 "@" translate to 5970 characters: only the translated text overflows.
    registry.registerTurnStateProvider(provider("a", 1, `${"a".repeat(100)}\n${"@".repeat(2985)}`));
    const out = registry.buildTurnState("s")!;
    expect(out).toBe(`<router-state>\n${"a".repeat(100)}\n… 1 more lines\n</router-state>`);
    // And the translated text is what is kept when it fits.
    const small = setup((text) => text.toUpperCase());
    small.registry.registerTurnStateProvider(provider("a", 1, "hello"));
    expect(small.registry.buildTurnState("s")).toBe("<router-state>\nHELLO\n</router-state>");
  });

  it("skips a section whose translate throws", () => {
    const { registry, warn } = setup((text) => { if (text === "bad") throw new Error("t"); return text; });
    registry.registerTurnStateProvider(provider("a", 1, "bad"));
    registry.registerTurnStateProvider(provider("b", 2, "fine"));
    expect(registry.buildTurnState("s")).toBe("<router-state>\nfine\n</router-state>");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("hasActivity", () => {
  it("is true only when some provider reports active() === true", () => {
    const { registry } = setup();
    expect(registry.hasActivity("s")).toBe(false);
    registry.registerTurnStateProvider(provider("a", 1, "x"));
    registry.registerTurnStateProvider(provider("b", 2, "y", () => false));
    expect(registry.hasActivity("s")).toBe(false);
    const off = registry.registerTurnStateProvider(provider("c", 3, "z", () => true));
    expect(registry.hasActivity("s")).toBe(true);
    off();
    expect(registry.hasActivity("s")).toBe(false);
  });

  it("passes the session id to active", () => {
    const { registry } = setup();
    const active = vi.fn((sid: string) => sid === "ses_1");
    registry.registerTurnStateProvider({ name: "a", order: 1, render: () => undefined, active });
    expect(registry.hasActivity("ses_1")).toBe(true);
    expect(registry.hasActivity("ses_2")).toBe(false);
  });
});

interface Part { type: string; text?: string; cache?: unknown; id?: string }
interface Msg { role: string; content: Part[]; id?: string }

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const makeTail = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const user = (...texts: string[]): Msg => ({ role: "user", content: texts.map((text) => ({ type: "text", text })) });

function hints(messages: readonly Msg[]): { message: number; part: number }[] {
  const found: { message: number; part: number }[] = [];
  messages.forEach((message, m) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, p) => { if (part.cache !== undefined) found.push({ message: m, part: p }); });
  });
  return found;
}

describe("placeTurnState", () => {
  it("leaves the messages alone without a tail", () => {
    const messages = [user("hi")];
    expect(placeTurnState(messages, undefined, makeTail)).toBeUndefined();
    expect(messages).toEqual([user("hi")]);
  });

  it("only appends the tail to an empty history", () => {
    expect(placeTurnState<Msg>([], "T", makeTail)).toEqual([makeTail("T")]);
  });

  it("hints the last text part of the last user message and appends the tail", () => {
    const messages = deepFreeze([user("first"), { role: "assistant", content: [{ type: "text", text: "answer" }] }, user("a", "b")]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(placed).toHaveLength(4);
    expect(placed).not.toBe(messages);
    expect(hints(placed)).toEqual([{ message: 2, part: 1 }]);
    expect(placed[2]!.content[1]).toEqual({ type: "text", text: "b", cache: { type: "ephemeral" } });
    expect(placed[2]!.content[0]).toBe(messages[2]!.content[0]);
    expect(placed[0]).toBe(messages[0]);
    expect(placed[1]).toBe(messages[1]);
    expect(placed[3]).toEqual({ role: "user", content: [{ type: "text", text: "T" }] });
    expect(placed[3]!.content[0]!.cache).toBeUndefined();
    expect(hints(messages)).toEqual([]);
  });

  it("walks past a message with no text (a tool result) to the last text part", () => {
    const toolResult: Msg = { role: "tool", content: [{ type: "tool-result", id: "t1" }] };
    const messages = deepFreeze([user("ask"), { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool-call", id: "t1" }] }, toolResult]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(hints(placed)).toEqual([{ message: 1, part: 0 }]);
    expect(placed[2]).toBe(toolResult);
    expect(placed[1]!.content[1]).toBe(messages[1]!.content[1]);
  });

  it("skips empty text parts and non-string text", () => {
    const messages = deepFreeze<Msg[]>([
      user("real"),
      { role: "user", content: [{ type: "text", text: "kept" }, { type: "text", text: "" }, { type: "text" }, { type: "image" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
    ]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(hints(placed)).toEqual([{ message: 1, part: 0 }]);
    expect(placed[1]!.content).toHaveLength(4);
    expect(placed[2]).toBe(messages[2]);
  });

  it("adds the tail with no hint when no message has any text", () => {
    const messages = deepFreeze<Msg[]>([
      { role: "tool", content: [{ type: "tool-result" }] },
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "user", content: [] },
    ]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(placed).toHaveLength(4);
    expect(hints(placed)).toEqual([]);
    expect(placed.slice(0, 3)).toEqual(messages);
    expect(placed[3]).toEqual(makeTail("T"));
  });

  it("ignores messages whose content is not an array", () => {
    const odd = { role: "user", content: "plain" } as unknown as Msg;
    const messages = deepFreeze([user("before"), odd]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(hints(placed)).toEqual([{ message: 0, part: 0 }]);
    expect(placed[1]).toBe(odd);
    expect(placeTurnState([null as unknown as Msg], "T", makeTail)).toHaveLength(2);
  });

  it("preserves the prototype and own properties of the copied message and part", () => {
    class Host {
      constructor(readonly id: string, readonly role: string, readonly content: Part[]) {}
      describe(): string { return `${this.role}:${this.id}`; }
    }
    const message = new Host("m1", "user", [{ type: "text", text: "hello", id: "p1" }]);
    deepFreeze(message);
    const placed = placeTurnState<Host | Msg>([message], "T", makeTail)!;
    const copy = placed[0] as Host;
    expect(copy).not.toBe(message);
    expect(Object.getPrototypeOf(copy)).toBe(Host.prototype);
    expect(copy.describe()).toBe("user:m1");
    expect(copy.content[0]).toEqual({ type: "text", text: "hello", id: "p1", cache: { type: "ephemeral" } });
    expect(message.content[0]).toEqual({ type: "text", text: "hello", id: "p1" });
  });

  it("never mutates deep-frozen input and puts exactly one fresh hint per request, never on the tail", () => {
    const messages = deepFreeze([user("one"), { role: "assistant", content: [{ type: "text", text: "two" }] }, user("three", "four")]);
    const snapshot = JSON.stringify(messages);
    const first = placeTurnState(messages, "T1", makeTail)!;
    const second = placeTurnState(messages, "T2", makeTail)!;
    expect(JSON.stringify(messages)).toBe(snapshot);
    for (const placed of [first, second]) {
      expect(hints(placed)).toHaveLength(1);
      expect(hints(placed)[0]!.message).toBeLessThan(placed.length - 1);
    }
    expect(first[2]!.content[1]!.cache).not.toBe(second[2]!.content[1]!.cache);
    expect(first[3]!.content[0]).toEqual({ type: "text", text: "T1" });
    // Placing again on a result that already carries a hint: still no mutation (and the older hint is not duplicated by us).
    const frozenResult = deepFreeze(first.slice(0, 3));
    expect(() => placeTurnState(frozenResult, "T3", makeTail)).not.toThrow();
  });

  it("accepts a readonly array and returns a new array", () => {
    const messages: readonly Msg[] = Object.freeze([user("x")]);
    const placed = placeTurnState(messages, "T", makeTail)!;
    expect(Array.isArray(placed)).toBe(true);
    expect(placed).not.toBe(messages);
    expect(messages).toHaveLength(1);
  });
});
