import type { NavigationCause, StepCommonV3, StepV3 } from "@/transport/types";
import { shouldIncludeDraft } from "./draft-policy";
import { hasRedirectQualifier } from "./navigation-policy";
import { unmatchedTarget } from "./target-matcher";
import type { RecordingDraftStep } from "./types";

interface CollapsedDraft {
  draft: RecordingDraftStep;
  draftIds: number[];
}

const TRANSITION_CAUSES: Record<string, NavigationCause> = {
  typed: "user_typed",
  generated: "user_typed",
  keyword: "user_typed",
  keyword_generated: "user_typed",
  link: "link",
  form_submit: "form_submit",
  reload: "reload",
  auto_bookmark: "browser",
  start_page: "browser",
};

function isRedirect(step: Extract<RecordingDraftStep, { op: "navigate" }>): boolean {
  return hasRedirectQualifier(step.transitionQualifiers);
}

function collapseRedirects(steps: RecordingDraftStep[]): CollapsedDraft[] {
  const output: CollapsedDraft[] = [];
  steps.forEach((step, index) => {
    const previous = output[output.length - 1];
    if (step.op === "navigate" && previous?.draft.op === "navigate" && isRedirect(step)) {
      previous.draft = {
        ...previous.draft,
        url: step.url,
        postStateId: step.postStateId ?? previous.draft.postStateId,
        // Post-state provenance must ride along too, otherwise a collapsed
        // redirect hides the fact that the surviving draft's result came from a
        // backfill or a fabricated landing (R2-8 / R2-12).
        ...(step.postStateBackfilled || previous.draft.postStateBackfilled
          ? { postStateBackfilled: true }
          : {}),
        ...(step.postStateFallback || previous.draft.postStateFallback
          ? { postStateFallback: true }
          : {}),
      };
      previous.draftIds.push(index + 1);
      return;
    }
    output.push({ draft: { ...step }, draftIds: [index + 1] });
  });
  return output;
}

function navigationCause(step: Extract<RecordingDraftStep, { op: "navigate" }>): NavigationCause {
  if (step.cause) return step.cause;
  const qualifiers = step.transitionQualifiers ?? [];
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.includes("from_address_bar")) return "user_typed";
  return TRANSITION_CAUSES[step.transitionType ?? ""] ?? "browser";
}

function selection(values: string[], labels?: string[]): Array<{ value: string; label?: string }> {
  return values.map((value, index) => ({
    value,
    ...(labels?.[index] ? { label: labels[index] } : {}),
  }));
}

interface ReduceDraftOptions {
  includeTabSwitches: boolean;
  redactValues: boolean;
}

/**
 * Forward-compatible per-step marker for "the pre-action observation is
 * missing".
 *
 * The v3 protocol (`crates/bsk-protocol/src/tools/record_v3.rs`) has no
 * `annotations` / `notes` / `needsReview` slot: `StepCommonV3` is exactly
 * `{ id, state, result }`, and the state body front matter is the only
 * protocol-visible text channel. `StepV3` carries no `deny_unknown_fields`
 * (only the enclosing `TraceV3` / bundle do, and both ignore extra *step*
 * keys), so an extra key here passes the extension's own wire trace — but
 * **only** that: measured against the real crate the key does *not* survive a
 * CLI bundle round trip, and `trace.json` / `bsk site` parsing drop it
 * (`R1-review.md` R1-4, `E1-impl.md` §1.2). The only durable channel is
 * therefore the `state_unbound_steps` line in the state body front matter,
 * which `trace-builder-v3.ts` mirrors from this flag.
 *
 * The name follows the field D-rootcause §1.4 M3 proposes for the protocol so
 * a later protocol change can adopt it without renaming.
 */
export interface PreStateUnboundMark {
  /** True when `state` could not be bound and was topped up with `result.state`. */
  state_unbound?: boolean;
}

export type MarkedStepV3 = StepV3 & PreStateUnboundMark;

function reduceDraft(
  draft: RecordingDraftStep,
  id: number,
  options: ReduceDraftOptions,
  counters: ReduceCounters,
): MarkedStepV3 | null {
  if (!shouldIncludeDraft(draft)) return null;
  if (draft.op === "switch_tab") {
    if (!options.includeTabSwitches || !draft.preStateId || !draft.postStateId) return null;
    return {
      op: "switch_tab",
      id,
      state: draft.preStateId,
      result: { state: draft.postStateId },
    };
  }
  // `state` is required by the protocol, so a missing pre-state still has to
  // point somewhere — but it no longer *pretends* to be a pre-state. The step
  // is kept (dropping it would lose a real user action). Only a pre-state the
  // timestamp guard actively *rejected* is flagged: an action that was never
  // observed at all (`preStateRejected === "none"`) gets no marker and is
  // counted instead, so `state_unbound` keeps meaning "a late snapshot was
  // discarded" rather than doubling as "no observation" (R1-5).
  const preStateRejected = draft.preStateId ? undefined : draft.preStateRejected;
  const preStateUnbound = preStateRejected === "late";
  if (!draft.preStateId && preStateRejected === "none") counters.noObservationIds.push(id);
  const state = draft.preStateId ?? draft.postStateId;
  const resultState = draft.postStateId ?? draft.preStateId;
  if (!state || !resultState) return null;
  const common: StepCommonV3 & PreStateUnboundMark = {
    id,
    state,
    result: { state: resultState },
    ...(preStateUnbound ? { state_unbound: true } : {}),
  };

  switch (draft.op) {
    case "navigate":
      return { op: "navigate", ...common, to: draft.url, cause: navigationCause(draft) };
    case "click":
      return {
        op: "click",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
      };
    case "hover":
      return {
        op: "hover",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
      };
    case "fill":
      const fillIsRedacted = options.redactValues || draft.redacted === true;
      return {
        op: "fill",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        value: fillIsRedacted ? "***" : draft.value,
        commit: draft.commit ?? "blur",
        ...(fillIsRedacted ? { redacted: true } : {}),
      };
    case "press":
      return {
        op: "press",
        ...common,
        key: draft.key,
        ...(draft.captureTarget || draft.matchedTarget
          ? { target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) }
          : {}),
        ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}),
      };
    case "select":
      return {
        op: "select",
        ...common,
        target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget),
        ...(!options.redactValues ? { selection: selection(draft.values, draft.labels) } : {}),
      };
    case "scroll":
      return { op: "scroll", ...common };
  }
}

/** Debug counters for pre-state gaps that deliberately carry no marker. */
export interface ReduceCounters {
  /**
   * Step ids whose action was bound with no observation at all. They carry no
   * `state_unbound` marker (that one means "a late snapshot was rejected"), so
   * the count is surfaced here rather than silently dropped.
   */
  noObservationIds: number[];
  /**
   * Step ids whose result state came from a trailing-observation backfill (E9)
   * instead of this step's own settle. The observation is real, but it may also
   * cover the effect of later actions, so the trace must not present the bind as
   * ordinary: `trace-builder-v3` mirrors this into the bound state's
   * `state_backfilled_steps` front-matter line (R2-8). There is no step-level
   * key for it on purpose — unknown step keys do not survive a CLI round trip.
   */
  backfilledIds: number[];
  /**
   * Step ids whose result state was fabricated from an adjacent draft because no
   * observation was ever available (`SettleController#fallbackMissingPostStates`
   * / `inferMissingPostStates`, R2-12). Disjoint from `backfilledIds`: these
   * steps were not observed at all. Mirrored into the bound state's
   * `post_state_fallback_steps` line.
   */
  fallbackIds: number[];
}

export interface ReducedTraceV3 {
  steps: MarkedStepV3[];
  stepIdByDraftId: Map<number, number>;
  /** Steps whose pre-state was missing because nothing was ever observed. */
  noObservationStepIds: number[];
  /** Steps whose post-state was backfilled from a trailing observation (R2-8). */
  backfilledStepIds: number[];
  /** Steps whose post-state was fabricated from an adjacent state (R2-12). */
  fallbackStepIds: number[];
}

export function reduceTraceStepsV3(
  steps: RecordingDraftStep[],
  options: { includeTabSwitches?: boolean; redactValues?: boolean } = {},
): ReducedTraceV3 {
  const output: MarkedStepV3[] = [];
  const stepIdByDraftId = new Map<number, number>();
  const counters: ReduceCounters = { noObservationIds: [], backfilledIds: [], fallbackIds: [] };
  for (const { draft, draftIds } of collapseRedirects(steps)) {
    const step = reduceDraft(
      draft,
      output.length + 1,
      {
        includeTabSwitches: options.includeTabSwitches === true,
        redactValues: options.redactValues === true,
      },
      counters,
    );
    if (!step) continue;
    output.push(step);
    // Post-state provenance is collected here, not in `reduceDraft`, because it
    // is not a protocol field: it only feeds the front-matter mirror. `backfilled`
    // wins over `fallback` if both flags were ever set on one draft, because the
    // later flag describes a fabricated landing that the backfill replaced.
    if (draft.postStateBackfilled === true) counters.backfilledIds.push(step.id);
    else if (draft.postStateFallback === true) counters.fallbackIds.push(step.id);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, step.id);
  }
  return {
    steps: output,
    stepIdByDraftId,
    noObservationStepIds: counters.noObservationIds,
    backfilledStepIds: counters.backfilledIds,
    fallbackStepIds: counters.fallbackIds,
  };
}
