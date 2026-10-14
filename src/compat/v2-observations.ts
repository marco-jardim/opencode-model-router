/**
 * Read-only v2 diagnostics. No global instance, config key, timer, host call or v1 activation.
 * The only production creator is v2.ts. Writers receive detached JSON, never live router objects.
 *
 * Wire format v1: {v, stream, seq, at, family, ...payload}. Families are native-args,
 * completion-effect and scheduler. A final {v, stream, seq, at, kind:"end", ...counts}
 * seals the stream. Consumers MUST require contiguous seq from 1, an end record, and
 * dropped=failed=0; absence, overflow, serialization faults and writer faults are not evidence.
 *
 * Native arguments are own-property fingerprints, not text: {type, digest} per field,
 * with background {present, type, value?} separately (value is ONLY a boolean).
 * Digests are stream-local HMAC-SHA256 of canonical, type-tagged values. Thus prompt,
 * description, paths, arbitrary extension values and credentials never leave the process,
 * but equality and key presence (including own undefined) remain testable. Unknown keys
 * are HMAC'd too. No HMAC key is persisted. Unsupported/accessor/overlarge values drop
 * the event, never inspect a getter or change the operation.
 *
 * Smoke: set MODEL_ROUTER_V2_OBSERVATIONS to an existing diagnostic directory before
 * v2 setup. Collect <pid>-<file-id>.jsonl after adapter disposal. Each setup has its own
 * stream (do not combine seq across streams). No directory creation and no writes off.
 * `checkV2ObservationStream` implements that collection check. Shared timing recorders
 * write each invocation to ONE live holder's stream; collect ALL files for the run.
 *
 * Completion payload: {effect, source, parentSessionID, callID, childSessionID,
 * handle?, outcome?}. The attempt key is the three identity fields, NOT child alone.
 * Count rows per effect AND source: background-delta and deferred-change are distinct
 * capture invocations. Delivery sources distinguish foreground-result, completed-provider,
 * held-synthetic and unheld-synthetic (every retry counts). Rows precede invocations,
 * including failed ones; they do not assert successful persistence/delivery.
 *
 * Scheduler payload: {planId,parentSessionID,action,state}. Ledger/attach state is
 * {ledgerSeq,status,maxParallel,tasks:[{id,state,kind,phase,p50,attempts:[{n,callID,
 * childSessionID,outcome}]}],edges:[{from,to}],phases:[{id,gate,paused}],
 * writeConflicts:[[taskId,taskId]]}. A graph >256 tasks invalidates the stream, not a
 * silently truncated snapshot. Ledger rows are emitted at the actual committed swap,
 * including collaborators' batches, before any subsequent await.
 * Runtime state is {clockMs,ledgerSeq,orchIdle,passive,recovering,disposed,latch,
 * inFlight:[taskId],tokens:["task#attempt"],detail}. Actions/detail:
 * - route {taskId,provider,heavy}; route-unavailable {taskId}
 * - capacity-free {provider,heavy,free}; capacity-reserve {taskId,attempt,provider,
 *   heavy,token,force}; capacity-release {taskId,attempt,token,result}
 * - lease-eligibility {writers:[taskId],holder:null|{planId,taskId}}
 * - launch-gate {ok,ready:[taskId]} or {taskId,attempt,ok}
 * - launch-prepare {taskId,attempt}; launch {taskId,attempt,callID,provider,heavy}
 * - launch-step-end {taskId,attempt,result}; orchestrator {event}
 * - runtime-attach, activation, activation-end, promote, schedule, abort, dispose,
 *   detach, lease-released-notification: detail=null.
 * Other raw states: capacity-init {maxParallel,providers:[{provider,limit,holdUntilMs,
 * lastSignalAtMs,pausedUntilMs}]}; provider {provider,change,from,to,until};
 * lease-acquire {taskRef,ok}; lease-release {taskRef}.
 * Provider labels are stream-local keyed tokens, never configuration text. These
 * observations never call updateIdle or query a controller/host just for diagnostics.
 * Unqueried route/lease/gate facts are UNKNOWN, not eligible. Reconstruct from the raw
 * graph + control transitions + original query results; do not use the ready list as
 * the oracle. `at` is epoch ms at observation entry; clockMs is the runtime clock.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export const OBSERVATION_MAX_EVENTS = 50_000;
export const OBSERVATION_MAX_BYTES = 16 * 1024 * 1024;
export const OBSERVATION_MAX_ROW_BYTES = 64 * 1024;

export interface ArgumentFingerprint { type: string; digest: string }
export interface ArgumentObservation {
  fields: Record<string, ArgumentFingerprint>;
  background: { present: boolean; type: string; value?: boolean };
}
export interface CompletionIdentity {
  parentSessionID: string;
  callID: string;
  childSessionID: string | null;
}
export type CompletionEffect = "change-set-capture" | "finish-dispatch" | "deferred-register"
  | "verification-enqueue" | "verification-settle" | "annotation-delivery" | "timing-row-write";
type Scalar = string | number | boolean | null;
export type ObservationValue = Scalar | readonly ObservationValue[] | { readonly [key: string]: ObservationValue };
export type ObservationData =
  | { family: "native-args"; callID: string; sessionID: string; before: ArgumentObservation; after: ArgumentObservation;
      backgroundDecision: boolean | null }
  | ({ family: "completion-effect"; effect: CompletionEffect; source: string; handle?: string; outcome?: string } & CompletionIdentity)
  | { family: "scheduler"; planId: string; parentSessionID: string; action: string; state: ObservationValue };
export type ObservationRecord = ObservationData & { v: 1; stream: string; seq: number; at: number };
export interface ObservationCounts { attempted: number; written: number; dropped: number; failed: number }
export interface V2Observations {
  record(make: (args: (value: unknown) => ArgumentObservation) => ObservationData): void;
  counts(): Readonly<ObservationCounts>;
  close(): void;
}

const ARG_KEYS = new Set(["prompt", "description", "agent", "subagent_type", "sessionID", "task_id", "model", "background",
  "cwd", "workdir", "workRoot", "variant", "temperature", "maxTokens"]);

/** No getters/toJSON, bounded traversal, and explicit type tags (undefined is not absence). */
function canonical(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) throw new Error("observation value bound");
    if (v === null) return ["null"];
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (bytes > 2 * 1024 * 1024) throw new Error("observation text bound");
      return ["string", v];
    }
    if (typeof v === "undefined") return ["undefined"];
    if (typeof v === "boolean") return ["boolean", v];
    if (typeof v === "number") return ["number", Object.is(v, -0) ? "-0" : String(v)];
    if (typeof v !== "object" || Object.getOwnPropertySymbols(v).length > 0) throw new Error("unsupported observation value");
    const proto: unknown = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) throw new Error("unsupported observation object");
    const entries = Object.entries(Object.getOwnPropertyDescriptors(v)).sort(([a], [b]) => a.localeCompare(b));
    return [Array.isArray(v) ? "array" : "object", entries.map(([k, d]) => {
      bytes += Buffer.byteLength(k);
      if (bytes > 2 * 1024 * 1024) throw new Error("observation key bound");
      if (!("value" in d)) throw new Error("observation accessor");
      return [k, walk(d.value, depth + 1)];
    })];
  };
  return JSON.stringify(walk(value, 0));
}

export function createV2Observations(options: {
  /** Synchronous, detached JSONL only. Never awaited or allowed to throw into the caller. */
  write(line: string): void;
  now?: () => number;
  maxEvents?: number;
  maxBytes?: number;
}): V2Observations {
  const stream = randomUUID();
  const key = randomBytes(32);
  const digest = (v: unknown): string => createHmac("sha256", key).update(canonical(v)).digest("hex");
  const args = (value: unknown): ArgumentObservation => {
    if (value === null || typeof value !== "object") throw new Error("non-object arguments");
    canonical(value); // Bound the ENTIRE argument bag, not each field separately.
    const fields: Record<string, ArgumentFingerprint> = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [name, d] of Object.entries(descriptors)) {
      if (!("value" in d)) throw new Error("argument accessor");
      fields[ARG_KEYS.has(name) ? name : `key:${digest(name)}`] = { type: d.value === null ? "null" : typeof d.value, digest: digest(d.value) };
    }
    const bg = descriptors.background;
    return { fields, background: { present: bg !== undefined, type: bg === undefined ? "absent" : typeof bg.value,
      ...(typeof bg?.value === "boolean" ? { value: bg.value } : {}) } };
  };
  const counts: ObservationCounts = { attempted: 0, written: 0, dropped: 0, failed: 0 };
  const bound = (n: number | undefined, max: number): number => n !== undefined && Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : max;
  const maxEvents = bound(options.maxEvents, OBSERVATION_MAX_EVENTS);
  const maxBytes = bound(options.maxBytes, OBSERVATION_MAX_BYTES);
  let bytes = 0;
  let closed = false;
  let recording = false;
  const stamp = (): number => options.now?.() ?? Date.now();
  return {
    record(make) {
      if (closed) return;
      const seq = ++counts.attempted;
      if (recording || seq > maxEvents) { counts.dropped++; return; }
      recording = true;
      try {
        const at = stamp();
        const line = JSON.stringify({ ...make(args), v: 1, stream, seq, at }, (name, value: unknown) =>
          name === "provider" && typeof value === "string" ? `provider:${digest(value)}` : value) + "\n";
        const size = Buffer.byteLength(line);
        if (size > OBSERVATION_MAX_ROW_BYTES || bytes + size > maxBytes) { counts.dropped++; return; }
        // Charge failed writes too: even a writer that writes then throws cannot exceed the byte bound.
        bytes += size;
        options.write(line);
        counts.written++;
      } catch { counts.failed++; }
      finally { recording = false; }
    },
    counts: () => ({ ...counts }),
    close() {
      if (closed) return;
      closed = true;
      try { options.write(JSON.stringify({ v: 1, stream, seq: counts.attempted + 1, at: stamp(), kind: "end", ...counts }) + "\n"); }
      catch { counts.failed++; }
    },
  };
}

/** One defensive seam for every call site, including an injected/broken observer. Off never evaluates make. */
export function observeV2(sink: V2Observations | undefined, make: Parameters<V2Observations["record"]>[0]): void {
  if (sink === undefined) return;
  try { sink.record(make); } catch { /* Diagnostics must not affect the operation. */ }
}

/** Adapter-injected callback: the timing recorder knows only its detached write identity, not this diagnostic layer. */
export function timingWriteObserver(sink: V2Observations | undefined): ((row: Readonly<CompletionIdentity & { outcome: string }>) => void) | undefined {
  if (sink === undefined) return undefined;
  return (row) => observeV2(sink, () => ({ family: "completion-effect", effect: "timing-row-write", source: "append-timings",
    parentSessionID: row.parentSessionID, callID: row.callID, childSessionID: row.childSessionID, outcome: row.outcome }));
}

/** The caller must be v2; v1 never reads this environment variable. Failure leaves diagnostics off. */
export function openV2Observations(env: NodeJS.ProcessEnv = process.env): V2Observations | undefined {
  const dir = env.MODEL_ROUTER_V2_OBSERVATIONS;
  if (!dir) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, `${process.pid}-${randomUUID()}.jsonl`), "wx", 0o600);
    const file = fd;
    const sink = createV2Observations({ write: (line) => {
      const data = Buffer.from(line);
      let offset = 0;
      while (offset < data.length) {
        const n = writeSync(file, data, offset, data.length - offset);
        if (n <= 0) throw new Error("observation write stalled");
        offset += n;
      }
    } });
    let closed = false;
    return { record: sink.record, counts: sink.counts, close() {
      if (closed) return;
      closed = true;
      sink.close();
      try { closeSync(file); } catch { /* Best effort. */ }
    } };
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort. */ } }
    return undefined;
  }
}

/** task:<parent>:<callID> is the dispatch store's key. No inference when it is not that namespace. */
export function completionIdentity(parentSessionID: string, dispatchID: string, childSessionID: string | null): CompletionIdentity {
  const prefix = `task:${parentSessionID}:`;
  return { parentSessionID, callID: dispatchID.startsWith(prefix) ? dispatchID.slice(prefix.length) : dispatchID, childSessionID };
}

/** Collector-side completeness check. Never called by routing; missing seals/gaps/faults are hard errors, not success. */
export function checkV2ObservationStream(lines: readonly string[]): ObservationRecord[] {
  if (lines.length === 0 || lines.length > OBSERVATION_MAX_EVENTS + 1) throw new Error("missing or oversized observation stream");
  const records: ObservationRecord[] = [];
  let stream: string | undefined;
  for (const [i, line] of lines.entries()) {
    if (Buffer.byteLength(line) > OBSERVATION_MAX_ROW_BYTES) throw new Error("oversized observation row");
    const row: unknown = JSON.parse(line);
    if (row === null || typeof row !== "object") throw new Error("invalid observation row");
    const r = row as Record<string, unknown>;
    if (typeof r.stream !== "string" || r.stream === "" || r.v !== 1 || r.seq !== i + 1 || typeof r.at !== "number" || !Number.isFinite(r.at)) {
      throw new Error("observation version/sequence gap");
    }
    stream ??= r.stream;
    if (r.stream !== stream) throw new Error("mixed observation streams");
    if (i === lines.length - 1) {
      if (r.kind !== "end" || r.attempted !== i || r.written !== i || r.dropped !== 0 || r.failed !== 0) throw new Error("incomplete observation stream");
    } else {
      if (r.kind !== undefined || !["native-args", "completion-effect", "scheduler"].includes(String(r.family))) throw new Error("invalid observation family");
      records.push(row as ObservationRecord);
    }
  }
  return records;
}
