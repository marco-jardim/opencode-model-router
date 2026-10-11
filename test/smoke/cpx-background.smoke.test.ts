/** CPX Phase 2.1 (task 2.1.8): background dispatch smoke against a REAL OpenCode v2 host running THIS router.
 *
 *   RUN_OC_SMOKE_CPX=1 OPENCODE_V2_BIN=<abs path to opencode 2> npm run smoke:cpx
 *
 * Gate: RUN_OC_SMOKE_CPX=1 (same as cpx-cache-prefix). Unset: every test of the file is skipped. Set without OPENCODE_V2_BIN: one test
 * fails hard and the scenario stays skipped.
 *
 * Scenarios, one test each (one real host each, keyless scripted provider behind a CpxFront: `provider: {}`):
 *   1. background dispatch returns at once, the root's next scripted step runs before the child ends, and the completion annotation appears
 *      in the turn-state tail of the next request;
 *   2. a held verified result: placeholder first, then the verdict entry;
 *   3. a resume of a held child is refused;
 *   4. two children writing one file: the second is refused by the lease registry.
 *
 * Observation: `<OBS_DIR>/<runId>/background.json` (+ `<OBS_DIR>/latest/background.json`) is written BEFORE any assertion.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CpxFront, CpxRequest } from "./helpers/cpx-scripted-provider";
import { RoutingHost, arr, clip, obj, redact, scriptLine, stopAllHosts, waitFor, type Dispatched, type HostOptions, type Obj } from "./helpers/routing-host";

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
const IMPLEMENT_PROMPT = "[route class=implement risk=low scope=single]\nImplement the feature in src/a.ts and report the file.";
/** Child requests whose last user text carries this marker are answered CHILD_HOLD_MS after they arrive (the scripted provider's hold). */
const HOLD_MARKER = "HOLD_CHILD";
const CHILD_HOLD_MS = 6_000;
const IN_FLIGHT = "[router] In flight (background)";
const HELD_LINE = "[router] Held for verification";
const COMPLETED_LINE = "[router] Completed since your last turn";

const obsBaseDir = (): string => path.join(process.env.OMR_CPX_PROBE_DIR || process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir(), "omr-cpx-probe");
interface Check { id: string; ok: boolean; message: string }
const newChecks = (): { checks: Check[]; check: (id: string, ok: boolean, message: string) => void } => {
  const checks: Check[] = [];
  return { checks, check: (id, ok, message) => { checks.push({ id, ok, message }); } };
};

async function writeObservation(record: Obj, name: string): Promise<string> {
  const base = obsBaseDir();
  const dir = path.join(base, RUN_ID);
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(base, "latest"), { recursive: true });
  const text = `${JSON.stringify(redact(record), null, 2)}\n`;
  const file = path.join(dir, `${name}.json`);
  await writeFile(file, text);
  await writeFile(path.join(base, "latest", `${name}.json`), text);
  console.log(`[cpx-background] observation written to ${file}`);
  return file;
}

function front(host: RoutingHost): CpxFront {
  if (!host.front) throw new Error("host started without the CPX front");
  return host.front;
}

const TAIL_OPEN = "<router-state>";
const json = (value: unknown): string => JSON.stringify(value) ?? "";
const hdr = (r: CpxRequest, name: string): string | undefined => { const v = r.headers[name]; return Array.isArray(v) ? v[0] : v; };
/** Provider requests of the primary agent loop of one session (the probe's http.request hook adds the x-proof-* headers). */
const primaryRequests = (host: RoutingHost, session: string): CpxRequest[] =>
  front(host).requests.filter(r => hdr(r, "x-proof-session") === session && hdr(r, "x-proof-kind") === "primary");
const bodyMessages = (r: CpxRequest): Obj[] => arr(obj(r.body).messages).map(obj);
/** The text of the `<router-state>` message of a request ("" when it has none). */
const tailOf = (r: CpxRequest): string => bodyMessages(r).map(json).filter(t => t.includes(TAIL_OPEN)).at(-1) ?? "";
/** Every message of a request except the router-state tail, as JSON text. */
const historyOf = (r: CpxRequest): string => bodyMessages(r).map(json).filter(t => !t.includes(TAIL_OPEN)).join("\n");

interface Ctx { host: RoutingHost; observed: Obj; check: (id: string, ok: boolean, message: string) => void }

const SHARED_FILE = "shared.txt";
const LEASE_ONE = "LEASE_ONE";
const LEASE_TWO = "LEASE_TWO";
const lastIsToolResult = (r: CpxRequest): boolean => arr(bodyMessages(r).at(-1)?.content).map(obj).some(b => b.type === "tool_result");
const BG_ROUTING = { engine: "advise", background: { mode: "auto" }, leases: { mode: "off" } } as const;
/** What the scripted child answers. */
const CHILD_OUTPUT = "CHILD_OK";
/** A verified (VERIFY:required, deterministic fileExists check that passes) background dispatch; the child is held so the root runs on. */
async function heldDispatch(host: RoutingHost): Promise<{ root: string; call: Dispatched & { childID: string } }> {
  host.provider.holdMarked(HOLD_MARKER, CHILD_HOLD_MS);
  const verified = path.join(host.project, "held-pass.txt");
  await writeFile(verified, "present\n");
  const root = await host.newRoot("cpx background held root");
  const prompt = `${IMPLEMENT_PROMPT}\n${HOLD_MARKER}\nVERIFY:required\n[acceptance]\ncheck: fileExists path=${verified}\n[/acceptance]`;
  const call = await host.dispatch(root, { agent: "fast", description: "Implement feature", prompt, background: true });
  return { root, call };
}
/** The ack the host returned for a dispatch (the text of the `subagent` result the root saw). */
const resultText = (d: { after: { result?: Obj } }): string => json(d.after.result);
/** Waits for the child's `session.execution.*` end event; returns its type. */
async function childEnded(host: RoutingHost, child: string): Promise<string> {
  return waitFor(`end event of ${child}`, async () => (await host.eventsOf(child)).find(e => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type))?.type, 60_000, 250);
}
/** The tail of the root's LAST primary request. */
const lastTail = (host: RoutingHost, root: string): string => {
  const last = primaryRequests(host, root).at(-1);
  return last === undefined ? "" : tailOf(last);
};

/**
 * Runs one scenario on its own host (`options`): the host is always stopped, the observation is written BEFORE any assertion,
 * then a scenario error or a failed check fails the test.
 */
async function scenario(name: string, options: HostOptions, body: (ctx: Ctx) => Promise<void>): Promise<void> {
  const observed: Obj = {};
  const { checks, check } = newChecks();
  let failure: unknown;
  let host: RoutingHost | undefined;
  try {
    host = await RoutingHost.start(name, { provider: {}, ...options });
    await body({ host, observed, check });
  } catch (error) {
    failure = error;
    observed.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  if (host !== undefined) {
    try {
      observed.hostErrors = clip(host.errorLines(), 400);
    } finally {
      const teardown: Obj = await host.stop().then(t => ({ ...t }), (error: unknown) => ({ stopError: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
      observed.teardown = teardown;
      check("teardown", teardown.stopError === undefined && teardown.rootRemoved === true && teardown.hostPortClosed === true, "host.stop() must remove the scratch root and close the host port");
    }
  }
  const file = await writeObservation({ scenario: name, runId: RUN_ID, recordedAt: new Date().toISOString(), obsDir: obsBaseDir(), vitestTmpdir: tmpdir(), checks, observed: clip(observed, 6000) }, name);
  if (failure !== undefined) throw failure;
  const broken = checks.filter(c => !c.ok);
  if (broken.length > 0) throw new Error(`${name}: ${broken.length} check(s) failed (observation: ${file})\n${broken.map(c => `  - ${c.id}: ${c.message}`).join("\n")}`);
  expect(broken).toHaveLength(0);
}

d("cpx background: dispatch, holding and leases on a real v2 host", () => {
  it("a background dispatch returns at once; the root's next step runs before the child ends; the completion is annotated in the next tail", async () => {
    await scenario("background-dispatch", { routing: { engine: "advise", background: { mode: "auto" }, leases: { mode: "off" } } }, async ({ host, observed, check }) => {
      host.provider.holdMarked(HOLD_MARKER, CHILD_HOLD_MS);
      const root = await host.newRoot("cpx background root");
      const call = await host.dispatch(root, { agent: "fast", description: "Implement feature", prompt: `${IMPLEMENT_PROMPT}\n${HOLD_MARKER}`, background: true });
      const rootRequests = primaryRequests(host, root);
      const endEventsAtReturn = (await host.eventsOf(call.childID)).filter(e => /^session\.execution\./.test(e.type)).map(e => e.type);
      observed.ack = clip(resultText(call), 800);
      observed.endEventsAtReturn = endEventsAtReturn;
      observed.tailsBeforeEnd = rootRequests.map(tailOf).map(t => clip(t, 800));
      check("ack", /Running in the background/.test(resultText(call)), "the dispatch result must be the background acknowledgement ([router] Running in the background)");
      check("returned-before-end", endEventsAtReturn.length === 0, `the dispatch returned and the root's next step ran while the child had not ended (end events: ${endEventsAtReturn.join(",")})`);
      check("next-step-ran", rootRequests.length >= 2, `the root must make a request after the dispatch result before the child ends (got ${rootRequests.length} primary requests)`);
      const inFlight = rootRequests.map(tailOf).some(t => t.includes(IN_FLIGHT));
      check("in-flight-tail", inFlight, "a root request made while the child runs must list it in flight in the tail");

      observed.childEnd = await childEnded(host, call.childID);
      await host.settle(root);
      await host.prompt(root, "Continue with the next independent step.");
      const tail = lastTail(host, root);
      observed.tailAfterEnd = clip(tail, 1500);
      check("completion-annotated", tail.includes(COMPLETED_LINE), "the tail of the root's first request after the completion must carry the completion annotation");
      check("not-in-flight", !tail.includes(IN_FLIGHT), "a processed child must leave the in-flight list");
    });
  }, 600_000);

  it("a held verified result: the placeholder first, then the verdict entry with the output", async () => {
    await scenario("background-held", { routing: BG_ROUTING }, async ({ host, observed, check }) => {
      const { root, call } = await heldDispatch(host);
      const verified = path.join(host.project, "held-pass.txt");
      observed.ack = clip(resultText(call), 800);
      check("ack-held", /held until verification finishes/.test(resultText(call)), "the acknowledgement must say the result is held until verification finishes");
      check("tail-held", primaryRequests(host, root).map(tailOf).some(t => t.includes(HELD_LINE)), "a root request made while the child runs must list the held result in the tail");

      await childEnded(host, call.childID);
      // The verdict entry is a `synthetic` message that wakes the parent: wait for a root request that carries it.
      const verdictRequest = await waitFor("a root request carrying the verdict entry", () => primaryRequests(host, root).find(r => historyOf(r).includes("<router-verdict")), 120_000, 500);
      await host.settle(root);
      const requests = primaryRequests(host, root);
      const before = requests.filter(r => r.index < verdictRequest.index);
      const after = requests.filter(r => r.index >= verdictRequest.index);
      observed.verified = verified;
      observed.requestCount = requests.length;
      observed.verdictRequest = verdictRequest.index;
      observed.verdictEntry = clip(historyOf(verdictRequest).slice(historyOf(verdictRequest).indexOf("<router-verdict")), 800);
      observed.placeholderBeforeVerdict = before.map(r => historyOf(r).includes('state=\\"held\\"'));
      check("no-output-before-verdict", before.every(r => !historyOf(r).includes(CHILD_OUTPUT)), `no request before the verdict may carry the child's output (${CHILD_OUTPUT})`);
      check("verdict-entry", /<router-verdict[^>]*verdict=\\?"PASS\\?"/.test(historyOf(verdictRequest)), "the verdict entry must carry verdict PASS");
      check("verdict-output", historyOf(verdictRequest).includes(CHILD_OUTPUT), "the verdict entry must post the held output");
      check("placeholder-stays", after.every(r => historyOf(r).includes('state=\\"held\\"')), "the placeholder stays in the history after the verdict (history keeps the original rendering)");
      check("verdict-once", requests.filter(r => (historyOf(r).match(/<router-verdict/g) ?? []).length > 1).length === 0, "the verdict entry appears once per request");
    });
  }, 600_000);

  it("two children write one file: the second is refused by the lease registry, naming the holder", async () => {
    const options: HostOptions = {
      routing: { engine: "advise", background: { mode: "auto" }, leases: { mode: "enforce", run: "annotate" } },
      prepare: async ({ project }) => {
        await writeFile(path.join(project, SHARED_FILE), "ORIGINAL\n");
        for (const args of [["init", "-q"], ["add", SHARED_FILE], ["-c", "user.email=smoke@example.invalid", "-c", "user.name=smoke", "commit", "-q", "-m", "init"]]) {
          const run = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
          if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
        }
      },
    };
    await scenario("background-leases", options, async ({ host, observed, check }) => {
      const shared = path.join(host.project, SHARED_FILE);
      // The first writer's request that follows its edit result is held: it keeps the lease while the second writer tries the same file.
      const firstHeld = { fired: false };
      front(host).options.delayMs = request => {
        if (firstHeld.fired || !json(request.body).includes(LEASE_ONE) || !lastIsToolResult(request)) return 0;
        firstHeld.fired = true;
        return CHILD_HOLD_MS * 2;
      };
      const edit = (to: string) => scriptLine([{ tool: "edit", input: { path: shared, oldString: "ORIGINAL", newString: to } }], CHILD_OUTPUT);
      const root = await host.newRoot("cpx background leases root");
      const first = await host.dispatch(root, { agent: "fast", description: "First writer", prompt: `${IMPLEMENT_PROMPT}\n${LEASE_ONE}\n${edit("ONE")}`, background: true });
      const firstEdit = await waitFor("the first writer's edit", async () => (await host.hooks()).find(h => h.hook === "after" && h.sessionID === first.childID && h.tool === "edit"), 60_000, 250);
      const second = await host.dispatch(root, { agent: "fast", description: "Second writer", prompt: `${IMPLEMENT_PROMPT}\n${LEASE_TWO}\n${edit("TWO")}`, background: true });
      const secondEdit = await waitFor("the second writer's edit result", async () => (await host.hooks()).find(h => h.hook === "after" && h.sessionID === second.childID && h.tool === "edit"), 60_000, 250);
      observed.firstEdit = clip(firstEdit, 600);
      observed.secondEdit = clip(secondEdit, 800);
      check("first-writes", secondEdit.__t > firstEdit.__t && firstEdit.error === undefined, `the first writer's edit must succeed (${json(firstEdit.error)})`);
      check("second-refused", /is being edited by/.test(json(secondEdit.error)), `the second writer's edit must be refused by the lease registry, naming the holder (got ${json(secondEdit.error)})`);
      await childEnded(host, second.childID);
      await childEnded(host, first.childID);
      const onDisk = await readFile(shared, "utf8");
      observed.sharedFileOnDisk = onDisk;
      check("one-writer", onDisk.includes("ONE") && !onDisk.includes("TWO"), `only the lease holder's edit may land in the shared file (got ${json(onDisk)})`);
    });
  }, 600_000);

  it("a resume of a held child is refused", async () => {
    await scenario("background-resume-refused", { routing: BG_ROUTING }, async ({ host, observed, check }) => {
      const { root, call } = await heldDispatch(host);
      const resume = await host.call(root, "subagent", { agent: "fast", description: "Resume the held child", prompt: "Continue the work.", sessionID: call.childID, background: false });
      const error = json(resume.after.error);
      observed.refusal = clip(error, 800);
      check("refused", /held for verification/.test(error), `the resume must be refused with the held-for-verification message (got ${error})`);
      check("same-child-ends-once", (await childEnded(host, call.childID)) !== "", "the held child still ends normally after the refusal");
    });
  }, 600_000);
});
