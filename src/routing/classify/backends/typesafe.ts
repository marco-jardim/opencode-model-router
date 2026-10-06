/**
 * `typesafe` backend: POST `<baseUrl>/v1/systemone` (TypeSafe "choice"
 * questions). The task text goes in the `state` field, which the API treats as
 * data; the class, risk and scope questions are constants. TypeSafe returns a
 * calibrated confidence, so `samples` is ignored (one request per call) and the
 * answer's own confidence is used.
 *
 * The API key is read from `apiKeyEnv` at each call. There is no built-in base
 * URL: sending the state to a host the user never configured would break the D14
 * privacy stance, so a missing `baseUrl` disables the backend with a logged
 * reason (the vendor's documented host is `TYPESAFE_DEFAULT_BASE_URL`).
 *
 * Contract: never throws, never retries, `timeoutMs` enforced by racing a timer
 * and aborting the `fetch` signal.
 */

import {
  BACKEND_PROMPT,
  CLASS_OPTIONS,
  CONFIDENCE,
  RISK_OPTIONS,
  RISKS,
  SCOPE_OPTIONS,
  SCOPES,
  type BackendCallOptions,
  type BackendResult,
  type ChoiceOption,
  type ClassifierBackend,
  type ClassifierLogger,
  type ClassifierSettings,
  type ClassifierState,
  type EnvLike,
  type FetchLike,
  type Risk,
  type Scope,
  type TaskClass,
} from "../types";
import {
  createRuntime,
  cutRaw,
  disabled,
  disabledMany,
  finish,
  finishMany,
  gatherSamples,
  guarded,
  guardedMany,
  parseModelRef,
  reasonOf,
  renderBatchPrompt,
  round2,
  shuffle,
  type Outcome,
  type Settled,
} from "./shared";

/** The vendor's documented API host; documentation and config defaults may point `baseUrl` here. */
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";

export interface TypeSafeBackendDeps {
  readonly fetch: FetchLike;
  readonly env: EnvLike;
  readonly settings: ClassifierSettings;
  readonly logger: ClassifierLogger;
  readonly now?: () => number;
}

const BAD_MODEL = "classifier.model is not provider/model[#variant]";
const NO_BASE_URL = "classifier.baseUrl is not set";
const NO_KEY = "classifier.apiKeyEnv is not set";

interface Endpoint {
  readonly url: string;
  readonly model: string;
  readonly headers: Record<string, string>;
}

interface ChoiceAnswer {
  readonly choice: string | null;
  readonly confidence: number;
}

interface SingleAnswer {
  readonly cls: TaskClass | null;
  readonly confidence: number;
  readonly risk?: Risk;
  readonly scope?: Scope;
  readonly raw: string | null;
  readonly reason?: string;
}

interface BatchAnswer {
  readonly items: ReadonlyArray<{ readonly cls: TaskClass | null; readonly confidence: number }>;
  readonly raw: string | null;
  readonly reason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function criteria(options: readonly ChoiceOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const option of options) out[option.label] = option.description;
  return out;
}

function readChoice(answers: Record<string, unknown> | null, key: string): ChoiceAnswer | null {
  const answer = asRecord(answers?.[key]);
  if (answer === null) return null;
  const confidence = answer.confidence;
  return {
    choice: typeof answer.choice === "string" ? answer.choice : null,
    confidence:
      typeof confidence === "number" && Number.isFinite(confidence)
        ? round2(Math.min(1, Math.max(0, confidence)))
        : CONFIDENCE.backendSingleSample,
  };
}

function oneOf<T extends string>(values: readonly T[], choice: string | null): T | null {
  return choice !== null ? (values.find((v) => v === choice) ?? null) : null;
}

export function createTypeSafeBackend(deps: TypeSafeBackendDeps): ClassifierBackend {
  const rt = createRuntime("typesafe", deps.logger, deps.now);
  const { settings } = deps;

  /** Resolve URL, key and wire model at call time; a string is the `disabled` reason. */
  function endpoint(): Endpoint | string {
    const baseUrl = settings.baseUrl?.trim() ?? "";
    if (baseUrl === "") return NO_BASE_URL;
    const ref = parseModelRef(settings.model ?? "");
    if (ref === null) return BAD_MODEL;
    if (!settings.apiKeyEnv) return NO_KEY;
    const key = deps.env[settings.apiKeyEnv];
    if (key === undefined || key.trim() === "") return `apiKeyEnv ${settings.apiKeyEnv} is not set`;
    return {
      url: baseUrl.replace(/\/+$/, "") + "/v1/systemone",
      model: ref.id,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    };
  }

  /** One request. HTTP failures throw (→ `error`); a malformed body returns a reason (→ `invalid`). */
  async function post(
    target: Endpoint,
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ answers: Record<string, unknown> | null; raw: string | null; reason?: string }> {
    const response = await deps.fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { answers: null, raw: null, reason: "non-JSON response" };
    }
    const answers = asRecord(asRecord(parsed)?.answers);
    if (answers === null) return { answers: null, raw: cutRaw(text), reason: "missing answers" };
    return { answers, raw: cutRaw(text) };
  }

  return {
    id: "typesafe",

    async classify(state: ClassifierState, options: BackendCallOptions): Promise<BackendResult> {
      const startedAt = rt.now();
      return guarded(rt, startedAt, async () => {
        const target = endpoint();
        if (typeof target === "string") return disabled(rt, target, startedAt);
        const classChoices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const body = {
          state: state.text,
          model: target.model,
          questions: {
            task_class: {
              type: "choice",
              instructions: BACKEND_PROMPT.typesafeClass,
              criteria: criteria(shuffle(classChoices, options.random)),
            },
            task_risk: {
              type: "choice",
              instructions: BACKEND_PROMPT.typesafeRisk,
              criteria: criteria(shuffle(RISK_OPTIONS, options.random)),
            },
            task_scope: {
              type: "choice",
              instructions: BACKEND_PROMPT.typesafeScope,
              criteria: criteria(shuffle(SCOPE_OPTIONS, options.random)),
            },
          },
        };
        const classLabels = classChoices.map((c) => c.label);
        const gathered = await gatherSamples<SingleAnswer>(1, settings.timeoutMs, new AbortController(), async (_, signal) => {
          const reply = await post(target, body, signal);
          if (reply.answers === null) {
            return { cls: null, confidence: 0, raw: reply.raw, reason: reply.reason };
          }
          const cls = readChoice(reply.answers, "task_class");
          const label = oneOf(classLabels, cls?.choice ?? null);
          if (label === null) {
            return { cls: null, confidence: 0, raw: reply.raw, reason: "task_class answer is not a class label" };
          }
          const risk = oneOf(RISKS, readChoice(reply.answers, "task_risk")?.choice ?? null);
          const scope = oneOf(SCOPES, readChoice(reply.answers, "task_scope")?.choice ?? null);
          return {
            cls: label,
            confidence: cls?.confidence ?? CONFIDENCE.backendSingleSample,
            ...(risk ? { risk } : {}),
            ...(scope ? { scope } : {}),
            raw: reply.raw,
          };
        });
        const only = gathered.settled[0]!;
        let outcome: Outcome;
        if (only.kind === "value" && only.v.cls !== null) {
          outcome = {
            status: "ok",
            label: only.v.cls,
            confidence: only.v.confidence,
            raw: only.v.raw,
            ...(only.v.risk ? { risk: only.v.risk } : {}),
            ...(only.v.scope ? { scope: only.v.scope } : {}),
          };
        } else if (only.kind === "value") {
          outcome = { status: "invalid", raw: only.v.raw, reason: only.v.reason ?? "no class answer" };
        } else if (only.kind === "error") {
          outcome = { status: "error", raw: null, reason: reasonOf(only.e) };
        } else {
          outcome = { status: "timeout", raw: null, reason: `no answer within ${settings.timeoutMs} ms` };
        }
        return finish(rt, outcome, 1, startedAt);
      });
    },

    async classifyMany(
      states: readonly ClassifierState[],
      options: BackendCallOptions,
    ): Promise<BackendResult[]> {
      if (states.length === 0) return [];
      const startedAt = rt.now();
      return guardedMany(rt, states.length, startedAt, async () => {
        const target = endpoint();
        if (typeof target === "string") return disabledMany(rt, states.length, target, startedAt);
        const count = states.length;
        const classChoices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const rendered = renderBatchPrompt(states, classChoices, options.random);
        const described = new Map<string, ChoiceOption>(classChoices.map((c) => [c.label, c]));
        const ordered = rendered.labels.flatMap((label) => {
          const option = described.get(label);
          return option ? [option] : [];
        });
        const questions: Record<string, unknown> = {};
        for (let n = 1; n <= count; n++) {
          questions[`class_${n}`] = {
            type: "choice",
            instructions: BACKEND_PROMPT.typesafeBatchClass.replaceAll("{n}", String(n)),
            criteria: criteria(ordered),
          };
        }
        const body = { state: rendered.blocks, model: target.model, questions };
        const classLabels = classChoices.map((c) => c.label);
        const gathered = await gatherSamples<BatchAnswer>(1, settings.timeoutMs, new AbortController(), async (_, signal) => {
          const reply = await post(target, body, signal);
          if (reply.answers === null) return { items: [], raw: reply.raw, reason: reply.reason };
          const items = Array.from({ length: count }, (_, i) => {
            const answer = readChoice(reply.answers, `class_${i + 1}`);
            return {
              cls: oneOf(classLabels, answer?.choice ?? null),
              confidence: answer?.confidence ?? CONFIDENCE.backendSingleSample,
            };
          });
          return { items, raw: reply.raw };
        });
        const only: Settled<BatchAnswer> = gathered.settled[0]!;
        const outcomes = states.map((_, i): Outcome => {
          if (only.kind === "value") {
            const item = only.v.items[i];
            if (item?.cls) {
              return { status: "ok", label: item.cls, confidence: item.confidence, raw: only.v.raw };
            }
            return {
              status: "invalid",
              raw: only.v.raw,
              reason: only.v.reason ?? `no valid class_${i + 1} answer`,
            };
          }
          if (only.kind === "error") return { status: "error", raw: null, reason: reasonOf(only.e) };
          return { status: "timeout", raw: null, reason: `no answer within ${settings.timeoutMs} ms` };
        });
        return finishMany(rt, outcomes, 1, startedAt);
      });
    },
  };
}
