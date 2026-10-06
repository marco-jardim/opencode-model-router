/**
 * `host` backend (amendment A4): classifies through the host's own
 * `ctx.generate.text`. The model is passed as the object `{ providerID, id,
 * variant? }` — never the `provider/model` string, never the raw
 * `/api/experimental/generate` HTTP route, never `fetch`.
 *
 * Contract: never throws, never retries, settles within `timeoutMs` (the timer
 * races the host call; an abandoned call may still complete and bill).
 */

import {
  CLASS_OPTIONS,
  type BackendCallOptions,
  type BackendResult,
  type ClassifierBackend,
  type ClassifierLogger,
  type ClassifierSettings,
  type ClassifierState,
  type HostGenerate,
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
  parseBatchLabels,
  parseLabel,
  parseModelRef,
  renderBatchPrompt,
  renderSinglePrompt,
  resolveOutcome,
  type SampleAnswer,
  type Settled,
} from "./shared";

export interface HostBackendDeps {
  readonly generate: HostGenerate;
  readonly settings: ClassifierSettings;
  readonly logger: ClassifierLogger;
  readonly now?: () => number;
}

const BAD_MODEL = "classifier.model is not provider/model[#variant]";

interface BatchAnswer {
  readonly labels: readonly (TaskClass | null)[];
  readonly raw: string | null;
  readonly reason?: string;
}

export function createHostBackend(deps: HostBackendDeps): ClassifierBackend {
  const rt = createRuntime("host", deps.logger, deps.now);
  const { generate, settings } = deps;

  const hostModel = () => {
    const ref = parseModelRef(settings.model ?? "");
    return ref === null
      ? null
      : {
          providerID: ref.providerID,
          id: ref.id,
          ...(ref.variant ? { variant: ref.variant } : {}),
        };
  };

  async function callHost(
    prompt: string,
    model: NonNullable<ReturnType<typeof hostModel>>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const result = await generate.text({ prompt, model }, { signal });
    return typeof result?.text === "string" ? result.text : null;
  }

  return {
    id: "host",

    async classify(state: ClassifierState, options: BackendCallOptions): Promise<BackendResult> {
      const startedAt = rt.now();
      return guarded(rt, startedAt, async () => {
        const model = hostModel();
        if (model === null) return disabled(rt, BAD_MODEL, startedAt);
        const samples = settings.samples;
        const choices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const rendered = Array.from({ length: samples }, () =>
          renderSinglePrompt(state, choices, options.random),
        );
        const gathered = await gatherSamples<SampleAnswer>(
          samples,
          settings.timeoutMs,
          new AbortController(),
          async (index, signal) => {
            const text = await callHost(rendered[index]!.prompt, model, signal);
            if (text === null) return { label: null, raw: null, reason: "host returned no text" };
            const label = parseLabel(text, rendered[index]!.labels);
            return { label, raw: cutRaw(text) };
          },
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
        const model = hostModel();
        if (model === null) return disabledMany(rt, states.length, BAD_MODEL, startedAt);
        const samples = settings.samples;
        const count = states.length;
        const choices = options.choices.length > 0 ? options.choices : CLASS_OPTIONS;
        const rendered = Array.from({ length: samples }, () => renderBatchPrompt(states, choices, options.random));
        const gathered = await gatherSamples<BatchAnswer>(
          samples,
          settings.timeoutMs,
          new AbortController(),
          async (index, signal) => {
            const batch = rendered[index]!;
            const text = await callHost(batch.prompt, model, signal);
            if (text === null) {
              return { labels: [], raw: null, reason: "host returned no text" };
            }
            return {
              labels: parseBatchLabels(text, count, batch.labels),
              raw: cutRaw(text),
            };
          },
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
