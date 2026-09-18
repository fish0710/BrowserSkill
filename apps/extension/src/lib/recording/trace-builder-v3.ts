import {
  type StepV3,
  type StopReason,
  TRACE_VERSION_V3,
  type TraceStateV3,
  type TraceV3,
  VOM_FORMAT_VERSION,
} from "@/transport/types";
import { resolveDraftStartUrl } from "./draft-policy";
import type { RecordedStateEntry, RecordingStateRegistry } from "./state-registry";
import { reduceTraceStepsV3 } from "./trace-reducer-v3";
import { collectTraceSecrets, scrubTraceSecrets } from "./trace-secrets";
import { formatTraceStateBody } from "./trace-state-body";
import type { RecordingDraftStep, StepAnnotation } from "./types";

function publishedEntries(registry: RecordingStateRegistry, steps: StepV3[]): RecordedStateEntry[] {
  const entries = registry.values();
  if (steps.length === 0) return entries.slice(0, 1);
  const referenced = new Set(steps.flatMap((step) => [step.state, step.result.state]));
  return entries.filter((entry) => referenced.has(entry.id));
}

function remapDraftIds(draftIds: number[], stepIdByDraftId: Map<number, number>): number[] {
  return [
    ...new Set(
      draftIds.flatMap((id) => {
        const stepId = stepIdByDraftId.get(id);
        return stepId === undefined ? [] : [stepId];
      }),
    ),
  ].sort((a, b) => a - b);
}

export function buildTraceV3(input: {
  registry: RecordingStateRegistry;
  drafts: RecordingDraftStep[];
  annotations?: StepAnnotation[];
  startedAt: string;
  purpose?: string;
  startUrl?: string;
  stoppedBy: StopReason;
  bskVersion: string;
  redactValues?: boolean;
  includeTabSwitches?: boolean;
}): TraceV3 {
  const reduced = reduceTraceStepsV3(input.drafts, {
    includeTabSwitches: input.includeTabSwitches,
    redactValues: input.redactValues,
  });
  const entries = publishedEntries(input.registry, reduced.steps);
  const publishedId = new Map(entries.map((entry, index) => [entry.id, `s${index + 1}`]));
  const annotationsByState = new Map<string, StepAnnotation[]>();
  for (const annotation of input.annotations ?? []) {
    const bucket = annotationsByState.get(annotation.stateId) ?? [];
    bucket.push(annotation);
    annotationsByState.set(annotation.stateId, bucket);
  }
  const steps = reduced.steps.map((step) => ({
    ...step,
    state: publishedId.get(step.state) ?? step.state,
    result: { state: publishedId.get(step.result.state) ?? step.result.state },
  }));
  // Mirror the per-step pre-state marker into the state body front matter.
  // `StepV3` has no such field and the Rust structs drop unknown step keys on a
  // CLI round trip, so the step-level flag each survives only the raw JSON the
  // extension emits; this front matter line is the durable copy (R1-4).
  const unboundStepIdsByState = new Map<string, number[]>();
  // R2-8 / R2-12: the post-state side gets the same treatment. A backfilled
  // result is a real observation that may also cover later actions; a fallback
  // result was never observed at all. Both are invisible in the wire trace
  // (`postStateBackfilled` / `postStateFallback` are binder bookkeeping), so the
  // body front matter is again the only durable channel. The two facts are kept
  // in separate keys so a consumer never has to guess which downgrade it sees.
  const resultStateByStepId = new Map(steps.map((step) => [step.id, step.result.state]));
  const groupByResultState = (stepIds: number[]): Map<string, number[]> => {
    const byState = new Map<string, number[]>();
    for (const stepId of stepIds) {
      const state = resultStateByStepId.get(stepId);
      if (!state) continue;
      const bucket = byState.get(state) ?? [];
      bucket.push(stepId);
      byState.set(state, bucket);
    }
    return byState;
  };
  const backfilledStepIdsByState = groupByResultState(reduced.backfilledStepIds);
  const fallbackStepIdsByState = groupByResultState(reduced.fallbackStepIds);
  for (const step of steps) {
    if (step.state_unbound !== true) continue;
    const bucket = unboundStepIdsByState.get(step.result.state) ?? [];
    bucket.push(step.id);
    unboundStepIdsByState.set(step.result.state, bucket);
  }
  // Steps whose gap was "never observed" intentionally carry no marker; keep
  // the count visible to live attribution runs instead of dropping it (R1-5).
  if (import.meta.env.DEV && reduced.noObservationStepIds.length > 0) {
    console.debug("[record-trace] pre-state never observed", {
      stepIds: reduced.noObservationStepIds,
    });
  }
  if (
    import.meta.env.DEV &&
    (reduced.backfilledStepIds.length > 0 || reduced.fallbackStepIds.length > 0)
  ) {
    console.debug("[record-trace] post-state not a plain observation", {
      backfilledStepIds: reduced.backfilledStepIds,
      fallbackStepIds: reduced.fallbackStepIds,
    });
  }
  const states: TraceStateV3[] = entries.map((entry) => {
    const id = publishedId.get(entry.id) ?? entry.id;
    return {
      id,
      url: entry.url,
      ...(entry.title ? { title: entry.title } : {}),
      body: formatTraceStateBody({
        stateId: id,
        url: entry.url,
        title: entry.title,
        stepIds: remapDraftIds(entry.stepsHere, reduced.stepIdByDraftId),
        unboundStepIds: unboundStepIdsByState.get(id) ?? [],
        backfilledStepIds: backfilledStepIdsByState.get(id) ?? [],
        fallbackStepIds: fallbackStepIdsByState.get(id) ?? [],
        vomText: entry.vomText,
        annotations: annotationsByState.get(entry.id) ?? [],
        stepIdByDraftId: reduced.stepIdByDraftId,
      }),
      ...(entry.truncated ? { truncated: true } : {}),
    };
  });

  // D3-1: the reducer masks only a fill step's `value`, while the same secret
  // reaches `states[].url`/`title`/`body` and `entry.start_url` through echoed
  // URLs and page text. Scrub once, here, so `trace.json` and `states/*.txt` are
  // generated from the same already-scrubbed data.
  return scrubTraceSecrets(
    {
      version: TRACE_VERSION_V3,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      recorded_at: new Date().toISOString(),
      started_at: input.startedAt,
      stopped_by: input.stoppedBy,
      entry: { start_url: resolveDraftStartUrl(input.drafts, input.startUrl, states[0]?.url) },
      recorder: { bsk: input.bskVersion, vom: VOM_FORMAT_VERSION },
      states,
      steps,
    },
    collectTraceSecrets(input.drafts, input.redactValues === true),
  );
}
