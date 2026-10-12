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
 *   - a request ending in a tool result carries the marker on its tool_result block (O12, check `o12-breakpoint`).
 * Recorded (not asserted): whether the host took the reassigned `event.messages` (the tail present in the wire request proves it), and
 * `systemFold`: whether any request carries a trailing native system message or a system update folded into a user message (the first
 * differing path between request N and N+1 before N's last real message, if any).
 *
 * Output: the observation `<OBS_DIR>/<runId>/cache-prefix.json` (+ `<OBS_DIR>/latest/cache-prefix.json`) is written BEFORE any assertion, with
 * OBS_DIR as in cpx-host-contract (`<OMR_CPX_PROBE_DIR | OMR_SMOKE_REAL_TMPDIR | os.tmpdir()>/omr-cpx-probe`).
 *
 * Scenario `DF-1-6 background tail` (dogfood fault DF-1-6, measurement only): a second host (same seed, background `auto`, leases off)
 * reproduces the live shape in which the orchestrator's cache read stopped advancing while the router-state tail was non-empty: an
 * ordinary turn; a verified (VERIFY:required + passing fileExists acceptance) `subagent` call with `background: true`, acknowledged as
 * running and held (the child's first request is held by the provider so it stays in flight); a turn while it runs; the host's synthetic
 * `<subagent … state="completed">` completion and the router's `<router-verdict>` synthetic waking the root; two turns after the release.
 * Per request: (c) exactly one message `cache_control`, on the last real message (the one before the `<router-state>` tail), never on the
 * tail. Per consecutive pair N, N+1: (a) `system` and `tools` byte-identical; (b) N+1 byte-identical to N through N's last real message
 * with `cache_control` stripped. A failure prints the first differing byte offset and ±200 chars of both sides; the observation
 * `<OBS_DIR>/<runId>/cache-prefix-df16.json` also records every request's phase, tail, markers and synthetic-message renderings.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeKey } from "../../src/routing/outcomes";
import type { CpxFront, CpxRequest } from "./helpers/cpx-scripted-provider";
import { RoutingHost, arr, clip, obj, redact, stopAllHosts, waitFor, type Obj, type Seed } from "./helpers/routing-host";

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
// DF-1-6 (background tail): the host's synthetic completion of a background child and the router's held-verdict synthetic.
const SUBAGENT_COMPLETED = /<subagent\b[^>]*\bstate=\\?"completed\\?"/;
/** Any `<subagent … state=…>` rendering in the history (the host's `completed`, or the router's `held` placeholder substituted for it). */
const DF16_SUBAGENT_STATE = /<subagent\b[^>]*\bstate=\\?"\w+\\?"/;
const ROUTER_VERDICT = "<router-verdict";
/** Background on (auto), leases off, advise engine (with MOVE_SEED the route hint keeps the tail non-empty on every root request). */
const DF16_ROUTING = { engine: "advise", background: { mode: "auto" }, leases: { mode: "off" } } as const;
/** Child requests whose last user text carries this marker are answered DF16_CHILD_HOLD_MS after they arrive (the provider's hold). */
const DF16_HOLD_MARKER = "HOLD_CHILD";
const DF16_CHILD_HOLD_MS = 15_000;
const DF16_IMPLEMENT_PROMPT = "[route class=implement risk=low scope=single]\nImplement the feature in src/a.ts and report the file.";
/** A verified background dispatch (VERIFY:required + a deterministic fileExists check that passes): the result is held until the verdict. */
const DF16_DISPATCH = (verified: string): Obj => ({
  agent: "fast", description: "Implement feature", background: true,
  prompt: `${DF16_IMPLEMENT_PROMPT}\n${DF16_HOLD_MARKER}\nVERIFY:required\n[acceptance]\ncheck: fileExists path=${verified}\n[/acceptance]`,
});
const DF16_IN_FLIGHT_ASK = "Find every usage of parseOther in the repository and list the files.";
const DF16_AFTER_ASK_1 = "Find every usage of parseThird in the repository and list the files.";
const DF16_AFTER_ASK_2 = "Find every usage of parseFourth in the repository and list the files.";
const DF16_END = /^session\.execution\.(succeeded|failed|interrupted)$/;
/** Background lines of the router-state tail (src/compat/background.ts): a child in flight, a held result, a completion. */
const DF16_TAIL_BUSY = /\[router\] (In flight \(background\)|Held for verification|Completed since your last turn)/;
const DF16_TAIL_BUSY_ALL = new RegExp(DF16_TAIL_BUSY.source, "g");
/** The tail of a request made while the child is still running (or its result still held): the live DF-1-6 condition. */
const DF16_TAIL_IN_FLIGHT = /\[router\] (In flight \(background\)|Held for verification)/;

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
/** The JSON path of the first place where two values differ (depth first, keys in `a`'s order), undefined when equal. */
function firstPathDiff(a: unknown, b: unknown, at: string): string | undefined {
  if (json(a) === json(b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const found = firstPathDiff(a[i], b[i], `${at}[${i}]`);
      if (found !== undefined) return found;
    }
    return at;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter(k => !(k in a))];
    for (const k of keys) {
      const found = firstPathDiff((a as Obj)[k], (b as Obj)[k], `${at}.${k}`);
      if (found !== undefined) return found;
    }
  }
  return at;
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
  /** Indexes of messages whose role is `system` (a native system message inside `messages`, QA-1.2-17). */
  systemRoleMessages: number[];
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
    systemRoleMessages: messages.flatMap((m, i) => (m.role === "system" ? [i] : [])),
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
  // QA-1.2-17: the JSON path of the first difference in the shared part (a system update folded into a user message shows up here).
  const firstDiffPath = earlier === later ? undefined : firstPathDiff(withoutCacheControl(am.slice(0, through)), withoutCacheControl(bm.slice(0, through)), "$.messages");
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
    firstDiffPath,
    laterPrefixOtherMarkers: bPrefixOtherMarkers,
    systemIdentical: json(obj(a.body).system) === json(obj(b.body).system),
    otherFieldsIdentical: json(Object.fromEntries(Object.entries(obj(a.body)).filter(([k]) => k !== "messages"))) === json(Object.fromEntries(Object.entries(obj(b.body)).filter(([k]) => k !== "messages"))),
  };
}

/** DF-1-6: the first differing character offset of two serialized bodies with ±200 chars of both around it; undefined when equal. */
function byteDiff(earlier: string, later: string, radius = 200): { offset: number; charOffset: number; earlierLength: number; laterLength: number; earlier: string; later: string } | undefined {
  if (earlier === later) return undefined;
  let at = 0;
  while (at < earlier.length && at < later.length && earlier[at] === later[at]) at += 1;
  const from = Math.max(0, at - radius);
  return {
    offset: Buffer.byteLength(earlier.slice(0, at), "utf8"), charOffset: at,
    earlierLength: Buffer.byteLength(earlier, "utf8"), laterLength: Buffer.byteLength(later, "utf8"),
    earlier: earlier.slice(from, at + radius), later: later.slice(from, at + radius),
  };
}
const showDiff = (diff: ReturnType<typeof byteDiff>): string =>
  diff === undefined ? "identical" : `first differing byte offset ${diff.offset} (char ${diff.charOffset}; UTF-8 lengths ${diff.earlierLength} / ${diff.laterLength})\n    N   [±200 chars]: ${JSON.stringify(diff.earlier)}\n    N+1 [±200 chars]: ${JSON.stringify(diff.later)}`;
/** DF-1-6: the `<router-state>` message of a request as JSON text ("" when it has none). */
const tailText = (r: CpxRequest): string => bodyMessages(r).map(json).filter(t => t.includes(TAIL_OPEN)).at(-1) ?? "";
/** DF-1-6: every message of a request except the `<router-state>` tail, as JSON text. */
const historyText = (r: CpxRequest): string => bodyMessages(r).map(json).filter(t => !t.includes(TAIL_OPEN)).join("\n");
/** DF-1-6: the request fields other than messages/system/tools (model, max_tokens, thinking…), for the observation. */
const otherFields = (r: CpxRequest): Obj => Object.fromEntries(Object.entries(obj(r.body)).filter(([k]) => !["messages", "system", "tools"].includes(k)));
/** DF-1-6: what the request carries of the background life cycle, so a failing pair names the step it belongs to. */
function phaseOf(r: CpxRequest): string {
  const tail = tailText(r);
  const history = historyText(r);
  const states = [...history.matchAll(/<subagent\b[^>]*\bstate=\\?"(\w+)\\?"/g)].map(m => m[1]);
  const verdicts = (history.match(/<router-verdict/g) ?? []).length;
  const lines = [...tail.matchAll(DF16_TAIL_BUSY_ALL)].map(m => m[1]);
  return `tail[${lines.join("|") || (tail === "" ? "none" : "hint only")}] history[subagent states=${states.join(",") || "-"}; verdicts=${verdicts}; last=${String(bodyMessages(r).at(lastRealOfMessages(bodyMessages(r)))?.role ?? "?")}${hasToolResult(bodyMessages(r).at(lastRealOfMessages(bodyMessages(r)))) ? " tool_result" : ""}]`;
}
/** The last real message index computed from the messages alone (the one before the tail, else the last). */
const lastRealOfMessages = (messages: readonly Obj[]): number => {
  const tails = messages.flatMap((m, i) => (json(m).includes(TAIL_OPEN) ? [i] : []));
  return tails.length > 0 ? tails[tails.length - 1]! - 1 : messages.length - 1;
};
/** DF-1-6: the last real message of a request: the one before its `<router-state>` tail, or its last message when it has no tail. */
const lastRealOf = (v: RequestView): number => (v.tailAt.length > 0 ? v.tailAt[v.tailAt.length - 1]! - 1 : v.messageCount - 1);
/** DF-1-6: one pair N, N+1 of consecutive root requests, compared part by part on the serialized wire bodies (the front's parsed body
 * re-serialized: same key order as the host sent). `system` and `tools` byte for byte (markers included); `messages` through N's last
 * real message with `cache_control` stripped on both sides. Each difference carries its first differing byte offset and ±200 chars. */
function compareTailPair(a: CpxRequest, b: CpxRequest, va: RequestView, vb: RequestView): Obj {
  const ab = obj(a.body);
  const bb = obj(b.body);
  const through = lastRealOf(va) + 1;
  const earlier = withoutCacheControl(bodyMessages(a).slice(0, through));
  const later = withoutCacheControl(bodyMessages(b).slice(0, through));
  const prefixDiff = byteDiff(json(earlier), json(later));
  return {
    from: a.index,
    to: b.index,
    comparedMessages: through,
    laterMessageCount: vb.messageCount,
    systemDiff: byteDiff(json(ab.system), json(bb.system)),
    toolsDiff: byteDiff(json(ab.tools), json(bb.tools)),
    prefixDiff,
    prefixDiffPath: prefixDiff === undefined ? undefined : firstPathDiff(earlier, later, "$.messages"),
  };
}
/** DF-1-6 assertions (a)-(c) over the consecutive root requests; every failure message carries what is needed to root-cause it. */
function checkTailPairs(phases: readonly string[], views: readonly RequestView[], pairs: readonly Obj[], check: (id: string, ok: boolean, message: string) => void): void {
  views.forEach((v, n) => {
    const label = `request ${n + 1} (#${v.index}, ${phases[n] ?? "?"})`;
    const lastReal = lastRealOf(v);
    // (c) exactly one message-level breakpoint, on the last real message, never on the tail.
    check("df16-breakpoint", v.messageBreakpoints.length === 1 && lastReal >= 0 && v.messageBreakpoints[0] === lastReal, `${label}: exactly one message cache_control, on the last real message (got [${v.messageBreakpoints.join(",")}], last real ${lastReal}, tail at [${v.tailAt.join(",")}] of ${v.messageCount}; marked parts ${json(v.partMarks)})`);
    check("df16-breakpoint-tail", v.tailAt.every(t => !v.messageBreakpoints.includes(t)), `${label}: no cache_control on the <router-state> tail (breakpoints [${v.messageBreakpoints.join(",")}], tail at [${v.tailAt.join(",")}])`);
    check("df16-tail-last", v.tailAt.length <= 1 && (v.tailAt.length === 0 || v.tailAt[0] === v.messageCount - 1), `${label}: at most one <router-state> message and it is the LAST message (tail at [${v.tailAt.join(",")}] of ${v.messageCount})`);
  });
  pairs.forEach((p, n) => {
    const label = `request #${String(p.from)} (${phases[n] ?? "?"}) -> #${String(p.to)} (${phases[n + 1] ?? "?"})`;
    const systemDiff = p.systemDiff as ReturnType<typeof byteDiff>;
    const toolsDiff = p.toolsDiff as ReturnType<typeof byteDiff>;
    const prefixDiff = p.prefixDiff as ReturnType<typeof byteDiff>;
    // (a) the system array and the tools are byte-identical (cache_control markers included).
    check("df16-system", systemDiff === undefined, `${label}: system must be byte-identical: ${showDiff(systemDiff)}`);
    check("df16-tools", toolsDiff === undefined, `${label}: tools must be byte-identical: ${showDiff(toolsDiff)}`);
    // (b) N+1 equals N byte for byte through N's last real message, cache_control stripped on both sides.
    check("df16-prefix", prefixDiff === undefined, `${label}: N+1 must equal N through N's last real message (${String(p.comparedMessages)} messages; N+1 has ${String(p.laterMessageCount)}) once cache_control is stripped; first differing path ${String(p.prefixDiffPath)}: ${showDiff(prefixDiff)}`);
  });
}

// ------------------------------------------------------------------------------------------------ observation ----
const obsBaseDir = (): string => path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-probe");
interface Check { id: string; ok: boolean; message: string }

async function writeObservation(record: Obj, name = "cache-prefix"): Promise<string> {
  const base = obsBaseDir();
  const dir = path.join(base, RUN_ID);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(base, "latest"), { recursive: true });
  const text = `${JSON.stringify(redact(record), null, 2)}\n`;
  const file = path.join(dir, `${name}.json`);
  await writeFile(file, text);
  await writeFile(path.join(base, "latest", `${name}.json`), text);
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
      // QA-1.2-17 (observation, not asserted): does any wire request carry a native system message inside `messages` (trailing or not), or a
      // system update folded into a user message (a difference between N and N+1 before N's last real message)? Either would break the prefix.
      observed.systemFold = {
        nativeSystemMessages: views.filter(v => v.systemRoleMessages.length > 0).map(v => ({ request: v.index, at: v.systemRoleMessages, trailing: v.systemRoleMessages.includes(v.messageCount - 1) })),
        anyNativeSystemMessage: views.some(v => v.systemRoleMessages.length > 0),
        anyTrailingNativeSystemMessage: views.some(v => v.systemRoleMessages.includes(v.messageCount - 1)),
        prefixDifferences: (observed.pairs as Obj[]).filter(p => p.prefixIdentical !== true).map(p => ({ from: p.from, to: p.to, firstDiffPath: p.firstDiffPath })),
        anySystemUpdateFoldedIntoUserMessage: (observed.pairs as Obj[]).some(p => p.prefixIdentical !== true),
      };
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

  it("DF-1-6 background tail", async () => {
    const observed: Obj = {};
    const checks: Check[] = [];
    const check = (id: string, ok: boolean, message: string): void => { checks.push({ id, ok, message }); };
    let failure: unknown;
    const host = await RoutingHost.start("cpx-cache-prefix-df16", { routing: DF16_ROUTING, seed: MOVE_SEED, provider: {} });
    try {
      host.provider.holdMarked(DF16_HOLD_MARKER, DF16_CHILD_HOLD_MS);
      const verified = path.join(host.project, "df16-held-pass.txt");
      await writeFile(verified, "present\n");
      const root = await host.newRoot("cpx cache prefix df16 root");
      observed.rootID = root;
      // 1. An ordinary turn first, so the background dispatch lands on an established prefix.
      await host.prompt(root, FIRST_ASK);
      // 2. The background dispatch, verified (VERIFY:required + a deterministic acceptance check that passes): its result is HELD.
      const call = await host.dispatch(root, DF16_DISPATCH(verified));
      observed.childID = call.childID;
      observed.ack = clip(json(call.after.result), 800);
      check("df16-ack", /Running in the background/.test(json(call.after.result)), `the dispatch result must be the background acknowledgement (got ${clip(json(call.after.result), 400) as string})`);
      check("df16-ack-held", /held until verification finishes/.test(json(call.after.result)), "the acknowledgement must say the result is held until verification finishes");
      // 3. A turn while the child is in flight (the tail lists it in flight / held).
      const endedEarly = (await host.eventsOf(call.childID)).some(e => DF16_END.test(e.type));
      observed.childEndedBeforeInFlightTurn = endedEarly;
      await host.prompt(root, DF16_IN_FLIGHT_ASK);
      // 4. The child ends: the host's synthetic `<subagent … state="completed">` and the router's `<router-verdict>` wake the root.
      observed.childEnd = await waitFor(`end event of ${call.childID}`, async () => (await host.eventsOf(call.childID)).find(e => DF16_END.test(e.type))?.type, 120_000, 250);
      const verdictRequest = await waitFor("a root request carrying the verdict entry", () => primaryRequests(host, root).find(r => historyText(r).includes(ROUTER_VERDICT)), 120_000, 500).catch(() => undefined);
      observed.verdictRequest = verdictRequest?.index;
      await host.settle(root);
      // 5. Two turns after the release.
      await host.prompt(root, DF16_AFTER_ASK_1);
      await host.prompt(root, DF16_AFTER_ASK_2);

      const requests = primaryRequests(host, root);
      const views = requests.map(view);
      const phases = requests.map(phaseOf);
      const pairs = requests.slice(1).map((r, i) => compareTailPair(requests[i]!, r, views[i]!, views[i + 1]!));
      observed.requestCount = requests.length;
      observed.phases = requests.map((r, n) => ({ request: r.index, phase: phases[n], messageCount: views[n]!.messageCount, tailAt: views[n]!.tailAt, lastReal: lastRealOf(views[n]!), messageBreakpoints: views[n]!.messageBreakpoints, partMarks: views[n]!.partMarks, systemBreakpoints: views[n]!.systemBreakpoints, totalMarkers: views[n]!.totalMarkers }));
      observed.pairs = pairs;
      observed.tails = requests.map(r => clip(tailText(r), 900));
      // H2 evidence: how each request renders the child's completion (the host's `completed` record, or the router's `held` placeholder
      // substituted for it while the hold is active) and the verdict entry, message by message.
      observed.syntheticMessages = requests.map(r => ({
        request: r.index,
        messages: bodyMessages(r).flatMap((m, i) => (json(m).includes("<subagent") || json(m).includes(ROUTER_VERDICT)
          ? [{ at: i, role: m.role, completed: SUBAGENT_COMPLETED.test(json(m)), heldPlaceholder: json(m).includes('state=\\"held\\"'), verdict: json(m).includes(ROUTER_VERDICT), length: json(m).length, text: clip(json(m), 900) }]
          : [])),
      }));
      observed.otherFields = requests.slice(1).map((r, i) => ({ from: requests[i]!.index, to: r.index, diff: byteDiff(json(otherFields(requests[i]!)), json(otherFields(r))) }));
      observed.hostErrors = clip(host.errorLines(), 400);
      observed.routerLog = clip(host.routerLogLines(), 400);
      observed.providerErrors = clip(host.provider.errors, 400);

      // The live shape must have been reproduced (otherwise (a)-(c) prove nothing about DF-1-6).
      check("df16-requests", requests.length >= 4, `expected at least 4 consecutive primary requests of the root, got ${requests.length}`);
      // The in-flight turn is the first request whose history carries its ask; its tail must list the child in flight / held.
      const inFlightTurn = requests.find(r => historyText(r).includes(DF16_IN_FLIGHT_ASK));
      observed.inFlightTurn = inFlightTurn?.index;
      observed.inFlightTails = requests.filter(r => DF16_TAIL_IN_FLIGHT.test(tailText(r))).map(r => r.index);
      check("df16-shape-in-flight", !endedEarly && inFlightTurn !== undefined && DF16_TAIL_IN_FLIGHT.test(tailText(inFlightTurn)), `the turn made while the child runs (#${String(inFlightTurn?.index)}) must carry the background tail (in flight / held); child ended before that turn: ${String(endedEarly)}; tail ${clip(inFlightTurn === undefined ? "" : tailText(inFlightTurn), 400) as string}`);
      check("df16-shape-completion", requests.some(r => DF16_SUBAGENT_STATE.test(historyText(r))), "the host's synthetic <subagent … state=…> completion message must reach a root request");
      check("df16-shape-verdict", verdictRequest !== undefined, "the router's <router-verdict> synthetic must reach a root request");
      check("df16-shape-released", verdictRequest !== undefined && requests.filter(r => r.index > verdictRequest.index).length >= 2, "at least two root requests must follow the verdict request (after the release)");
      checkTailPairs(phases, views, pairs, check);
    } catch (error) {
      failure = error;
      observed.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      let teardown: Obj;
      try { teardown = { ...(await host.stop()) }; } catch (error) { teardown = { stopError: error instanceof Error ? (error.stack ?? error.message) : String(error) }; }
      observed.teardown = teardown;
      check("teardown", teardown.stopError === undefined && teardown.rootRemoved === true && teardown.hostPortClosed === true, "host.stop() must remove the scratch root and close the host port");
    }
    const file = await writeObservation({
      scenario: "cpx-cache-prefix-df16", runId: RUN_ID, recordedAt: new Date().toISOString(), obsDir: obsBaseDir(), vitestTmpdir: tmpdir(), checks, observed: clip(observed, 12000),
    }, "cache-prefix-df16");
    if (failure !== undefined) throw failure;
    const broken = checks.filter(c => !c.ok);
    if (broken.length > 0) throw new Error(`cpx-cache-prefix DF-1-6: ${broken.length} check(s) failed (observation: ${file})\n${broken.map(c => `  - ${c.id}: ${c.message}`).join("\n")}`);
    expect(broken).toHaveLength(0);
  }, 900_000);
});
