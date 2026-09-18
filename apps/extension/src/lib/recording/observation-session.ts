import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import { captureRecordingObservation, type RegisteredObservation } from "./observation-capture";
import { RecordingStateRegistry } from "./state-registry";
import { matchObservationTarget, unmatchedTarget } from "./target-matcher";
import type { RecordingDraftStep, StepAnnotation, TargetedRecordingDraft } from "./types";

const DEFAULT_MAX_PAGE_TOKENS = 3_000;
const MIN_CAPTURE_INTERVAL_MS = 200;

export interface TabObservationCursor {
  lastSettled: RegisteredObservation | null;
  /**
   * When `lastSettled` was registered. `undefined` means the observation was
   * injected by a caller that has no arrival clock (tests, transitional code),
   * which is treated as "usable as a pre-state".
   */
  lastSettledAt?: number;
  lastCaptureAt: number;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isTargeted(draft: RecordingDraftStep): draft is TargetedRecordingDraft {
  return (
    draft.op === "click" ||
    draft.op === "hover" ||
    draft.op === "fill" ||
    draft.op === "press" ||
    draft.op === "select"
  );
}

export class RecordingObservationSession {
  readonly registry: RecordingStateRegistry;
  readonly cursor: TabObservationCursor;
  readonly annotations: StepAnnotation[];
  readonly #maxTokens: number;
  readonly #redactValues: boolean;

  constructor(
    options: {
      registry?: RecordingStateRegistry;
      cursor?: TabObservationCursor;
      annotations?: StepAnnotation[];
      maxTokens?: number;
      redactValues?: boolean;
    } = {},
  ) {
    this.registry = options.registry ?? new RecordingStateRegistry();
    this.cursor = options.cursor ?? { lastSettled: null, lastCaptureAt: 0 };
    this.annotations = options.annotations ?? [];
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_PAGE_TOKENS;
    this.#redactValues = options.redactValues ?? false;
  }

  async capture(
    cdp: CdpRunner,
    tabsApi: ChromeTabsApi,
    tabId: number,
    signal?: AbortSignal,
  ): Promise<RegisteredObservation> {
    // Sampling clock, taken before the throttle wait and before any `await`, so
    // it is as close to the CDP DOM read as this layer can get and is never
    // inflated by queueing. It is the clock `bindDraft` compares against
    // `arrivedAt`: a sample that *began* before the action arrived is that
    // action's pre-state even if it only settled afterwards (E11).
    const capturedAt = Date.now();
    const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (Date.now() - this.cursor.lastCaptureAt));
    if (waitMs > 0) await abortableDelay(waitMs, signal);
    if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
    const captured = await captureRecordingObservation({
      cdp,
      tabsApi,
      tabId,
      maxTokens: this.#maxTokens,
      redactValues: this.#redactValues,
      signal,
    });
    const state = this.registry.register({
      url: captured.url,
      title: captured.title,
      vomText: captured.vomText,
      truncated: captured.truncated,
    });
    const settledAt = Date.now();
    const observation: RegisteredObservation = {
      stateId: state.id,
      rootFrameId: captured.rootFrameId,
      index: captured.index,
      url: captured.url,
      // Carried on the observation itself (E9/E11) so the settle controller can
      // decide "had this sample already started when that action arrived?"
      // without reading back through the shared cursor, which may already point
      // at a newer capture by the time a queued task resumes.
      capturedAt,
      settledAt,
    };
    this.cursor.lastSettled = observation;
    this.cursor.lastSettledAt = settledAt;
    this.cursor.lastCaptureAt = settledAt;
    return observation;
  }

  /**
   * Attach the most recent observation to `draft`.
   *
   * A pending previous action no longer skips binding: that early return threw
   * away `preStateId` *and* `markStep`, which is how a step ended up with no
   * pre-state at all (and, downstream, with `state === result.state`). Whether
   * an observation may stand in as this step's pre-state is decided by the
   * timestamp guard below instead.
   *
   * `arrivedAt` is the moment the caller received this action.
   */
  bindDraft(draft: RecordingDraftStep, draftId: number, arrivedAt: number = Date.now()): void {
    const observation = this.cursor.lastSettled;
    if (isTargeted(draft)) {
      draft.matchedTarget = observation
        ? matchObservationTarget({
            observation,
            hint: draft.targetHint,
            fallback: draft.captureTarget,
          })
        : unmatchedTarget(draft.captureTarget);
    }
    if (!observation) {
      // No observation at all. Record the reason so the reducer can count the
      // gap without claiming a late snapshot was rejected (R1-5).
      draft.preStateRejected = "none";
      return;
    }

    // What disqualifies an observation is that its *sampling* began after the
    // action arrived: it was started on the far side of that action, so it
    // shows the state the action produced (a panel it opened, a page it
    // navigated to). A sample that started before the action and only settled
    // afterwards is still a legal pre-state — that is the hover-opens-menu /
    // click-500ms-later shape (E11) — so the guard uses `capturedAt`, not the
    // registration clock. Leave `preStateId` unbound instead of recording a
    // post-action snapshot as a pre-action one; the reducer turns this reason
    // into an explicit marker.
    //
    // The cursor fallback keeps observations injected by tests/transitional
    // code (which only set `lastSettledAt`, or `settledAt`) on the old clock.
    const capturedAt = observation.capturedAt ?? this.cursor.lastSettledAt ?? observation.settledAt;
    if (capturedAt !== undefined && capturedAt > arrivedAt) {
      draft.preStateRejected = "late";
      return;
    }
    draft.preStateRejected = undefined;

    draft.preStateId = observation.stateId;
    this.registry.markStep(observation.stateId, draftId);

    if (!isTargeted(draft) || !draft.matchedTarget?.ref) return;
    const ref = observation.index.ref(draft.matchedTarget.ref);
    if (!ref) return;
    this.annotations.push({
      draftId,
      op: draft.op,
      line: ref.line,
      stateId: observation.stateId,
      ...(draft.op === "fill" && !this.#redactValues
        ? { detail: JSON.stringify(draft.value) }
        : {}),
    });
  }
}
