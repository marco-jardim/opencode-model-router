/** CPX Phase 1.2 (task 1.2.7): cache-prefix smoke of the v2 turn state against a REAL OpenCode v2 host running THIS router.
 *
 *   RUN_OC_SMOKE_CPX=1 OPENCODE_V2_BIN=<abs path to opencode 2> npm run smoke:cpx
 *
 * Gate: RUN_OC_SMOKE_CPX=1 (same as cpx-host-contract). Unset: every test of the file is skipped. Set without OPENCODE_V2_BIN: one test fails
 * hard (`Set OPENCODE_V2_BIN ...`) and the scenario stays skipped (the harness would otherwise fall back to whatever `opencode` is on PATH).
 *
 * Scenario: ONE real host (RoutingHost, keyless scripted provider behind a CpxFront: `provider: {}`) with this router in advise mode and a
 * seeded outcome store (fast keeps failing `search`, `explore` keeps passing it), so the route hint is non-empty and the router renders a
 * `<router-state>` tail on every root request. The root runs two search turns and then one tool call (a `subagent` dispatch), which gives four
 * consecutive primary requests of the root; the last one ends in a tool result (O12). Per request the wire is inspected:
 *   - exactly one `<router-state>` message, the LAST message of the request (the tail of an earlier request is never in a later one);
 *   - exactly one message `cache_control` breakpoint, on the request's own last real message (on its last non-blank text part, or, when
 *     it has none, as for a tool result, on its LAST part: the tool_result block, O12), never on the tail or an earlier message;
 *   - no `ttl` on any block, and at most 4 `cache_control` markers in total;
 * and per pair of consecutive requests N, N+1:
 *   - N+1 equals N byte for byte through N's last real message, with `cache_control` stripped on both sides (the marker moves);
 *   - N+1 carries no `cache_control` inside that shared part except on its own last real message;
 *   - `system` (the host's own markers included) is byte-identical.
 * Recorded (not asserted): whether the tool_result block carries the marker (O12) and whether the host took the reassigned `event.messages`
 * (the tail present in the wire request proves it).
 *
 * Output: the observation `<OBS_DIR>/<runId>/cache-prefix.json` (+ `<OBS_DIR>/latest/cache-prefix.json`) is written BEFORE any assertion, with
 * OBS_DIR as in cpx-host-contract (`<OMR_CPX_PROBE_DIR | OMR_SMOKE_REAL_TMPDIR | os.tmpdir()>/omr-cpx-probe`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeKey } from "../../src/routing/outcomes";
import type { CpxFront, CpxRequest } from "./helpers/cpx-scripted-provider";
import { RoutingHost, arr, clip, obj, redact, stopAllHosts, type Obj, type Seed } from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_CPX === "1";
const BIN = process.env.OPENCODE_V2_BIN;
const d = RUN && BIN ? describe : describe.skip;
const RUN_ID = randomUUID().slice(0, 8);

if (RUN && !BIN) {
  it("requires OPENCODE_V2_BIN", () => {
    throw new Error("Set OPENCODE_V2_BIN to the absolute path of the OpenCode v2 executable (RUN_OC_SMOKE_CPX=1 is set)");
  });
}

afterAll(async () => { await stopAllHosts(); }, 120_000);

// -------------------------------------------------------------------------------------------- scenario inputs ----
const SONNET = { providerID: "anthropic", id: "claude-sonnet-5-5" } as const;
const ROOT_PARENT = { providerID: "anthropic", id: "claude-opus-4-7" } as const;
/** `fast` keeps failing `search` and the read-only host agent `explore` keeps passing it: the class moves to explore, so the hint is non-empty. */
const MOVE_SEED: readonly Seed[] = [
  { key: makeKey("search", { origin: "router", id: "fast" }, SONNET.providerID, SONNET.id, "low"), pass: 0, fail: 20 },
  { key: makeKey("search", { origin: "host", id: "explore" }, ROOT_PARENT.providerID, ROOT_PARENT.id, "default"), pass: 20, fail: 0 },
];
const FIRST_ASK = "Find every usage of parseThing in the repository and list the files.";
const SECOND_ASK = "Find every usage of parseOther in the repository and list the files.";
const SEARCH_PROMPT = "[route class=search risk=low scope=single]\nFind every usage of parseThing in the repository and list the files.";
const TAIL_OPEN = "<router-state>";
const HINT = /Route hint: for \w+ work like this turn, prefer @/;

// ------------------------------------------------------------------------------------------------ wire helpers ----
const json = (value: unknown): string => JSON.stringify(value) ?? "";
const hdr = (r: CpxRequest, name: string): string | undefined => { const v = r.headers[name]; return Array.isArray(v) ? v[0] : v; };
function front(host: RoutingHost): CpxFront {
  if (!host.front) throw new Error("host started without the CPX front");
  return host.front;
}
/** Provider requests of the primary agent loop of one session (the probe's http.request hook adds the x-proof-* headers). */
const primaryRequests = (host: RoutingHost, session: string): CpxRequest[] =>
  front(host).requests.filter(r => hdr(r, "x-proof-session") === session && hdr(r, "x-proof-kind") === "primary");
const bodyMessages = (r: CpxRequest): Obj[] => arr(obj(r.body).messages).map(obj);
const hasToolResult = (m: Obj | undefined): boolean => arr(m?.content).map(obj).some(b => b.type === "tool_result");
const hasText = (m: Obj | undefined): boolean => typeof m?.content === "string" ? m.content !== "" : arr(m?.content).map(obj).some(b => b.type === "text" && typeof b.text === "string" && b.text !== "");

/** Every object key matching `key` anywhere in `value`, with its JSON path and value. */
function findKeys(value: unknown, key: RegExp, at = "$", out: Obj[] = []): Obj[] {
  if (Array.isArray(value)) value.forEach((v, i) => findKeys(v, key, `${at}[${i}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (key.test(k)) out.push({ path: `${at}.${k}`, value: v });
      findKeys(v, key, `${at}.${k}`, out);
    }
  }
  return out;
}
/** A deep copy without any `cache_control` key. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !/^cache_?control$/i.test(k)).map(([k, v]) => [k, withoutCacheControl(v)]));
  }
  return value;
}
const messageIndexOf = (p: string): number | undefined => {
  const m = /^\$\.messages\[(\d+)\]/.exec(p);
  return m ? Number(m[1]) : undefined;
};

/** What one request carries, as far as this scenario cares. */
interface RequestView {
  index: number;
  messageCount: number;
  /** Indexes of the messages that contain the router-state tail. */
  tailAt: number[];
  /** Index of the last real message (the one before the tail); -1 when there is no tail. */
  lastReal: number;
  lastRealIsToolResult: boolean;
  /** Message indexes carrying a `cache_control`. */
  messageBreakpoints: number[];
  /** Content blocks carrying their own `cache_control`: message index, part index and part type. */
  partMarks: Array<{ message: number; part: number; type: string }>;
  /** True when the last real message has a non-blank text part (otherwise the breakpoint goes on its LAST part, QA-1.2-5). */
  lastRealHasText: boolean;
  /** Parts of the last real message that carry a `cache_control` (type per marked part). */
  lastRealMarkedTypes: string[];
  /** Whether the LAST part of the last real message carries a `cache_control`. */
  lastRealLastPartMarked: boolean;
  /** Whether a `tool_result` block of the last real message carries a `cache_control` (O12). */
  lastRealToolResultMarked: boolean;
  systemBreakpoints: number;
  totalMarkers: number;
  ttlPaths: string[];
  hintInTail: boolean;
  tailText: string;
}
function view(r: CpxRequest): RequestView {
  const messages = bodyMessages(r);
  const tailAt = messages.flatMap((m, i) => (json(m).includes(TAIL_OPEN) ? [i] : []));
  const tail = tailAt.length > 0 ? tailAt[tailAt.length - 1]! : -1;
  const markers = findKeys(obj(r.body), /^cache_?control$/i);
  const paths = markers.map(m => String(m.path));
  const partMarks = messages.flatMap((m, message) => arr(m.content).map(obj).flatMap((b, part) => (Object.keys(b).some(k => /^cache_?control$/i.test(k)) ? [{ message, part, type: String(b.type) }] : [])));
  const lastRealMarks = partMarks.filter(p => p.message === (tail > 0 ? tail - 1 : -1));
  const lastRealParts = tail > 0 ? arr(messages[tail - 1]?.content) : [];
  return {
    partMarks,
    lastRealHasText: tail > 0 && hasText(messages[tail - 1]),
    lastRealMarkedTypes: lastRealMarks.map(p => p.type),
    lastRealLastPartMarked: lastRealMarks.some(p => p.part === lastRealParts.length - 1),
    lastRealToolResultMarked: lastRealMarks.some(p => p.type === "tool_result"),
    index: r.index,
    messageCount: messages.length,
    tailAt,
    lastReal: tail > 0 ? tail - 1 : -1,
    lastRealIsToolResult: tail > 0 && hasToolResult(messages[tail - 1]),
    messageBreakpoints: paths.flatMap(p => { const i = messageIndexOf(p); return i === undefined ? [] : [i]; }),
    systemBreakpoints: paths.filter(p => p.startsWith("$.system")).length,
    totalMarkers: markers.length,
    ttlPaths: [...findKeys(obj(r.body), /^ttl/i).map(k => String(k.path))],
    hintInTail: tail >= 0 && HINT.test(json(messages[tail])),
    tailText: tail >= 0 ? json(messages[tail]).slice(0, 600) : "",
  };
}

/**
 * N+1 equals N through N's last real message once `cache_control` is stripped on BOTH sides (the marker moves from request to request);
 * the systems are byte-identical. Marker placement is checked separately: N+1's only message breakpoint is on its own last real message,
 * so none of its markers lies inside the part of its prefix that equals N, except at that position.
 */
function comparePair(a: CpxRequest, b: CpxRequest, va: RequestView, vb: RequestView): Obj {
  const am = bodyMessages(a);
  const bm = bodyMessages(b);
  const through = va.lastReal + 1;
  const earlier = json(withoutCacheControl(am.slice(0, through)));
  const later = json(withoutCacheControl(bm.slice(0, through)));
  let firstDiff: Obj | undefined;
  if (earlier !== later) {
    let at = 0;
    while (at < earlier.length && earlier[at] === later[at]) at += 1;
    firstDiff = { charOffset: at, earlier: earlier.slice(Math.max(0, at - 60), at + 80), later: later.slice(Math.max(0, at - 60), at + 80) };
  }
  // Markers of N+1 inside the shared part, other than the one on N+1's own last real message.
  const bPrefixOtherMarkers = vb.messageBreakpoints.filter(i => i < through && i !== vb.lastReal).length;
  return {
    from: a.index,
    to: b.index,
    comparedMessages: through,
    prefixIdentical: earlier === later,
    firstDiff,
    laterPrefixOtherMarkers: bPrefixOtherMarkers,
    systemIdentical: json(obj(a.body).system) === json(obj(b.body).system),
    otherFieldsIdentical: json(Object.fromEntries(Object.entries(obj(a.body)).filter(([k]) => k !== "messages"))) === json(Object.fromEntries(Object.entries(obj(b.body)).filter(([k]) => k !== "messages"))),
  };
}

// ------------------------------------------------------------------------------------------------ observation ----
const obsBaseDir = (): string => path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-probe");
interface Check { id: string; ok: boolean; message: string }

async function writeObservation(record: Obj): Promise<string> {
  const base = obsBaseDir();
  const dir = path.join(base, RUN_ID);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(base, "latest"), { recursive: true });
  const text = `${JSON.stringify(redact(record), null, 2)}\n`;
  const file = path.join(dir, "cache-prefix.json");
  await writeFile(file, text);
  await writeFile(path.join(base, "latest", "cache-prefix.json"), text);
  console.log(`[cpx-cache-prefix] observation written to ${file}`);
  return file;
}

d("cpx cache prefix: the turn-state tail never touches the cached prefix", () => {
  it("consecutive root requests share their prefix byte for byte; one breakpoint on the last real message, never on the tail", async () => {
    const observed: Obj = {};
    const checks: Check[] = [];
    const check = (id: string, ok: boolean, message: string): void => { checks.push({ id, ok, message }); };
    let failure: unknown;
    const host = await RoutingHost.start("cpx-cache-prefix", { routing: { engine: "advise" }, seed: MOVE_SEED, provider: {} });
    try {
      const root = await host.newRoot("cpx cache prefix root");
      await host.prompt(root, FIRST_ASK);
      await host.prompt(root, SECOND_ASK);
      // One tool call: the request that follows it ends in a tool result (O12).
      await host.dispatch(root, { agent: "fast", description: "Find usages", prompt: SEARCH_PROMPT, background: false });

      const requests = primaryRequests(host, root);
      const views = requests.map(view);
      observed.rootID = root;
      observed.requestCount = requests.length;
      observed.views = views.map(v => ({ ...v }));
      observed.pairs = requests.slice(1).map((r, i) => comparePair(requests[i]!, r, views[i]!, views[i + 1]!));
      // O12: does the tool_result block itself carry the cache_control? And did the host take the reassigned `event.messages`
      // (the router-state tail present in the wire request proves it)?
      observed.o12ToolResultBlockCarriesCacheControl = views.filter(v => v.lastRealIsToolResult).map(v => ({ request: v.index, toolResultMarked: v.lastRealToolResultMarked, markedTypes: v.lastRealMarkedTypes }));
      observed.eventMessagesReassigned = { tailInEveryWireRequest: views.every(v => v.tailAt.length === 1), perRequest: views.map(v => ({ request: v.index, tailAt: v.tailAt })) };
      observed.lastMessages = requests.map(r => clip(bodyMessages(r).at(-1), 700));
      observed.systems = requests.map(r => clip(obj(r.body).system, 1500));
      observed.hostErrors = clip(host.errorLines(), 400);

      check("requests", requests.length >= 4, `expected at least 4 primary requests of the root (2 turns + tool call + its follow-up), got ${requests.length}`);
      views.forEach((v, n) => {
        const label = `request ${n + 1} (#${v.index})`;
        check("tail", v.tailAt.length === 1 && v.tailAt[0] === v.messageCount - 1, `${label}: exactly one <router-state> message and it must be the LAST message (tail at [${v.tailAt.join(",")}] of ${v.messageCount}); an earlier tail must not persist into a later request`);
        check("tail-hint", v.hintInTail, `${label}: the route hint must ride in the tail (the seeded advise state makes it non-empty)`);
        check("breakpoint", v.messageBreakpoints.length === 1 && v.lastReal >= 0 && v.messageBreakpoints[0] === v.lastReal, `${label}: exactly one message cache_control, on the request's own last real message (got [${v.messageBreakpoints.join(",")}], last real ${v.lastReal})`);
        check("breakpoint-tail", !v.messageBreakpoints.includes(v.messageCount - 1), `${label}: no cache_control on the tail`);
        check("ttl", v.ttlPaths.length === 0, `${label}: no ttl on any block (${v.ttlPaths.join(", ")})`);
        check("markers", v.totalMarkers <= 4, `${label}: at most 4 cache_control markers in total (got ${v.totalMarkers})`);
        const own = requests[n] ? bodyMessages(requests[n]!) : [];
        if (v.lastReal >= 0 && v.lastRealHasText) {
          const marked = v.partMarks.filter(p => p.message === v.lastReal);
          const part = marked.length === 1 ? obj(arr(own[v.lastReal]?.content)[marked[0]!.part]) : undefined;
          check("breakpoint-last-real", part !== undefined && part.type === "text" && typeof part.text === "string" && part.text.trim() !== "", `${label}: the last real message has text, so the breakpoint must sit on a non-blank text part of it (marked parts [${marked.map(p => `${p.part}:${p.type}`).join(",")}])`);
        }
      });
      const toolResultRequests = views.filter(v => v.lastRealIsToolResult);
      check("o12", toolResultRequests.length >= 1, "at least one request must end (before its tail) in a tool result (O12)");
      for (const v of toolResultRequests) {
        if (v.lastRealHasText) continue;
        check("o12-breakpoint", v.messageBreakpoints.length === 1 && v.messageBreakpoints[0] === v.lastReal && v.lastRealLastPartMarked && v.lastRealToolResultMarked, `request #${v.index} ends in a tool result without text: the breakpoint must sit on the tool_result block, the last part of the last real message, never on an earlier message (got messages [${v.messageBreakpoints.join(",")}], marked parts [${v.lastRealMarkedTypes.join(",")}], last real ${v.lastReal})`);
      }
      (observed.pairs as Obj[]).forEach(p => {
        const label = `request #${String(p.from)} -> #${String(p.to)}`;
        check("prefix", p.prefixIdentical === true, `${label}: N+1 must equal N byte for byte through N's last real message once cache_control is stripped on both sides (${json(p.firstDiff)})`);
        check("prefix-markers", p.laterPrefixOtherMarkers === 0, `${label}: N+1 carries no cache_control inside the part of its prefix that equals N, except on its own last real message (${String(p.laterPrefixOtherMarkers)} other)`);
        check("system", p.systemIdentical === true, `${label}: system blocks (the host's markers included) must be byte-identical`);
        check("other-fields", p.otherFieldsIdentical === true, `${label}: the request fields other than messages must be byte-identical`);
      });
    } catch (error) {
      failure = error;
      observed.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      let teardown: Obj;
      try { teardown = { ...(await host.stop()) }; } catch (error) { teardown = { stopError: error instanceof Error ? (error.stack ?? error.message) : String(error) }; }
      observed.teardown = teardown;
      check("teardown", teardown.stopError === undefined && teardown.rootRemoved === true && teardown.hostPortClosed === true, "host.stop() must remove the scratch root and close the host port");
    }
    // The observation first, then the assertions.
    const file = await writeObservation({
      scenario: "cpx-cache-prefix", runId: RUN_ID, recordedAt: new Date().toISOString(), obsDir: obsBaseDir(), vitestTmpdir: tmpdir(), checks, observed: clip(observed, 6000),
    });
    if (failure !== undefined) throw failure;
    const broken = checks.filter(c => !c.ok);
    if (broken.length > 0) throw new Error(`cpx-cache-prefix: ${broken.length} check(s) failed (observation: ${file})\n${broken.map(c => `  - ${c.id}: ${c.message}`).join("\n")}`);
    expect(broken).toHaveLength(0);
  }, 600_000);
});
