/**
 * #193 (finding 2.1-r3-c): the held gate (src/index.ts `runHeldGate`, v2 only: the finish API the v2 adapter attaches to)
 * settles its claim exactly once even when a step before `claim.settle` throws. The claim settles UNVERIFIABLE with the
 * scrubbed error, the verdict is posted, and the error is logged; the entry never stays `verifying`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { ROUTER_FINISH_ATTACH, type FinishApi, type HeldSink } from "../../src/compat/background";
import { invalidateConfigCache } from "../../src/router/config";
import { HELD_RESULT_TEXT } from "../../src/verify/wiring";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const scrub = vi.hoisted(() => ({ armed: false, thrown: 0 }));

// `heldOutcomeOf` is the only builder of a "not verified: " reason, and it scrubs it before the claim settles. Armed, that
// scrub throws: a step before `claim.settle` fails. Every other input is scrubbed as usual.
vi.mock("../../src/guard/scrub", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/guard/scrub")>();
  return {
    ...actual,
    scrubText: (input: string) => {
      if (scrub.armed && typeof input === "string" && input.startsWith("not verified: ")) {
        scrub.thrown += 1;
        throw new Error("scrub boom token=sk-ant-api03-SECRETVALUE");
      }
      return actual.scrubText(input);
    },
  };
});

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MODEL_ROUTER_ENFORCE: process.env.MODEL_ROUTER_ENFORCE };
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omr-held-settle-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  scrub.armed = false;
  scrub.thrown = 0;
  invalidateConfigCache();
});

afterEach(async () => {
  scrub.armed = false;
  for (const key of ["HOME", "USERPROFILE", "MODEL_ROUTER_ENFORCE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  invalidateConfigCache();
  await removeDirWhenReleased(home);
});

type Posted = { handle: string; verdict: string; text: string; reason?: string };
type Logged = { level: string; message: string; extra?: Record<string, unknown> };

async function attach(logged: Logged[]): Promise<{ api: FinishApi; posted: Posted[]; hooks: Hooks }> {
  const hooks: Hooks = await ModelRouterPlugin({
    directory: home,
    worktree: home,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    routerHost: "v2",
    client: {
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) },
      // The plugin logger posts through `client.app.log` when present: every warning lands here.
      app: { log: async ({ body }: { body: Logged }) => { logged.push(body); return {}; } },
    },
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  const channel: unknown = Reflect.get(hooks, ROUTER_FINISH_ATTACH);
  if (typeof channel !== "function") throw new Error("the plugin exposes no finish attach channel");
  const posted: Posted[] = [];
  const held: HeldSink = { verdict: async (handle, v) => { posted.push({ handle, ...v }); } };
  const api = channel({ host: "v2", held }) as FinishApi | undefined;
  if (api === undefined) throw new Error("v2 attach returned no finish API");
  return { api, posted, hooks };
}

/** The plugin's own `router_verify` on one handle, bounded: a claim left `verifying` would make it join that run. */
async function routerVerifyBounded(hooks: Hooks, handle: string, boundMs: number): Promise<string> {
  const verify = hooks.tool?.router_verify;
  if (verify === undefined) throw new Error("the plugin registers no router_verify tool");
  const context = { sessionID: "ses_parent", messageID: "msg_193", agent: "build", abort: new AbortController().signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: unknown = await Promise.race([
      verify.execute({ handles: [handle] }, context as unknown as Parameters<typeof verify.execute>[1]),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("router_verify did not answer: still verifying"), boundMs); }),
    ]);
    return typeof result === "string" ? result : JSON.stringify(result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("#193 held gate settle (2.1-r3-c)", () => {
  it("a step before claim.settle throws: the claim settles once, UNVERIFIABLE with the scrubbed error, and the error is logged", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1"; // router_verify is registered only when verification is on
    const logged: Logged[] = [];
    const { api, posted, hooks } = await attach(logged);
    // A read-only delegation: the held gate ends `skipped`, whose reason `heldOutcomeOf` scrubs before the settle.
    await hooks["tool.execute.before"]?.({ tool: "task", sessionID: "ses_parent", callID: "call-193" }, {
      args: { subagent_type: "fast", prompt: "Explore the parser and explain its entry point." },
    });
    const handle = api.reserveHeld("ses_parent", "call-193");
    if (handle === undefined) throw new Error("no handle reserved");
    scrub.armed = true;
    const result = await api.finish({
      callID: "call-193",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child_call-193",
      outputText: "Looked around; nothing to change.",
      status: "succeeded",
      mode: "background",
      heldHandle: handle,
      endedAt: Date.now(),
    });
    expect(result.verification).toEqual({ kind: "held", handle });
    await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 25_000 });
    await api.idle();
    scrub.armed = false;
    expect(scrub.thrown).toBe(1);

    // Settled once, UNVERIFIABLE, with the error's scrubbed text (never the secret it carried).
    const reason = "verification unavailable: Error: scrub boom token=[REDACTED]";
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ handle, verdict: "UNVERIFIABLE", reason });
    expect(posted[0].text).toContain("Looked around; nothing to change.");
    expect(posted[0].text.trimEnd().endsWith(`[router] UNVERIFIABLE — ${reason}`)).toBe(true);
    expect(JSON.stringify(posted)).not.toContain("SECRETVALUE");

    // Logged, not swallowed; handled in place, so the gate itself did not fail.
    const warning = logged.find((l) => l.message === "[router] held verification could not be settled; settling UNVERIFIABLE");
    expect(warning?.level).toBe("warn");
    expect(warning?.extra).toMatchObject({ handle, error: "Error: scrub boom token=[REDACTED]" });
    expect(logged.map((l) => l.message)).not.toContain("[router] held gate failed");
    expect(JSON.stringify(logged)).not.toContain("SECRETVALUE");

    // The claim left `verifying`: router_verify replays the settled verdict at once instead of joining a run.
    const text = await routerVerifyBounded(hooks, handle, 5_000);
    expect(text).toContain(`- ${handle} \u00b7 `);
    expect(text).toContain(" (cached verdict; nothing was run)");
    expect(text).not.toContain(HELD_RESULT_TEXT);
    expect(posted).toHaveLength(1);
  }, 30_000);
});
