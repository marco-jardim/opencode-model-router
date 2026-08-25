import { describe, it, expect } from "vitest";
import {
  createVerificationWiring,
  extractAssistantText,
} from "../../src/verify/wiring";
import type { RouterConfig } from "../../src/router/config";

function cfg(over: Partial<RouterConfig> = {}): RouterConfig {
  return {
    activePreset: "alpha",
    defaultTier: "medium",
    rules: [],
    presets: { alpha: { fast: { model: "p/fast-m" }, heavy: { model: "p/heavy-m" } } },
    ...over,
  } as RouterConfig;
}

/** Records what the wiring asks of the opencode client. */
function fakeClient(over: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    session: {
      create: async (a: any) => {
        calls.push(["create", a]);
        return { data: { id: "SID1" } };
      },
      prompt: async (a: any) => {
        calls.push(["prompt", a]);
        return { data: { parts: [{ type: "text", text: "graded" }] } };
      },
      abort: async (a: any) => {
        calls.push(["abort", a]);
      },
      delete: async (a: any) => {
        calls.push(["delete", a]);
      },
      ...over,
    },
  };
}

describe("extractAssistantText", () => {
  it("joins the text parts", () => {
    expect(
      extractAssistantText({ data: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    ).toBe("a\nb");
  });

  it("skips non-text and malformed parts", () => {
    expect(
      extractAssistantText({
        data: { parts: [{ type: "tool" }, { type: "text", text: 5 }, { type: "text", text: "ok" }] },
      }),
    ).toBe("ok");
  });

  // Fail-closed: an empty string reads downstream as "the grader said nothing".
  it("returns an empty string for a missing or malformed body", () => {
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText({})).toBe("");
    expect(extractAssistantText({ data: {} })).toBe("");
  });
});

describe("dispatchGrader", () => {
  it("parents the grader session when a parent id is given", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }, "PARENT");
    expect(client.calls[0]).toEqual(["create", { body: { parentID: "PARENT" } }]);
  });

  it("omits parentID entirely when no parent is given", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[0]).toEqual(["create", { body: {} }]);
  });

  it("disposes the session it created, in order, on the happy path", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    const out = await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(out).toEqual({ sessionID: "SID1", text: "graded" });
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  // The dispose lives in a finally; a failing prompt must not leak the session.
  it("still disposes when the prompt throws", async () => {
    const client = fakeClient({
      prompt: async () => {
        throw new Error("boom");
      },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await expect(
      w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }),
    ).rejects.toThrow("boom");
    expect(client.calls.map((c) => c[0])).toContain("delete");
  });

  it("tracks the session as a grader only while it runs", async () => {
    // Hold the prompt open so the in-flight window is observable; the session is
    // not registered until session.create has resolved.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const client = fakeClient({
      prompt: async () => {
        await held;
        return { data: { parts: [{ type: "text", text: "graded" }] } };
      },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    const p = w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.graderSessions.has("SID1")).toBe(true);

    release();
    await p;
    expect(w.graderSessions.has("SID1")).toBe(false);
  });

  it("returns empty when the backend creates no session", async () => {
    const client = fakeClient({ create: async () => ({ data: {} }) });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    expect(await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" })).toEqual({
      sessionID: "",
      text: "",
    });
  });
});

describe("disposeChildSession", () => {
  it("never throws, even when both calls fail", async () => {
    const client = {
      session: {
        abort: async () => {
          throw new Error("no");
        },
        delete: async () => {
          throw new Error("no");
        },
      },
    };
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await expect(w.disposeChildSession("X")).resolves.toBeUndefined();
  });
});

describe("config is read lazily", () => {
  // The regression this guards: cfg in index.ts is a `let` reassigned by
  // /preset, /budget and /router enforce. Capturing it at construction would
  // pin the grader to whatever was active when the plugin loaded.
  it("dispatchGrader picks up a model change made after construction", async () => {
    const client = fakeClient();
    let current = cfg();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => current });

    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[1]![1].body.model).toEqual({ providerID: "p", modelID: "fast-m" });

    current = cfg({ presets: { alpha: { fast: { model: "q/switched-m" } } } } as never);
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[5]![1].body.model).toEqual({
      providerID: "q",
      modelID: "switched-m",
    });
  });

  it("buildGateDeps picks up an enforcement change made after construction", () => {
    let current = cfg();
    const w = createVerificationWiring({
      client: fakeClient(),
      directory: "/d",
      getConfig: () => current,
    });
    expect(w.buildGateDeps().checker.minGraderTier).toBe(null);

    current = cfg({
      enforcement: { verify: { minGraderTier: "heavy" } },
    } as never);
    expect(w.buildGateDeps().checker.minGraderTier).toBe("heavy");
  });
});
