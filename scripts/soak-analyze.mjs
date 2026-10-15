#!/usr/bin/env node
/**
 * Offline, read-only A-6.1-3 evidence inventory (not an acceptance certificate).
 * Usage: node scripts/soak-analyze.mjs --observations <dir> [--outcomes <dir>]
 *   [--pending <file>] [--since <ISO>] [--until <ISO>] [--json <out>]
 * Collect at least five working days with MODEL_ROUTER_V2_OBSERVATIONS enabled.
 * Keep original files, including seals; a live/unsealed stream is insufficient evidence.
 * Missing evidence is never a pass. JSON defaults to ./soak-analysis.json, outside input trees.
 * Node >=22; like routing-stats.ts, imports product TS through an extensionless-import loader.
 * Also reads this checkout's git-common-dir/omr-executor. Optional archived journal copies:
 * <observations>/executor/<planId>/events.<seq>.<epoch>.jsonl
 * and history.jsonl. Optional g8-inputs.jsonl there supplies {plan,final,events,rawΣI} to
 * the unmodified service oracle; without authored/frozen inputs g8Ratio is not applicable.
 * Output is created exclusively: choose a new --json path on subsequent runs.
 */
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

// The repo already loads TS via scripts/routing-stats.ts:9-27. A local loader adds
// the same resolution and explicitly strips types without a compiler-API dependency.
if (!process.env.VITEST) register("./soak-loader.mjs", import.meta.url);

const IDS = ["G1", "G2", "G6", "G8", "G9", "G3", "G11"];
export function evidenceStatus(observed, violations) {
  return violations > 0 ? "violated" : observed === 0 ? "not-observed" : observed < 3 ? "insufficient" : "ok";
}

const MAX_LINE = 1024 * 1024;
const MAX_KEYS = 100_000;
const MAX_EXAMPLES = 100;
const OBS_BYTES = 16 * 1024 * 1024;
const rec = x => x !== null && typeof x === "object" && !Array.isArray(x);
const str = x => typeof x === "string" && x.length > 0;
const finite = x => typeof x === "number" && Number.isFinite(x);
function requireFact(ok, message) { if (!ok) throw new Error(message); }
const timestamp = row => finite(row.at) ? row.at : finite(row.createdAt) ? row.createdAt : Date.parse(row.at ?? row.ts);
const reference = (file, line, row = {}) => ({ file, line, id: row.handle ?? row.decisionID ?? row.planId ?? row.callID ?? null,
  at: finite(timestamp(row)) ? new Date(timestamp(row)).toISOString() : null });

/** Unlike readline, an arbitrarily long/torn input line cannot grow the heap without limit. */
async function* lines(file) {
  let parts = [], size = 0, oversized = false, line = 0;
  for await (const chunk of createReadStream(file)) {
    let from = 0;
    while (from < chunk.length) {
      const end = chunk.indexOf(10, from), to = end < 0 ? chunk.length : end;
      size += to - from;
      if (size > MAX_LINE) { oversized = true; parts = []; }
      if (!oversized) parts.push(chunk.subarray(from, to));
      if (end >= 0) {
        yield { text: oversized ? null : Buffer.concat(parts).toString("utf8").replace(/\r$/, ""), line: ++line, complete: true };
        parts = []; size = 0; oversized = false;
      }
      from = end < 0 ? chunk.length : end + 1;
    }
  }
  if (size || oversized) yield { text: oversized ? null : Buffer.concat(parts).toString("utf8"), line: ++line, complete: false };
}

async function productReaders() {
  const [persist, pending, observations, idle, types] = await Promise.all([
    import("../src/routing/outcomes/persist.ts"), import("../src/verify/pending.ts"),
    import("../src/compat/v2-observations.ts"), import("../test/smoke/helpers/cpx-idle-oracle.ts"),
    import("../src/routing/outcomes/types.ts"),
  ]);
  return { ...persist, ...pending, ...observations, ...idle, ...types };
}

export async function resolveInputs(options, env = process.env) {
  const readers = await productReaders();
  requireFact(str(options.observations ?? env.MODEL_ROUTER_V2_OBSERVATIONS), "--observations <dir> is required");
  return {
    observations: path.resolve(options.observations ?? env.MODEL_ROUTER_V2_OBSERVATIONS),
    // Same meaning as routing.outcomes.path; config is not auto-loaded by the product stats CLI either.
    outcomes: readers.resolveOutcomesDir(options.outcomes, { tmpdir: tmpdir(), homedir: homedir() }),
    pending: path.resolve(options.pending ?? path.join(readers.resolvePendingJournalDir({ homedir: homedir(),
      platform: process.platform, xdgStateHome: env.XDG_STATE_HOME }), "pending.jsonl")),
    executor: await executorHome(options.projectRoot ?? process.cwd()),
  };
}

// Read-only equivalent of git-common-dir discovery, without spawning git or opening a LedgerStore.
// Product location: executor/paths.ts:24-25,77,125-127. Worktree gitdir/commondir files are tiny.
async function executorHome(root) {
  const smallText = async file => {
    requireFact((await stat(file)).size <= 64 * 1024, "oversized git path indirection");
    return (await readFile(file, "utf8")).trim();
  };
  try {
    let dir = path.join(root, ".git");
    if ((await stat(dir)).isFile()) {
      const match = /^gitdir: ([^\r\n]+)$/.exec(await smallText(dir));
      requireFact(match, "invalid .git indirection"); dir = path.resolve(root, match[1]);
    }
    try { dir = path.resolve(dir, await smallText(path.join(dir, "commondir"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return path.join(dir, "omr-executor");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function analyze(options) {
  const p = await productReaders(), inputs = await resolveInputs(options);
  const since = options.since === undefined ? -Infinity : Date.parse(options.since);
  const until = options.until === undefined ? Infinity : Date.parse(options.until);
  requireFact(!Number.isNaN(since) && !Number.isNaN(until) && since <= until, "invalid --since/--until interval");
  const selected = at => finite(at) && at >= since && at <= until;
  const criteria = Object.fromEntries(IDS.map(id => [id, { observed: 0, violations: [], violationCount: 0,
    evidence: [], faults: [], faultCount: 0, status: "not-observed" }]));
  const report = { version: 1, inputs, interval: { since: options.since ?? null, until: options.until ?? null }, criteria,
    unreadable: 0, unreadableEvidence: [], coverage: { firstAt: null, lastAt: null, workingDays: 0,
      note: "UTC weekdays containing evidence; not proof of five full working days. Rotations/compaction may remove history." },
    dogfood: { plansRun: 0, tasksIntegrated: 0, childProcesses: 0, restartsRecovered: 0, evidence: [] } };
  const sample = (list, value) => { if (list.length < MAX_EXAMPLES) list.push(value); };
  const fault = (id, source, reason) => { criteria[id].faultCount++; sample(criteria[id].faults, { ...source, reason }); };
  const unreadable = (source, reason, ids = IDS) => {
    report.unreadable++; sample(report.unreadableEvidence, { ...source, reason });
    ids.forEach(id => fault(id, source, `unreadable: ${reason}`));
  };
  const observe = (id, source, count = 1) => { criteria[id].observed += count; sample(criteria[id].evidence, source); };
  const violate = (id, source, reason) => { criteria[id].violationCount++; sample(criteria[id].violations, { ...source, reason }); };
  const days = new Set();
  const cover = at => {
    if (!selected(at)) return;
    const iso = new Date(at).toISOString();
    if (report.coverage.firstAt === null || iso < report.coverage.firstAt) report.coverage.firstAt = iso;
    if (report.coverage.lastAt === null || iso > report.coverage.lastAt) report.coverage.lastAt = iso;
    const weekday = new Date(at).getUTCDay();
    if (weekday > 0 && weekday < 6 && days.size < MAX_KEYS) days.add(iso.slice(0, 10));
  };
  const bounded = (map, key, make) => {
    if (!map.has(key)) {
      requireFact(map.size < MAX_KEYS, `correlation limit (${MAX_KEYS}); narrow the interval or archive inputs`);
      map.set(key, make());
    }
    return map.get(key);
  };
  const handles = new Map(), identities = new Map(), planStreams = new Map(), seen = new Map();
  const integrated = new Map(), launchedPlans = new Map();
  const handle = id => bounded(handles, id, () => ({ registrations: [], settles: [], posted: [], effects: [], annotations: [],
    recovered: [], postedCount: 0, settleCount: 0, effectCount: 0, annotationCount: 0,
    journalRegistered: false, pendingState: undefined, relevant: false, held: false, closed: false }));
  const remember = (h, field, evidence) => {
    h.relevant ||= selected(evidence.ms);
    if (h[field].length < 4) h[field].push(evidence);
  };
  const identity = (parent, call, child) => JSON.stringify([parent, call?.startsWith(`task:${parent}:`) ? call.slice(`task:${parent}:`.length) : call, child]);
  const unique = key => { if (seen.has(key)) return false; bounded(seen, key, () => true); return true; };
  const directory = async (dir, ids) => {
    try { return (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort(); }
    catch (error) {
      if (error.code !== "ENOENT") unreadable({ file: dir }, error.message, ids);
      return [];
    }
  };
  const parseRows = async (file, ids, callback) => {
    try {
      for await (const line of lines(file)) {
        const source = reference(file, line.line);
        try {
          requireFact(line.text !== null && line.complete, "oversized or unterminated JSONL line");
          const row = JSON.parse(line.text);
          requireFact(rec(row), "expected object");
          await callback(row, line.text, reference(file, line.line, row));
        } catch (error) { unreadable(source, error.message, ids); }
      }
    } catch (error) { if (error.code !== "ENOENT") unreadable({ file }, error.message, ids); }
  };

  // Reader is deliberately not createPersister/load: those APIs can quarantine or compact files.
  // parseLogLine and parseTimingLine are the product's read-only validation seams (persist.ts:354,949).
  const modes = Object.fromEntries(["enforce", "shadow", "advise", "static", "sampled", "prior", "off"].map(m => [m, 0]));
  criteria.G1.modes = modes;
  criteria.G1.windowChecked = 0;
  const sources = {
    G1: [path.join(inputs.outcomes, "decisions*.jsonl")],
    G2: [inputs.pending, path.join(inputs.observations, "*.jsonl (completion-effect)")],
    G6: [path.join(inputs.observations, "*.jsonl (scheduler lease/slot/writeConflicts)")],
    G8: [path.join(inputs.observations, "*.jsonl (sealed scheduler)"), "test/smoke/helpers/cpx-idle-oracle.ts:212,508"],
    G9: [inputs.pending, path.join(path.dirname(inputs.pending), "pending.writers"), "completion-effect/restored-hold"],
    G3: [path.join(inputs.outcomes, "decisions*.jsonl (FAIL + explicit C15 marker)")],
    G11: [path.join(inputs.outcomes, "timings*.jsonl"), path.join(inputs.observations, "executor/<plan>/*.jsonl")],
  };
  for (const id of IDS) criteria[id].sources = sources[id];
  criteria.G1.modeAvailability = "decisions.jsonl currently records enforce/shadow/advise only. static/off emit no decision; duration prior is not a routing mode (outcomes/types.ts:71; durations.ts:41). Zero means not observed.";
  for (const name of await directory(inputs.outcomes, ["G1", "G3", "G11"])) {
    const decisionFile = name === p.DECISIONS_FILE || p.DECISIONS_ROTATED_RE.test(name);
    const timingFile = name === p.TIMINGS_FILE || p.TIMINGS_ROTATED_RE.test(name);
    if (!decisionFile && !timingFile) continue;
    await parseRows(path.join(inputs.outcomes, name), decisionFile ? ["G1", "G3"] : ["G11"], (raw, text, source) => {
      const row = decisionFile ? p.parseLogLine(text) : p.parseTimingLine(text);
      requireFact(row && row !== "newer", "invalid/unsupported outcome row");
      if (!selected(timestamp(row))) return;
      cover(timestamp(row));
      if (row.kind === "decision" && !p.isAnnotationRow(row) && unique(`decision:${row.decisionID}`)) {
        observe("G1", source); modes[row.mode] = (modes[row.mode] ?? 0) + 1;
        // DecisionRow currently stores tier/boundsReasons, NOT the effective window (types.ts:632-649).
        // Never reconstruct a historical window from today's config. Accept explicit additive window facts only.
        const window = raw.window ?? raw;
        const order = window.tiers ?? ["fast", "medium", "heavy"];
        const tier = raw.dispatchedTier ?? row.tier;
        if (Array.isArray(order) && order.every(str) && new Set(order).size === order.length
          && order.includes(window.floor) && order.includes(window.ceiling) && order.includes(tier)) {
          const floor = order.indexOf(window.floor), ceiling = order.indexOf(window.ceiling), rank = order.indexOf(tier);
          requireFact(floor <= ceiling, "inverted routing window");
          criteria.G1.windowChecked++;
          if (rank < floor || rank > ceiling) violate("G1", source, `tier ${tier} outside [${window.floor}, ${window.ceiling}]`);
        } else fault("G1", source, "effective [floor, ceiling] / dispatched tier not recorded; window not observed");
      }
      if (row.kind === "verdict" && row.verdict === "fail" && unique(`fail:${row.attemptID}`)) {
        criteria.G3.failVerdicts = (criteria.G3.failVerdicts ?? 0) + 1;
        if (raw.fallback === "C15" || raw.fallback?.marker === "C15") {
          observe("G3", source);
          if (raw.fallback?.forced === false) violate("G3", source, "FAIL fallback explicitly not forced");
        } else fault("G3", source, "FAIL observed, but no C15 fallback marker; fallback not observed");
      }
      if (row.kind === "dispatch-timing" && row.capacity === "usage-limit" && unique(`quota:${row.parentSessionID}:${row.callID}`)) {
        observe("G11", source);
        // Timing proves a quota occurrence, not the ensuing pause. Current timings have no pause field.
        if (raw.paused === false) violate("G11", source, "usage-limit explicitly not paused");
        else if (raw.paused !== true) fault("G11", source, "usage-limit observed; pause not recorded in timing row");
      }
    });
  }

  // Journal format mirrors pending.ts:1648-1665,2298-2352. No TTL filtering: expired history is evidence.
  // Held delivery: src/compat/background.ts:1037-1078 writes posted after synthetic succeeds.
  // Deferred: src/verify/pending.ts:2501-2527 writes state=verified, then resolves the run.
  // processed is dispatch bookkeeping (src/compat/background.ts:1555-1557), NOT a verdict delivery.
  // Late notices are optional (silent background PASS), and cached router_verify replays
  // are intentional (docs/VERIFICATION.md:203-204; src/verify/wiring.ts:3534-3543,3620-3629).
  await parseRows(inputs.pending, ["G2", "G9", "G3"], (row, _text, source) => {
    requireFact(row.v === 1 && str(row.kind), "invalid pending envelope");
    const at = timestamp(row);
    cover(at);
    if (["entry", "hold", "state", "posted", "posting", "tomb"].includes(row.kind)) {
      // A callID-only tomb closes an inflight dispatch, not a verification handle.
      if (row.kind === "tomb" && row.handle === undefined && str(row.callID)) return;
      requireFact(/^vrf_[0-9a-f]{24}$/.test(row.handle), "pending record missing/invalid handle");
      if (["entry", "hold", "state", "posted"].includes(row.kind)) requireFact(finite(at), "pending record missing timestamp");
      const h = handle(row.handle);
      if (row.kind === "entry" || row.kind === "hold") {
        requireFact(str(row.parent ?? row.parentSessionID) && str(row.child ?? row.childSessionID), "registration missing parent/child");
        remember(h, "registrations", { ...source, ms: at });
        h.journalRegistered = true;
        h.pendingState ??= row.state;
        if (str(row.callID)) bounded(identities, identity(row.parent ?? row.parentSessionID, row.callID, row.child ?? row.childSessionID), () => row.handle);
        h.held ||= row.kind === "hold" || row.state === "held";
      } else if (row.kind === "state") {
        requireFact(["unverified", "verifying", "verified", "held"].includes(row.state), "unknown pending state");
        if (row.state === "verified") {
          // Verdict.outcome is optional on legacy verdicts (verify/types.ts:32-41).
          requireFact(rec(row.verdict) && typeof row.verdict.pass === "boolean" && str(row.verdict.method)
            && Array.isArray(row.verdict.reasons) && row.verdict.reasons.every(r => typeof r === "string")
            && (row.verdict.outcome === undefined || ["pass", "fail", "unverifiable"].includes(row.verdict.outcome)), "verified state missing/invalid verdict");
          // persistedRecords can repeat a terminal state without a new run
          // (pending.ts:2355-2362); only another nonterminal->verified transition
          // is a second settlement. Retryable runs return to unverified/held.
          if (h.settleCount === 0 || h.pendingState !== "verified") {
            h.settleCount++; remember(h, "settles", { ...source, ms: at, priorJournalRegistration: h.journalRegistered });
          }
          h.closed = true;
        }
        h.pendingState = row.state;
      } else if (row.kind === "posted") {
        h.held = true; h.closed = true; h.postedCount++;
        remember(h, "posted", { ...source, ms: at, priorJournalRegistration: h.journalRegistered });
      } else if (row.kind === "tomb") h.tomb = { ...source, ms: at };
    }
  });

  // Marks are transient current-writer evidence (pending.ts:1456,1628), NOT a restart log.
  criteria.G9.writerMarks = 0;
  const marksDir = path.join(path.dirname(inputs.pending), "pending.writers");
  for (const name of await directory(marksDir, ["G9"])) {
    await parseRows(path.join(marksDir, name), ["G9"], (row, _text, source) => {
      requireFact(Number.isSafeInteger(row.pid) && row.pid > 0 && str(row.token) && finite(row.at), "invalid writer mark");
      criteria.G9.writerMarks++; sample(criteria.G9.evidence, { ...source, kind: "current-writer-mark", pid: row.pid });
    });
  }

  // Product bounds each observation file to 16 MiB / 50,000 records. Stream all other logs;
  // keep at most ONE bounded observation file for the unmodified reconstruct+assert oracle.
  const observationFiles = (await directory(inputs.observations, ["G2", "G6", "G8", "G9"])).filter(n => n.endsWith(".jsonl"));
  const readObservation = async name => {
    const file = path.join(inputs.observations, name), text = [];
    requireFact((await stat(file)).size <= OBS_BYTES, "oversized observation file");
    let bytes = 0;
    for await (const line of lines(file)) {
      requireFact(line.complete && line.text !== null, `truncated/oversized observation line ${line.line}`);
      bytes += Buffer.byteLength(line.text) + 1;
      requireFact(bytes <= OBS_BYTES && text.length <= p.OBSERVATION_MAX_EVENTS, "observation stream exceeds product bounds");
      text.push(line.text);
    }
    const rows = p.checkV2ObservationStream(text);
    let last = -Infinity;
    for (const row of rows) { requireFact(row.at >= last, "observation clock moved backwards"); last = row.at; }
    requireFact(JSON.parse(text.at(-1)).at >= last, "seal clock moved backwards");
    return { file, text: text.join("\n") + "\n", rows };
  };
  // First pass establishes owning streams, independently of filename order and time filtering.
  const streams = new Map();
  for (const name of observationFiles) {
    try {
      const capture = await readObservation(name);
      const stream = JSON.parse(capture.text.split("\n", 1)[0]).stream;
      requireFact(!streams.has(stream), `duplicate stream ${stream}`);
      bounded(streams, stream, () => name);
      for (const row of capture.rows) if (row.family === "scheduler") {
        const owners = bounded(planStreams, row.planId, () => new Set()); owners.add(stream);
      }
    } catch (error) { unreadable({ file: path.join(inputs.observations, name) }, error.message, ["G2", "G6", "G8", "G9"]); }
  }

  // Further processing is below; streams failing completeness never contribute passing evidence.
  await analyzeObservations();
  finalizeHandles();
  report.coverage.workingDays = days.size;
  for (const id of IDS) {
    const c = criteria[id];
    c.status = evidenceStatus(c.observed, c.violationCount);
    if (c.status === "ok" && c.faultCount) c.status = "insufficient";
    if (id === "G8" && c.status === "not-observed" && c.faultCount) c.status = "insufficient";
    c.label = c.status === "not-observed" ? "not observed" : c.status;
    c.evidenceTruncated = c.observed > c.evidence.length;
  }
  return report;

  async function analyzeObservations() {
    criteria.G6.sharedReads = 0;
    criteria.G6.slotRows = 0;
    criteria.G6.scope = "Observed intra-plan writeConflicts + successful lease lifetimes. Cross-plan logical paths and shared reads are not in the current wire format (executor/observations.ts:200-209).";
    criteria.G8.g8Ratio = "not applicable";
    criteria.G8.inventory = "Idle episodes reconstructed independently; no persisted ledger fragment inventory is inferred from idle-close.";
    const lost = new Map();
    for (const name of streams.values()) {
      const file = path.join(inputs.observations, name);
      try {
        const capture = await readObservation(name), plans = new Map();
        // Lease acquisition/release facts are scoped to this process. Multiple streams of a plan
        // invalidate continuity; do not join lifetimes across a crash or adapter reattachment.
        for (const [index, row] of capture.rows.entries()) {
          const source = reference(file, index + 1, row), at = row.at;
          cover(at);
          if (row.family === "completion-effect") {
            requireFact(str(row.source) && str(row.parentSessionID) && str(row.callID), "invalid completion identity");
            const handleID = row.handle ?? identities.get(identity(row.parentSessionID, row.callID, row.childSessionID));
            if (handleID !== undefined) {
              requireFact(str(handleID), "invalid completion handle");
              const h = handle(handleID);
              if (row.effect === "deferred-register") {
                remember(h, "registrations", { ...source, ms: at, stream: row.stream });
                bounded(identities, identity(row.parentSessionID, row.callID, row.childSessionID), () => handleID);
              }
              if (row.effect === "verification-settle") {
                h.effectCount++; remember(h, "effects", { ...source, ms: at, stream: row.stream });
              }
              if (row.effect === "annotation-delivery" && row.source === "held-synthetic") {
                h.held = true; h.annotationCount++;
                remember(h, "annotations", { ...source, ms: at, stream: row.stream });
              }
              if (row.source === "restored-hold" && row.effect === "finish-dispatch") {
                remember(h, "recovered", { ...source, ms: at, stream: row.stream });
              }
            }
            continue;
          }
          if (row.family !== "scheduler") continue;
          requireFact(str(row.planId) && str(row.parentSessionID) && str(row.action) && rec(row.state), "invalid scheduler identity/state");
          const state = row.state;
          const plan = bounded(plans, row.planId, () => ({ parent: row.parentSessionID, finalSeq: undefined,
            conflicts: undefined, held: new Map(), snapshots: 0 }));
          requireFact(plan.parent === row.parentSessionID, "plan parent changed");
          if (row.action === "attach" || row.action === "ledger") {
            requireFact(Array.isArray(state.tasks) && finite(state.ledgerSeq), "invalid graph snapshot");
            plan.finalSeq = state.ledgerSeq;
            plan.conflicts = state.writeConflicts;
            plan.snapshots++;
            for (const task of state.tasks) {
              requireFact(str(task.id) && str(task.state) && Array.isArray(task.attempts), "invalid task snapshot");
              if (task.state === "integrated" && selected(at) && !integrated.has(`${row.planId}:${task.id}`)) {
                bounded(integrated, `${row.planId}:${task.id}`, () => true);
                report.dogfood.tasksIntegrated++; sample(report.dogfood.evidence, { ...source, taskId: task.id, kind: "integrated" });
              }
              for (const a of task.attempts) if (a.outcome === "lost") {
                // Redacted snapshots omit attempt.detail: 'lost' alone cannot establish restart.
                if (!lost.has(`${row.planId}:${task.id}:${a.n}`)) {
                  bounded(lost, `${row.planId}:${task.id}:${a.n}`, () => true);
                  report.dogfood.lostAttempts = (report.dogfood.lostAttempts ?? 0) + 1;
                }
              }
            }
          }
          if (row.action === "launch" && selected(at) && !launchedPlans.has(row.planId)) {
            bounded(launchedPlans, row.planId, () => true); report.dogfood.plansRun++;
            sample(report.dogfood.evidence, { ...source, kind: "plan-launch" });
          }
          if (row.action === "lease-acquire") {
            requireFact(str(state.taskRef) && typeof state.ok === "boolean", "invalid lease acquisition");
            if (!state.ok) continue;
            const taskId = state.taskRef.startsWith(`${row.planId}:`) ? state.taskRef.slice(row.planId.length + 1) : state.taskRef;
            if (selected(at)) {
              observe("G6", source);
              if (!Array.isArray(plan.conflicts) || planStreams.get(row.planId)?.size !== 1) {
                fault("G6", source, "missing conflict inventory or lease continuity across streams");
              } else {
                requireFact(plan.conflicts.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(str)), "invalid writeConflicts");
                for (const pair of plan.conflicts) {
                  const other = pair[0] === taskId ? pair[1] : pair[1] === taskId ? pair[0] : null;
                  if (other !== null && plan.held.has(other)) violate("G6", source,
                    `overlapping writer leases: ${taskId} and ${other} (same logical/prefix path per writeConflicts; acquired at ${plan.held.get(other).at})`);
                }
              }
            }
            bounded(plan.held, taskId, () => source);
          } else if (row.action === "lease-release") {
            requireFact(str(state.taskRef), "invalid lease release");
            plan.held.delete(state.taskRef.startsWith(`${row.planId}:`) ? state.taskRef.slice(row.planId.length + 1) : state.taskRef);
          } else if (row.action.startsWith("slot-")) {
            requireFact(Array.isArray(state.slots), "missing physical slot snapshot");
            const names = state.slots.map(s => s.slot);
            requireFact(new Set(names).size === names.length, "duplicate physical slot identity");
            if (selected(at)) criteria.G6.slotRows++;
          }
        }
        for (const [planId, plan] of plans) {
          const source = { file, id: planId };
          if (planStreams.get(planId)?.size !== 1) {
            fault("G8", source, "evidence insufficient: plan spans multiple streams; no continuous sealed lifecycle"); continue;
          }
          try {
            const oracle = p.reconstructIdleEpisodes([{ file, text: capture.text }], {
              planId, parentSessionID: plan.parent, finalLedgerSeq: plan.finalSeq,
            });
            // Never clip rows before reconstruction. Select complete episodes by their end time;
            // a 10,001ms episode crossing --since must not become a shorter passing episode.
            for (const episode of oracle.episodes) {
              if (!selected(episode.toMs)) continue;
              const evidence = { file, id: planId, at: new Date(episode.toMs).toISOString(),
                fromAt: new Date(episode.fromMs).toISOString(), ms: episode.ms, fromSeq: episode.fromSeq, toSeq: episode.toSeq };
              observe("G8", evidence);
              if (episode.ms > p.G8_IDLE_CEILING_MS) violate("G8", evidence, `idle episode ${episode.ms} ms > 10,000 ms`);
            }
            // Required smoke assertion too. Only known bound failures are violations; every other
            // oracle error means insufficient evidence, never a scheduler violation.
            p.assertG8IdleEpisodes(oracle.episodes, []);
          } catch (error) {
            // Only the assertion's direct bound failure was already counted above. A
            // reconstruction fault can mention a *possible* overlong episode too
            // (unknown eligibility); that is insufficient evidence, never a violation.
            if (!/^G8 observations: idle-with-ready episode \d+ ms exceeds 10,000 ms/.test(error.message))
              fault("G8", source, `evidence insufficient: ${error.message}`);
          }
        }
      } catch (error) { unreadable({ file }, error.message, ["G2", "G6", "G8", "G9"]); }
    }
    report.dogfood.note = "Observation launch rows are not child-process launcher records; lost attempts omit their reason. Exact launcher/restart counts require executor journals.";
    await executorLogs();
  }
  function finalizeHandles() {
    criteria.G2.registrations = 0;
    criteria.G2.open = 0;
    criteria.G2.heldAnnotationAttempts = 0;
    criteria.G2.settleInvocations = 0;
    criteria.G2.deliverySemantics = "Held: each journal posted is one durable delivery (compat/background.ts:1037-1078); matching held-synthetic observations corroborate it, never add another. Deferred: terminal state=verified publishes the cached verdict and resolves the run (verify/pending.ts:2501-2527); repeated terminal snapshots/cached replays are not new settlements. processed closes dispatch bookkeeping, not verification. Late notices are optional; background PASS is silent (docs/VERIFICATION.md:203-204). Parent-message receipt is not independently logged.";
    criteria.G9.restartEvidence = "restored-hold finish-dispatch observations prove adoption of persisted holds. Writer marks describe current writers, not historical restarts; journal v1 rows carry no process token.";
    for (const [id, h] of handles) {
      const delivery = h.held ? h.posted : h.settles;
      const deliveries = h.held ? h.postedCount : h.settleCount;
      const terminal = h.held || h.closed || deliveries > 0;
      if (!h.relevant) continue;
      criteria.G2.heldAnnotationAttempts += h.annotationCount;
      criteria.G2.settleInvocations += h.effectCount;
      const source = delivery[0] ?? h.settles[0] ?? h.posted[0] ?? h.registrations[0] ?? { id };
      if (h.registrations.length) criteria.G2.registrations++;
      if (terminal) {
        observe("G2", { ...source, id, deliveries, deliveryKind: h.held ? "posted" : "verified-state",
          corroboration: (h.held ? h.annotations : h.effects).map(e => ({ file: e.file, line: e.line, at: e.at })) });
        const orphan = delivery.find(e => !e.priorJournalRegistration
          && !h.registrations.some(r => r.stream && r.ms <= e.ms));
        if (orphan || !h.registrations.length) violate("G2", { ...(orphan ?? source), id }, "delivery/settlement without a prior hold/registration");
        if (deliveries !== 1) violate("G2", { ...source, id }, `${h.held ? "held" : "settled"} handle has ${deliveries} deliveries; expected exactly one`);
      } else {
        criteria.G2.open++;
        // verification-settle precedes c.settle and also observes retryable/error
        // runs (wiring.ts:3553-3557,3605-3610). Invocations alone cannot prove a
        // terminal delivery; do not turn retries into duplicate verdicts.
        if (h.effectCount && !h.registrations.length) violate("G2", { ...h.effects[0], id }, "settle invocation without a registration");
        fault("G2", { ...source, id }, "deferred terminal verified state not observed; settle invocations and processed records do not prove delivery");
      }
      const firstRegistration = Math.min(...h.registrations.map(e => e.ms).filter(finite));
      const recovery = h.recovered.find(e => e.ms > firstRegistration);
      if (recovery && terminal) {
        observe("G9", { ...recovery, id, deliveries });
        const after = delivery.filter(e => e.ms >= recovery.ms).length;
        if (deliveries !== 1 || after !== 1) violate("G9", { ...source, id }, `pending across recovery: ${deliveries} total / ${after} post-restart deliveries (lost or duplicated)`);
      } else if (recovery) fault("G9", { ...recovery, id }, "recovered pending handle remains open; post-restart settlement not observed");
    }
  }
  async function executorLogs() {
    // Optional read-only journal captures: <observations>/executor/<planId>/{events.*,history}.jsonl.
    // Real executor journals normally live under the git common dir's omr-executor home
    // (paths.ts:24-25; ledger.ts:1675-1681). They are NOT created/copied by this analyzer.
    const roots = [path.join(inputs.observations, "executor"), ...(inputs.executor ? [inputs.executor] : [])];
    for (const root of roots) await readRoot(root);
    async function readRoot(root) {
    let plans;
    try { plans = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()); }
    catch (error) { if (error.code !== "ENOENT") unreadable({ file: root }, error.message, ["G11"]); return; }
    for (const entry of plans) {
      const planId = entry.name, dir = path.join(root, planId);
      let fragments = [], fragmentBytes = 0;
      const processEvent = (row, source) => {
        source = { ...source, id: planId };
        if (!selected(Date.parse(row.at)) || !unique(`event:${planId}:${row.seq}`)) return;
        cover(Date.parse(row.at));
        if (row.type === "metric" && row.metric?.name === "counter" && row.metric.key === "child-process") {
          requireFact(rec(row.metric.labels), "invalid child-process labels");
          report.dogfood.childProcesses++;
          if (unique(`plan-run:${planId}`)) report.dogfood.launcherPlans = (report.dogfood.launcherPlans ?? 0) + 1;
          if (!launchedPlans.has(planId)) { bounded(launchedPlans, planId, () => true); report.dogfood.plansRun++; }
          sample(report.dogfood.evidence, { ...source, kind: "child-process" });
        }
        if (row.type === "attempt-ended" && row.outcome === "lost" && row.detail === "restart") {
          report.dogfood.restartsRecovered++; sample(report.dogfood.evidence, { ...source, kind: "lost-restart" });
        }
        if (row.type === "task-integrated") {
          report.dogfood.journalTasksIntegrated = (report.dogfood.journalTasksIntegrated ?? 0) + 1;
          if (!integrated.has(`${planId}:${row.taskId}`)) {
            bounded(integrated, `${planId}:${row.taskId}`, () => true); report.dogfood.tasksIntegrated++;
          }
        }
        if (row.type === "inbox-added" && row.item?.kind === "usage-limit") observe("G11", { ...source, id: row.item.id, kind: "usage-limit-inbox" });
        if (row.type === "metric" && row.metric?.name === "capacity" && row.metric.errorType === "provider.quota") {
          observe("G11", { ...source, kind: "provider.quota" });
          if (row.metric.change !== "pause") violate("G11", source, "provider.quota did not pause provider");
        }
        if (row.type === "metric" && row.metric?.name === "idle-with-ready") {
          fragmentBytes += Buffer.byteLength(JSON.stringify(row.metric));
          requireFact(fragmentBytes <= OBS_BYTES, "idle fragment inventory exceeds bound");
          fragments.push(row.metric);
        }
      };
      const names = await directory(dir, ["G8", "G11"]);
      const epochs = names.flatMap(name => { const m = /^events\.\d+\.(\d+)\.jsonl$/.exec(name); return m ? [Number(m[1])] : []; });
      const epoch = Math.max(-1, ...epochs);
      for (const name of names) {
        if (name !== "history.jsonl" && !/^events\.\d+\.\d+\.jsonl$/.test(name)) continue;
        if (name !== "history.jsonl" && Number(/^events\.\d+\.(\d+)\.jsonl$/.exec(name)[1]) !== epoch) continue;
        let batch = [], bytes = 0, priorSeq, batchId;
        await parseRows(path.join(dir, name), ["G8", "G11"], (row, _text, source) => {
          // Journal batches commit only at last:true (types.ts:598-604). A torn batch
          // is unreadable, not a sequence of individually passing facts.
          requireFact(Number.isSafeInteger(row.seq) && row.seq > 0 && Number.isSafeInteger(row.batch)
            && typeof row.last === "boolean" && str(row.type) && finite(Date.parse(row.at)), "invalid executor event envelope");
          if (name === "history.jsonl") { processEvent(row, source); return; } // history is intentionally sparse
          requireFact(priorSeq === undefined || row.seq === priorSeq + 1, "executor sequence gap");
          priorSeq = row.seq;
          if (!batch.length) { batchId = row.seq; requireFact(row.batch === row.seq, "batch missing beginning"); }
          requireFact(row.batch === batchId, "mixed executor batches");
          bytes += Buffer.byteLength(_text); requireFact(bytes <= OBS_BYTES, "oversized executor batch");
          batch.push([row, source]);
          if (row.last) { for (const [event, ref] of batch) processEvent(event, ref); batch = []; bytes = 0; }
        });
        if (batch.length) unreadable({ file: path.join(dir, name) }, "uncommitted executor batch", ["G8", "G11"]);
      }
      if (fragments.length) criteria.G8.ledgerFragments = (criteria.G8.ledgerFragments ?? 0) + fragments.length;
      if (fragments.length) {
        try {
          const owners = [...(planStreams.get(planId) ?? [])];
          requireFact(owners.length === 1, "ledger fragments have no continuous sealed owning stream");
          const capture = await readObservation(streams.get(owners[0]));
          const rows = capture.rows.filter(r => r.family === "scheduler" && r.planId === planId);
          const graph = rows.filter(r => r.action === "attach" || r.action === "ledger").at(-1);
          const oracle = p.reconstructIdleEpisodes([{ file: capture.file, text: capture.text }], {
            planId, parentSessionID: graph?.parentSessionID, finalLedgerSeq: graph?.state.ledgerSeq,
          });
          p.assertG8IdleEpisodes(oracle.episodes, fragments);
        } catch (error) { fault("G8", { file: dir, id: planId }, `evidence insufficient: ${error.message}`); }
      }
      // A ratio requires authored durations + frozen pre-run graph, not estimates.
      // Optional g8-inputs.jsonl contains {plan, final, events, rawΣI}; this is an
      // explicit oracle input export, NOT a format the production router emits.
      await parseRows(path.join(dir, "g8-inputs.jsonl"), ["G8"], async (row, _text, source) => {
        requireFact(rec(row.plan) && row.plan.planId === planId && rec(row.final) && Array.isArray(row.events) && finite(row.rawΣI), "invalid G8 oracle inputs");
        const owner = [...(planStreams.get(planId) ?? [])].map(stream => streams.get(stream));
        requireFact(owner.length === 1, "G8 inputs require one continuous owning stream");
        const files = [];
        for (const name of owner) { const capture = await readObservation(name); files.push({ file: capture.file, text: capture.text }); }
        const { reconstructG8 } = await import("../test/smoke/helpers/cpx-g8-oracle.ts");
        try {
          const result = reconstructG8(row.plan, row.final, row.events, files, row.rawΣI);
          requireFact(finite(result.bound) && result.bound > 0, "invalid G8 bound");
          criteria.G8.g8Ratio = rec(criteria.G8.g8Ratio) ? criteria.G8.g8Ratio : {};
          criteria.G8.g8Ratio[planId] = { value: result.makespan / result.bound, source };
        } catch (error) { fault("G8", source, `evidence insufficient: ${error.message}`); }
      });
    }
    }
  }
}

export function formatReport(report) {
  const rows = [["Criterion", "Observed", "Violations", "Unreadable/faults", "Status", "Evidence"]];
  for (const [id, c] of Object.entries(report.criteria)) rows.push([id, c.observed, c.violationCount, c.faultCount,
    c.label, c.evidence[0]?.file ?? c.faults[0]?.file ?? "none"]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => String(row[i]).length)));
  return rows.map(row => row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ")).join("\n")
    + `\nUnreadable: ${report.unreadable}; UTC working days with evidence: ${report.coverage.workingDays} (target >= 5)\n`
    + `G1 modes: ${JSON.stringify(report.criteria.G1.modes)}; windows checked: ${report.criteria.G1.windowChecked}\n`
    + `G6 shared reads: ${report.criteria.G6.sharedReads ?? 0} (not observed when zero); slot rows: ${report.criteria.G6.slotRows ?? 0}\n`
    + `G8 ratio: ${JSON.stringify(report.criteria.G8.g8Ratio)}\n`
    + `Dogfood: ${JSON.stringify(report.dogfood)}\n`
    + `Absence is not a pass. Samples capped at ${MAX_EXAMPLES}; totals are not capped. See JSON for violations and evidence gaps.\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    requireFact(["observations", "outcomes", "pending", "since", "until", "json"].includes(key)
      && argv[i].startsWith("--") && str(argv[i + 1]) && !argv[i + 1].startsWith("--") && !(key in options), `invalid argument: ${argv[i]}`);
    options[key] = argv[++i];
  }
  const inputs = await resolveInputs(options), output = path.resolve(options.json ?? "soak-analysis.json");
  const canonical = async file => {
    try { return await realpath(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(file);
      return parent === file ? file : path.join(await canonical(parent), path.basename(file));
    }
  };
  const target = await canonical(output);
  const folded = value => process.platform === "win32" ? value.toLowerCase() : value;
  const under = (file, dir) => { const rel = path.relative(folded(dir), folded(file)); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
  for (const dir of [inputs.observations, inputs.outcomes, ...(inputs.executor ? [inputs.executor] : [])]) {
    let root; try { root = await realpath(dir); } catch (error) { if (error.code !== "ENOENT") throw error; root = dir; }
    requireFact(!under(target, root), "--json must be outside the observation/outcome log directories");
  }
  requireFact(folded(target) !== folded(await canonical(inputs.pending)), "--json must not overwrite the pending journal");
  const report = await analyze(options);
  // Exclusive creation also prevents hard-link aliases and existing arbitrary files from being overwritten.
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(formatReport(report));
  process.stdout.write(`JSON: ${output}\n`);
  return Object.values(report.criteria).some(c => c.status === "violated") ? 1 : report.unreadable ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`soak-analyze: ${error.message}`); process.exitCode = 2; });
}
