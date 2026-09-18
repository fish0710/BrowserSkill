import type { CaptureTargetDescriptor } from "@/lib/describe-target";
import type {
  FillCommit,
  KeyModifier,
  NavigationCause,
  StepV3,
  TargetDescriptorV3,
} from "@/transport/types";

export interface TargetGeometry {
  /** Top-level viewport-relative CSS pixels, as defined by the geometry module. */
  rect: { x: number; y: number; w: number; h: number };
  tag: string;
}

export interface TargetMatchHint {
  geometry?: TargetGeometry;
  /** Missing means top frame; null means the source Document could not be resolved. */
  frameId?: string | null;
  geometrySpace?: "top" | "local";
}

export interface StepAnnotation {
  draftId: number;
  op: StepV3["op"];
  line: number;
  stateId: string;
  detail?: string;
}

interface DraftStateLink {
  pageUrl?: string;
  preStateId?: string;
  postStateId?: string;
  /**
   * When the recorded action actually arrived, sampled by the caller before it
   * awaited anything (R1-2). The pre-state guard compares the observation clock
   * against this instead of against "when the recording queue slot ran".
   * `undefined` falls back to `Date.now()` at bind time.
   */
  arrivedAt?: number;
  /**
   * Why `preStateId` is missing, when the binder knows (R1-5):
   *
   * - `"late"`: an observation existed, but it was sampled *after* the action
   *   arrived, so the guard refused to record a post-action snapshot as a
   *   pre-state. The reducer turns this into `state_unbound`.
   * - `"none"`: there was no observation at all when the action was bound.
   *   The reducer only counts it, so "never observed" is not reported as the
   *   same defect as "rejected late snapshot".
   */
  preStateRejected?: "late" | "none";
  /**
   * Set when a later action superseded this draft's settle before it could
   * sample a result (E9). `postStateId` deliberately stays unset: during a
   * burst every action shares one stale pre-state, so writing the *next*
   * action's pre-state as this action's result pinned `result.state` to the
   * snapshot from before the whole burst. A later observation that was
   * genuinely sampled after `arrivedAt` backfills it instead
   * (`SettleController#bindTrailing`).
   */
  postStatePending?: boolean;
  /**
   * True once `postStateId` was written by a trailing observation (E9) rather
   * than by this draft's own settle. Purely internal bookkeeping: it is never
   * serialized into the wire trace or the protocol — `trace-builder-v3` mirrors
   * it into the bound state's `state_backfilled_steps` front-matter line, which
   * is the only durable channel (R2-8), next to a DEV `console.debug`.
   *
   * A backfilled result *is* a real observation; it may just cover the effect of
   * later actions too. That is why it is reported separately from
   * `postStateFallback`.
   */
  postStateBackfilled?: boolean;
  /**
   * True when `postStateId` was not observed at all but fabricated from an
   * adjacent draft's state (`SettleController#fallbackMissingPostStates` /
   * `inferMissingPostStates`), R2-12.
   *
   * Written instead of dropping the step, but it must not pass for a real
   * "after" observation: `trace-builder-v3` mirrors it into the bound state's
   * `post_state_fallback_steps` front-matter line, kept disjoint from
   * `state_backfilled_steps` so a consumer can tell "coarser observation" from
   * "no observation at all".
   */
  postStateFallback?: boolean;
}

interface DraftTarget {
  captureTarget?: CaptureTargetDescriptor;
  targetHint?: TargetMatchHint;
  matchedTarget?: TargetDescriptorV3;
}

interface DraftNavigationEffect {
  navigatedTo?: string;
}

export type RecordingDraftStep =
  | ({ op: "click" } & DraftStateLink & DraftTarget & DraftNavigationEffect)
  | ({ op: "hover" } & DraftStateLink & DraftTarget)
  | ({
      op: "fill";
      value: string;
      commit?: FillCommit;
      redacted?: boolean;
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({
      op: "press";
      key: string;
      modifiers?: KeyModifier[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({
      op: "select";
      values: string[];
      labels?: string[];
    } & DraftStateLink &
      DraftTarget &
      DraftNavigationEffect)
  | ({ op: "scroll" } & DraftStateLink)
  | ({ op: "switch_tab" } & DraftStateLink)
  | ({
      op: "navigate";
      url: string;
      cause?: NavigationCause;
      transitionType?: string;
      transitionQualifiers?: string[];
    } & DraftStateLink);

export type TargetedRecordingDraft = Extract<
  RecordingDraftStep,
  { op: "click" | "hover" | "fill" | "press" | "select" }
>;
