/**
 * `openai-compatible` backend: POST `<baseUrl>/chat/completions` on any server
 * that speaks the OpenAI chat protocol (Ollama, vLLM, LM Studio, OpenRouter…).
 *
 * Users point `baseUrl` at the `/v1` root. The API key is read from the
 * environment variable named by `apiKeyEnv` at EACH call, so setting it later
 * enables the backend without a reload; `apiKeyEnv: null` sends no
 * `Authorization` header (local servers). `response_format` json_schema is sent
 * first and dropped for later calls when the server rejects it.
 *
 * Contract: never throws, never retries, `timeoutMs` enforced by racing a timer
 * and aborting the `fetch` signal.
 */

import {
  CLASS_OPTIONS,
  type BackendCallOptions,
  type BackendResult,
  type ClassifierBackend,
  type ClassifierLogger,
  type ClassifierSettings,
  type ClassifierState,
  type EnvLike,
  type FetchLike,
  type TaskClass,
} from "../types";
import {
  checkBaseUrl,
  createRuntime,
  cutRaw,
  disabled,
  disabledMany,
  finish,
  finishMany,
  backendUnavailable,
  gatherSamples,
  guarded,
  guardedMany,
  logEffectiveHost,
  parseBatchLabels,
  parseLabel,
  parseModelRef,
  renderBatchPrompt,
  renderSinglePrompt,
  resolveOutcome,
  safeWarn,
  type SampleAnswer,
  type Settled,
} from "./shared";

export interface OpenAICompatibleBackendDeps {
  readonly fetch: FetchLike;
  readonly env: EnvLike;
  readonly settings: ClassifierSettings;
  readonly logger: ClassifierLogger;
  readonly now?: () => number;
}

const BAD_MODEL = "classifier.model is not provider/model[#variant]";
const NO_BASE_URL = "classifier.baseUrl is not set";

interface Endpoint {
  readonly url: string;
  readonly model: string;
  readonly headers: Record<string, string>;
}

interface ChatContent {
  readonly content: string | null;
  readonly reason?: string;
}

interface BatchAnswer {
  readonly labels: readonly (TaskClass | null)[];
  readonly raw: string | null;
  readonly reason?: string;
}

export function createOpenAICompatibleBackend(deps: OpenAICompatibleBackendDeps): ClassifierBackend {
  const rt = createRuntime("openai-compatible", deps.logger, deps.now);
  const { settings } = deps;
  logEffectiveHost(rt, settings.baseUrl);
  /** Instance memo: false once the server rejected `response_format`. */
  let jsonSchema = true;

  /** Resolve URL, model and headers at call time; a string is the `disabled` reason. */
  function endpoint(): Endpoint | string {
    const baseUrl = settings.baseUrl?.trim() ?? "";
    if (baseUrl === "") return NO_BASE_URL;
    const ref = parseModelRef(settings.model ?? "");
    if (ref === null) return BAD_MODEL;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let key: string | null = null;
    if (settings.apiKeyEnv) {
      const value = deps.env[settings.apiKeyEnv];
      if (value === undefined || value.trim() === "") return `apiKeyEnv ${settings.apiKeyEnv} is not set`;
      key = value;
      headers.Authorization = `Bearer ${value}`;
    }
    const safe = checkBaseUrl(baseUrl, key !== null);
    if (!safe.ok) return safe.reason;
    return { url: baseUrl.replace(/\/+$/, "") + "/chat/completions", model: ref.id, headers };
  }

  function requestBody(
    target: Endpoint,
    system: string,
    user: string,
    labels: readonly string[],
    batchCount: number | null,
    withSchema: boolean,
  ): string {
    const schema =
      batchCount === null
        ? {
            type: "object",
            properties: { label: { type: "string", enum: labels } },
            required: ["label"],
            additionalProperties: false,
          }
        : {
            type: "object",
            properties: {
              labels: {
                type: "array",
                items: { type: "string", enum: labels },
                minItems: batchCount,
                maxItems: batchCount,
              },
            },
            required: ["labels"],
            additionalProperties: false,
          };
    return JSON.stringify({
      model: target.model,
      temperature: 0,
      max_tokens: batchCount === null ? 20 : 12 * batchCount + 20,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(withSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: batchCount === null ? "task_class" : "task_classes",
                strict: true,
                schema,
              },
            },
          }
        : {}),
    });
  }

  /** One chat request. HTTP failures throw (→ `error`); malformed bodies return a reason (→ `invalid`). */
  async function chat(
    target: Endpoint,
    system: string,
    user: string,
    labels: readonly string[],
    batchCount: number | null,
    signal: AbortSignal,
  ): Promise<ChatContent> {
    const withSchema = jsonSchema;
    const response = await deps.fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: requestBody(target, system, user, labels, batchCount, withSchema),
      signal,
    });
    if (!response.ok) {
      // The status below is the reported failure; the body is read only to detect `response_format` rejection.
      const detail = await response.text().catch(() => "");
      if (withSchema && jsonSchema && (response.status === 400 || response.status === 422) && /response_format/i.test(detail)) {
        jsonSchema = false;
        safeWarn(
          rt.logger,
          "classifier openai-compatible: server rejected response_format json_schema; later calls omit it",
          { status: response.status },
        );
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { content: null, reason: "non-JSON response" };
    }
    const choices = (parsed as { choices?: unknown } | null)?.choices;
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content !== "string") return { content: null, reason: "missing message content" };
    return { content };
  }

  return {
    id: "openai-compatible",

    async classify(state: ClassifierState, options: BackendCallOptions): Promise<BackendResult> {
      const startedAt = rt.now();
      return guarded(rt, startedAt, async () => {
        const target = endpoint();
        if (typeof target === "string") return disabled(rt, target, startedAt);
        const blocked = backendUnavailable(rt);
        if (blocked !== null) return disabled(rt, blocked, startedAt);
        const samples = settings.samples;
        const choices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const rendered = Array.from({ length: samples }, () => renderSinglePrompt(state, choices, options.random));
        const gathered = await gatherSamples<SampleAnswer>(
          rt,
          samples,
          settings.timeoutMs,
          new AbortController(),
          async (index, signal) => {
            const r = rendered[index]!;
            const answer = await chat(target, r.system, r.user, r.labels, null, signal);
            if (answer.content === null) return { label: null, raw: null, reason: answer.reason };
            return { label: parseLabel(answer.content, r.labels), raw: cutRaw(answer.content) };
          },
          (answer) => answer.label,
        );
        const labels = gathered.settled.map((s) => (s.kind === "value" ? s.v.label : null));
        const outcome = resolveOutcome(labels, gathered.settled, samples, gathered.timedOut, settings.timeoutMs);
        return finish(rt, outcome, samples, startedAt);
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
        const blocked = backendUnavailable(rt);
        if (blocked !== null) return disabledMany(rt, states.length, blocked, startedAt);
        const samples = settings.samples;
        const count = states.length;
        const choices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const rendered = Array.from({ length: samples }, () => renderBatchPrompt(states, choices, options.random));
        const gathered = await gatherSamples<BatchAnswer>(
          rt,
          samples,
          settings.timeoutMs,
          new AbortController(),
          async (index, signal) => {
            const r = rendered[index]!;
            const answer = await chat(target, r.system, r.user, r.labels, count, signal);
            if (answer.content === null) return { labels: [], raw: null, reason: answer.reason };
            return { labels: parseBatchLabels(answer.content, count, r.labels), raw: cutRaw(answer.content) };
          },
          (answer) => (answer.labels.length > 0 ? answer.labels.join("|") : null),
        );
        const settled: Array<Settled<BatchAnswer>> = gathered.settled;
        const outcomes = states.map((_, item) =>
          resolveOutcome(
            settled.map((s) => (s.kind === "value" ? (s.v.labels[item] ?? null) : null)),
            settled,
            samples,
            gathered.timedOut,
            settings.timeoutMs,
          ),
        );
        return finishMany(rt, outcomes, samples, startedAt);
      });
    },
  };
}
